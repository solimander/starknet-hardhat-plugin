import path from "path";
import { hardhatStarknetCompileDeprecated, hardhatStarknetTest } from "../../utils/cli-functions";
import { deployFundedAccount } from "../../utils/deploy-funded-account";
import { ensureEnvVar } from "../../utils/utils";

const home = ensureEnvVar("HOME");

const accountDir = path.join(home, ".starknet_accounts_wallet_test");
process.env.ACCOUNT_DIR = accountDir;

hardhatStarknetCompileDeprecated(["contracts/contract.cairo"]);

(async () => {
    await deployFundedAccount();
    hardhatStarknetTest("--no-compile test/wallet-test.ts".split(" "));
})();
