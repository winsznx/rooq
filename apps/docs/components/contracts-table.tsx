import { EXPLORER_URL, ROOQ_CONTRACTS, THIRD_PARTY_CONTRACTS, type ContractRow } from "@/lib/deployment";
import styles from "./docs.module.css";

function Table({ caption, rows }: { caption: string; rows: readonly ContractRow[] }) {
  return (
    <div className="doc-table">
      <table>
        <caption className={styles.tableCaption}>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Contract</th>
            <th scope="col">What it does</th>
            <th scope="col">Address</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <th scope="row">{row.name}</th>
              <td>{row.role}</td>
              <td>{row.address ? <a className={styles.address} href={`${EXPLORER_URL}/address/${row.address}`}>{row.address}</a> : "Published at launch"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ContractsTable() {
  return (
    <div className={styles.contracts}>
      <Table caption="Rooq contracts" rows={ROOQ_CONTRACTS} />
      <Table caption="Tokens Rooq uses. These belong to other projects." rows={THIRD_PARTY_CONTRACTS} />
    </div>
  );
}
