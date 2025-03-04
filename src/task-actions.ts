import * as path from "path";
import * as fs from "fs";
import axios from "axios";
import FormData = require("form-data");
import { StarknetPluginError } from "./starknet-plugin-error";
import {
    ABI_SUFFIX,
    ALPHA_TESTNET,
    CAIRO1_SIERRA_SUFFIX,
    CAIRO1_ASSEMBLY_SUFFIX,
    DEFAULT_STARKNET_NETWORK
} from "./constants";
import { ProcessResult } from "@nomiclabs/hardhat-docker";
import { adaptLog, traverseFiles, getNetwork, isStarknetDevnet, adaptPath } from "./utils";
import {
    HardhatNetworkConfig,
    HardhatRuntimeEnvironment,
    HttpNetworkConfig,
    RunSuperFunction,
    TaskArguments
} from "hardhat/types";
import { createIntegratedDevnet } from "./external-server";
import { Recompiler } from "./recompiler";
import { version } from "../package.json";
import { StarknetConfig } from "./types/starknet";
import * as toml from "@iarna/toml";
import { ScarbWrapper } from "./scarb-wrapper";
import { ScarbConfig } from "./types";

function checkSourceExists(sourcePath: string): void {
    if (!fs.existsSync(sourcePath)) {
        const msg = `Source expected to be at ${sourcePath}, but not found.`;
        throw new StarknetPluginError(msg);
    }
}

/**
 * Transfers logs and generates a return status code.
 *
 * @param executed The process result of running the container
 * @returns 0 if succeeded, 1 otherwise
 */
function processExecuted(executed: ProcessResult, logStatus: boolean): number {
    if (executed.stdout.length) {
        console.log(adaptLog(executed.stdout.toString()));
    }

    if (executed.stderr.length) {
        // synchronize param names reported by actual CLI with param names used by this plugin
        const err = executed.stderr.toString();
        const replacedErr = adaptLog(err);
        console.error(replacedErr);
    }

    if (logStatus) {
        const finalMsg = executed.statusCode ? "Failed" : "Succeeded ✅";
        console.log(`\t${finalMsg}\n`);
    }
    return executed.statusCode ? 1 : 0;
}

/**
 * First deletes the file if it already exists. Then creates an empty file at the provided path.
 * Unlinking/deleting is necessary if user switched from docker to venv.
 * @param filePath the file to be recreated
 */
function initializeFile(filePath: string) {
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
    fs.closeSync(fs.openSync(filePath, "w"));
}

function getFileName(filePath: string) {
    return path.basename(filePath, path.extname(filePath));
}

function getCompilerBinDir(args: TaskArguments, config: StarknetConfig): string {
    // give precedence to CLI input over config file
    return args?.cairo1BinDir || config.cairo1BinDir;
}

class ScarbConfigValidationError extends StarknetPluginError {
    constructor(path: string, message: string, parent?: Error) {
        super(
            `Invalid config file ${path}: ${message}\n` +
                "To skip this validation, use the --skip-validate flag in the CLI",
            parent
        );
    }
}

function loadScarbTomlFromPath(tomlPath: string, validate: boolean): ScarbConfig {
    const config = toml.parse(
        fs.readFileSync(tomlPath, "utf-8").toString()
    ) as unknown as ScarbConfig;
    const packageName = config.package.name;

    if (validate) {
        // it's an array of possible compilation configs
        const contractTargetConfigs = config?.target["starknet-contract"] || [];
        const configCandidates = contractTargetConfigs.filter(
            (config) => !config.name || config.name === packageName
        );

        if (configCandidates.length === 0) {
            throw new ScarbConfigValidationError(
                tomlPath,
                "Property 'name' of [[target.starknet-contract]] must be left out or equal the [package] name"
            );
        } else if (configCandidates.length > 1) {
            // this case is handled by Scarb
        }

        const contractTargetConfig = configCandidates[0]; // assume length = 1
        if (!contractTargetConfig || !contractTargetConfig.sierra || !contractTargetConfig.casm) {
            throw new ScarbConfigValidationError(
                tomlPath,
                "To allow later loading of this project's contracts, " +
                    "your TOML file must set 'sierra' and 'casm' to `true` under [[target.starknet-contract]]"
            );
        }
    }
    return config;
}

function loadScarbMainArtifact(scarbArtifactDirPath: string, packageName: string) {
    const mainPackageArtifactPath = path.join(
        scarbArtifactDirPath,
        `${packageName}.starknet_artifacts.json`
    );
    if (!fs.existsSync(mainPackageArtifactPath)) {
        const msg = `Error in building ${packageName}, could not find ${mainPackageArtifactPath}`;
        throw new StarknetPluginError(msg);
    }
    return JSON.parse(fs.readFileSync(mainPackageArtifactPath, "utf-8").toString());
}

