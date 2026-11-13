# Rooq UI/UX audit and redesign proposal

Date: 8 November 2026.

Status: review and proposed direction. No runtime UI changes have been made for this audit. This document does not supersede the approved product/privacy requirements or authorize implementation by itself.

## 1. Recommendation

Build Rooq around the experience of a precise, private trading instrument. Give the public site a memorable visual story, the account overview a clear hierarchy, and the terminal stable, efficient controls. Treat motion, component states and mobile behavior as part of the design system.

Keep the useful foundation: Instrument Sans, IBM Plex Mono for financial data, white/carbon surfaces, restrained copper, explicit Spot/Perps separation, real figures, and honest testnet labeling. Change the composition, component detailing, interaction continuity and account journeys substantially. Adding entrance animations to the existing boxes would leave most of the product's weaknesses intact.

The private V1 addendum (in the private product spec) remains authoritative. A redesign must support its complete lifecycle and visibility boundary. These recommendations do not add an order book, cross-margin, conditional orders or another financial product.

## 2. Evidence and review limits

Reviewed current route/component source across the public site, app shell, trading, portfolio, markets, swap, liquidity, maker, creator, activity, settings and education/status surfaces. Inspected saved desktop/mobile captures in both themes and connected trading-flow captures. Compared the source with existing screen, brand and motion specifications.

The local web server was running, but browser discovery returned no available browser. Consequently, no fresh live walkthrough, keyboard/screen-reader result, frame-rate measurement or current viewport certification is claimed. Screenshots are archived fixtures; source findings are a snapshot while another coding agent is working on privacy.

Representative inspected captures:

- [Desktop landing](screenshots/matrix/home_1440_dark.png) and [mobile landing](screenshots/matrix/home_390_light.png).
- [Markets](screenshots/matrix/app_markets_1440_dark.png) and [disconnected portfolio](screenshots/matrix/app_portfolio_1440_dark.png).
- [Desktop perps](screenshots/matrix/app_trade_TSLA_mode_perps_1440_light.png) and [mobile perps](screenshots/matrix/app_trade_TSLA_mode_perps_390_dark.png).
- [Connected review](screenshots/flow/04-review.png) and [connected position flow](screenshots/flow/06-position.png).

External research used first-party product pages, documentation, designer descriptions and indexed previews. Some Behance projects and the Figma Community file were inaccessible to direct inspection. Reference-specific limitations are recorded below. Concept artwork is not evidence that its interactions work in production.

## 3. Findings

Priority describes the redesign work's impact: P1 affects financial understanding, continuity or required privacy workflows; P2 affects product clarity, completeness or visual quality. These are UX findings, not protocol audit severities.

