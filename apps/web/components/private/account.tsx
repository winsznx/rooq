"use client";

import { useEffect, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, useSignMessage, useSwitchChain, useWalletClient } from "wagmi";
import { CHAIN_CONFIG } from "@/lib/env";
import { Dialog } from "@/components/feedback/dialog";
import { setHideValues } from "@/lib/preferences";
import { ACCOUNT_MESSAGE } from "@/lib/private/account";
import { closeAccountSheet, usePrivate, wallet, WalletError } from "@/lib/private/client";
import { createPasskey, passkeysAvailable, PasskeyUnsupported, assertPasskey as readPasskey } from "@/lib/private/passkey";
import { styles } from "./kit";

const IDLE_LOCK_MS = 15 * 60_000;

const EXPLAIN = "Nothing to write down. Whoever controls this wallet controls this private account, so only sign on Rooq.";

/** Keeps the worker's account tied to the connected wallet: disconnect clears keys, a switch opens the other wallet's account. */
export function WalletLink() {
  const { address } = useAccount();
  useEffect(() => {
    void wallet.setWallet(address?.toLowerCase() ?? null);
  }, [address]);
  return null;
}

export function LockWatcher() {
  const { status, ops } = usePrivate();
  const busy = ops.some((o) => ["preparing_proof", "queued", "submitted", "included", "waiting", "rechecking"].includes(o.stage));
  useEffect(() => {
    if (status !== "unlocked" || busy) return;
    let timer = window.setTimeout(() => void wallet.lock(), IDLE_LOCK_MS);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void wallet.lock(), IDLE_LOCK_MS);
    };
    window.addEventListener("keydown", reset);
    window.addEventListener("pointerdown", reset);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", reset);
      window.removeEventListener("pointerdown", reset);
    };
  }, [status, busy]);
  return null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** Connect, sign, continue. Opens over whatever the person was doing, so their inputs stay where they left them. */
export function AccountSheet() {
  const { address } = useAccount();
  return <Sheet key={address ?? "none"} address={address} />;
}

function Sheet({ address }: { address: string | undefined }) {
  const { status, remembered, verified, sheetOpen } = usePrivate();
  const { openConnectModal, connectModalOpen } = useConnectModal();
  const { signMessageAsync } = useSignMessage();
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonDeterministic, setNonDeterministic] = useState(false);
  const [showPasskey, setShowPasskey] = useState(false);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      if (!verified) setHideValues(true);
    } catch (err) {
      const rejected = err instanceof Error && (err.name === "UserRejectedRequestError" || /rejected|denied/i.test(err.message));
      if (!rejected) console.warn("rooq: account step failed", err);
      setError(rejected ? "You declined in your wallet. Nothing changed." : err instanceof WalletError ? err.message : `Your wallet couldn't complete this: ${walletDetail(err)}. Nothing changed.`);
      if (err instanceof WalletError && err.reason === "NON_DETERMINISTIC") setNonDeterministic(true);
    } finally {
      setBusy(null);
    }
  };

  const sign = () =>
    run("Waiting for your wallet", async () => {
      if (chainId !== CHAIN_CONFIG.chainId) {
        setBusy(`Switching your wallet to ${CHAIN_CONFIG.name}`);
        await switchChainAsync({ chainId: CHAIN_CONFIG.chainId });
        setBusy("Waiting for your wallet");
      }
      // A remembered connection can outlive the wallet's permission for this site. Asking again is instant when it still holds.
      if (walletClient) {
        const granted = await walletClient.requestAddresses();
        if (!granted.some((a) => a.toLowerCase() === address?.toLowerCase())) {
          throw new WalletError("ACCOUNT_NOT_AUTHORIZED", "Your wallet didn't share this account with Rooq. Pick it in your wallet and try again.");
        }
      }
      const first = await signMessageAsync({ message: ACCOUNT_MESSAGE });
      if (verified) {
        await wallet.openSigned(address!, first);
        return;
      }
      setBusy("Signing again to check this wallet");
      const second = await signMessageAsync({ message: ACCOUNT_MESSAGE });
      await wallet.openSignedTwice(address!, first, second);
    });

  const passkeyAccount = (create: boolean) =>
    run("Waiting for your passkey", async () => {
      const r = create ? await createPasskey(`Rooq ${address?.slice(0, 8)}`, "seed") : await readPasskey(null, "seed");
      await wallet.openPasskey(address!, r.output);
    });

  const unlockRemembered = () =>
    run("Unlocking", async () => {
      const output = remembered?.method === "passkey" ? (await readPasskey(remembered.credentialId, "remember")).output : null;
      await wallet.unlockRemembered(address!, output);
    });

  const title = status === "no_wallet" ? "Connect a wallet" : status === "unlock" ? "Unlock your private account" : "Open your private account";
  const showFallback = status === "sign" && (nonDeterministic || showPasskey);

  return (
    <Dialog open={sheetOpen && !connectModalOpen} onOpenChange={(o) => { if (!o) closeAccountSheet(); }} title={title} description={EXPLAIN} width={460}>
      <div className={styles.stack} data-testid="account-sheet">
        {status === "no_wallet" ? (
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => openConnectModal?.()}>Connect wallet</button>
        ) : null}
        {status === "unlock" ? (
          <>
            <button type="button" className="btn btn-primary btn-lg btn-block" disabled={busy !== null} onClick={() => void unlockRemembered()}>
              {busy ?? (remembered?.method === "passkey" ? "Unlock with passkey" : "Unlock on this device")}
            </button>
            <button type="button" className="btn btn-block" disabled={busy !== null} onClick={() => void sign()}>Sign with wallet instead</button>
          </>
        ) : null}
        {status === "sign" && !showFallback ? (
          <>
            <button type="button" className="btn btn-primary btn-lg btn-block" disabled={busy !== null} onClick={() => void sign()}>{busy ?? "Sign to continue"}</button>
            {!verified ? <p className={styles.hint}>Your wallet asks twice, once to sign and once to check it signs the same way. It costs nothing.</p> : null}
          </>
        ) : null}
        {status === "sign" && nonDeterministic ? <p className="notice" data-tone="warning" role="alert">This wallet signed the same message two different ways, so it can&apos;t hold a stable private account. Use a passkey instead.</p> : null}
        {showFallback ? (
          passkeysAvailable() ? (
            <>
              <button type="button" className="btn btn-block" disabled={busy !== null} onClick={() => void passkeyAccount(true)}>Create a passkey account</button>
              <button type="button" className="btn btn-block" disabled={busy !== null} onClick={() => void passkeyAccount(false)}>Use an existing passkey</button>
            </>
          ) : (
            <p className="notice" role="alert">This browser has no passkeys. Use a browser that does, or a wallet that signs the same way each time.</p>
          )
        ) : null}
        {status === "sign" && !showFallback ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowPasskey(true)}>Use a passkey instead</button> : null}
        {error ? <p className="field-error" role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}

