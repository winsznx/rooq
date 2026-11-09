"use client";

import { useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi } from "viem";
import { formatBps, formatFixed, minReceived, mockERC20Abi, parseDecimal, priceImpactBps, spotRouterAbi } from "@rooq/sdk";
import { copy, copyAt } from "@rooq/ui";
import { DEPLOYMENT } from "@/lib/env";
import type { AccountSnapshot, MarketSnapshot } from "@/lib/chain-data";
import { deadlineBase, confirmedLabel, useTxRunner } from "@/lib/tx";
import { useChainNow } from "@/lib/use-now";
import { useSlippageBps } from "@/lib/preferences";
import { Dialog } from "../feedback/dialog";
import { TxProgress } from "../feedback/tx-progress";
import { useToast } from "../feedback/toast";
import { WalletGate, useWalletState } from "../wallet";
import { AmountField } from "../funds/amount-field";
import { ArrowDown, ArrowUp, Warning } from "../icons";
import { ActionButton, PriceKindTag, Receipt, ReceiptGroup, ReceiptRow } from "../primitives";
import styles from "./trade.module.css";

type Direction = "buy" | "sell";
const HIGH_IMPACT_BPS = 300n;

export function SpotTicket({ m, acct }: { m: MarketSnapshot; acct: AccountSnapshot | null | undefined }) {
  const client = usePublicClient();
  const { address } = useAccount();
  const { isConnected, wrongChain } = useWalletState();
  const [direction, setDirection] = useState<Direction>("buy");
  const [text, setText] = useState("");
  const [review, setReview] = useState<{ direction: Direction; amountIn: bigint; amountOut: bigint; minOut: bigint; impact: bigint | null } | null>(null);
  const slippageBps = useSlippageBps();
  const payToken = direction === "buy" ? m.quote : m.base;
  const getToken = direction === "buy" ? m.base : m.quote;
  const amountIn = parseDecimal(text, payToken.decimals);
  const balance = acct ? (direction === "buy" ? acct.walletCollateral : (acct.baseBalances[m.marketId] ?? 0n)) : null;
  const tooMuch = amountIn !== null && balance !== null && amountIn > balance;
  const funded = m.reserveBase > 0n && m.reserveQuote > 0n;

  const quoteQuery = useQuery({
    queryKey: ["spot-quote", m.pool, direction, amountIn?.toString()],
    enabled: Boolean(client && DEPLOYMENT && amountIn && amountIn > 0n && funded),
    staleTime: 3_000,
    refetchInterval: 6_000,
    queryFn: async () => {
      if (!client || !DEPLOYMENT || !amountIn) return null;
      const out = await client.readContract({
        address: DEPLOYMENT.spotRouter,
        abi: spotRouterAbi,
        functionName: "quoteExactInput",
        args: [[payToken.address, getToken.address], [m.poolFeeBps], amountIn],
      });
      return out;
    },
  });
  const amountOut = quoteQuery.data ?? null;
  const reserveIn = direction === "buy" ? m.reserveQuote : m.reserveBase;
  const reserveOut = direction === "buy" ? m.reserveBase : m.reserveQuote;
  const impact = amountIn && amountOut !== null ? priceImpactBps(amountIn, amountOut, reserveIn, reserveOut) : null;
  const minOut = amountOut !== null ? minReceived(amountOut, BigInt(slippageBps)) : null;
  const feeAmount = amountIn ? (amountIn * BigInt(m.poolFeeBps)) / 10_000n : null;

  let cta: { label: string; disabled: boolean } = { label: direction === "buy" ? "Review buy" : "Review sell", disabled: false };
  if (!funded) cta = { label: copy.spot.emptyPool, disabled: true };
  else if (m.poolPaused) cta = { label: copyAt("spot.poolPaused"), disabled: true };
  else if (m.spotStatus !== "ACTIVE") cta = { label: copy.errors.paused, disabled: true };
  else if (amountIn === null || amountIn === 0n) cta = { label: "Enter an amount", disabled: true };
  else if (tooMuch) cta = { label: copy.errors.insufficientBalance, disabled: true };
  else if (amountOut === null || amountOut === 0n) cta = { label: quoteQuery.isFetching ? "Getting price" : "Amount too small to trade", disabled: true };

  return (
    <div className={styles.ticket}>
      <div className={styles.ticketContext}>
        <p className={styles.modeNote}>Spot buys and sells the token itself. No leverage and no liquidation.</p>
      </div>
      <div className="side" role="group" aria-label="Buy or sell">
        {(["buy", "sell"] as const).map((d) => (
          <button
            key={d}
            type="button"
            data-side={d === "buy" ? "long" : "short"}
            aria-pressed={direction === d}
            onClick={() => {
              setDirection(d);
              setText("");
            }}
          >
            {d === "buy" ? <ArrowUp size={15} /> : <ArrowDown size={15} />}
            {d === "buy" ? copy.spot.buy : copy.spot.sell}
          </button>
        ))}
      </div>
      <AmountField
        label={copy.spot.pay}
        value={text}
        onChange={setText}
        decimals={payToken.decimals}
        unit={payToken.symbol}
        balanceLabel={copy.spot.balance}
        balance={isConnected && !wrongChain ? balance : null}
        onMax={balance !== null ? () => setText(formatFixed(balance, payToken.decimals, payToken.decimals, { group: false })) : undefined}
        error={tooMuch ? copy.errors.insufficientBalance : null}
      />
      <div className={styles.receiveBox} aria-live="polite">
        <span className={styles.pxLabel}>{copy.spot.receive} <PriceKindTag kind="estimate" /></span>
        <span className={styles.receiveValue}>
          {amountOut === null ? "—" : formatFixed(amountOut, getToken.decimals, Math.min(getToken.decimals, 6))}
          <span className="t-small muted">{getToken.symbol}</span>
        </span>
      </div>
      {!funded ? <p className="notice">{copy.spot.emptyPool}</p> : null}
      {impact !== null && impact >= HIGH_IMPACT_BPS ? (
        <p className="notice" data-tone="warning" role="status">
          <Warning size={16} /> Price impact is high. You would move this pool&apos;s price by {formatBps(impact)}.
        </p>
      ) : null}
      {amountIn && amountOut !== null ? (
        <dl className="facts">
          <div>
            <dt>{copy.spot.minReceived}</dt>
            <dd>{minOut === null ? "—" : `${formatFixed(minOut, getToken.decimals, Math.min(getToken.decimals, 6))} ${getToken.symbol}`}</dd>
          </div>
          <div>
            <dt>{copy.spot.priceImpact}</dt>
            <dd className={impact !== null && impact >= HIGH_IMPACT_BPS ? "warn" : undefined}>{impact === null ? "—" : formatBps(impact)}</dd>
          </div>
          <div>
            <dt>{copy.spot.swapFee}</dt>
            <dd>{feeAmount === null ? "—" : `${formatFixed(feeAmount, payToken.decimals, Math.min(payToken.decimals, 6))} ${payToken.symbol}`}</dd>
          </div>
          <div>
            <dt>{copy.spot.slippage}</dt>
            <dd>{formatBps(slippageBps)}</dd>
          </div>
          <div>
            <dt>{copy.spot.route}</dt>
            <dd>{copy.spot.pool}</dd>
          </div>
        </dl>
      ) : null}
      <div className={styles.ctaWrap}>
        <WalletGate>
          <ActionButton disabled={cta.disabled} state={quoteQuery.isFetching && amountOut === null ? "working" : "idle"} onClick={() => {
              if (amountIn && amountOut !== null && minOut !== null) setReview({ direction, amountIn, amountOut, minOut, impact });
            }}>
            {cta.label}
          </ActionButton>
        </WalletGate>
      </div>
      {review && address ? (
        <SpotReviewDialog
          open
          onOpenChange={(o) => {
            if (!o) setReview(null);
          }}
          m={m}
          direction={review.direction}
          amountIn={review.amountIn}
          amountOut={review.amountOut}
          minOut={review.minOut}
          impact={review.impact}
          onDone={() => setText("")}
        />
      ) : null}
    </div>
  );
}

