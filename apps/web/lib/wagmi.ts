import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet, rabbyWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { mock } from "wagmi/connectors";
import { CHAIN, LOCAL_TEST_WALLET, RPC_URL } from "./env";

/** anvil's first ten unlocked dev accounts. Only reachable when LOCAL_TEST_WALLET is on. */
const ANVIL_ACCOUNTS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
] as const;

function localAccount(): (typeof ANVIL_ACCOUNTS)[number] {
  const index = Number(process.env.NEXT_PUBLIC_LOCAL_TEST_ACCOUNT ?? 2);
  return ANVIL_ACCOUNTS[index] ?? ANVIL_ACCOUNTS[2];
}

/** Injected wallets only. A WalletConnect wallet would need a third-party relay in the page that handles keys. */
const walletConnectors = connectorsForWallets([{ groupName: "Wallets", wallets: [injectedWallet, rabbyWallet] }], { appName: "Rooq", projectId: "rooq-injected-wallets-only" });

export const wagmiConfig = createConfig({
  chains: [CHAIN],
  connectors: [...walletConnectors, ...(LOCAL_TEST_WALLET ? [mock({ accounts: [localAccount()], features: { reconnect: true } })] : [])],
  transports: { [CHAIN.id]: http(RPC_URL, { timeout: 5_000, retryCount: 1 }) },
  ssr: true,
  pollingInterval: 2_000,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
