import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitCreditEvents, creditVaultDir, ensureVault, getDomain, ledgerPath, newEventId } from "./store.js";
import {
  EVIDENCE_LEVELS, grantAvailable, validateIdentity,
  type ActionSettledEvent, type CreditAar, type CreditIdentity, type DomainCredit,
  type EvidenceLevel, type PermissionTier, type SessionClosedEvent, type SessionOutcome,
} from "./types.js";

export interface FinalizeOptions extends CreditIdentity {
  outcome: SessionOutcome;
  intent?: string;
  summary?: string;
  agentDraft?: string;
  userFinal?: string;
  at?: Date;
}
export interface FinalizeResult {
  aar: CreditAar;
  event_id: string;
  score: number;
  tier: number;
  /** The replay line: a tier the person may now choose to grant. Never applied automatically. */
  grant_available: PermissionTier | null;
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

function scoreChange(before: DomainCredit, after: DomainCredit): number {
  return Math.round((after.score - before.score) * 10) / 10;
}

/** Record a reviewed (or unreviewed) session. Scoring and any automatic contraction happen in the same write. */
export function finalizeCreditSession(
  options: FinalizeOptions,
  vault = creditVaultDir(),
): FinalizeResult {
  validateIdentity(options);
  if (!["accepted", "rejected", "crashed", "unreviewed"].includes(options.outcome)) {
    throw new Error("Unknown session outcome");
  }
  const { delta, ratio } = interactionDelta(options.outcome, options.agentDraft, options.userFinal);
  const timestamp = (options.at ?? new Date()).toISOString();
  const aarId = `aar_${timestamp.replace(/[-:.TZ]/g, "")}_${randomUUID()}`;
  let before: DomainCredit | undefined;
  let event: SessionClosedEvent | undefined;
  const report = commitCreditEvents(vault, (current) => {
    before = getDomain(current, options);
    event = {
      id: newEventId(current), at: timestamp,
      product_id: options.productId, domain: options.domain,
      type: "session_closed", outcome: options.outcome,
      delta, edit_ratio: ratio === null ? null : Math.round(ratio * 10000) / 10000,
      intent: (options.intent ?? "").slice(0, 2000), summary: (options.summary ?? "").slice(0, 2000),
      aar_id: aarId,
    };
    return [event];
  });
  const after = getDomain(report, options);
  const aar: CreditAar = {
    aar_id: aarId,
    event_id: event!.id,
    timestamp,
    product_id: options.productId,
    domain: options.domain,
    intent: event!.intent,
    outcome: options.outcome,
    interaction_delta: delta,
    edit_ratio: event!.edit_ratio,
    score_change: scoreChange(before!, after),
    score_after: after.score,
    summary: event!.summary,
  };
  const home = ensureVault(vault);
  const aarDir = join(home, "aars");
  mkdirSync(aarDir, { recursive: true, mode: 0o700 });
  const aarPath = join(aarDir, aar.aar_id + ".json");
  writeFileSync(aarPath, JSON.stringify(aar, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return {
    aar, event_id: event!.id, score: after.score, tier: after.permission_tier,
    grant_available: grantAvailable(after), ledger_path: ledgerPath(home), aar_path: aarPath,
  };
}

export interface SettleOptions extends CreditIdentity {
  /** The host's own id for the action, so later evidence can be matched to it. */
  ref: string;
  evidence: EvidenceLevel;
  summary?: string;
  at?: Date;
}
export interface SettleResult {
  event_id: string;
  score: number;
  score_change: number;
  tier: number;
  tilt: boolean;
  grant_available: PermissionTier | null;
}
/**
 * Record how far the proof of an action got, once it settles. One settlement
 * per action; a contradiction may follow an earlier settlement of the same
 * action, because evidence against can arrive late.
 */
export function settleActionEvidence(options: SettleOptions, vault = creditVaultDir()): SettleResult {
  validateIdentity(options);
  const ref = options.ref?.trim() ?? "";
  if (!ref || ref.length > 200) throw new Error("settle needs a --ref of 1 to 200 characters naming the action");
  if (!EVIDENCE_LEVELS.includes(options.evidence)) {
    throw new Error(`evidence must be one of ${EVIDENCE_LEVELS.join(", ")}`);
  }
  let before: DomainCredit | undefined;
  let event: ActionSettledEvent | undefined;
  const report = commitCreditEvents(vault, (current) => {
    const earlier = current.events.filter((e) =>
      e.type === "action_settled" && e.product_id === options.productId &&
      e.domain === options.domain && e.ref === ref) as ActionSettledEvent[];
    if (earlier.length && (options.evidence !== "contradicted" || earlier.some((e) => e.evidence === "contradicted"))) {
      throw new Error(`Action ${ref} has already settled as ${earlier[earlier.length - 1].evidence}. Only a contradiction can follow it.`);
    }
    before = getDomain(current, options);
    event = {
      id: newEventId(current), at: (options.at ?? new Date()).toISOString(),
      product_id: options.productId, domain: options.domain,
      type: "action_settled", ref, evidence: options.evidence,
      summary: (options.summary ?? "").slice(0, 2000),
    };
    return [event];
  });
  const after = getDomain(report, options);
  return {
    event_id: event!.id, score: after.score, score_change: scoreChange(before!, after),
    tier: after.permission_tier, tilt: options.evidence === "contradicted",
    grant_available: grantAvailable(after),
  };
}
