"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { clearingHouseAbi, formatFixed, parseDecimal } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { DEPLOYMENT } from "@/lib/env";
import type { MarketSnapshot } from "@/lib/chain-data";
import { useMakerAccount } from "@/lib/maker-data";
import { useTxRunner } from "@/lib/tx";
import { Dialog } from "@/components/feedback/dialog";
import { TxProgress } from "@/components/feedback/tx-progress";
import { AmountField } from "@/components/funds/amount-field";
import { DepositDialog } from "@/components/funds/funds-dialogs";

/**
 * Commit or withdraw maker backing for one market. Committed backing funds maker margin on fills.
 * Margin already inside open positions is not here and cannot be withdrawn until those close.
 */
export function BackingDialog({ m, action, open, onOpenChange }: { m: MarketSnapshot; action: "commit" | "withdraw"; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { address } = useAccount();
  const { data: maker } = useMakerAccount(address);
  const tx = useTxRunner();
  const [text, setText] = useState("");
  const [depositOpen, setDepositOpen] = useState(false);
  if (!DEPLOYMENT) return null;
  const dep = DEPLOYMENT;
  const amount = parseDecimal(text, m.quote.decimals);
  const committed = maker?.rows[m.marketId]?.committed ?? null;
  const limit = action === "commit" ? (maker?.vaultFree ?? null) : committed;
  const min = m.risk?.minMakerBacking ?? 0n;
  const withdrawableUnderMin = m.perpStatus === "ACTIVE" ? (m.makerBacking > min ? m.makerBacking - min : 0n) : m.makerBacking;
  const overLimit = amount !== null && limit !== null && amount > limit;
  const breaksMinimum = action === "withdraw" && amount !== null && m.perpStatus === "ACTIVE" && m.makerBacking - amount < min;
  const done = tx.steps.length > 0 && tx.steps.every((s) => s.phase === "confirmed");
  const unit = m.quote.symbol;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) {
            tx.reset();
            setText("");
          }
          onOpenChange(o);
        }}
        title={action === "commit" ? `Commit backing to ${m.base.symbol}` : `Withdraw backing from ${m.base.symbol}`}
        description={
          action === "commit"
            ? "Committed backing is pledged to this market. Each fill moves the initial margin for your side of the position out of it."
            : "Only uncommitted backing can be withdrawn. Margin inside open positions stays locked until they close."
        }
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
              disabled={amount === null || amount === 0n || overLimit || breaksMinimum || tx.busy}
              onClick={() => {
                if (amount === null) return;
                void tx.run([
                  {
                    label: `${action === "commit" ? "Commit" : "Withdraw"} ${formatFixed(amount, m.quote.decimals, 2)} ${unit}`,
                    address: dep.clearingHouse,
                    abi: clearingHouseAbi,
                    functionName: action === "commit" ? "commitBacking" : "withdrawBacking",
                    args: [m.marketId, amount],
                  },
                ], { kind: "maker" });
              }}
            >
              {tx.busy ? copy.activity.pending : action === "commit" ? "Commit backing" : "Withdraw backing"}
            </button>
          )
        }
      >
        <div className="stack">
          <AmountField
            label="Amount"
            value={text}
            onChange={setText}
            decimals={m.quote.decimals}
            unit={unit}
            balanceLabel={action === "commit" ? "Available in vault" : "Your committed backing"}
            balance={limit}
            onMax={limit !== null ? () => setText(formatFixed(action === "withdraw" ? minBig(limit, withdrawableUnderMin) : limit, m.quote.decimals, m.quote.decimals, { group: false })) : undefined}
            error={
              overLimit
                ? action === "commit"
                  ? copy.errors.insufficientBalance
                  : "That is more than you have committed to this market."
                : breaksMinimum
                  ? `While perps are active, this market's total backing can't drop below ${formatFixed(min, m.quote.decimals, 0)} ${unit}. You can withdraw up to ${formatFixed(withdrawableUnderMin, m.quote.decimals, 2)} ${unit} now.`
                  : null
            }
          />
          <dl className="facts">
            <div>
              <dt>Market backing now</dt>
              <dd>{`${formatFixed(m.makerBacking, m.quote.decimals, 2)} ${unit}`}</dd>
            </div>
            <div>
              <dt>Minimum while perps are active</dt>
              <dd>{m.risk ? `${formatFixed(min, m.quote.decimals, 0)} ${unit}` : "—"}</dd>
            </div>
          </dl>
          {action === "commit" ? (
            <p className="t-small muted" style={{ margin: 0 }}>
              Need more in the vault?{" "}
              <button type="button" className="btn-link" onClick={() => setDepositOpen(true)}>
                {copy.portfolio.deposit}
              </button>
            </p>
          ) : null}
          <TxProgress steps={tx.steps} />
        </div>
      </Dialog>
      <DepositDialog open={depositOpen} onOpenChange={setDepositOpen} />
    </>
  );
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
