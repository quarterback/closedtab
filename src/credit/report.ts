import { domainEvents, foldDomain, MARKS, type Mark, type TraceEntry } from "./engine.js";
import {
  MIN_HISTORY, SCORE_MAX, SCORE_MIN, TIER_LINES,
  bandFor, effectiveTier, grantAvailable, scoredEvents,
  type CreditEvent, type CreditReport, type DomainCredit, type InquiryEvent,
} from "./types.js";

/**
 * The printable agent credit report: one page per product, laid out the way
 * a consumer credit report is (scores and the reasons behind them, accounts,
 * a payment history grid, inquiries, adverse items, how to dispute).
 *
 * Print rules: reads in black and white, prints on letter and A4, tabular
 * figures for every number, system fonts, nothing that needs color to read.
 */
export interface ReportOptions {
  /** Only this product. */
  productId?: string;
  /** When the report was prepared. Defaults to now. */
  now?: Date;
  /** Where the record lives, as the person should see it. */
  recordLabel?: string;
}

const HISTORY_CELLS = 24;
const INQUIRY_ROWS = 12;

function esc(text: unknown): string {
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
function dayTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}
function monthDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function points(change: number): string {
  const n = Math.round(change);
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return "0";
}
function list(xs: string[]): string {
  return xs.length ? xs.map(esc).join(", ") : "None";
}
function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

interface Account {
  domain: string;
  state: DomainCredit;
  trace: TraceEntry[];
}

function historyNote(scored: number): string {
  if (scored < MIN_HISTORY[2]) return `${scored}; tier 2 needs ${MIN_HISTORY[2]}`;
  if (scored < MIN_HISTORY[3]) return `${scored}; tier 3 needs ${MIN_HISTORY[3]}`;
  return String(scored);
}

function scoreBlock(a: Account): string {
  const scored = scoredEvents(a.state);
  const band = scored === 0 ? "No scored history yet" : bandFor(a.state.score);
  const ask = grantAvailable(a.state);
  const movers = a.trace
    .filter((t) => !t.disputed && t.type !== "baseline" && Math.round(t.score_after - t.score_before) !== 0)
    .sort((x, y) => Math.abs(y.score_after - y.score_before) - Math.abs(x.score_after - x.score_before))
    .slice(0, 3);
  const moverRows = movers.length
    ? movers.map((t) => `<tr><td class="num">${points(t.score_after - t.score_before)}</td><td>${esc(t.label)}</td><td class="date">${esc(day(t.at))}</td><td class="id">${esc(t.event_id)}</td></tr>`).join("")
    : `<tr><td colspan="4">Nothing has moved this score yet.</td></tr>`;
  const limits = a.state.credit_limit;
  const minScores = Object.entries(limits.min_scores).map(([action, min]) =>
    `${esc(action)} at ${min}${a.state.held_actions.includes(action) ? " (held now)" : ""}`);
  const pending = a.state.pending_grant
    ? `Tier 3, confirm after ${esc(dayTime(a.state.pending_grant.not_before))}`
    : "";
  return `
  <section class="account">
    <h3>${esc(a.domain)}</h3>
    <div class="account-top">
      <p class="score"><span class="score-number">${Math.round(a.state.score)}</span><span class="band">${esc(band)}</span></p>
      <dl class="facts">
        <dt>Active tier</dt><dd>${effectiveTier(a.state)} of 3, your ceiling ${a.state.user_max_tier}</dd>
        <dt>Can ask for</dt><dd>${ask === null ? "Nothing higher yet" : `Tier ${ask}`}</dd>
        <dt>Scored events</dt><dd>${historyNote(scored)}</dd>
        ${pending ? `<dt>Waiting</dt><dd>${pending}</dd>` : ""}
      </dl>
      <dl class="limits">
        <dt>Paths</dt><dd>${list(limits.allowed_paths)}</dd>
        <dt>Remote actions</dt><dd>${list(limits.allowed_actions)}</dd>
        <dt>Blocked</dt><dd>${list(limits.blocked_actions)}</dd>
        <dt>Minimums</dt><dd>${minScores.length ? minScores.join(", ") : "None"}</dd>
        <dt>Spending cap</dt><dd>${usd(limits.financial_cap_usd)} per session</dd>
      </dl>
    </div>
    <table class="movers"><thead><tr><th class="num">Points</th><th>What moved the score most</th><th>Date</th><th>Event id</th></tr></thead><tbody>${moverRows}</tbody></table>
    ${historyGrid(a.trace)}
  </section>`;
}