function SpotReviewDialog({
  open,
  onOpenChange,
  m,
  direction,
  amountIn,
  amountOut,
  minOut,
  impact,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  m: MarketSnapshot;
  direction: Direction;
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  impact: bigint | null;
  onDone: () => void;
}) {
  const client = usePublicClient();
  const { address } = useAccount();
  const tx = useTxRunner();
  const toast = useToast();
  const chainNow = useChainNow();
  const payToken = direction === "buy" ? m.quote : m.base;
  const getToken = direction === "buy" ? m.base : m.quote;
  const done = tx.steps.length > 0 && tx.steps.every((s) => s.phase === "confirmed");

  const allowance = useQuery({
    queryKey: ["allowance", payToken.address, address, DEPLOYMENT?.spotRouter],
    enabled: Boolean(open && client && address && DEPLOYMENT),
    queryFn: async () =>
      client && address && DEPLOYMENT
        ? client.readContract({ address: payToken.address, abi: erc20Abi, functionName: "allowance", args: [address, DEPLOYMENT.spotRouter] })
        : 0n,
  });
  const needsApproval = (allowance.data ?? 0n) < amountIn;

  const submit = async () => {
    if (!DEPLOYMENT || !address || chainNow === null) return;
    const dep = DEPLOYMENT;
    const action = `${direction === "buy" ? copy.spot.buy : copy.spot.sell} ${direction === "buy" ? getToken.symbol : payToken.symbol}`;
    const receipts = await tx.run(
      [
        ...(needsApproval
          ? [{ label: `Approve ${formatFixed(amountIn, payToken.decimals, 4)} ${payToken.symbol}`, address: payToken.address, abi: mockERC20Abi, functionName: "approve", args: [dep.spotRouter, amountIn] }]
          : []),
        {
          label: action,
          address: dep.spotRouter,
          abi: spotRouterAbi,
          functionName: "swapExactInput",
          args: [[payToken.address, getToken.address], [m.poolFeeBps], amountIn, minOut, address, BigInt(deadlineBase(chainNow) + 300)],
        },
      ],
      { kind: "trade", title: action },
    );
    if (receipts) {
      toast.notify({ tone: "success", title: "Swap confirmed", body: confirmedLabel() });
      onDone();
    }
  };

  const payText = `${formatFixed(amountIn, payToken.decimals, Math.min(payToken.decimals, 6))} ${payToken.symbol}`;
  const getText = `${formatFixed(amountOut, getToken.decimals, Math.min(getToken.decimals, 6))} ${getToken.symbol}`;
  const minText = `${formatFixed(minOut, getToken.decimals, Math.min(getToken.decimals, 6))} ${getToken.symbol}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) tx.reset();
        onOpenChange(o);
      }}
      title={copy.spot.review}
      dismissible={!tx.busy || tx.leavable}
      footer={
        done ? (
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => onOpenChange(false)}>
            Done
          </button>
        ) : (
          <ActionButton disabled={tx.busy || allowance.isLoading} state={tx.busy ? "working" : "idle"} onClick={() => void submit()}>
            {tx.busy ? copy.activity.pending : needsApproval ? `Approve, then ${copy.spot.execute.toLowerCase()}` : copy.spot.execute}
          </ActionButton>
        )
      }
    >
      <div className="stack">
        <Receipt title={`${direction === "buy" ? copy.spot.buy : copy.spot.sell} ${direction === "buy" ? getToken.symbol : payToken.symbol}`} status={done ? "Settled" : "Review"}>
          <ReceiptGroup title={done ? "What changed" : "What changes"}>
            <ReceiptRow lead label={`${copy.spot.receive} (estimate)`} value={`+${getText}`} tone="pos" sub={`At least ${minText}`} />
            <ReceiptRow label={copy.spot.pay} value={`-${payText}`} />
          </ReceiptGroup>
          <ReceiptGroup title="What it costs">
            <ReceiptRow label={copy.spot.swapFee} value={formatBps(m.poolFeeBps)} />
            <ReceiptRow label={copy.spot.priceImpact} value={impact === null ? "—" : formatBps(impact)} />
            <ReceiptRow label="Approval" value={allowance.isLoading ? "—" : needsApproval ? "Exact amount, separate step" : "Not needed"} />
          </ReceiptGroup>
          <ReceiptGroup title="How it settles">
            <ReceiptRow label={copy.spot.route} value={copy.spot.pool} />
            <ReceiptRow label={copy.spot.minReceived} value={minText} />
          </ReceiptGroup>
        </Receipt>
        <p className="t-small muted" style={{ margin: 0 }}>
          The swap reverts if you would receive less than the minimum, or if it is not mined within 5 minutes.
        </p>
        {tx.leavable ? <p className="t-small muted" style={{ margin: 0 }}>You can close this. Operations keeps tracking it.</p> : null}
        <TxProgress steps={tx.steps} />
      </div>
    </Dialog>
  );
}