export function DeviceLoss() {
  return <p className={styles.note}>Lost this device? Connect the same wallet on any browser and sign again. Your account rebuilds from chain data. Whoever controls this wallet controls this private account.</p>;
}

let rememberDismissed = false;

/** Optional, after the account opens. Passkey where PRF works, otherwise a device key this browser can't export. */
export function RememberCard() {
  const { status, remembered } = usePrivate();
  const [hidden, setHidden] = useState(rememberDismissed);
  const [note, setNote] = useState<string | null>(null);
  const [supported, setSupported] = useState(() => passkeysAvailable());
  if (status !== "unlocked" || remembered || hidden) return null;
  const withPasskey = async () => {
    try {
      const r = await createPasskey("Rooq device unlock", "remember");
      await wallet.rememberPasskey(r.output, r.credentialId);
    } catch (error) {
      if (error instanceof PasskeyUnsupported) setSupported(false);
      setNote(error instanceof PasskeyUnsupported ? "This browser doesn't support passkey unlock. You can use this device's key instead." : "The passkey didn't complete.");
    }
  };
  return (
    <section className={styles.card} aria-label="Remember this device">
      <h2 className={styles.cardTitle}>Remember this device</h2>
      <p className={styles.note}>Unlock here next time without signing. Your account stays encrypted on this device and never leaves it.</p>
      <div className={styles.row}>
        {supported ? <button type="button" className="btn btn-sm btn-primary" onClick={() => void withPasskey()}>Use a passkey</button> : null}
        <button type="button" className="btn btn-sm" onClick={() => void wallet.rememberDevice()}>Use this device&apos;s key</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => { rememberDismissed = true; setHidden(true); }}>Not now</button>
      </div>
      {note ? <p className="notice" role="status">{note}</p> : null}
    </section>
  );
}

export function AccountSettings() {
  const { status, remembered } = usePrivate();
  if (status === "checking" || status === "no_wallet") return null;
  return (
    <section className={styles.card} aria-label="Private account">
      <h2 className={styles.cardTitle}>Private account</h2>
      <p className={styles.note}>{EXPLAIN} Locks automatically after 15 minutes without activity, unless an operation is running. Disconnecting or switching your wallet locks it too.</p>
      <div className={styles.row}>
        {status === "unlocked" ? <button type="button" className="btn" onClick={() => void wallet.lock()}>Lock now</button> : null}
        {remembered ? <button type="button" className="btn btn-ghost" onClick={() => void wallet.forgetRemembered()}>Forget this device</button> : null}
      </div>
      <RememberCard />
      <DeviceLoss />
    </section>
  );
}

/** The wallet's own short reason, so a failure says what actually went wrong. */
function walletDetail(err: unknown): string {
  if (err instanceof Error) {
    const short = "shortMessage" in err && typeof err.shortMessage === "string" ? err.shortMessage : err.message;
    return short.split("\n")[0]!.replace(/\.$/, "").slice(0, 140);
  }
  return "unknown error";
}
