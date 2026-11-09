"use client";

import { useEffect, useRef } from "react";
import { useWalletClient } from "wagmi";
import { parseAbi, type Abi, type Hex } from "viem";
import { CHAIN } from "@/lib/env";
import { usePrivate, wallet } from "@/lib/private/client";

const SPEND_ABI: Abi = parseAbi([
  "struct SpendPublic { bytes32 root; bytes32[2] nullifiers; bytes32[3] commitments; bytes32[7][3] ciphertexts; address publicAsset; uint256 withdrawAmount; address withdrawRecipient; address relayer; uint256 relayerFee; }",
  "function spend(bytes proof, SpendPublic p)",
]);

interface SpendInputs {
  readonly withdrawAmount: string;
  readonly relayerFee: string;
  readonly [key: string]: unknown;
}

/** Sends the one private action a person can choose to pay for themselves: the emergency unshield. Nothing else signs here. */
export function WalletTxBridge() {
  const { ops, view } = usePrivate();
  const { data: client } = useWalletClient();
  const claimed = useRef(new Set<string>());
  useEffect(() => {
    const pending = ops.find((o) => o.walletCall !== null && !claimed.current.has(o.id));
    if (!pending || !client || !view) return;
    claimed.current.add(pending.id);
    const call = pending.walletCall!;
    const p = call.publicInputs as SpendInputs;
    void (async () => {
      try {
        const hash: Hex = await client.writeContract({ address: view.pool, abi: SPEND_ABI, functionName: "spend", args: [call.proof, { ...p, withdrawAmount: BigInt(p.withdrawAmount), relayerFee: BigInt(p.relayerFee) }], chain: CHAIN });
        await wallet.walletTxSent(pending.id, hash);
      } catch (error) {
        const rejected = error instanceof Error && error.name === "UserRejectedRequestError";
        await wallet.walletTxFailed(pending.id, rejected ? "USER_REJECTED" : "WALLET_FAILED", rejected ? "You declined this in your wallet. Nothing was sent." : "Your wallet couldn't send this transaction.");
      }
    })();
  }, [ops, client, view]);
  return null;
}
