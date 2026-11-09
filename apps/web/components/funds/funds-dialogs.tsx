"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { formatFixed, marginVaultAbi, mockERC20Abi, parseDecimal } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { DEPLOYMENT } from "@/lib/env";
import { collateralIdentity } from "@/lib/assets";
import { useAccountSnapshot } from "@/lib/chain-data";
import { useTxRunner } from "@/lib/tx";
import { Dialog } from "../feedback/dialog";
import { TxProgress } from "../feedback/tx-progress";
import { AmountField } from "./amount-field";
import { TestTag } from "../primitives";

const asset = collateralIdentity();

/** AC04. Approval and deposit are two separate wallet actions, each for the exact amount. */
export function DepositDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { address } = useAccount();
  const { data: acct } = useAccountSnapshot(address);
  const tx = useTxRunner();
  const [text, setText] = useState("");
  if (!DEPLOYMENT || !asset) return null;
  const dep = DEPLOYMENT;
  const amount = parseDecimal(text, asset.decimals);
  const tooMuch = amount !== null && acct ? amount > acct.walletCollateral : false;
  const needsApproval = amount !== null && acct ? acct.vaultAllowance < amount : true;
  const canSubmit = amount !== null && amount > 0n && !tooMuch && !tx.busy;
  const done = tx.steps.length > 0 && tx.steps.every((s) => s.phase === "confirmed");

  const submit = async () => {
    if (amount === null) return;
    const requests = [
      ...(needsApproval
        ? [{ label: `Approve ${formatFixed(amount, asset.decimals, 2)} ${asset.symbol}`, address: dep.collateral, abi: mockERC20Abi, functionName: "approve", args: [dep.marginVault, amount] }]
        : []),
      { label: `Deposit ${formatFixed(amount, asset.decimals, 2)} ${asset.symbol}`, address: dep.marginVault, abi: marginVaultAbi, functionName: "deposit", args: [amount, address] },
    ];
    await tx.run(requests, { kind: "funds", title: `Deposit ${formatFixed(amount, asset.decimals, 2)} ${asset.symbol}` });
  };

  const faucet = async () => {
    await tx.run([{ label: `Get 10,000 test ${asset.symbol}`, address: dep.collateral, abi: mockERC20Abi, functionName: "faucet", args: [10_000n * 10n ** BigInt(asset.decimals)] }], { kind: "faucet" });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          tx.reset();
          setText("");
        }
        onOpenChange(o);
      }}
      title={copy.portfolio.deposit}
      description={`Move ${asset.symbol} from your wallet into the Rooq margin vault. Margin backs leveraged positions only; it never funds spot pools.`}
      fullscreenOnMobile
      dismissible={!tx.busy || tx.leavable}
      footer={
        done ? (
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => onOpenChange(false)}>
            Done
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!canSubmit} onClick={() => void submit()}>
            {tx.busy ? copy.activity.pending : needsApproval && amount ? "Approve, then deposit" : copy.portfolio.deposit}
          </button>
        )
      }
    >
      <div className="stack">
        <div className="row between">
          <span className="row" style={{ "--gap": "6px" } as React.CSSProperties}>
            <strong>{asset.symbol}</strong>
            <span className="t-small muted">{asset.name}</span>
          </span>
          {asset.isTestFixture ? <TestTag>Test collateral</TestTag> : null}
        </div>
        <AmountField
          label="Amount"
          value={text}
          onChange={setText}
          decimals={asset.decimals}
          unit={asset.symbol}
          balanceLabel="Wallet"
          balance={acct?.walletCollateral}
          onMax={acct ? () => setText(formatFixed(acct.walletCollateral, asset.decimals, asset.decimals, { group: false })) : undefined}
          error={tooMuch ? copy.errors.insufficientBalance : null}
        />
        <dl className="facts">
          <div>
            <dt>Margin vault, available after</dt>
            <dd>{acct ? `${formatFixed(acct.vaultFree + (amount ?? 0n), asset.decimals, 2)} ${asset.symbol}` : "Unavailable"}</dd>
          </div>
          <div>
            <dt>Margin vault, in positions</dt>
            <dd>{acct ? `${formatFixed(acct.vaultLocked, asset.decimals, 2)} ${asset.symbol}` : "Unavailable"}</dd>
          </div>
          <div>
            <dt>Approval needed</dt>
            <dd>{amount === null ? "—" : needsApproval ? "Yes, exact amount" : "No"}</dd>
          </div>
        </dl>
        {dep.collateralMode === "mock" ? (
          <div className="notice">
            <span>
              {asset.symbol} is a test token with no value. The faucet sends 10,000 once per hour.{" "}
              <button type="button" className="btn-link" disabled={tx.busy} onClick={() => void faucet()}>
                Get test {asset.symbol}
              </button>
            </span>
          </div>
        ) : null}
        <TxProgress steps={tx.steps} />
      </div>
    </Dialog>
  );
}

/** AC05. Only free collateral can be withdrawn; the vault rejects anything else onchain. */
export function WithdrawDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { address } = useAccount();
  const { data: acct } = useAccountSnapshot(address);
  const tx = useTxRunner();
  const [text, setText] = useState("");
  if (!DEPLOYMENT || !asset) return null;
  const dep = DEPLOYMENT;
  const amount = parseDecimal(text, asset.decimals);
  const tooMuch = amount !== null && acct ? amount > acct.vaultFree : false;
  const done = tx.steps.length > 0 && tx.steps.every((s) => s.phase === "confirmed");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          tx.reset();
          setText("");
        }
        onOpenChange(o);
      }}
      title={copy.portfolio.withdraw}
      description="Withdraw collateral that is not backing an open position. Margin inside positions stays locked until you reduce or close."
      fullscreenOnMobile
      dismissible={!tx.busy || tx.leavable}
      footer={
        done ? (
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => onOpenChange(false)}>
            Done
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            disabled={amount === null || amount === 0n || tooMuch || tx.busy}
            onClick={() => {
              if (amount === null || !address) return;
              void tx.run([{ label: `Withdraw ${formatFixed(amount, asset.decimals, 2)} ${asset.symbol}`, address: dep.marginVault, abi: marginVaultAbi, functionName: "withdraw", args: [amount, address] }]);
            }}
          >
            {tx.busy ? copy.activity.pending : copy.portfolio.withdraw}
          </button>
        )
      }
    >
      <div className="stack">
        <AmountField
          label="Amount"
          value={text}
          onChange={setText}
          decimals={asset.decimals}
          unit={asset.symbol}
          balanceLabel={copy.portfolio.available}
          balance={acct?.vaultFree}
          onMax={acct ? () => setText(formatFixed(acct.vaultFree, asset.decimals, asset.decimals, { group: false })) : undefined}
          error={tooMuch ? "That is more than your available margin. Collateral in open positions is locked." : null}
        />
        <dl className="facts">
          <div>
            <dt>Locked in positions</dt>
            <dd>{acct ? `${formatFixed(acct.vaultLocked, asset.decimals, 2)} ${asset.symbol}` : "Unavailable"}</dd>
          </div>
        </dl>
        <TxProgress steps={tx.steps} />
      </div>
    </Dialog>
  );
}
