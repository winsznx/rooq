/** What each observer can see. One table drives the lens on the privacy page and the plain-text version search reads. */

export type Reach = "sees" | "partly" | "hidden";

export interface Observer {
  readonly id: string;
  readonly label: string;
  readonly intro: string;
}

export interface VisibilityRow {
  readonly item: string;
  readonly cells: Readonly<Record<string, readonly [Reach, string]>>;
}

export const OBSERVERS: readonly Observer[] = [
  { id: "public", label: "Public chain", intro: "Anyone can read Robinhood Chain. This includes people who trade on Rooq just to watch others." },
  { id: "you", label: "You", intro: "Your device decrypts your own account from chain data. Nobody needs to hand it to you." },
  { id: "maker", label: "Your maker", intro: "The maker on the other side of your position. It sees that one position and nothing else about you." },
  { id: "risk", label: "Risk workers", intro: "Two services, each with its own key, that watch positions so they can be liquidated while you are offline." },
  { id: "coordinator", label: "Coordinator", intro: "The service that matches locks and fills spot intents. It can only act inside the limits you signed." },
  { id: "relayer", label: "Relayer", intro: "It pays gas and submits your proofs. It only sees what is about to become public." },
];

const row = (item: string, cells: VisibilityRow["cells"]): VisibilityRow => ({ item, cells });

export const VISIBILITY_ROWS: readonly VisibilityRow[] = [
  row("Shielding and unshielding", {
    public: ["sees", "The wallet or recipient, the token, the amount and the time."],
    you: ["sees", "Full details."],
    maker: ["sees", "The same public details as anyone else."],
    risk: ["sees", "The same public details as anyone else."],
    coordinator: ["sees", "The same public details as anyone else."],
    relayer: ["sees", "The same public details, for the unshields it submits."],
  }),
  row("Your private balance", {
    public: ["hidden", "Only commitments and encrypted data."],
    you: ["sees", "Every note, on your device."],
    maker: ["hidden", "No access."],
    risk: ["hidden", "No access."],
    coordinator: ["hidden", "No access."],
    relayer: ["hidden", "No access."],
  }),
  row("Private transfers", {
    public: ["hidden", "Not the amount, the token or either person."],
    you: ["sees", "Yours, sent and received."],
    maker: ["hidden", "No access."],
    risk: ["hidden", "No access."],
    coordinator: ["hidden", "No access."],
    relayer: ["partly", "Its own fee note. Not the payment."],
  }),
  row("A position's size, side, entry and margin", {
    public: ["hidden", "Only that a position opened or changed in a market."],
    you: ["sees", "Full details."],
    maker: ["sees", "The positions it is on the other side of."],
    risk: ["partly", "What is needed to check health, against one-time addresses."],
    coordinator: ["partly", "The terms of each lock it matches, against one-time addresses."],
    relayer: ["hidden", "Only proofs and encrypted data."],
  }),
  row("Which maker backs a fill", {
    public: ["hidden", "Not published per fill."],
    you: ["hidden", "A taker cannot see who backs its position."],
    maker: ["sees", "Its own fills."],
    risk: ["partly", "A one-time address, not a stable identity."],
    coordinator: ["partly", "A one-time address, not a stable identity."],
    relayer: ["hidden", "No access."],
  }),
  row("Funding on a position", {
    public: ["partly", "The market's funding index each period. Never your own payment."],
    you: ["sees", "Owed, paid and any shortfall."],
    maker: ["sees", "Its own positions."],
    risk: ["sees", "The positions it can read."],
    coordinator: ["partly", "The funding index and the positions it settles."],
    relayer: ["hidden", "No access."],
  }),
  row("Liquidations", {
    public: ["partly", "That a position in a market was liquidated, and the price. No amounts."],
    you: ["sees", "Your full receipt."],
    maker: ["sees", "Its own positions."],
    risk: ["sees", "The positions it liquidates."],
    coordinator: ["hidden", "No amounts from positions it did not settle."],
    relayer: ["hidden", "Risk workers submit their own."],
  }),
  row("Spot swaps", {
    public: ["hidden", "Only that a pool changed."],
    you: ["sees", "Full details."],
    maker: ["hidden", "Spot does not use makers."],
    risk: ["partly", "The swaps it fills, against one-time addresses."],
    coordinator: ["partly", "The swaps it fills, against one-time addresses."],
    relayer: ["hidden", "Only proofs and encrypted data."],
  }),
  row("Liquidity you provide", {
    public: ["hidden", "Only commitments and encrypted data."],
    you: ["sees", "Your share and history."],
    maker: ["hidden", "No access."],
    risk: ["partly", "The pool's reserves and its pool records, not your wallet."],
    coordinator: ["partly", "The pool's reserves and its pool records, not your wallet."],
    relayer: ["hidden", "No access."],
  }),
  row("Pool reserves and open interest", {
    public: ["partly", "Only rounded hourly totals that meet a privacy threshold."],
    you: ["partly", "Rounded quotes, and your own share."],
    maker: ["partly", "What it needs to back its fills."],
    risk: ["sees", "Full figures."],
    coordinator: ["sees", "Full figures."],
    relayer: ["hidden", "No access."],
  }),
  row("Prices, market rules and contract code", {
    public: ["sees", "Everything."],
    you: ["sees", "Everything."],
    maker: ["sees", "Everything."],
    risk: ["sees", "Everything."],
    coordinator: ["sees", "Everything."],
    relayer: ["sees", "Everything."],
  }),
];

const REACH_LABEL: Readonly<Record<Reach, string>> = { sees: "Can see", partly: "Partly", hidden: "Cannot see" };

export function reachLabel(reach: Reach): string {
  return REACH_LABEL[reach];
}

export function visibilityMarkdown(): string {
  const header = `| What | ${OBSERVERS.map((o) => o.label).join(" | ")} |`;
  const divider = `| --- | ${OBSERVERS.map(() => "---").join(" | ")} |`;
  const rows = VISIBILITY_ROWS.map((r) => `| ${r.item} | ${OBSERVERS.map((o) => {
    const cell = r.cells[o.id];
    return cell ? `${reachLabel(cell[0])}. ${cell[1]}` : "";
  }).join(" | ")} |`);
  return [header, divider, ...rows].join("\n");
}
