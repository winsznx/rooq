"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAccount, usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { formatBps, formatFixed, mockERC20Abi, parseDecimal, spotFactoryAbi, spotPoolAbi, sqrt } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { DEPLOYMENT } from "@/lib/env";
import { AmountField } from "@/components/funds/amount-field";
import { useCreateDraft } from "../create-store";
import { CreateSteps } from "../steps";
import styles from "../create.module.css";

const FEE_TIERS = [
  { bps: 5, label: "0.05%", hint: "For pairs that barely move against each other" },
  { bps: 25, label: "0.25%", hint: "Default for most tokens" },
  { bps: 100, label: "1.00%", hint: "For thin or volatile tokens" },
] as const;
const MINIMUM_LIQUIDITY = 1_000n;

/** C03. Real launch funds: the creator's own tokens seed the pool and set its starting price. */
export function LiquidityStep() {
  const router = useRouter();
  const client = usePublicClient();
  const { address } = useAccount();
  const { draft, update } = useCreateDraft();
  const token = draft.token;
  const dep = DEPLOYMENT;

  const balances = useQuery({
    queryKey: ["create-balances", token?.address, address],
    enabled: Boolean(client && dep && token && address),
    refetchInterval: 6_000,
    queryFn: async () => {
      if (!client || !dep || !token || !address) return null;
      const [base, quote] = await Promise.all([
        client.readContract({ address: token.address, abi: mockERC20Abi, functionName: "balanceOf", args: [address] }),
        client.readContract({ address: dep.collateral, abi: mockERC20Abi, functionName: "balanceOf", args: [address] }),
      ]);
      return { base, quote };
    },
  });

  const existingPool = useQuery({
    queryKey: ["create-pool", token?.address, draft.poolFeeBps],
    enabled: Boolean(client && dep && token),
    queryFn: async () => {
      if (!client || !dep || !token) return null;
      const pool = await client.readContract({ address: dep.spotFactory, abi: spotFactoryAbi, functionName: "getPool", args: [token.address, dep.collateral, draft.poolFeeBps] });
      if (pool === "0x0000000000000000000000000000000000000000") return null;
      const reserves = await client.readContract({ address: pool, abi: spotPoolAbi, functionName: "getReserves" });
      return { pool, funded: reserves[0] > 0n && reserves[1] > 0n };
    },
  });

  if (!token || !dep) {
    return (
      <div className={styles.page}>
        <CreateSteps current={1} />
        <p className="empty">
          Choose an asset first.
          <Link className="btn" href="/app/create/asset">
            Choose asset
          </Link>
        </p>
      </div>
    );
  }

  const base = parseDecimal(draft.seedBaseText, token.decimals);
  const quote = parseDecimal(draft.seedQuoteText, dep.collateralDecimals);
  const baseShort = base !== null && balances.data ? base > balances.data.base : false;
  const quoteShort = quote !== null && balances.data ? quote > balances.data.quote : false;
  const priceWad =
    base && quote && base > 0n ? (quote * 10n ** BigInt(18 - dep.collateralDecimals) * 10n ** 18n) / (base * 10n ** BigInt(18 - token.decimals)) : null;
  const root = base && quote ? sqrt(base * quote) : null;
  const shares = root !== null && root > MINIMUM_LIQUIDITY ? root - MINIMUM_LIQUIDITY : null;
  const tooSmall = root !== null && root <= MINIMUM_LIQUIDITY;
  const canContinue = Boolean(base && quote && base > 0n && quote > 0n && !baseShort && !quoteShort && !tooSmall && !existingPool.data?.funded);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <CreateSteps current={1} />
        <h1 className="t-page">{copy.preflight.spotLiquidity}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {`Seed the ${token.symbol} / ${dep.collateralSymbol} pool. The ratio of your two deposits is the market's starting price.`}
        </p>
      </header>
      <div className={styles.layout}>
        <div className={styles.main}>
          <fieldset className={styles.choice} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label" style={{ marginBottom: 8 }}>
              {copy.spot.swapFee}
            </legend>
            {FEE_TIERS.map((f) => (
              <label key={f.bps} className={styles.option}>
                <input type="radio" name="fee" checked={draft.poolFeeBps === f.bps} onChange={() => update({ poolFeeBps: f.bps })} />
                <span className={styles.optionText}>
                  <strong>{f.label}</strong>
                  <span className="t-small muted">{f.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {existingPool.data?.funded ? (
            <p className="notice" data-tone="warning" role="alert">
              A funded pool already exists for this pair and fee tier. Choose another fee tier, or add liquidity to the existing pool from Liquidity.
            </p>
          ) : null}
          <AmountField
            label={`${token.symbol} to deposit`}
            value={draft.seedBaseText}
            onChange={(v) => update({ seedBaseText: v })}
            decimals={token.decimals}
            unit={token.symbol}
            balanceLabel="Wallet"
            balance={balances.data?.base ?? null}
            error={baseShort ? copy.errors.insufficientBalance : null}
          />
          <AmountField
            label={`${dep.collateralSymbol} to deposit`}
            value={draft.seedQuoteText}
            onChange={(v) => update({ seedQuoteText: v })}
            decimals={dep.collateralDecimals}
            unit={dep.collateralSymbol}
            balanceLabel="Wallet"
            balance={balances.data?.quote ?? null}
            error={quoteShort ? copy.errors.insufficientBalance : tooSmall ? "These amounts are below the pool's minimum liquidity." : null}
          />
          {!address ? <p className="t-small muted">Connect a wallet to check your balances. You can still prepare the market.</p> : null}
          <div className={styles.actions}>
            <Link href="/app/create/asset" className="btn">
              Back
            </Link>
            <button type="button" className="btn btn-primary btn-lg" disabled={!canContinue} onClick={() => router.push("/app/create/leverage")}>
              Continue
            </button>
          </div>
        </div>
        <aside className={`panel panel-pad ${styles.summary}`} aria-label="Pool preview">
          <h2 className="t-label" style={{ margin: "0 0 8px" }}>
            Pool preview
          </h2>
          <dl className="facts">
            <div>
              <dt>Pair</dt>
              <dd>{`${token.symbol} / ${dep.collateralSymbol}`}</dd>
            </div>
            <div>
              <dt>Starting price</dt>
              <dd>{priceWad === null ? "—" : `${formatFixed(priceWad, 18, priceWad >= 10n ** 18n ? 2 : 6)} ${dep.collateralSymbol}`}</dd>
            </div>
            <div>
              <dt>LP shares you receive</dt>
              <dd>
                {shares === null ? "—" : formatFixed(shares, 18, 6)}
                <span className="sub">1,000 units stay locked forever</span>
              </dd>
            </div>
            <div>
              <dt>Your pool share</dt>
              <dd>
                {shares === null ? "—" : formatBps((shares * 10_000n) / (shares + MINIMUM_LIQUIDITY))}
                <span className="sub">the locked minimum is the rest</span>
              </dd>
            </div>
            <div>
              <dt>{copy.spot.swapFee}</dt>
              <dd>{FEE_TIERS.find((f) => f.bps === draft.poolFeeBps)?.label}</dd>
            </div>
          </dl>
          <p className="t-small muted" style={{ margin: "8px 0 0" }}>
            {copy.liquidity.warning} Pool deposits are never used as perp margin.
          </p>
        </aside>
      </div>
    </div>
  );
}
