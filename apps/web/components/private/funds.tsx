"use client";

import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { erc20Abi, parseAbi, type Abi, type Hex } from "viem";
import { formatFixed, parseDecimal } from "@rooq/sdk";
import { useTxRunner } from "@/lib/tx";
import { privatePublicClient } from "@/lib/private/public-client";
import { wallet, WalletError } from "@/lib/private/client";
import type { BalanceView, PrivateView, TokenInfo } from "@/lib/private/types";
import { Dialog } from "@/components/feedback/dialog";
import { AmountField } from "@/components/funds/amount-field";
import { Segmented } from "@/components/primitives";
import { TxProgress } from "@/components/feedback/tx-progress";
import { WalletGate } from "@/components/wallet";
import { amountText, Line, PV, styles, TokenLabel, tokenOf, useView } from "./kit";

const SHIELD_ABI = parseAbi(["function shield(address asset, uint256 amount, bytes32 inner) returns (uint256)"]);


function AssetSelect({ tokens, value, onChange }: { tokens: readonly TokenInfo[]; value: Hex; onChange: (v: Hex) => void }) {
  const view = useView();
  return (
    <Segmented<string>
      value={value}
      onChange={(v) => onChange(v as Hex)}
      label="Asset"
      options={tokens.map((t) => ({ value: t.address, label: view ? <TokenLabel view={view} asset={t.address} /> : t.symbol }))}
    />
  );
}

function useFundsTokens(view: PrivateView) {
  return view.tokens;
}

export function ShieldDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const view = useView();
  return view ? <ShieldForm key={String(open)} open={open} onOpenChange={onOpenChange} view={view} /> : null;
}

function ShieldForm({ open, onOpenChange, view }: { open: boolean; onOpenChange: (o: boolean) => void; view: PrivateView }) {
  const { address } = useAccount();
  const tokens = useFundsTokens(view);
  const [asset, setAsset] = useState<Hex>(tokens[0]?.address ?? ("0x0" as Hex));
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const { run, steps, busy, reset } = useTxRunner(privatePublicClient);
  const t = tokenOf(view, asset);
  const amount = parseDecimal(text, t.decimals);

  const go = async () => {
    if (!address || amount === null || amount <= 0n) return;
    setNote(null);
    try {
      const { inner, depositIndex } = await wallet.prepareShield(asset, amount);
      const allowance = await privatePublicClient.readContract({ address: asset, abi: erc20Abi, functionName: "allowance", args: [address, view.pool] });
      const requests = [
        ...(allowance < amount ? [{ label: `Approve ${t.symbol}`, address: asset, abi: erc20Abi as Abi, functionName: "approve", args: [view.pool, amount] as const }] : []),
        { label: `Shield ${formatFixed(amount, t.decimals, 4)} ${t.symbol}`, address: view.pool, abi: SHIELD_ABI as Abi, functionName: "shield", args: [asset, amount, inner] as const },
      ];
      const receipts = await run(requests, { title: `Shield ${t.symbol}`, kind: "funds", icons: [{ asset }] });
      await wallet.shieldFinished(depositIndex, receipts !== null);
      if (receipts) setNote("Shielded. It enters your private balance once the queue is processed, usually within a block or two.");
    } catch (error) {
      setNote(error instanceof WalletError ? error.message : "Your wallet couldn't start this. Check it's connected to the right network.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) { onOpenChange(o); reset(); } }} title="Shield" description="Moves tokens from your public wallet into your private balance. This deposit is public: anyone can see the wallet, the token and the amount." width={460}>
      <div className={styles.stack}>
        <AssetSelect tokens={tokens} value={asset} onChange={setAsset} />
        <AmountField label="Amount" value={text} onChange={setText} decimals={t.decimals} unit={t.symbol} />
        <TxProgress steps={steps} />
        {note ? <p className="notice" role="status">{note}</p> : null}
        <WalletGate>
          <button type="button" className="btn btn-primary btn-block" disabled={busy || amount === null || amount <= 0n} onClick={() => void go()}>
            {busy ? "Check your wallet" : "Shield"}
          </button>
        </WalletGate>
      </div>
    </Dialog>
  );
}

function RelayerFee({ view, asset }: { view: PrivateView; asset: Hex }) {
  const fee = view.relayerFee.find((f) => f.asset.toLowerCase() === asset.toLowerCase())?.amount ?? 0n;
  return <Line label="Relayer fee">{fee === 0n ? "None on this network" : <PV>{amountText(view, asset, fee)}</PV>}</Line>;
}

function feeFor(view: PrivateView, asset: Hex): bigint {
  return view.relayerFee.find((f) => f.asset.toLowerCase() === asset.toLowerCase())?.amount ?? 0n;
}

export function UnshieldDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (o: boolean) => void; initial?: Hex }) {
  const view = useView();
  const { address } = useAccount();
  const [asset, setAsset] = useState<Hex | null>(initial ?? null);
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [directOk, setDirectOk] = useState(false);
  if (!view) return null;
  const relayerDown = !view.health.relayer;
  const a = asset ?? view.balances[0]?.asset ?? view.tokens[0]!.address;
  const t = tokenOf(view, a);
  const amount = parseDecimal(text, t.decimals);
  const recipient = (to || address) as Hex | undefined;
  const fee = relayerDown ? 0n : feeFor(view, a);
  const bal = view.balances.find((b) => b.asset.toLowerCase() === a.toLowerCase());
  const go = async () => {
    if (amount === null || amount <= 0n || !recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) return;
    setError(null);
    if (bal && amount + fee > bal.free) {
      setError("This is more than your private balance.");
      return;
    }
    await wallet.start({ t: "unshield", asset: a, amount, recipient, fee, direct: relayerDown }, `Unshield ${formatFixed(amount, t.decimals, 4)} ${t.symbol}`, "/app/portfolio");
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Unshield" description="Sends tokens from your private balance to a public address. The amount and recipient are public. Your private history and the link to your other activity are not." width={480}>
      <div className={styles.stack}>
        <AssetSelect tokens={view.tokens} value={a} onChange={setAsset} />
        <AmountField label="Amount" value={text} onChange={setText} decimals={t.decimals} unit={t.symbol} balanceLabel="Private balance" balance={bal?.free ?? null} onMax={bal ? () => setText(formatFixed(bal.free - fee > 0n ? bal.free - fee : 0n, t.decimals, t.decimals)) : undefined} />
        <div className="field">
          <label className="field-label" htmlFor="unshield-to"><span>Recipient address</span></label>
          <input id="unshield-to" className="input-text" placeholder={address ?? "0x..."} value={to} onChange={(e) => setTo(e.target.value.trim())} />
        </div>
        {relayerDown ? (
          <label className="notice" data-tone="warning">
            <input type="checkbox" checked={directOk} onChange={(e) => setDirectOk(e.target.checked)} />{" "}
            The relayer can&apos;t be reached. You can still withdraw by paying gas from your own wallet, which publicly links it to this withdrawal.
          </label>
        ) : (
          <RelayerFee view={view} asset={a} />
        )}
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        {relayerDown ? <WalletGate><button type="button" className="btn btn-primary btn-block" disabled={amount === null || amount <= 0n || !recipient || !directOk} onClick={() => void go()}>Withdraw from my wallet</button></WalletGate> : <button type="button" className="btn btn-primary btn-block" disabled={amount === null || amount <= 0n || !recipient} onClick={() => void go()}>Unshield</button>}
      </div>
    </Dialog>
  );
}