async function findPackageConfigPaths(
    traversablePaths: string[],
    root: string,
    configFileName = "Scarb.toml"
) {
    // collect all package configs by traversing provided paths
    const packageConfigPaths: string[] = [];
    for (let traversablePath of traversablePaths) {
        traversablePath = adaptPath(root, traversablePath);
        checkSourceExists(traversablePath);
        const traversionResult = await traverseFiles(traversablePath, configFileName);
        packageConfigPaths.push(
            ...traversionResult.filter((p) => path.basename(p) == configFileName)
        );
    }

    if (!packageConfigPaths.length) {
        const msg = `No projects to build. Could not find directories containing ${configFileName}`;
        throw new StarknetPluginError(msg);
    }

    return packageConfigPaths;
}

export async function starknetCompileCairo1Action(
    args: TaskArguments,
    hre: HardhatRuntimeEnvironment
) {
    const binDirPath = getCompilerBinDir(args, hre.config.starknet);

    const root = hre.config.paths.root;
    const rootRegex = new RegExp("^" + root);

    const defaultSourcesPath = hre.config.paths.starknetSources;
    const sourcesPaths: string[] = args.paths || [defaultSourcesPath];
    const artifactsPath = hre.config.paths.starknetArtifacts;

    let statusCode = 0;
    for (let sourcesPath of sourcesPaths) {
        sourcesPath = adaptPath(root, sourcesPath);
        checkSourceExists(sourcesPath);

        const recompiler = new Recompiler(hre);
        const files = await traverseFiles(sourcesPath, "*.cairo");
        for (const file of files) {
            console.log("Compiling", file);

            const dirSuffix = file.replace(rootRegex, "");
            const fileName = getFileName(dirSuffix);
            const dirPath = path.join(artifactsPath, dirSuffix);
            const outputPath = path.join(dirPath, `${fileName}${CAIRO1_SIERRA_SUFFIX}`);

            fs.mkdirSync(dirPath, { recursive: true });
            initializeFile(outputPath);

            // Compile to sierra representation
            {
                const executed = await hre.starknetWrapper.compileCairoToSierra({
                    path: file,
                    output: outputPath,
                    binDirPath,
                    replaceIds: args.replaceIds,
                    allowedLibfuncsListName: args.allowedLibfuncsListName,
                    allowedLibfuncsListFile: args.allowedLibfuncsListFile,
                    singleFile: args.singleFile
                });
                statusCode += processExecuted(executed, true);

                if (executed.statusCode) {
                    // continue with compiling to casm only if compiling to sierra succeeded
                    continue;
                }
            }

            // Copy abi array from output to abiOutput
            const abiOutput = path.join(dirPath, `${fileName}${ABI_SUFFIX}`);
            initializeFile(abiOutput);

            const outputJson = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
            fs.writeFileSync(abiOutput, JSON.stringify(outputJson.abi) + "\n");

            const casmOutput = path.join(dirPath, `${fileName}${CAIRO1_ASSEMBLY_SUFFIX}`);
            initializeFile(casmOutput);

            // Compile sierra to casm representation
            {
                const executed = await hre.starknetWrapper.compileSierraToCasm({
                    file: outputPath,
                    output: casmOutput,
                    binDirPath,
                    addPythonicHints: args.addPythonicHints,
                    allowedLibfuncsListName: args.allowedLibfuncsListName,
                    allowedLibfuncsListFile: args.allowedLibfuncsListFile
                });
                statusCode += processExecuted(executed, true);
            }

            // Update cache after compilation
            await recompiler.updateCache(args, file, outputPath, abiOutput);
        }
        await recompiler.saveCache();
    }

    if (statusCode) {
        const msg = `Failed compilation of ${statusCode} contract${statusCode === 1 ? "" : "s"}.`;
        throw new StarknetPluginError(msg);
    }
}

