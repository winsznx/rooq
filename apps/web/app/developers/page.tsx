import type { Metadata } from "next";
import { docsUrl } from "@rooq/config";
import { ArticleShell, PublicPage } from "@/components/public/public-chrome";
import { PRIVATE_READ_URL, PRIVATE_RELAYER_URL } from "@/lib/private/config";

export const metadata: Metadata = { title: "Developers", description: "Build on Rooq: the private read API, relayer, SDK, contracts and proof circuits for stock token markets on Robinhood Chain testnet.", alternates: { canonical: "/developers" } };

const READ_ROUTES: readonly [string, string][] = [
  ["GET /v1/sync", "How far the service has read the chain"],
  ["GET /v1/deployment", "Deployment ID, addresses and public keys"],
  ["GET /v1/records", "Encrypted records, by page"],
  ["GET /v1/tree/path/:index", "A proof path for one note tree leaf"],
  ["POST /v1/nullifiers", "Whether notes are spent"],
  ["GET /v1/spot/pools", "Pool list"],
  ["POST /v1/spot/quote", "A rounded swap estimate"],
  ["GET /v1/markets", "All markets, with price and funding"],
  ["GET /v1/markets/:id/funding", "A market's funding history"],
];

const RELAYER_ROUTES: readonly [string, string][] = [
  ["POST /v1/relay/:action", "Submits a proof you have already made"],
  ["GET /v1/jobs/:id", "Status of a submission"],
  ["GET /v1/relayer", "Fee address and minimum fees"],
];

const SDK_EXAMPLE = `import { addressOf, deriveKeys, scanCreated } from "@rooq/private-sdk";

const keys = deriveKeys(seed);                     // keep the seed on the client
const privateAddress = addressOf(keys);            // share this to receive transfers
const notes = scanCreated(keys, deploymentId, events); // decrypt your notes locally`;

function RouteTable({ rows }: { rows: readonly [string, string][] }) {
  return (
    <div className="panel table-scroll">
      <table className="table">
        <tbody>
          {rows.map(([route, what]) => (
            <tr key={route}>
              <td className="num t-small">{route}</td>
              <td className="t-small" style={{ whiteSpace: "normal" }}>
                {what}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Developers() {
  return (
    <PublicPage>
      <ArticleShell index={[{ id: "read-api", label: "Read API" }, { id: "relayer", label: "Relayer" }, { id: "sdk", label: "SDK" }]} source="Testnet only. Rooq has not been audited.">
        <h1 className="t-page">Developers</h1>
        <p>
          Rooq&apos;s services return only public chain data and encrypted records. Your keys and proofs stay on the client. The full reference is on the docs site: <a href={docsUrl("api-and-sdk")}>API and SDK</a>.
        </p>
        <h2 id="read-api" className="t-section">Read API</h2>
        <p>{`Base URL: ${PRIVATE_READ_URL}. It holds no keys and keeps no per-client state.`}</p>
        <RouteTable rows={READ_ROUTES} />
        <h2 id="relayer" className="t-section">Relayer</h2>
        <p>{`Base URL: ${PRIVATE_RELAYER_URL}. It submits proofs and pays gas, and it can't sign for anyone.`}</p>
        <RouteTable rows={RELAYER_ROUTES} />
        <h2 id="sdk" className="t-section">SDK</h2>
        <pre className="code">
          <code>{SDK_EXAMPLE}</code>
        </pre>
      </ArticleShell>
    </PublicPage>
  );
}
