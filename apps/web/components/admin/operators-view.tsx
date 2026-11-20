"use client";

import { UNKNOWN, formatAge } from "@rooq/sdk";
import type { AdminOperator, AdminOperators } from "@rooq/private-sdk/admin";
import { Address, StateBlock } from "@/components/primitives";
import { Warning } from "@/components/icons";
import { useAdminOperators, useAdminRange } from "@/lib/admin/hooks";
import { useNow } from "@/lib/use-now";
import { actionLabel, count, eth } from "./format";
import { Kpi, KpiStrip } from "./kpi";
import { AdminPageHead } from "./page-head";
import { Loaded, TableSkeleton } from "./query-state";
import { RANGE_LABEL } from "./range-label";

const TOP_ACTIONS = 3;

function sumWei(list: readonly AdminOperator[], pick: (o: AdminOperator) => string): string {
  return list.reduce((acc, o) => acc + BigInt(pick(o)), 0n).toString();
}

function topActions(o: AdminOperator): string {
  const sorted = [...o.actions].sort((a, b) => b.count - a.count);
  const shown = sorted.slice(0, TOP_ACTIONS).map((a) => `${actionLabel(a.action)} ${count(a.count)}`);
  return shown.length === 0 ? "None" : `${shown.join(", ")}${sorted.length > TOP_ACTIONS ? `, +${sorted.length - TOP_ACTIONS} more` : ""}`;
}

function OperatorsTable({ operators }: { operators: readonly AdminOperator[] }): React.JSX.Element {
  const now = useNow();
  return (
    <div className="panel table-scroll">
      <table className="table">
        <caption className="sr-only">Rooq operator wallets</caption>
        <thead>
          <tr>
            <th scope="col">Wallet</th>
            <th scope="col">Address</th>
            <th scope="col" className="n">
              Balance
            </th>
            <th scope="col" className="n">
              Gas spent
            </th>
            <th scope="col" className="n">
              Indexed txs
            </th>
            <th scope="col" className="n">
              Nonce
            </th>
            <th scope="col" className="n">
              Unindexed
            </th>
            <th scope="col" className="n">
              Last tx
            </th>
            <th scope="col">Top actions</th>
          </tr>
        </thead>
        <tbody>
          {operators.map((o) => (
            <tr key={o.address}>
              <th scope="row">{o.label}</th>
              <td>
                <Address value={o.address} />
              </td>
              <td className="n">{eth(o.balanceWei)}</td>
              <td className="n">{eth(o.gasSpentWei, 5)}</td>
              <td className="n">{count(o.indexedTxs)}</td>
              <td className="n">{count(o.nonce)}</td>
              <td className={`n ${o.unindexedTxs > 0 ? "warn" : ""}`}>{count(o.unindexedTxs)}</td>
              <td className="n">{o.lastTxAt === null ? UNKNOWN : formatAge(now - o.lastTxAt)}</td>
              <td className="t-small muted">{topActions(o)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OperatorsBody({ data }: { data: AdminOperators }): React.JSX.Element {
  const { operators } = data;
  const unindexed = operators.reduce((acc, o) => acc + o.unindexedTxs, 0);
  const flagged = operators.filter((o) => o.unindexedTxs > 0);
  if (operators.length === 0) return <StateBlock kind="empty" title="No operator wallets configured" body="Set ADMIN_OPERATORS on the analytics service to label our wallets." />;
  return (
    <>
      <KpiStrip label="Operator totals">
        <Kpi label="Operator wallets" value={count(operators.length)} sub="Labeled in config" />
        <Kpi label="Gas spent" value={eth(sumWei(operators, (o) => o.gasSpentWei))} sub="In range, all wallets" />
        <Kpi label="Combined balance" value={eth(sumWei(operators, (o) => o.balanceWei))} sub="Now" />
        <Kpi label="Unindexed transactions" value={count(unindexed)} sub="Nonce minus indexed" tone={unindexed > 0 ? "warning" : undefined} />
      </KpiStrip>
      {flagged.length > 0 ? (
        <div className="notice" data-tone="warning" role="status">
          <Warning size={16} />
          <span>
            {`${flagged.map((o) => o.label).join(", ")} sent ${count(unindexed)} ${unindexed === 1 ? "transaction" : "transactions"} that emitted no protocol event. These are usually reverts, approvals or plain transfers. Open the wallet on the explorer to check them.`}
          </span>
        </div>
      ) : null}
      <OperatorsTable operators={operators} />
    </>
  );
}

export function OperatorsView(): React.JSX.Element {
  const range = useAdminRange();
  const operators = useAdminOperators(range);
  return (
    <>
      <AdminPageHead title="Operators" lede={`${RANGE_LABEL[range]} for gas and actions. Balances and nonces are read now. These are Rooq's own wallets, which are public by design.`} />
      <Loaded query={operators} fallback={<TableSkeleton label="Loading operator wallets" rows={7} />}>
        {(data) => <OperatorsBody data={data} />}
      </Loaded>
    </>
  );
}