export async function starknetDeprecatedCompileAction(
    args: TaskArguments,
    hre: HardhatRuntimeEnvironment
) {
    const root = hre.config.paths.root;
    const rootRegex = new RegExp("^" + root);

    const defaultSourcesPath = hre.config.paths.starknetSources;
    const sourcesPaths: string[] = args.paths || [defaultSourcesPath];
    const artifactsPath = hre.config.paths.starknetArtifacts;

    const cairoPaths = [defaultSourcesPath, root];
    if (args.cairoPath) {
        args.cairoPath.split(":").forEach((path: string) => {
            cairoPaths.push(path);
        });
    }
    if (hre.config.paths.cairoPaths) {
        hre.config.paths.cairoPaths.forEach((path: string) => {
            cairoPaths.push(path);
        });
    }
    for (let i = 0; i < cairoPaths.length; i++) {
        if (!path.isAbsolute(cairoPaths[i])) {
            cairoPaths[i] = adaptPath(root, cairoPaths[i]);
        }
    }

    const cairoPath = cairoPaths.join(":");
    let statusCode = 0;
    for (let sourcesPath of sourcesPaths) {
        sourcesPath = adaptPath(root, sourcesPath);
        checkSourceExists(sourcesPath);
        const files = await traverseFiles(sourcesPath, "*.cairo");
        const recompiler = new Recompiler(hre);
        for (const file of files) {
            console.log("Compiling", file);
            const dirSuffix = file.replace(rootRegex, "");
            const fileName = getFileName(dirSuffix);
            const dirPath = path.join(artifactsPath, dirSuffix);
            const outputPath = path.join(dirPath, `${fileName}.json`);
            const abiPath = path.join(dirPath, `${fileName}${ABI_SUFFIX}`);

            fs.mkdirSync(dirPath, { recursive: true });
            initializeFile(outputPath);
            initializeFile(abiPath);

            const executed = await hre.starknetWrapper.deprecatedCompile({
                file,
                output: outputPath,
                abi: abiPath,
                cairoPath,
                accountContract: args.accountContract,
                disableHintValidation: args.disableHintValidation
            });

            // Update cache after compilation
            await recompiler.updateCache(args, file, outputPath, abiPath, cairoPath);
            statusCode += processExecuted(executed, true);
        }
        await recompiler.saveCache();
    }

    if (statusCode) {
        const msg = `Failed compilation of ${statusCode} contract${statusCode === 1 ? "" : "s"}.`;
        throw new StarknetPluginError(msg);
    }
}

export async function starknetBuildAction(args: TaskArguments, hre: HardhatRuntimeEnvironment) {
    const root = hre.config.paths.root;
    const rootRegex = new RegExp("^" + root);

    const defaultSourcesPath = hre.config.paths.starknetSources;
    const traversablePaths: string[] = args.paths || [defaultSourcesPath];
    const packageConfigPaths = await findPackageConfigPaths(traversablePaths, root);

    const artifactsPath = hre.config.paths.starknetArtifacts;

    const scarbWrapper = ScarbWrapper.getInstance(args, hre);

    let statusCode = 0;
    for await (const packageConfigPath of packageConfigPaths) {
        // each config path is assumed to be of format $hardhat_project_root/<CAIRO_DIR>/Scarb.toml
        let packageConfig = null;
        try {
            packageConfig = loadScarbTomlFromPath(packageConfigPath, !args.skipValidate);
        } catch (error) {
            console.error(error);
            statusCode += 1;
            continue;
        }
        const packageName = packageConfig.package.name;

        // strip "Scarb.toml" from path end to get $hardhat_project_root/<CAIRO_DIR>/
        const packageDir = path.dirname(packageConfigPath);
        console.log(`Building package ${packageName} from ${packageDir}`);

        // not using path.basename(...) because it could be a more complex path than just the directory name
        const dirSuffix = packageDir.replace(rootRegex, ""); // <CAIRO_DIR>/
        const artifactDirPath = path.join(artifactsPath, dirSuffix); // starknet-artifacts/<CAIRO_DIR>/

        const executed = scarbWrapper.build(packageConfigPath, artifactDirPath);
        statusCode += processExecuted(executed, true);
        if (executed.statusCode) {
            // continue with compiling to casm only if compiling to sierra succeeded
            continue;
        }

        // by default (dev mode, unlike the release mode), scarb stores artifacts in subdir "dev"
        const scarbArtifactDirPath = path.join(artifactDirPath, "dev");

        // load scarb's main build artifact
        const mainPackageArtifact = loadScarbMainArtifact(scarbArtifactDirPath, packageName);

        for (const contractEntry of mainPackageArtifact.contracts) {
            // package_contract (underscore separation)
            const fileName = `${contractEntry.package_name}_${contractEntry.contract_name}`;

            // artifact dir created by us, not the one created by scarb
            const ourArtifactDirPath = path.join(artifactDirPath, `${fileName}.cairo`);
            fs.mkdirSync(ourArtifactDirPath, { recursive: true });

            // We want to create artifacts compatible with our contract loading mechanisms.
            // To achieve this, we will now copy scarb artifacts

            // this is false if user skipped validation
            if (contractEntry.artifacts.sierra) {
                const scarbSierraPath = path.join(
                    scarbArtifactDirPath,
                    contractEntry.artifacts.sierra
                );
                const ourSierraPath = path.join(
                    ourArtifactDirPath,
                    `${fileName}${CAIRO1_SIERRA_SUFFIX}`
                );
                fs.copyFileSync(scarbSierraPath, ourSierraPath);

                // Copy abi array from output to abiOutput
                const abiOutput = path.join(ourArtifactDirPath, `${fileName}${ABI_SUFFIX}`);
                initializeFile(abiOutput);

                const outputJson = JSON.parse(fs.readFileSync(scarbSierraPath, "utf-8"));
                fs.writeFileSync(abiOutput, JSON.stringify(outputJson.abi) + "\n");
            }

            // this is false if user skipped validation
            if (contractEntry.artifacts.casm) {
                const scarbCasmPath = path.join(scarbArtifactDirPath, contractEntry.artifacts.casm);
                const ourCasmPath = path.join(
                    ourArtifactDirPath,
                    `${fileName}${CAIRO1_ASSEMBLY_SUFFIX}`
                );
                fs.copyFileSync(scarbCasmPath, ourCasmPath);
            }
        }
    }

    if (statusCode) {
        const msg = `Failed building of ${statusCode} project${statusCode === 1 ? "" : "s"}.`;
        throw new StarknetPluginError(msg);
    }
}

