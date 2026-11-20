"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BaseError, UserRejectedRequestError } from "viem";
import { useSignMessage } from "wagmi";
import { copy } from "@rooq/ui";
import type { AdminErrorBody } from "@/lib/admin/api";
import { adminSiweMessage } from "@/lib/admin/siwe";
import { CHAIN } from "@/lib/env";
import { Warning } from "../icons";
import { WalletButton, WalletGate, useWalletState } from "../wallet";

class SignInError extends Error {
  override readonly name = "SignInError";
}

/** Sign-in with Ethereum for the owner console. Switching wallets remounts the form, so a stale error never carries over. */
export function AdminSignIn(): React.JSX.Element {
  const { address } = useWalletState();
  return <SignInForm key={address ?? "none"} address={address} />;
}

function SignInForm({ address }: { address: `0x${string}` | undefined }): React.JSX.Element {
  const router = useRouter();
  const { signMessageAsync } = useSignMessage();
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, startOpening] = useTransition();
  const busy = step !== null || opening;

  const signIn = async (signer: `0x${string}`): Promise<void> => {
    setError(null);
    try {
      setStep("Preparing sign-in");
      const nonce = await requestNonce();
      setStep("Waiting for your wallet");
      const message = adminSiweMessage({ address: signer, origin: window.location.origin, chainId: CHAIN.id, nonce, now: new Date() });
      const signature = await signMessageAsync({ account: signer, message });
      setStep("Checking the signature");
      await verify(message, signature);
      startOpening(() => {
        setStep(null);
        router.refresh();
      });
    } catch (err) {
      if (!(err instanceof SignInError) && !isRejection(err)) console.warn("rooq admin: sign-in failed", err);
      setError(describe(err));
      setStep(null);
    }
  };

  return (
    <section className="panel panel-pad stack" style={{ width: "100%", maxWidth: 420, "--gap": "20px" } as React.CSSProperties} aria-labelledby="admin-sign-in-title">
      <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
        <h1 id="admin-sign-in-title" className="t-section">
          Rooq admin
        </h1>
        <p className="muted">Sign in with an owner wallet. Signing proves you hold it. It sends no transaction and costs no gas.</p>
      </div>
      {address ? (
        <div className="row between">
          <span className="muted t-small">Wallet</span>
          <WalletButton compact />
        </div>
      ) : null}
      <WalletGate>
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={busy || !address} aria-busy={busy} onClick={() => address && void signIn(address)}>
          {step ?? (opening ? "Opening admin" : "Sign in")}
        </button>
      </WalletGate>
      {error ? (
        <p className="field-error" role="alert">
          <Warning size={16} />
          {error}
        </p>
      ) : null}
    </section>
  );
}

async function requestNonce(): Promise<string> {
  const res = await call("/admin/api/auth/nonce", { method: "GET" });
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || !("nonce" in body) || typeof body.nonce !== "string") throw new SignInError("Rooq sent an unexpected sign-in request. Try again.");
  return body.nonce;
}

async function verify(message: string, signature: `0x${string}`): Promise<void> {
  await call("/admin/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) });
}

async function call(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new SignInError("Couldn't reach Rooq. Check your connection and try again.");
  }
  if (!res.ok) throw new SignInError(await errorMessage(res));
  return res;
}

/** The admin routes answer with user-facing messages; anything else gets a generic line. */
async function errorMessage(res: Response): Promise<string> {
  const fallback = res.status >= 500 ? "Sign-in is unavailable right now. Try again shortly." : "Sign-in didn't go through. Try again.";
  try {
    const body = (await res.json()) as Partial<AdminErrorBody>;
    return typeof body.message === "string" && body.message ? body.message : fallback;
  } catch {
    return fallback;
  }
}

function isRejection(err: unknown): boolean {
  if (err instanceof BaseError) return err.walk((e) => e instanceof UserRejectedRequestError) !== null;
  return err instanceof Error && err.name === "UserRejectedRequestError";
}

function describe(err: unknown): string {
  if (err instanceof SignInError) return err.message;
  if (isRejection(err)) return copy.errors.signatureRejected;
  return "Your wallet couldn't sign the message. Try again.";
}