| ID | Priority | Finding and evidence | Recommended treatment |
|---|---|---|---|
| UI-01 | P2 | The landing uses a familiar headline/CTA/example-card composition followed by explanatory sections. Its central story remains the original Spot/Perps distinction; the new private-product proposition is absent. See [landing](../apps/web/app/page.tsx), [layout](../apps/web/components/public/landing.module.css) and desktop/mobile captures. | Create an original interactive market illustration and a short privacy narrative. Keep the dual-engine distinction, but make the value and disclosure boundary understandable from the first two screens. Publish privacy claims only when supported by the implementation. |
| UI-02 | P2 | App entry is mainly a last-market panel and balances list. It does not establish a strong account overview. `/app` is also absent from the primary navigation, while the wordmark links to the public home. See [AppEntry](../apps/web/app/app/app-entry.tsx), around lines 39–135, and [AppShell](../apps/web/components/shell/app-shell.tsx), lines 40–63. | Give Overview an explicit place in navigation and organize it around available funds, positions needing attention, pending operations and continuation of the user's work. |
| UI-03 | P2 | The disconnected portfolio is almost entirely a heading, sentence and Connect button. The connected view gives four summary panels similar weight. See [portfolio](../apps/web/app/app/portfolio/portfolio-view.tsx), lines 26–85. | Design distinct first-use, disconnected, locked, syncing, empty and active states. Establish one primary financial summary with clearly subordinate supporting figures and next actions. |
| UI-04 | P1 | `ChartPanel` removes and recreates its chart when the trades/oracle array dependencies change, then calls `fitContent()`. This risks losing zoom/pan context as data changes. See [chart-panel](../apps/web/components/trade/chart-panel.tsx), lines 32–66. | Retain the chart instance and update its data while preserving viewport/context. Reset deliberately on an actual market change. Verify the behavior live; its frequency and performance impact have not been measured here. |
| UI-05 | P2 | Desktop trading gives substantial space to a separate capacity/recent-fills column while the ticket repeats many equally weighted financial rows. At lower desktop heights, useful position content can fall below the first viewport. See [trade layout](../apps/web/components/trade/trade.module.css), lines 213–255, and connected captures. | Prioritize chart, execution and positions. Make market capacity a concise disclosure, expand details on demand, and use the required private replacement for the public fill tape. |
| UI-06 | P1 | In the 390px perps capture, roughly half the initial screen is consumed before the ticket begins. Header, environment information, metadata, local tabs, sticky action and bottom navigation compete for space. | Use a compact instrument header and expandable market facts. Design the ticket and review sheet specifically for a phone. Verify keyboard-open, short-height and safe-area states before acceptance. |
| UI-07 | P1 | Transaction progress handles simulation, wallet, submission and confirmation, but has no private-proof, queue or recovery stages. The shell has no persistent operation center. See [TxProgress](../apps/web/components/feedback/tx-progress.tsx), lines 10–20, and [AppShell](../apps/web/components/shell/app-shell.tsx). | Add a persistent operation dock/center with resumable status, actual stage, elapsed time, expiry and safe actions. It must survive navigation and reflect canonical operation status. |
| UI-08 | P2 | Motion is present in the landing instrument, dialogs, quotes, countdown, toasts and transaction text. It is localized, with no cohesive relationship between page navigation, selection, review and completion. The motion specification (in the private product spec) intentionally constrains expressive treatment. | Propose an explicit revision to the motion system. Separate expressive public storytelling from short, functional trading transitions. Preserve the existing `MotionConfig reducedMotion="user"` in [providers](../apps/web/lib/providers.tsx). |
| UI-09 | P1 | Portfolio has no explicit account-query error branch; missing data falls through to empty arrays for positions/holdings/LPs. An unavailable account can therefore be presented like an empty one in some states. See [portfolio](../apps/web/app/app/portfolio/portfolio-view.tsx), lines 20, 48–49 and 105. | Model unavailable, loading, locked, stale and genuinely empty separately. Show freshness and a recovery action; never imply a zero holding because data could not be read. |
| UI-10 | P1 | Current UI exposes address-based position views, individual fills and raw reserve/capacity data. See [position detail](../apps/web/app/app/positions/[accountId]/[marketId]/position-detail.tsx), [chart](../apps/web/components/trade/chart-panel.tsx) and [pool list](../apps/web/app/app/liquidity/pools-list.tsx). | Replace these according to the privacy addendum. A new visual treatment must not preserve incompatible feeds, wallet identifiers in private URLs or reconstructible public account history. |
| UI-11 | P2 | Settings contains theme, slippage and a language note. The original ST01 calls for saved watchlists and notification/risk preferences; those were not found in the inspected frontend search. Private-key/session/recovery controls also need their new V1 workflow. See [settings](../apps/web/app/app/settings/settings-view.tsx) and ST01 (in the private product spec). | Design settings as Appearance, Trading preferences, Privacy/access, Backup/recovery and Notifications. Implement only real supported controls, with safe defaults and explicit notification permissions. |
| UI-12 | P2 | Some local tabs declare `tablist`/`tab` roles but lack associated panel IDs/`aria-controls` and explicit arrow-key focus handling in their implementations. See [portfolio](../apps/web/app/app/portfolio/portfolio-view.tsx), lines 88–105, and [mobile trade tabs](../apps/web/components/trade/trade-view.tsx), lines 76–94. | Implement the complete tab behavior and verify it with a keyboard/screen reader. Retain ordinary button/group semantics where controls are filters rather than tabs. Use the [WAI tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) as the reference. |

Retain existing strengths: restrained palette, tabular financial figures, responsive market-list alternatives, labeled test fixtures, separate holdings/exposure, differentiated settlement finality, Radix dialogs, real preflight reasons, and reduced-motion configuration. These are valuable foundations.

The archived review screenshot has a partially transparent dialog. The source animates whole-dialog opacity and its final surface is opaque. This may be a capture during entry; verify the settled dialog and transition before calling it a persistent transparency defect. Financial review text should become readable promptly and remain stable.

## 4. Reference board: what to learn and what to leave behind

The following are references for particular decisions, not templates to copy. The resulting Rooq layouts, component geometry, wording and assets should be original.