export async function amarnaAction(args: TaskArguments, hre: HardhatRuntimeEnvironment) {
    await hre.amarnaDocker.run(args);
}

/**
 * Extracts the verification URL assigned to the network provided.
 * If no `networkName` is provided, defaults to Alpha testnet.
 * If `networkName` is provided, but not supported for verification, an error is thrown.
 * @param networkName the name of the network
 * @param hre the runtime environment from which network data is extracted
 * @param origin short string describing where/how `networkName` was specified
 */
function getVerificationNetwork(
    networkName: string,
    hre: HardhatRuntimeEnvironment,
    origin: string
) {
    networkName ||= ALPHA_TESTNET;
    const network = getNetwork<HttpNetworkConfig>(networkName, hre.config.networks, origin);
    if (!network.verificationUrl) {
        throw new StarknetPluginError(
            `Network ${networkName} does not support Voyager verification.`
        );
    }
    return network;
}

export async function starknetVoyagerAction(args: TaskArguments, hre: HardhatRuntimeEnvironment) {
    const network = getVerificationNetwork(args.starknetNetwork, hre, "--starknet-network");
    const voyagerUrl = `${network.verificationUrl}${args.address}/code`;
    const verifiedUrl = `${network.verifiedUrl}${args.address}#code`;

    let isVerified = false;
    try {
        const resp = await axios.get(voyagerUrl);
        const data = resp.data;

        if (data.contract) {
            if (data.contract.length > 0 || Object.keys(data.contract).length > 0) {
                isVerified = true;
            }
        }
    } catch (error) {
        const msg =
            "Something went wrong while checking if the contract has already been verified.";
        throw new StarknetPluginError(msg);
    }

    if (isVerified) {
        console.log(`Contract at address ${args.address} has already been verified`);
        console.log(`Check it out on Voyager: ${verifiedUrl}`);
    } else {
        await handleContractVerification(args, voyagerUrl, verifiedUrl, hre);
    }
}

function getMainVerificationPath(contractPath: string, root: string) {
    if (!path.isAbsolute(contractPath)) {
        contractPath = adaptPath(root, contractPath);
        if (!fs.existsSync(contractPath)) {
            throw new StarknetPluginError(`File ${contractPath} does not exist`);
        }
    }
    return contractPath;
}

async function handleContractVerification(
    args: TaskArguments,
    voyagerUrl: string,
    verifiedUrl: string,
    hre: HardhatRuntimeEnvironment
) {
    // Set main contract path
    const mainPath = getMainVerificationPath(args.path, hre.config.paths.root);
    const paths = [mainPath];

    const bodyFormData = new FormData();
    bodyFormData.append("compiler-version", args.compilerVersion);
    const accountContract = args.accountContract ? "true" : "false";
    bodyFormData.append("account-contract", accountContract);
    bodyFormData.append("license", args.license || "No License (None)");

    // Dependencies (non-main contracts) are in args.paths
    if (args.paths) {
        paths.push(...args.paths);
    }

    const sourceRegex = new RegExp("^" + hre.config.paths.starknetSources + "/");
    const contractNameDefault = mainPath.replace(sourceRegex, "");
    // If contract name is not provided, use the default
    bodyFormData.append("contract-name", contractNameDefault);
    // Appends all contracts to the form data with the name "file" + index
    handleMultiPartContractVerification(bodyFormData, paths, hre.config.paths.root, sourceRegex);

    await axios
        .post(voyagerUrl, bodyFormData.getBuffer(), {
            headers: bodyFormData.getHeaders()
        })
        .catch((err) => {
            throw new StarknetPluginError(
                `\
Could not verify the contract at address ${args.address}.
${
    err.response.data.message ||
    `It is hard to tell exactly what happened, but possible reasons include:
- Deployment transaction hasn't been accepted or indexed yet (check its tx_status or try in a minute)
- Wrong contract address
- Wrong files provided
- Wrong main contract chosen (first after --path)
- Voyager is down`
}
            `
            );
        });

    console.log(`Contract has been successfully verified at address ${args.address}`);
    console.log(`Check it out on Voyager: ${verifiedUrl}`);
}