function historyGrid(trace: TraceEntry[]): string {
  const marked = trace.filter((t) => t.mark !== null).slice(-HISTORY_CELLS);
  const cells: string[] = [];
  for (let i = 0; i < HISTORY_CELLS - marked.length; i++) {
    cells.push(`<div class="cell empty" aria-hidden="true"><span class="mark">&nbsp;</span><span class="when">&nbsp;</span></div>`);
  }
  for (const t of marked) {
    const cls = ["cell", t.tilt ? "tilt" : "", t.disputed ? "disputed" : ""].filter(Boolean).join(" ");
    const title = `${t.label}${t.disputed ? " (disputed, not counted)" : ""}`;
    cells.push(`<div class="${cls}" title="${esc(title)}"><span class="mark">${esc(t.mark)}</span><span class="when">${esc(monthDay(t.at))}</span></div>`);
  }
  return `<div class="grid-wrap"><div class="grid" role="list" aria-label="Last ${HISTORY_CELLS} sessions and actions, oldest first">${cells.join("")}</div></div>`;
}

const LEGEND: Record<Mark, string> = {
  OK: "accepted untouched",
  ED: "light edit, under 15%",
  RW: "rewrite, 15 to 50%",
  HV: "heavy rewrite, over 50%",
  RJ: "rejected",
  CR: "crashed",
  NR: "not reviewed, not scored",
  VF: "verified by an outside source",
  CO: "confirmed by the company",
  EX: "exchange recorded only",
  HR: "helper's own report only",
  CT: "contradicted",
  TL: "tried a blocked action",
};
function legend(): string {
  const rows = (Object.keys(LEGEND) as Mark[]).map((m) => `<li><span class="mark-key">${m}</span>${esc(LEGEND[m])}</li>`);
  return `<ul class="legend">${rows.join("")}<li><span class="mark-key tilt-key">&nbsp;</span>heavy border: tilt</li><li><span class="mark-key"><s>RJ</s></span>struck through: disputed</li></ul>`;
}

function inquiriesTable(events: CreditEvent[]): string {
  const inquiries = events.filter((e): e is InquiryEvent => e.type === "inquiry");
  if (!inquiries.length) return `<p>No agent has read its limits yet.</p>`;
  const groups = new Map<string, { reader: string; domain: string; count: number; first: string; last: string }>();
  for (const e of inquiries) {
    const key = `${e.reader}\u0000${e.domain}`;
    const g = groups.get(key);
    if (g) { g.count++; g.last = e.at; } else groups.set(key, { reader: e.reader, domain: e.domain, count: 1, first: e.at, last: e.at });
  }
  const rows = [...groups.values()].sort((x, y) => Date.parse(y.last) - Date.parse(x.last));
  const shown = rows.slice(0, INQUIRY_ROWS);
  const more = rows.length - shown.length;
  return `<table class="inquiries"><thead><tr><th>Read by</th><th>Task</th><th class="num">Reads</th><th>First read</th><th>Last read</th></tr></thead><tbody>${
    shown.map((g) => `<tr><td>${esc(g.reader)}</td><td>${esc(g.domain)}</td><td class="num">${g.count}</td><td class="date">${esc(dayTime(g.first))}</td><td class="date">${esc(dayTime(g.last))}</td></tr>`).join("")
  }</tbody></table>${more > 0 ? `<p class="note">${more} more ${more === 1 ? "reader is" : "readers are"} in the record; run closedtab credit events to see every read.</p>` : ""}`;
}

