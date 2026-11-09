"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { formatFixed, marginVaultAbi, marketBackstopAbi, marketRegistryAbi, mockERC20Abi, parseDecimal, shortAddress, spotPoolAbi } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { DEPLOYMENT } from "@/lib/env";
import { deadlineBase, useTxRunner, type WriteRequest } from "@/lib/tx";
import { useChainNow } from "@/lib/use-now";
import { TxProgress } from "@/components/feedback/tx-progress";
import { WalletGate } from "@/components/wallet";
import { useCreateDraft } from "../create-store";
import { CreateSteps } from "../steps";
import styles from "../create.module.css";

const WAD = 10n ** 18n;

/** C06. Shows every contract write, in order, with its target, before anything is signed. */
export function ReviewStep() {
  const router = useRouter();
  const client = usePublicClient();
  const { address } = useAccount();
  const chainNow = useChainNow();
  const { draft, update } = useCreateDraft();
  const createTx = useTxRunner();
  const seedTx = useTxRunner();
  const perpTx = useTxRunner();
  const [pool, setPool] = useState<Address | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const token = draft.token;
  const dep = DEPLOYMENT;

  const marketIdQuery = useQuery({
    queryKey: ["create-market-id", token?.address],
    enabled: Boolean(client && dep && token),
    queryFn: async () =>
      client && dep && token ? client.readContract({ address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "computeMarketId", args: [token.address, dep.collateral] }) : null,
  });

  if (!token || !dep) {
    return (
      <div className={styles.page}>
        <CreateSteps current={4} />
        <p className="empty">
          Choose an asset first.
          <Link className="btn" href="/app/create/asset">
            Choose asset
          </Link>
        </p>
      </div>
    );
  }

  const seedBase = parseDecimal(draft.seedBaseText, token.decimals) ?? 0n;
  const seedQuote = parseDecimal(draft.seedQuoteText, dep.collateralDecimals) ?? 0n;
  const bond = parseDecimal(draft.bondText, dep.collateralDecimals) ?? 0n;
  const maxOiUsd = parseDecimal(draft.maxOiUsdText, 0) ?? 0n;
  const withPerps = draft.perps && draft.feedId !== null;
  const marketId = marketIdQuery.data ?? null;
  const busy = createTx.busy || seedTx.busy || perpTx.busy;

  const run = async () => {
    if (!client || !address || !marketId || chainNow === null) return;
    setFailed(null);
    const created = await createTx.run([
      { label: `Create ${token.symbol} / ${dep.collateralSymbol} market`, address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "createMarket", args: [token.address, dep.collateral, draft.poolFeeBps] },
    ], { kind: "market" });
    if (!created) {
      setFailed("Market creation did not complete. Nothing after it was sent.");
      return;
    }
    update({ createdMarketId: marketId });
    const market = await client.readContract({ address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "getMarket", args: [marketId] });
    setPool(market.pool);
    const token0 = await client.readContract({ address: market.pool, abi: spotPoolAbi, functionName: "token0" });
    const baseIs0 = token0.toLowerCase() === token.address.toLowerCase();
    const [baseAllowance, quoteAllowance] = await Promise.all([
      client.readContract({ address: token.address, abi: mockERC20Abi, functionName: "allowance", args: [address, market.pool] }),
      client.readContract({ address: dep.collateral, abi: mockERC20Abi, functionName: "allowance", args: [address, market.pool] }),
    ]);
    const a0 = baseIs0 ? seedBase : seedQuote;
    const a1 = baseIs0 ? seedQuote : seedBase;
    const seedRequests: WriteRequest[] = [
      ...(baseAllowance < seedBase ? [{ label: `Approve ${formatFixed(seedBase, token.decimals, 4)} ${token.symbol} to the pool`, address: token.address, abi: mockERC20Abi, functionName: "approve", args: [market.pool, seedBase] }] : []),
      ...(quoteAllowance < seedQuote ? [{ label: `Approve ${formatFixed(seedQuote, dep.collateralDecimals, 2)} ${dep.collateralSymbol} to the pool`, address: dep.collateral, abi: mockERC20Abi, functionName: "approve", args: [market.pool, seedQuote] }] : []),
      {
        label: "Seed the pool and receive LP shares",
        address: market.pool,
        abi: spotPoolAbi,
        functionName: "addLiquidity",
        args: [a0, a1, (a0 * 99n) / 100n, (a1 * 99n) / 100n, address, BigInt(deadlineBase(chainNow) + 600)],
      },
    ];
    const seeded = await seedTx.run(seedRequests, { kind: "market", title: "Seed spot liquidity" });
    if (!seeded) {
      setFailed("The market exists but the pool was not seeded. You can add liquidity later from Liquidity.");
      return;
    }
    if (withPerps && draft.feedId) {
      const vaultAllowance = await client.readContract({ address: dep.collateral, abi: mockERC20Abi, functionName: "allowance", args: [address, dep.marginVault] });
      const perpRequests: WriteRequest[] = [
        { label: "Register the perp configuration", address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "proposePerp", args: [marketId, draft.tierId, draft.feedId as Hex, maxOiUsd * WAD] },
        ...(bond > 0n && vaultAllowance < bond ? [{ label: `Approve ${formatFixed(bond, dep.collateralDecimals, 2)} ${dep.collateralSymbol} to the margin vault`, address: dep.collateral, abi: mockERC20Abi, functionName: "approve", args: [dep.marginVault, bond] }] : []),
        ...(bond > 0n
          ? [
              { label: "Deposit the bond into the margin vault", address: dep.marginVault, abi: marginVaultAbi, functionName: "deposit", args: [bond, address] },
              { label: "Post the creator bond", address: dep.marketBackstop, abi: marketBackstopAbi, functionName: "postBond", args: [marketId, bond] },
            ]
          : []),
      ];
      const registered = await perpTx.run(perpRequests, { kind: "market", title: "Register perps" });
      if (!registered) {
        setFailed("The spot market is live. The perp configuration was not completed, so leverage is not activated.");
        return;
      }
    }
    router.push(`/app/create/success?marketId=${marketId}`);
  };

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <CreateSteps current={4} />
        <h1 className="t-page">{copy.preflight.review}</h1>
        <p className="muted" style={{ margin: 0 }}>
          These are the exact transactions your wallet will ask you to sign, in order. Your wallet shows the network fee for each one before you confirm.
        </p>
      </header>
      <div className={styles.layout}>
        <div className={styles.main}>
          <section className="panel panel-pad stack" aria-label="Contract writes">
            <ol className={styles.writes}>
              <li>
                <strong>Create market</strong>
                <span className="t-small muted" style={{ display: "block" }}>
                  {`MarketRegistry.createMarket(${token.symbol}, ${dep.collateralSymbol}, ${draft.poolFeeBps} bps) on ${shortAddress(dep.marketRegistry)}. Deploys the pool through SpotFactory.`}
                </span>
              </li>
              <li>
                <strong>Approve exact amounts to the pool</strong>
                <span className="t-small muted" style={{ display: "block" }}>
                  {`${formatFixed(seedBase, token.decimals, 4)} ${token.symbol} and ${formatFixed(seedQuote, dep.collateralDecimals, 2)} ${dep.collateralSymbol}, only if your current approval is lower.`}
                </span>
              </li>
              <li>
                <strong>Seed the pool</strong>
                <span className="t-small muted" style={{ display: "block" }}>
                  {`SpotPool.addLiquidity on ${pool ? shortAddress(pool) : "the new pool"}. Reverts if it would use less than 99% of either amount.`}
                </span>
              </li>
              {withPerps ? (
                <>
                  <li>
                    <strong>Register the perp configuration</strong>
                    <span className="t-small muted" style={{ display: "block" }}>
                      {`MarketRegistry.proposePerp with tier ${draft.tierId}, the approved feed and a ${formatFixed(maxOiUsd, 0, 0)} USD open interest cap. This does not activate trading.`}
                    </span>
                  </li>
                  <li>
                    <strong>Deposit and post the bond</strong>
                    <span className="t-small muted" style={{ display: "block" }}>
                      {`MarginVault.deposit then MarketBackstop.postBond for ${formatFixed(bond, dep.collateralDecimals, 2)} ${dep.collateralSymbol} on ${shortAddress(dep.marketBackstop)}.`}
                    </span>
                  </li>
                </>
              ) : null}
            </ol>
            <p className="t-small muted" style={{ margin: 0 }}>
              {withPerps
                ? "After this, a maker commits backing from the maker desk. Anyone can then call MarketPreflight.activatePerps, which rechecks every requirement onchain. Leverage stays off until it passes."
                : "Leverage is not activated. This launches a spot market only."}
            </p>
          </section>

          <section className="panel panel-pad stack" aria-label="Authority after launch">
            <h2 className="t-label" style={{ margin: 0 }}>
              Who can change this market afterwards
            </h2>
            <p className="t-small muted" style={{ margin: 0 }}>
              The guardian can only reduce risk: close-only, pause, or move to settlement. No one can raise leverage above the tier, move your LP shares, or withdraw your bond except through the market&apos;s loss waterfall. You can withdraw the bond once the market carries no positions and perps are not active.
            </p>
          </section>

          {[createTx.steps, seedTx.steps, perpTx.steps].some((s) => s.length > 0) ? (
            <section className="panel panel-pad stack" aria-label="Progress">
              <TxProgress steps={createTx.steps} />
              <TxProgress steps={seedTx.steps} />
              <TxProgress steps={perpTx.steps} />
            </section>
          ) : null}
          {failed ? (
            <p className="notice" data-tone="warning" role="alert">
              {failed}
            </p>
          ) : null}

          <div className={styles.actions}>
            <Link href="/app/create/preflight" className="btn">
              Back
            </Link>
            <span>
              <WalletGate>
                <button type="button" className="btn btn-primary btn-lg" disabled={busy || !marketId || chainNow === null} onClick={() => void run()}>
                  {busy ? copy.activity.pending : withPerps ? copy.preflight.launch : copy.preflight.spotOnly}
                </button>
              </WalletGate>
            </span>
          </div>
        </div>
        <aside className={`panel panel-pad ${styles.summary}`} aria-label="Market identity">
          <h2 className="t-label" style={{ margin: "0 0 8px" }}>
            Market identity
          </h2>
          <dl className="facts">
            <div>
              <dt>Market ID</dt>
              <dd className={styles.mono}>{marketId ?? "—"}</dd>
            </div>
            <div>
              <dt>{copy.preflight.asset}</dt>
              <dd className={styles.mono}>{token.address}</dd>
            </div>
            <div>
              <dt>{copy.preflight.quoteAsset}</dt>
              <dd className={styles.mono}>{dep.collateral}</dd>
            </div>
            <div>
              <dt>{copy.spot.swapFee}</dt>
              <dd>{`${formatFixed(BigInt(draft.poolFeeBps), 2, 2)}%`}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </div>
  );
}