function handleMultiPartContractVerification(
    bodyFormData: FormData,
    paths: string[],
    root: string,
    sourceRegex: RegExp
) {
    paths.forEach(function (item: string, index: number) {
        if (!path.isAbsolute(item)) {
            paths[index] = adaptPath(root, item);
            if (!fs.existsSync(paths[index])) {
                throw new StarknetPluginError(`File ${paths[index]} does not exist`);
            }
        }
        bodyFormData.append("file" + index, fs.readFileSync(paths[index]), {
            filepath: paths[index].replace(sourceRegex, ""),
            contentType: "application/octet-stream"
        });
    });
}

/**
 * Used later on for network interaction.
 * @param args Hardhat CLI args
 * @param hre HardhatRuntimeEnvironment
 */
function setRuntimeNetwork(args: TaskArguments, hre: HardhatRuntimeEnvironment) {
    let networkName;
    let networkConfig: HardhatNetworkConfig;
    if (args.starknetNetwork) {
        networkName = args.starknetNetwork;
        networkConfig = getNetwork(networkName, hre.config.networks, "--starknet-network");
    } else if (hre.config.starknet.network) {
        networkName = hre.config.starknet.network;
        networkConfig = getNetwork(
            networkName,
            hre.config.networks,
            "starknet.network in hardhat.config"
        );
    } else {
        networkName = DEFAULT_STARKNET_NETWORK;
        networkConfig = getNetwork(networkName, hre.config.networks, "default settings");
    }

    hre.starknet.network = networkName;
    hre.starknet.networkConfig = networkConfig;

    hre.starknetJs.setProvider(hre.starknet.networkConfig);

    console.log(`Using network ${hre.starknet.network} at ${hre.starknet.networkConfig.url}`);
}

async function runWithDevnet(hre: HardhatRuntimeEnvironment, fn: () => Promise<unknown>) {
    if (!isStarknetDevnet(hre.starknet.network)) {
        await fn();
        return;
    }

    const devnet = createIntegratedDevnet(hre);

    await devnet.start();
    await fn();
    devnet.stop();
}

export async function starknetTestAction(
    args: TaskArguments,
    hre: HardhatRuntimeEnvironment,
    runSuper: RunSuperFunction<TaskArguments>
) {
    setRuntimeNetwork(args, hre);
    await new Recompiler(hre).handleCache();

    await runWithDevnet(hre, async () => {
        await runSuper(args);
    });
}

export async function starknetRunAction(
    args: TaskArguments,
    hre: HardhatRuntimeEnvironment,
    runSuper: RunSuperFunction<TaskArguments>
) {
    if (args.starknetNetwork) {
        throw new StarknetPluginError(`Using "--starknet-network" with "hardhat run" currently does not have effect.
Use the "network" property of the "starknet" object in your hardhat config file.`);
    }
    setRuntimeNetwork(args, hre);
    await new Recompiler(hre).handleCache();

    await runWithDevnet(hre, async () => {
        await runSuper(args);
    });
}

export async function starknetPluginVersionAction() {
    console.log(`Version: ${version}`);
}

export async function starknetMigrateAction(args: TaskArguments, hre: HardhatRuntimeEnvironment) {
    if (!args.paths || args.paths.length < 1) {
        throw new StarknetPluginError("Expected at least one file to migrate");
    }

    const root = hre.config.paths.root;
    const defaultSourcesPath = hre.config.paths.starknetSources;
    const files: string[] = args.paths || [defaultSourcesPath];
    const cairoFiles: string[] = [];
    for (let file of files) {
        file = adaptPath(root, file);
        cairoFiles.push(file);
    }

    const result = await hre.starknetWrapper.migrateContract({
        files: cairoFiles,
        inplace: args.inplace
    });

    processExecuted(result, true);
}
