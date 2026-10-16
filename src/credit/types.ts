/**
 * CT-ACE rates consumer-facing products (anthropic/claude, google/gemini),
 * not ephemeral model sessions or subagents. A domain is a task context.
 *
 * Ledger format 2.0.0: an append-only list of events is the record. Every
 * score, tier and limit is a view computed from those events (see engine.ts).
 */
export type PermissionTier = 0 | 1 | 2 | 3;
export type SessionOutcome = "accepted" | "rejected" | "crashed" | "unreviewed";
/** How far the proof of an action in the world got. */
export type EvidenceLevel = "verified" | "company" | "exchange" | "helper" | "contradicted";

/** The score reads like a credit score on its own range, apart from 300-850. */
export const SCORE_MIN = 100;
export const SCORE_MAX = 600;
/** A new domain starts in the middle of the range, with no authority granted. */
export const SCORE_START = 350;
/** Score each tier requires. Below 300 is tier 0. */
export const TIER_LINES: Record<1 | 2 | 3, number> = { 1: 300, 2: 450, 3: 550 };
/** Scored events (reviewed sessions plus settled actions) a tier needs before it can be granted. */
export const MIN_HISTORY: Record<1 | 2 | 3, number> = { 1: 0, 2: 10, 3: 25 };
/** A grant that raises a domain to tier 3 waits this long and needs a second confirmation. */
export const TIER_THREE_WAIT_MS = 24 * 60 * 60 * 1000;

export const BANDS = [
  { name: "Prime", min: 550 },
  { name: "Near Prime", min: 450 },
  { name: "Subprime", min: 300 },
  { name: "Deep Subprime", min: SCORE_MIN },
] as const;
export type BandName = (typeof BANDS)[number]["name"];

/** Every action the guard recognizes, with the tier it needs. Anything else is denied. */
export const ACTION_TIERS: Record<string, PermissionTier> = {
  read_file: 0, search: 0, analyze: 0,
  stage_file: 1, draft_code: 1, stage_transaction: 1,
  write_file: 2, edit_file: 2, run_tests: 2, internal_api: 2, schedule_invite: 2,
  delete_file: 3, commit_main: 3, push_to_main: 3,
  live_deploy: 3, execute_payment: 3, sign_payload: 3,
  delete_branch: 3, manage_secrets: 3,
};
/** Actions with a remote side effect: they need the person's separate yes even when the tier allows them. */
export const EXPLICIT_ACTIONS = [
  "internal_api", "schedule_invite", "commit_main", "push_to_main",
  "live_deploy", "execute_payment", "sign_payload", "delete_branch", "manage_secrets",
];
export const DEFAULT_BLOCKED_ACTIONS = ["manage_secrets", "delete_branch", "push_to_main"];

export interface CreditLimit {
  allowed_paths: string[];
  blocked_actions: string[];
  allowed_actions: string[];
  financial_cap_usd: number;
  /** Per-action minimum score set by the person. Falling below one holds the action until the next grant. */
  min_scores: Record<string, number>;
}
export interface CreditStats {
  total_sessions: number;
  reviewed_sessions: number;
  untouched_acceptances: number;
  untouched_acceptance_rate: number;
  /** The current combo: consecutive scored successes since the last failure or tilt. */
  consecutive_successes: number;
  settled_actions: number;
  tilts: number;
  inquiries: number;
  disputes: number;
}
export interface PendingGrant {
  requested_at: string;
  not_before: string;
}
export interface DomainCredit {
  /** 100 to 600. */
  score: number;
  permission_tier: PermissionTier;
  user_max_tier: PermissionTier;
  credit_limit: CreditLimit;
  held_actions: string[];
  pending_grant: PendingGrant | null;
  stats: CreditStats;
}
export interface ProductCredit {
  display_name: string;
  domains: Record<string, DomainCredit>;
}

interface EventBase {
  id: string;
  at: string;
  product_id: string;
  domain: string;
}
export type BaselineEvent = EventBase & { type: "baseline"; state: DomainCredit };
export type SessionClosedEvent = EventBase & {
  type: "session_closed";
  outcome: SessionOutcome;
  delta: number | null;
  edit_ratio: number | null;
  intent: string;
  summary: string;
  aar_id: string;
};
export type ActionSettledEvent = EventBase & {
  type: "action_settled";
  ref: string;
  evidence: EvidenceLevel;
  summary: string;
};
export type GrantEvent = EventBase & {
  type: "grant";
  max_tier: PermissionTier;
  /** The active tier this grant produced when it was made. Replays never exceed it. */
  granted_tier: PermissionTier;
  allowed_paths?: string[];
  allowed_actions?: string[];
  blocked_actions?: string[];
  financial_cap_usd?: number;
  min_scores?: Record<string, number>;
};
export type GrantConfirmedEvent = EventBase & { type: "grant_confirmed"; granted_tier: PermissionTier };
export type BlockedAttemptEvent = EventBase & { type: "blocked_attempt"; action: string };
export type InquiryEvent = EventBase & { type: "inquiry"; reader: string };
export type DisputeEvent = EventBase & {
  type: "dispute";
  event_id: string;
  reason: string;
  /** The active tier when the dispute was filed. A dispute never raises authority. */
  tier_cap: PermissionTier;
};
export type CreditEvent =
  | BaselineEvent | SessionClosedEvent | ActionSettledEvent | GrantEvent
  | GrantConfirmedEvent | BlockedAttemptEvent | InquiryEvent | DisputeEvent;