function adverseTable(accounts: Account[]): string {
  const rows: string[] = [];
  for (const a of accounts) {
    for (const action of a.state.held_actions) {
      const min = a.state.credit_limit.min_scores[action];
      rows.push(`<tr><td class="date">Now</td><td>${esc(a.domain)}</td><td>${esc(action)} is held: the score is below your minimum of ${min ?? "the line you set"}</td><td class="id"></td></tr>`);
    }
    for (const t of a.trace) {
      if (t.mark !== "CT" && t.mark !== "TL") continue;
      rows.push(`<tr><td class="date">${esc(day(t.at))}</td><td>${esc(a.domain)}</td><td>${t.disputed ? `<s>${esc(t.label)}</s> (disputed)` : esc(t.label)}</td><td class="id">${esc(t.event_id)}</td></tr>`);
    }
  }
  if (!rows.length) return `<p>No held, blocked or contradicted actions.</p>`;
  return `<table class="adverse"><thead><tr><th>Date</th><th>Task</th><th>What happened</th><th>Event id</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function productPage(productId: string, events: CreditEvent[], opts: Required<Pick<ReportOptions, "now" | "recordLabel">>): string {
  const mine = events.filter((e) => e.product_id === productId);
  const domains = [...new Set(mine.map((e) => e.domain))].sort();
  const accounts: Account[] = domains.map((domain) => {
    const trace: TraceEntry[] = [];
    const state = foldDomain(domainEvents(events, { productId, domain }), trace);
    return { domain, state, trace };
  });
  const first = mine[0]?.at;
  const last = mine[mine.length - 1]?.at;
  const summaryRows = accounts.map((a) => {
    const scored = scoredEvents(a.state);
    return `<tr><td>${esc(a.domain)}</td><td class="num">${Math.round(a.state.score)}</td><td>${scored === 0 ? "No history" : esc(bandFor(a.state.score))}</td><td class="num">${effectiveTier(a.state)}</td><td class="num">${a.state.user_max_tier}</td><td class="num">${scored}</td></tr>`;
  }).join("");
  return `
<section class="page">
  <header class="page-head">
    <h1>Agent credit report</h1>
    <p class="product">${esc(productId)}</p>
    <dl class="meta">
      <dt>Prepared</dt><dd>${esc(dayTime(opts.now.toISOString()))}</dd>
      <dt>Record kept at</dt><dd>${esc(opts.recordLabel)}</dd>
      <dt>Covers</dt><dd>${first ? `${esc(day(first))} to ${esc(day(last!))}` : "No events"}</dd>
      <dt>Score range</dt><dd>${SCORE_MIN} to ${SCORE_MAX}. Tier lines at ${TIER_LINES[1]}, ${TIER_LINES[2]} and ${TIER_LINES[3]}.</dd>
    </dl>
    <p class="privacy">This record stays on your device and is never sent to a provider. The score is for you; agents are shown their limits and never their score.</p>
  </header>
  ${accounts.length > 2 ? `<h2>Summary</h2>
  <table class="summary"><thead><tr><th>Task</th><th class="num">Score</th><th>Band</th><th class="num">Active tier</th><th class="num">Ceiling</th><th class="num">Scored events</th></tr></thead><tbody>${summaryRows}</tbody></table>` : ""}
  <h2>${accounts.length > 1 ? "Accounts" : "Account"}</h2>
  ${accounts.map(scoreBlock).join("")}
  <h2>Inquiries</h2>
  ${inquiriesTable(mine)}
  <h2>Held, blocked and contradicted actions</h2>
  ${adverseTable(accounts)}
  <h2>How to dispute an entry</h2>
  <p>If an entry was recorded wrong, run <code>closedtab credit dispute --event &lt;id&gt; --reason "what was wrong"</code>. The tool sets that event aside and recomputes the score from the rest. A dispute never raises a tier by itself; grant again once the score supports it.</p>
  <h2>Marks in the history row, oldest first</h2>
  ${legend()}
</section>`;
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html { background: #e8e8e8; color: #000; }
body { margin: 0; font: 8pt/1.32 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-variant-numeric: tabular-nums; }
.screen-note { max-width: 190mm; margin: 16px auto 0; padding: 0 16px; font-size: 10pt; }
.page { background: #fff; max-width: 190mm; margin: 16px auto; padding: 12mm 10mm; }
h1 { font-size: 16pt; line-height: 1.15; margin: 0; }
h2 { font-size: 9.5pt; margin: 2.8mm 0 1mm; padding-bottom: 0.8mm; border-bottom: 1.2pt solid #000; }
h3 { font-size: 10pt; margin: 0 0 1.5mm; }
p { margin: 0 0 1.5mm; }
.product { font-size: 11pt; margin: 0.5mm 0 2mm; }
.note { color: #333; }
.page-head { border-bottom: 2.5pt solid #000; padding-bottom: 2mm; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.3mm 3mm; margin: 0; }
dt { font-weight: 600; }
dd { margin: 0; overflow-wrap: anywhere; }
.meta { grid-template-columns: max-content 1fr max-content 1fr; }
table { width: 100%; border-collapse: collapse; margin: 0 0 1.5mm; }
th, td { text-align: left; vertical-align: top; padding: 0.45mm 1.2mm; border-bottom: 0.5pt solid #777; }
th { font-weight: 600; border-bottom: 1pt solid #000; }
.num { text-align: right; white-space: nowrap; }
.date { white-space: nowrap; }
td.id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 7.5pt; white-space: nowrap; }
.account { border: 1pt solid #000; padding: 2mm 2.5mm; margin: 0 0 2mm; break-inside: avoid; }
.account-top { display: grid; grid-template-columns: 22mm 0.95fr 1.4fr; gap: 3mm; align-items: start; margin-bottom: 1.2mm; }
.score { margin: 0; display: flex; flex-direction: column; }
.score-number { font-size: 22pt; font-weight: 700; line-height: 1; }
.band { font-weight: 600; margin-top: 0.8mm; }
.movers { margin-bottom: 1.5mm; }
.grid { display: grid; grid-template-columns: repeat(${HISTORY_CELLS}, minmax(0, 1fr)); border-left: 0.5pt solid #000; }
.cell { border: 0.5pt solid #000; border-left: none; text-align: center; padding: 0.5mm 0; display: flex; flex-direction: column; min-width: 0; }
.cell .mark { font-weight: 700; font-size: 7.5pt; }
.cell .when { font-size: 5.5pt; color: #333; }
.cell.empty { border-color: #999; border-style: dotted; }
.cell.tilt { outline: 1.5pt solid #000; outline-offset: -1.5pt; }
.cell.disputed .mark { text-decoration: line-through; }
.legend { list-style: none; padding: 0; margin: 0; columns: 5; column-gap: 3mm; font-size: 7pt; }
.legend li { break-inside: avoid; margin-bottom: 0.4mm; display: grid; grid-template-columns: 7mm 1fr; align-items: baseline; }
.mark-key { display: inline-block; width: 6mm; font-weight: 700; border: 0.5pt solid #000; text-align: center; }
.mark-key.tilt-key { outline: 1.5pt solid #000; outline-offset: -1.5pt; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 7.5pt; }
.privacy { margin: 1.5mm 0 0; color: #333; }
@media screen and (max-width: 720px) {
  body { font-size: 10pt; }
  .page { margin: 12px 0; padding: 20px 16px; }
  .meta { grid-template-columns: max-content 1fr; }
  .account-top { grid-template-columns: 1fr; }
  .legend { columns: 2; }
  table { display: block; overflow-x: auto; }
  .grid-wrap { overflow-x: auto; }
  .grid { grid-template-columns: repeat(${HISTORY_CELLS}, 30px); width: max-content; }
}
@page { margin: 10mm; }
@media print {
  html { background: #fff; }
  .screen-note { display: none; }
  .page { margin: 0; padding: 0; max-width: none; break-after: page; }
  .page:last-of-type { break-after: auto; }
}
`;

export function renderCreditReportHtml(report: CreditReport, opts: ReportOptions = {}): string {
  const now = opts.now ?? new Date();
  const recordLabel = opts.recordLabel ?? "this device";
  const products = [...new Set(report.events.map((e) => e.product_id))]
    .filter((p) => !opts.productId || p === opts.productId)
    .sort();
  const pages = products.length
    ? products.map((p) => productPage(p, report.events, { now, recordLabel })).join("\n")
    : `<section class="page"><h1>Agent credit report</h1><p>The record has no ${opts.productId ? `events for ${esc(opts.productId)}` : "events"} yet. Grant limits with <code>closedtab credit grant</code> and close a reviewed session with <code>closedtab credit close</code> to start one.</p></section>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent credit report</title>
<style>${STYLE}</style>
</head>
<body>
<p class="screen-note">Print this page or save it as a PDF from your browser. Each product starts on a new page.</p>
${pages}
</body>
</html>
`;
}
