"use client";

import { useState } from "react";
import { useAccount, useDisconnect, useSwitchChain } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { shortAddress } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { CHAIN, CHAIN_CONFIG, ENV, ENV_LABEL } from "@/lib/env";
import { Dialog } from "./feedback/dialog";
import { Warning } from "./icons";

export function useWalletState() {
  const { address, chainId, isConnected, status } = useAccount();
  return {
    address,
    isConnected,
    status,
    wrongChain: isConnected && chainId !== CHAIN.id,
    chainId,
  };
}

const networkBody = ENV === "testnet" ? copy.connect.wrongChainBody : `Rooq is running on ${ENV_LABEL[ENV].toLowerCase()}.`;

/** AC02. Explicit switch; never silent. */
export function NetworkDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { chainId } = useAccount();
  const { switchChain, status, error } = useSwitchChain();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={copy.connect.wrongChainTitle} description={networkBody} width={440}>
      <dl className="facts">
        <div>
          <dt>Current network</dt>
          <dd>{chainId ?? "—"}</dd>
        </div>
        <div>
          <dt>Required network</dt>
          <dd>
            {CHAIN_CONFIG.name}
            <span className="sub">Chain ID {CHAIN.id}</span>
          </dd>
        </div>
      </dl>
      <div className="stack" style={{ marginTop: 16, "--gap": "8px" } as React.CSSProperties}>
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={status === "pending"} onClick={() => switchChain({ chainId: CHAIN.id }, { onSuccess: () => onOpenChange(false) })}>
          {status === "pending" ? "Waiting for wallet" : copy.connect.switch}
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={() => onOpenChange(false)}>
          {copy.connect.cancel}
        </button>
        {error ? (
          <p className="field-error" role="alert">
            <Warning size={16} />
            {error.name === "UserRejectedRequestError" ? copy.errors.signatureRejected : "Your wallet could not switch networks. Add the network manually with the details above."}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

export function WalletButton({ compact = false }: { compact?: boolean }) {
  const { address, isConnected, wrongChain } = useWalletState();
  const { disconnect } = useDisconnect();
  const { openConnectModal } = useConnectModal();
  const [networkOpen, setNetworkOpen] = useState(false);
  if (!isConnected || !address) {
    return (
      <button type="button" className="btn btn-primary" aria-label={copy.connect.action} onClick={() => openConnectModal?.()}>
        {compact ? "Connect" : copy.connect.action}
      </button>
    );
  }
  if (wrongChain) {
    return (
      <>
        <button type="button" className="btn" style={{ "--btn-fg": "var(--rq-warning)" } as React.CSSProperties} onClick={() => setNetworkOpen(true)}>
          <Warning size={16} />
          {copy.connect.wrongChainTitle}
        </button>
        <NetworkDialog open={networkOpen} onOpenChange={setNetworkOpen} />
      </>
    );
  }
  return (
    <button type="button" className="btn" onClick={() => disconnect()} title="Disconnect wallet" aria-label={`Connected ${address}. Disconnect`}>
      <span className="num">{shortAddress(address)}</span>
    </button>
  );
}

/** The single next step a disconnected or wrong-network user must take before acting. */
export function WalletGate({ children }: { children: React.ReactNode }) {
  const { isConnected, wrongChain } = useWalletState();
  const { openConnectModal } = useConnectModal();
  const [networkOpen, setNetworkOpen] = useState(false);
  if (!isConnected) {
    return (
      <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => openConnectModal?.()}>
        {copy.connect.action}
      </button>
    );
  }
  if (wrongChain) {
    return (
      <>
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => setNetworkOpen(true)}>
          {copy.connect.switch}
        </button>
        <NetworkDialog open={networkOpen} onOpenChange={setNetworkOpen} />
      </>
    );
  }
  return <>{children}</>;
}