export type CreditEventType = CreditEvent["type"];
export const DISPUTABLE_EVENTS: CreditEventType[] = ["session_closed", "action_settled", "blocked_attempt"];

export interface CreditReport {
  version: "2.0.0";
  updated_at: string;
  /** The record. Append-only. */
  events: CreditEvent[];
  /** A snapshot computed from events, written for people who open the file. Recomputed on every read. */
  products: Record<string, ProductCredit>;
}
export interface CreditAar {
  aar_id: string;
  event_id: string;
  timestamp: string;
  product_id: string;
  domain: string;
  intent: string;
  outcome: SessionOutcome;
  interaction_delta: number | null;
  edit_ratio: number | null;
  score_change: number;
  score_after: number;
  summary: string;
}
export interface CreditIdentity {
  productId: string;
  domain: string;
}
export interface ToolAttempt {
  action: string;
  target?: string;
  amountUsd?: number;
}

export function scoreTier(score: number): PermissionTier {
  if (score >= TIER_LINES[3]) return 3;
  if (score >= TIER_LINES[2]) return 2;
  if (score >= TIER_LINES[1]) return 1;
  return 0;
}
export function bandFor(score: number): BandName {
  for (const band of BANDS) if (score >= band.min) return band.name;
  return "Deep Subprime";
}
export function scoredEvents(record: DomainCredit): number {
  return record.stats.reviewed_sessions + record.stats.settled_actions;
}
/** The highest tier the history is long enough to support. */
export function historyTier(scored: number): PermissionTier {
  if (scored >= MIN_HISTORY[3]) return 3;
  if (scored >= MIN_HISTORY[2]) return 2;
  return 1;
}
/** The highest tier a grant could reach right now: score and history both have to support it. */
export function eligibleTier(record: DomainCredit): PermissionTier {
  return Math.min(scoreTier(record.score), historyTier(scoredEvents(record))) as PermissionTier;
}
/**
 * Credit deterioration contracts the live grant immediately. A later score
 * recovery never reinstates authority; only a consumer grant may raise it.
 */
export function effectiveTier(record: DomainCredit): PermissionTier {
  return Math.min(
    scoreTier(record.score),
    record.user_max_tier,
    record.permission_tier,
  ) as PermissionTier;
}
/** The replay line: crossing a tier earns the right to ask for a grant, never the grant itself. */
export function grantAvailable(record: DomainCredit): PermissionTier | null {
  const eligible = eligibleTier(record);
  return eligible > record.permission_tier ? eligible : null;
}
export function newDomain(): DomainCredit {
  return {
    score: SCORE_START,
    permission_tier: 0,
    user_max_tier: 0,
    credit_limit: {
      allowed_paths: [],
      blocked_actions: [...DEFAULT_BLOCKED_ACTIONS],
      allowed_actions: [],
      financial_cap_usd: 0,
      min_scores: {},
    },
    held_actions: [],
    pending_grant: null,
    stats: {
      total_sessions: 0,
      reviewed_sessions: 0,
      untouched_acceptances: 0,
      untouched_acceptance_rate: 0,
      consecutive_successes: 0,
      settled_actions: 0,
      tilts: 0,
      inquiries: 0,
      disputes: 0,
    },
  };
}
export function validateIdentity({ productId, domain }: CreditIdentity): void {
  const safe = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})?$/i;
  const domainSafe = /^[a-z0-9][a-z0-9._-]{0,95}$/i;
  if (!safe.test(productId) || !domainSafe.test(domain)) {
    throw new Error("Product and domain must be simple identifiers (e.g. anthropic/claude, code-refactoring).");
  }
}
export function isTier(tier: unknown): tier is PermissionTier {
  return typeof tier === "number" && Number.isInteger(tier) && tier >= 0 && tier <= 3;
}
export function isValidMinScore(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= SCORE_MIN && value <= SCORE_MAX;
}
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === "string");
}
export function assertValidMinScores(input: unknown): asserts input is Record<string, number> {
  if (!isPlainObject(input)) throw new Error("Invalid CT-ACE minimum scores");
  for (const [action, value] of Object.entries(input)) {
    if (!Object.hasOwn(ACTION_TIERS, action)) throw new Error(`Minimum score names an unknown action: ${action}`);
    if (!isValidMinScore(value)) throw new Error(`Minimum score for ${action} must be a whole number from ${SCORE_MIN} to ${SCORE_MAX}`);
  }
}

