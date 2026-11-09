import { DOCS_URL } from "./site";

export const INTRODUCTION_SLUG = "introduction";

export interface DocPage {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
}

export interface DocSection {
  readonly title: string;
  readonly pages: readonly DocPage[];
}

export const DOC_SECTIONS: readonly DocSection[] = [
  {
    title: "Start here",
    pages: [
      { slug: INTRODUCTION_SLUG, title: "What is Rooq", description: "Private spot and matched-pair perps for stock tokens on Robinhood Chain testnet." },
      { slug: "getting-started", title: "Getting started", description: "Connect a wallet, get test funds, and create your private account with one signature." },
    ],
  },
  {
    title: "Your money",
    pages: [
      { slug: "private-balances", title: "Private balances", description: "Shield tokens, send them privately and unshield them back to a public address." },
    ],
  },
  {
    title: "Trading",
    pages: [
      { slug: "spot", title: "Spot and routing", description: "Swap tokens privately through Rooq pools, with a minimum you set and a refund if nothing fills." },
      { slug: "perps", title: "Perps", description: "Go long or short with leverage. How matching, margin and position changes work." },
      { slug: "funding-and-fees", title: "Funding and fees", description: "What you pay to hold and trade a position, who receives it and when." },
      { slug: "closing-and-liquidation", title: "Closing and liquidation", description: "Close on your own, what happens when margin runs out, and the forced exit." },
    ],
  },
  {
    title: "Providing",
    pages: [
      { slug: "liquidity", title: "Liquidity", description: "Add to a spot pool privately and earn its fee. What you risk and how to leave." },
      { slug: "makers", title: "Makers", description: "Back private perps from your private balance and set the spreads you commit to." },
      { slug: "create-a-market", title: "Creating a market", description: "How a market is added, and what a token needs before it can trade." },
    ],
  },
  {
    title: "Privacy and safety",
    pages: [
      { slug: "how-privacy-works", title: "How privacy works", description: "Exactly what the public, your maker, the risk workers and you can each see." },
      { slug: "recovery", title: "Recovery", description: "Get back into your account on any device, and what happens while you are away." },
      { slug: "risks", title: "Risks", description: "What can go wrong on Rooq, in plain terms. Read this before you trade." },
    ],
  },
  {
    title: "Builders",
    pages: [
      { slug: "contracts", title: "Contracts", description: "Every Rooq contract, the fixed numbers inside them and how to check them yourself." },
      { slug: "api-and-sdk", title: "API and SDK", description: "The private read API, the relayer and the TypeScript SDK." },
    ],
  },
  {
    title: "Reference",
    pages: [
      { slug: "faq", title: "Frequently asked questions", description: "Short answers to what people ask most about Rooq." },
      { slug: "glossary", title: "Glossary", description: "The words used on Rooq and in these docs." },
      { slug: "terms", title: "Terms of use", description: "The terms for using Rooq on testnet." },
      { slug: "privacy-policy", title: "Privacy policy", description: "What Rooq collects, what it does not, and what your browser keeps." },
    ],
  },
];

export interface IndexedDocPage extends DocPage {
  readonly section: string;
  readonly path: string;
  readonly url: string;
}

export function docPath(slug: string): string {
  return slug === INTRODUCTION_SLUG ? "/" : `/${slug}`;
}

export const DOC_PAGES: readonly IndexedDocPage[] = DOC_SECTIONS.flatMap((section) =>
  section.pages.map((page) => ({ ...page, section: section.title, path: docPath(page.slug), url: `${DOCS_URL}${docPath(page.slug)}` })),
);
