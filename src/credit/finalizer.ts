import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  creditVaultDir, ensureDomain, ensureVault, readCreditReport, writeCreditReport,
} from "./store.js";
import {
  effectiveTier, type CreditAar, type CreditIdentity, type SessionOutcome,
} from "./types.js";

export interface FinalizeOptions extends CreditIdentity {
  outcome: SessionOutcome;
  intent?: string;
  summary?: string;
  agentDraft?: string;
  userFinal?: string;
  alpha?: number;
}
export interface FinalizeResult {
  aar: CreditAar;
  score: number;
  tier: number;
  ledger_path: string;
  aar_path: string;
}
function tokenize(text: string): string[] {
  return text.trim() ? text.trim().split(/\s+/) : [];
}
/**
 * Fraction of changed content. On ordinary artifacts, a bounded LCS compares
 * words rather than confusing the agent's changes since the initial Git commit
 * with subsequent user edits. Long texts use a conservative token overlap.
 */
export function editRatio(draft: string, final: string): number {
  if (draft === final) return 0;
  const a = tokenize(draft), b = tokenize(final);
  if (!a.length && !b.length) return 0;
  const total = Math.max(a.length, b.length, 1);
  if (a.length > 2000 || b.length > 2000) {
    const counts = new Map<string, number>();
    for (const word of a) counts.set(word, (counts.get(word) ?? 0) + 1);
    let matched = 0;
    for (const word of b) {
      const n = counts.get(word) ?? 0;
      if (n > 0) { matched++; counts.set(word, n - 1); }
    }
    return Math.min(1, (a.length + b.length - 2 * matched) / total);
  }
  let prev = new Uint16Array(b.length + 1);
  for (let i = 0; i < a.length; i++) {
    const row = new Uint16Array(b.length + 1);
    for (let j = 0; j < b.length; j++) {
      row[j + 1] = a[i] === b[j] ? prev[j] + 1 : Math.max(row[j], prev[j + 1]);
    }
    prev = row;
  }
  return Math.min(1, (a.length + b.length - 2 * prev[b.length]) / total);
}
export function interactionDelta(
  outcome: SessionOutcome, draft?: string, final?: string,
): { delta: number | null; ratio: number | null; untouched: boolean } {
  if (outcome === "rejected" || outcome === "crashed") {
    return { delta: -1, ratio: null, untouched: false };
  }
  // A closed tab is NOT implicit approval: missing feedback is unscored.
  if (outcome !== "accepted" || draft === undefined || final === undefined) {
    return { delta: null, ratio: null, untouched: false };
  }
  if (draft === final) return { delta: 1, ratio: 0, untouched: true };
  const ratio = editRatio(draft, final);
  const delta = ratio < 0.15 ? 0.5 : ratio <= 0.5 ? -0.2 : -0.5;
  return { delta, ratio, untouched: false };
}
export function nextVeracityScore(previous: number, delta: number, alpha = 0.20): number {
  if (!Number.isFinite(previous) || previous < 0 || previous > 10 ||
      !Number.isFinite(delta) || delta < -1 || delta > 1 ||
      !Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new Error("Score, delta, or decay factor is outside its permitted range");
  }
  return Math.round(Math.max(0, Math.min(10,
    (1 - alpha) * previous + alpha * (5 + 5 * delta),
  )) * 100) / 100;
}
export function finalizeCreditSession(
  options: FinalizeOptions,
  vault = creditVaultDir(),
): FinalizeResult {
  if (!["accepted", "rejected", "crashed", "unreviewed"].includes(options.outcome)) {
    throw new Error("Unknown session outcome");
  }
  const alpha = options.alpha ?? 0.20;
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) throw new Error("alpha must be between 0 and 1");
  const report = readCreditReport(vault);
  const domain = ensureDomain(report, options);
  const { delta, ratio, untouched } = interactionDelta(
    options.outcome, options.agentDraft, options.userFinal,
  );
  const previous = domain.veracity_score;
  if (delta !== null) {
    domain.veracity_score = nextVeracityScore(previous, delta, alpha);
    domain.stats.reviewed_sessions++;
    if (untouched) domain.stats.untouched_acceptances++;
  }
  domain.stats.total_sessions++;
  domain.stats.untouched_acceptance_rate = domain.stats.reviewed_sessions
    ? Math.round(10000 * domain.stats.untouched_acceptances / domain.stats.reviewed_sessions) / 10000
    : 0;
  domain.stats.consecutive_successes = options.outcome === "accepted" && delta !== null
    ? domain.stats.consecutive_successes + 1
    : 0;
  domain.permission_tier = effectiveTier(domain);
  const timestamp = new Date().toISOString();
  const aar: CreditAar = {
    aar_id: `aar_${timestamp.replace(/[-:.TZ]/g, "")}_${randomUUID()}`,
    timestamp,
    product_id: options.productId,
    domain: options.domain,
    intent: options.intent ?? "",
    outcome: options.outcome,
    interaction_delta: delta,
    edit_ratio: ratio === null ? null : Math.round(ratio * 10000) / 10000,
    score_change: Math.round((domain.veracity_score - previous) * 100) / 100,
    summary: options.summary ?? "",
  };
  report.recent_aars.push(aar);
  report.recent_aars = report.recent_aars.slice(-30);
  const home = ensureVault(vault);
  const aarDir = join(home, "aars");
  mkdirSync(aarDir, { recursive: true, mode: 0o700 });
  const aarPath = join(aarDir, aar.aar_id + ".json");
  writeFileSync(aarPath, JSON.stringify(aar, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const ledgerPath = writeCreditReport(report, home);
  return { aar, score: domain.veracity_score, tier: domain.permission_tier, ledger_path: ledgerPath, aar_path: aarPath };
}