/** Validate policy state before relying on it as an execution boundary. */
export function assertValidDomain(input: unknown): asserts input is DomainCredit {
  if (!isPlainObject(input)) throw new Error("Invalid CT-ACE domain credit record");
  const record = input as unknown as DomainCredit;
  const validCount = (count: unknown) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  if (typeof record.score !== "number" || !Number.isFinite(record.score) ||
      record.score < SCORE_MIN || record.score > SCORE_MAX ||
      !isTier(record.permission_tier) || !isTier(record.user_max_tier)) {
    throw new Error("Invalid CT-ACE score or permission tier");
  }
  const limit = record.credit_limit;
  if (!isPlainObject(limit) || typeof limit.financial_cap_usd !== "number" ||
      !Number.isFinite(limit.financial_cap_usd) || limit.financial_cap_usd < 0 ||
      ![limit.allowed_paths, limit.allowed_actions, limit.blocked_actions].every(isStringArray)) {
    throw new Error("Invalid CT-ACE authorization limits");
  }
  assertValidMinScores(limit.min_scores);
  if (!isStringArray(record.held_actions)) throw new Error("Invalid CT-ACE held actions");
  const pending = record.pending_grant;
  if (pending !== null && (!isPlainObject(pending) ||
      typeof pending.requested_at !== "string" || typeof pending.not_before !== "string" ||
      Number.isNaN(Date.parse(pending.requested_at)) || Number.isNaN(Date.parse(pending.not_before)))) {
    throw new Error("Invalid CT-ACE pending grant");
  }
  const s = record.stats;
  if (!isPlainObject(s) ||
      ![s.total_sessions, s.reviewed_sessions, s.untouched_acceptances, s.consecutive_successes,
        s.settled_actions, s.tilts, s.inquiries, s.disputes].every(validCount) ||
      typeof s.untouched_acceptance_rate !== "number" || !Number.isFinite(s.untouched_acceptance_rate) ||
      s.untouched_acceptance_rate < 0 || s.untouched_acceptance_rate > 1 ||
      s.reviewed_sessions > s.total_sessions ||
      s.untouched_acceptances > s.reviewed_sessions) {
    throw new Error("Invalid CT-ACE session statistics");
  }
}

const EVENT_ID = /^ev_[0-9a-f]{10}$/;
const OUTCOMES: SessionOutcome[] = ["accepted", "rejected", "crashed", "unreviewed"];
export const EVIDENCE_LEVELS: EvidenceLevel[] = ["verified", "company", "exchange", "helper", "contradicted"];

/** Validate one recorded event. A malformed record fails closed instead of granting anything. */
export function assertValidEvent(input: unknown): asserts input is CreditEvent {
  const bad = (why: string): never => { throw new Error(`Invalid CT-ACE event: ${why}`); };
  if (!isPlainObject(input)) bad("not an object");
  const e = input as Record<string, unknown>;
  if (typeof e.id !== "string" || !EVENT_ID.test(e.id)) bad("id");
  if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) bad("timestamp");
  if (typeof e.product_id !== "string" || typeof e.domain !== "string") bad("identity");
  validateIdentity({ productId: e.product_id as string, domain: e.domain as string });
  const str = (k: string, max = 2000) => { if (typeof e[k] !== "string" || (e[k] as string).length > max) bad(k); };
  switch (e.type) {
    case "baseline":
      assertValidDomain(e.state);
      break;
    case "session_closed":
      if (!OUTCOMES.includes(e.outcome as SessionOutcome)) bad("outcome");
      if (e.delta !== null && (typeof e.delta !== "number" || !Number.isFinite(e.delta) || e.delta < -1 || e.delta > 1)) bad("delta");
      if (e.edit_ratio !== null && (typeof e.edit_ratio !== "number" || !Number.isFinite(e.edit_ratio) || e.edit_ratio < 0 || e.edit_ratio > 1)) bad("edit_ratio");
      str("intent"); str("summary"); str("aar_id", 200);
      break;
    case "action_settled":
      str("ref", 200);
      if (!(e.ref as string).trim()) bad("ref");
      if (!EVIDENCE_LEVELS.includes(e.evidence as EvidenceLevel)) bad("evidence");
      str("summary");
      break;
    case "grant":
      if (!isTier(e.max_tier) || !isTier(e.granted_tier) || e.granted_tier > e.max_tier) bad("tier");
      for (const k of ["allowed_paths", "allowed_actions", "blocked_actions"]) {
        if (e[k] !== undefined && !isStringArray(e[k])) bad(k);
      }
      if (e.financial_cap_usd !== undefined &&
          (typeof e.financial_cap_usd !== "number" || !Number.isFinite(e.financial_cap_usd) || e.financial_cap_usd < 0)) bad("financial_cap_usd");
      if (e.min_scores !== undefined) assertValidMinScores(e.min_scores);
      break;
    case "grant_confirmed":
      if (!isTier(e.granted_tier)) bad("tier");
      break;
    case "blocked_attempt":
      str("action", 200);
      break;
    case "inquiry":
      str("reader", 200);
      break;
    case "dispute":
      if (typeof e.event_id !== "string" || !EVENT_ID.test(e.event_id)) bad("event_id");
      str("reason");
      if (!isTier(e.tier_cap)) bad("tier_cap");
      break;
    default:
      bad("unknown type");
  }
}