export function TransferDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const view = useView();
  const [asset, setAsset] = useState<Hex | null>(null);
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!view) return null;
  const a = asset ?? view.tokens[0]!.address;
  const t = tokenOf(view, a);
  const amount = parseDecimal(text, t.decimals);
  const fee = feeFor(view, a);
  const go = async () => {
    if (amount === null || amount <= 0n || to.trim() === "") return;
    setError(null);
    try {
      await wallet.start({ t: "transfer", asset: a, amount, to: to.trim(), fee }, `Send ${formatFixed(amount, t.decimals, 4)} ${t.symbol}`, "/app/portfolio");
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof WalletError ? err.message : "This couldn't start.");
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Private transfer" description="Sends privately to another Rooq account. The amount, asset and both parties stay hidden." width={480}>
      <div className={styles.stack}>
        <AssetSelect tokens={view.tokens} value={a} onChange={setAsset} />
        <AmountField label="Amount" value={text} onChange={setText} decimals={t.decimals} unit={t.symbol} />
        <div className="field">
          <label className="field-label" htmlFor="xfer-to"><span>Their private address</span></label>
          <input id="xfer-to" className="input-text" placeholder="rq1..." value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <RelayerFee view={view} asset={a} />
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <button type="button" className="btn btn-primary btn-block" disabled={amount === null || amount <= 0n || to.trim() === ""} onClick={() => void go()}>Send</button>
      </div>
    </Dialog>
  );
}

export function BalancesPanel({ onShield, onUnshield, onTransfer }: { onShield: () => void; onUnshield: (asset?: Hex) => void; onTransfer: () => void }) {
  const view = useView();
  const rows = useMemo(() => (view ? [...view.balances].sort((a, b) => (a.free > b.free ? -1 : 1)) : []), [view]);
  if (!view) return null;
  return (
    <section className={styles.card} aria-label="Private balances">
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>Private balances</h2>
        <div className={styles.row}>
          <button type="button" className="btn btn-sm btn-primary" onClick={onShield}>Shield</button>
          <button type="button" className="btn btn-sm" onClick={() => onUnshield()}>Unshield</button>
          <button type="button" className="btn btn-sm" onClick={onTransfer}>Send</button>
        </div>
      </div>
      {rows.map((b) => <BalanceRow key={b.asset} b={b} view={view} onUnshield={onUnshield} />)}
      {view.unlocked ? (
        <div className={styles.rowLine}>
          <span>Your private address</span>
          <span className={styles.address} data-testid="private-address" title={view.address}><span className={styles.addressHead}>{view.address.slice(0, 18)}</span>…{view.address.slice(-8)}</span>
        </div>
      ) : null}
    </section>
  );
}

function BalanceRow({ b, view, onUnshield }: { b: BalanceView; view: PrivateView; onUnshield: (asset?: Hex) => void }) {
  const canCombine = b.noteCount > 1 && b.largestSpendable < b.free;
  return (
    <div className={`${styles.rowLine} ${styles.balanceRow}`}>
      <TokenLabel view={view} asset={b.asset} />
      <span className={styles.balanceValue}>
        <PV>{amountText(view, b.asset, b.free)}</PV>
        {b.arriving > 0n ? <span className={styles.badge}>Arriving <PV>{amountText(view, b.asset, b.arriving)}</PV></span> : null}
      </span>
      {canCombine || b.free > 0n ? (
        <span className={styles.balanceActions}>
          {canCombine ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void wallet.start({ t: "combine", asset: b.asset }, `Combine ${tokenOf(view, b.asset).symbol} notes`, "/app/portfolio")}>Combine</button>
          ) : null}
          {b.free > 0n ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => onUnshield(b.asset)}>Unshield</button> : null}
        </span>
      ) : null}
    </div>
  );
}