| Reference | Evidence/access | Useful principle for Rooq | Boundary |
|---|---|---|---|
| [Excited — SpendHub hero animation, Dribbble](https://dribbble.com/shots/27537988-Fintech-SaaS-Website-Hero-Section-Animation) | Designer's page and description accessed; motion playback not tested | Make the product demonstration the centerpiece of the hero and direct motion toward the explanation/CTA | Do not transplant the blue SaaS identity, content or animation sequence |
| [QUARTE / Ivan Poddubchenko — Cryptocurrency Trading Platform, Dribbble](https://dribbble.com/shots/22889852-Cryptocurrency-Trading-Platform) | Indexed image preview; full page unavailable | Maintain a strong central chart with account/watchlist information in supporting regions | Decorative performance data and unfamiliar order features are not Rooq requirements |
| [Openware — FrontDEX, Dribbble](https://dribbble.com/shots/17851293-FrontDEX-Crypto-Trading-UI-UX-Design-Kit-by-Openware) and [Figma Community file](https://www.figma.com/community/file/1081520624421222872) | Author documents a design system, 40+ screens and desktop/mobile coverage; Community file could not be inspected | Treat the whole product as a component-and-state system, including small controls and both device classes | Useful as an inventory reference, not a ready-made Rooq theme; no claim that its variants were inspected |
| [Figma dashboard templates](https://www.figma.com/templates/dashboard-designs/) | Official directory accessed | Compare composition and responsive component inventories before locking account-dashboard structure | Do not adopt an unrelated template's metrics, palette or decorative widgets |
| [Cryptocurrency Exchange and Desktop/Mobile Trading, Behance](https://www.behance.net/gallery/57457931/Cryptocurrency-Exchange-and-DesktopMobile-Trading) | Indexed Cryptonite preview; full case study returned 403 | Distinguish account summary/history from markets and open positions; treat dashboard and terminal as separate tasks | No verified usability or interaction result from the preview; do not copy public trade history into a private product |
| [Kraken Pro interface guide](https://support.kraken.com/articles/kraken-pro-trading-interface-guide?mode=consumerapp) | First-party guide accessed | Consistent market context, efficient portfolio access, helpful explanations and layouts suited to different information density | Rooq's RFQ/CPMM model does not become an order-book exchange; full free-form workspace customization is not needed for this redesign |
| [Coinbase Advanced](https://www.coinbase.com/advanced-trade) | Public product page and desktop/mobile presentation referenced; no signed-in test | Keep discovery, analysis, execution and account management visually connected | Its product breadth, leverage, claims and order types must not be imported |
| [Paradex](https://www.paradex.trade/) and [its privacy explanation](https://docs.paradex.trade/trading/privacy) | First-party pages accessed | Put the privacy proposition prominently in the product story and make the disclosure boundary discoverable | Rooq must use its own exact maker/risk-service/public-transfer disclosures; broad marketing claims are not transferable |
| [Hyperliquid](https://hyperliquid.xyz/) | Public homepage accessed; trading app returned no readable content in this environment | Make the market scope and Trade/Build entry paths obvious | No claim of an interactive terminal audit; do not imitate its identity or use it to justify unsupported features |

## 5. Proposed visual direction

### Composition and typography

Keep the existing white/carbon/copper territory, but use stronger contrast in scale and structure. Public pages can have generous editorial spacing, an oversized headline and an original diagram. The app should use compact headings, reliable alignment, carefully weighted financial figures and fewer competing borders.

Retain Instrument Sans for navigation, explanations and headings, and IBM Plex Mono for financial figures where it improves comparison. Preserve tabular numerals. Typography should distinguish action, outcome and explanation without requiring every value to live in its own card. Keep important inputs legible on mobile and test text enlargement.

Use the existing 4px spacing lattice. Give borders a purpose: panel edges, separation of totals, input boundaries and state markers. Use copper sparingly for primary actions and selection, with green/red reserved for directional or financial meaning. Keep symbols/signs and text alongside semantic color.

### A recognizable component family

I would prototype a restrained clipped-corner treatment on primary action surfaces, a consistent short copper selection marker, and aligned horizontal rules in tickets/receipts. Carry this language through buttons, market selectors, tabs and operation states. Limit it to places that carry meaning; do not put decorative ticks around every card.

Use ordinary accessible control semantics and stable hit areas. A distinctive button should still be immediately recognizable as a button. Keep a common geometry across the product rather than inventing a new shape for every screen.

The wordmark remains typographic until a separate identity study is approved. A refined custom wordmark and small-size mark are worthwhile design deliverables; a randomly generated shield or letter tile is not an approved identity.

## 6. Screen redesigns I would implement

### Landing and explanation

Proposed hero structure: a short privacy-led headline, one sentence explaining private spot/perps, a clear testnet CTA, a secondary interactive explanation, and a large original market instrument. A candidate headline is “Your position. Your business.” Pair it with precise supported language; do not launch it as a claim before the private implementation passes its gates.

The instrument has two deliberate user controls: Spot/Perps and “What can others see?”. Spot shows owned assets; Perps shows exposure and collateral. Switching the observer view explains public boundary transfers, private internal state and scoped maker/risk visibility. Use synthetic values explicitly marked as an illustration, or authorized real data with provenance. Never use an unrelated live user's account.

A short optional demonstration moves through funding, private execution and receipt. It should play once or on request, be pausable when necessary, and have a static reduced-motion equivalent. Text and CTA are usable immediately. Do not hide the whole page behind a reveal or hijack scrolling.

Below the hero: a clear privacy explanation; the Spot/Perps distinction; a readable product walkthrough; market availability using only permitted public data; recovery/risk explanation; maker/creator paths; docs and a truthful testnet footer. Vary section composition so the page develops a story instead of repeating cards. The first sections must answer what Rooq is, why privacy matters, and what remains visible.

### Account overview and portfolio

Make `/app` an Overview with an explicit navigation item. Give it three clear jobs: understand available capital, see what needs attention, and resume work.

The upper region shows the primary account summary with a defined valuation basis and actions to fund/withdraw. Supporting figures distinguish available, reserved, in positions, LP claims and pending exit. Display exposure separately; never add leveraged notional to account value. If a defensible total cannot be computed, show its components and the missing valuation instead.

The main region contains the user's positions and actions requiring attention. A smaller supporting region holds watchlist, recent private activity and recoverable pending operations. A history chart is appropriate only when authentic private history and valuation semantics exist. An empty account gets useful setup/restore/funding guidance, not fabricated performance.

Separate connection from private-account unlocking. Returning, locked, syncing, unavailable and empty accounts must look different and offer the right next action. A hide-values control is useful for shoulder-surfing; it does not change protocol confidentiality. Labels must make that distinction clear.

### Trading and position detail

Use a compact market header, a dominant chart region, a consistently placed order ticket and a readable position tray. Preserve chart state during data updates and routine navigation. Move secondary market facts into a concise expandable area; retain freshness and risk-critical information beside the action.

The ticket should have a clear reading order: Spot/Perps context, direction, amount, leverage where applicable, exact quote, cost/margin summary, review action. Make the quoted price and its validity visually distinct from the oracle mark and an indicative estimate. Show limits and changed-economics states close to the fields that caused them.

Position detail should lead with side/size, actual equity/margin and the user's next permitted actions. A linear entry/mark/liquidation illustration can help, provided it uses the approved model, supports long and short correctly, labels estimates and never suggests a guaranteed exit. Funding, fees, maker disclosures and history remain accessible without dominating the top of the page.

The private terminal cannot inherit a public account-linked tape or conventional public depth visualization. Use approved reference data/aggregates and the owner's authenticated history. Any capacity estimate must respect the disclosure policy and be labeled as an estimate rather than an executable quote.

### Mobile

Give mobile its own composition. Keep the symbol, mode, price and essential status compact; put detailed market facts behind a labeled expansion. Preserve Chart/Trade/Position access while making the selected section appear promptly. Use stable bottom actions with keyboard-safe placement and sufficient scrolling clearance.

Review should be a legible sheet with the economic outcome first, costs/risk next, and a stable confirmation action. Test the minimum supported width, short heights, text zoom and keyboard-open state. No action should be hidden behind the navigation bar or a status toast.

### Private operation experience

Add an operation center available throughout the app. Its compact dock shows the number/state of pending operations without exposing financial details when locked. Expanding it reveals the authorized action, real stage, elapsed time, quote expiry when relevant, and permitted next actions.

Friendly stage labels can be “Preparing private trade”, “Waiting to submit”, “Submitted”, and “Confirmed”, backed by the complete state machine in the privacy addendum. Include rejected, expired, cancelled, rechecking and recovery-required paths. Keep confirmation and finality distinct. No fake percentage or guaranteed 30-second countdown.

The dock must persist through navigation/reload using the authorized private persistence model, not a new plaintext cache of account history. Retrying reconciles the existing operation first; changing price or bounds returns the user to review. Transaction progress is a core workflow, not a toast that disappears while the trade is still pending.

### Supporting product areas

Market discovery should support saved watchlists and useful filters, with compact rows and deliberate hover/focus states. Put primary market facts first and reveal asset identity/eligibility/details when needed. Do not fill discovery with synthetic volume or unsupported trend data.

Swap needs a purpose-built asset/amount interaction, route explanation and clear minimum received. Liquidity needs private claim value, composition, fee accounting and add/remove outcome previews. Makers need an operational capital view distinguishing free, committed, reserved and releasable funds. Creators need a guided, resumable launch process with persistent context, exact failed checks and direct repair actions.

Activity becomes a private economic ledger with receipt detail and scoped sharing. Settings houses privacy/access/recovery controls as well as visual/trading preferences. Status should tell users what is affected and which actions remain possible before presenting infrastructure detail. Learn/docs/developer content needs clear navigation, diagrams where useful, and source/version labels.

## 7. Buttons, controls and motion

### Component specification proposal

| Component | Proposed treatment | Required states/behavior |
|---|---|---|
| Primary action | Copper surface, compact geometry, one restrained corner detail and optional separated directional icon area | Default, hover, pressed, keyboard focus, disabled-with-reason, working, success and failure; stable width/label space; no double submission |
| Secondary action | Neutral surface/outline with the same geometry and typography | Clear hierarchy below the primary; visible in both themes; useful contrast without looking disabled |
| Long/short selection | Shared selector geometry, text plus directional color and selection indicator | Arrow-key/button semantics as appropriate; no reliance on green/red alone; selection cannot execute a trade |
| Financial confirmation | Exact verb and relevant amount/side, supported by a readable review summary | Repriced/expired states stop confirmation; a check mark appears only after the corresponding real state |
| Destructive/recovery action | Explicit wording, appropriate risk tone and context | No ambiguous close icon for a financial action; confirm actual consequences without adding ritual to harmless navigation |
| Amount input | Strong numeric type, unit/asset affordance, secondary available amount, inline validation | Locale/paste/precision handling, clear Max semantics, keyboard support, no destructive formatting while typing |
| Tabs and market selector | Short copper marker and consistent focus/selection geometry | Complete focus/keyboard behavior, stable panel sizing, preserved intent, no remote-value change hidden by motion |
| Receipt | Original ruled layout that emphasizes deltas, costs and outcome | Decrypted details, inclusion linkage, provenance/finality and opt-in scoped export |
| Empty/error/loading | Purpose-designed composition with explicit status and next action | Locked, absent, stale and unavailable are distinct; skeleton geometry matches content; no counterfeit data |

The clipped corner is a prototype direction, not a frozen token. Validate readability, hit area and focus outline before adopting it. Keep touch targets at least the existing 44px design minimum and preserve complete clickable areas even if the visual surface is clipped.

### Motion choreography proposal

These are proposed design timings, not measured performance results. Tune them with real device testing.

| Event | Proposed timing | Behavior |
|---|---|---|
| Button hover/press | 100–140ms | Small surface/contrast change; optional 1px press or 2px icon movement; no moving target |
| Active tab/selection | 160–200ms | Marker moves between known positions; data labels stay crisp; no long exit delay |
| Content navigation | 160–220ms | Small content-only transition with persistent shell; do not remount chart/ticket or erase input state to animate |
| Desktop review / mobile sheet | 220–280ms | Controlled entrance, stable reading surface and immediate focus management; no bounce on financial confirmation |
| Hero instrument change | 350–500ms | Coordinated movement of the original explanatory visual; text/CTA remain available |
| Public section emphasis | 250–400ms, used sparingly | Optional small reveal or diagram transition; no compulsory stagger on every paragraph/card |
| Operation stage change | 180–220ms | Progress marker and label move once on a real event; accessible announcement does not repeat on every tick |
| Price, risk and PnL updates | Immediate value update | Preserve numeric truth and alignment; optional restrained status indication, no rolling digits or interpolated financial values |

Retain the installed Motion library and existing reduced-motion provider. Use CSS for small hover/focus changes and Motion for coordinated layout/state changes where it is useful. An additional animation stack is not required by this proposal. Do not add smooth-scroll interception, particle backgrounds, cursor-following buttons or perpetual decorative loops to the trading workspace.

Reduced motion keeps all information and state changes while removing unnecessary movement. Tab switching, authentication, review and errors must never depend on watching an animation. All animated states need their static equivalent in the component catalogue.

## 8. Full surface coverage

All 37 existing screen IDs remain in scope. This matrix maps every surface to a proposed redesign treatment. It is a coverage plan, not a claim that every state has been exercised live.

| Screens | Treatment |
|---|---|
| L01, L02 | Original landing instrument, privacy/dual-engine story and interactive explanation |
| A01 | Account overview, setup/restore states, attention items and pending operations |
| M01, M02 | Market discovery/watchlists and asset identity with readable eligibility/status |
| T01, T02 | Shared terminal family with distinct spot/perp economics, stable chart and purpose-built tickets |
| S01 | Focused asset/amount swap flow with honest routing, quote and receive bounds |
| P01, P02, P03 | Private portfolio hierarchy, position management and economic activity/receipts |
| LQ01, LQ02 | Liquidity discovery and private claim/composition/add/remove experience |
| C01, C02, C03, C04, C05, C06, C07 | Guided creator journey: intro, asset, seed, leverage, exact preflight, review, actual launch result |
| MK01, MK02 | Maker capital/capacity operations, reservations and market-specific controls |
| AC01, AC02, AC03 | Connection, wrong network and versioned leverage/privacy disclosure |
| AC04, AC05 | Shield/unshield and margin flows with available/locked distinctions and recovery |
| AC06, AC07 | Legible order review and durable verifiable private receipt |
| AC08 | Searchable accessible asset selector with real identity/provenance |
| ST01, ST02 | Complete settings/privacy/recovery preferences and user-oriented operational status |
| ED01, ED02, ED03 | Clear educational, protocol and developer information architecture |
| F01, F02 | Consistent but context-specific errors, empty, locked, syncing and unavailable states |

## 9. Implementation order I recommend

These are internal work stages for one complete redesign, not a reduced public release.

1. **State and layout contract.** Agree how private account/operation states map to the UI. Correct chart continuity, ambiguous empty/error behavior, tab semantics and mobile action visibility. Define component tokens and state coverage before reskinning pages.
2. **Three representative designs.** Develop landing, active account overview and perps terminal at desktop and mobile sizes, in both themes. Include one locked/error state and the full review/pending/receipt sequence. Validate the visual family across these before spreading it.
3. **Shared components and motion.** Implement button/input/selector/dialog/receipt/operation primitives with accessibility and reduced-motion behavior. Test components in real financial flows; attractive static components alone are insufficient.
4. **Complete surface rollout.** Apply the system to all 37 surfaces, including LP, maker, creator and recovery. Keep the full private V1 requirement mapping intact.
5. **Verification and refinement.** Record actual walkthroughs, motion behavior and performance on realistic data/devices. Refine density and timing from these observations before claiming the redesign complete.

Coordinate with the privacy coding agent through state/API contracts. The visual work must not invent public data endpoints or create a competing financial state machine. Keep screenshots/fixtures clearly labeled and use synthetic test identities in design demonstrations.

## 10. Acceptance evidence for the redesign

- Every surface in section 8 has a design and implemented state inventory: initial, loading, empty, locked/unavailable where applicable, active, error and relevant pending/recovery states.
- Verify 320/390/768/1440/1920 widths, short viewport heights, both themes, 200% zoom, reduced motion and mobile keyboard-open behavior. No hidden confirmation action or unintended page-level horizontal scroll.
- Use keyboard and screen-reader walkthroughs for navigation, tabs, asset selectors, dialogs, trade review, notifications and recovery. Check focus restoration and accessible status announcements.
- Demonstrate chart zoom/pan and user input surviving ordinary data updates, quote refreshes and unrelated navigation/state changes. A route animation must not reset financial intent.
- Demonstrate a delayed private operation through navigation, refresh, rejected signature, quote expiry, reconnection, reorg and recovery. No fake finality, duplicate execution or disappearing pending claim.
- Check information disclosure across screen, URL, clipboard/share/export and notifications. Showing a hidden-value icon does not replace protocol privacy.
- Record performance traces on declared devices. Target responsive interaction and stable geometry; set and report actual LCP/INP/CLS and animation budgets rather than claiming smoothness from a desktop recording alone.
- Compare real fees, balances, realized/unrealized PnL, funding and liquidation estimates against authorized underlying state. Art direction must not change financial meaning.
- Review landing copy, testnet labels, diagrams and testimonials/metrics for truthful provenance. Keep unsupported privacy, execution, volume and audit claims out of the release.

The result should be recognizable as Rooq through its layout, typography, components and behavior, while remaining easy to understand under the pressure of a trading decision.
