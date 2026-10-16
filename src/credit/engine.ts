import {
  SCORE_MAX, SCORE_MIN, SCORE_START, TIER_THREE_WAIT_MS, DISPUTABLE_EVENTS,
  effectiveTier, eligibleTier, newDomain, scoreTier,
  type CreditEvent, type CreditIdentity, type DomainCredit, type EvidenceLevel,
  type PermissionTier, type ProductCredit, type SessionClosedEvent,
} from "./types.js";

/**
 * The scoring engine. A domain's state is a fold over its events, in the
 * order they were recorded. The same fold runs for every write, every read
 * and the printable report, so a score always matches its history.
 *
 * Points work the way pinball scores them:
 * - Base: each scored session or settled action sets a target on the range,
 *   350 + 250 x delta, and the score moves part of the way toward it.
 * - Step: the score moves 20% of the way (the moving average; older play decays).
 * - Multiplier: stronger evidence moves the score further (company 1.5x;
 *   outside verification or a contradiction 2x).
 * - Combo: each consecutive success after the first adds 0.25x to upward
 *   moves, up to 2x at five in a row. Any failure resets it.
 * - Tilt: a contradicted action, or an attempt at an action the person
 *   blocked, resets the combo and drops the active tier one step.
 * - Replay line: crossing a tier line earns the right to ask the person for a
 *   grant (grantAvailable), never the grant itself.
 * No single event moves the score more than 60% of the way to its target.
 */
export const ALPHA = 0.2;
export const MAX_STEP = 0.6;
export const COMBO_STEP = 0.25;
export const COMBO_CAP = 2;
export const EVIDENCE_DELTA: Record<EvidenceLevel, number> = {
  verified: 1, company: 0.5, exchange: 0, helper: -0.5, contradicted: -1,
};
export const EVIDENCE_MULTIPLIER: Record<EvidenceLevel, number> = {
  verified: 2, company: 1.5, exchange: 1, helper: 1, contradicted: 2,
};

/** Marks for the session history grid. Two letters each, readable in black and white. */
export const MARKS = {
  OK: "Accepted untouched",
  ED: "Light edit, under 15% changed",
  RW: "Rewritten, 15% to 50% changed",
  HV: "Heavy rewrite, over 50% changed",
  RJ: "Rejected",
  CR: "Session crashed",
  NR: "Closed without review, not scored",
  VF: "Action verified by an outside source",
  CO: "Action confirmed by the company",
  EX: "Exchange recorded, nothing back yet",
  HR: "Only the helper's own report",
  CT: "Action contradicted (tilt)",
  TL: "Tried an action you blocked (tilt)",
} as const;
export type Mark = keyof typeof MARKS;

export interface TraceEntry {
  event_id: string;
  at: string;
  type: CreditEvent["type"];
  mark: Mark | null;
  label: string;
  score_before: number;
  score_after: number;
  tier_before: PermissionTier;
  tier_after: PermissionTier;
  tilt: boolean;
  disputed: boolean;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function clampScore(n: number): number {
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, n));
}
function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
export function targetFor(delta: number): number {
  return SCORE_START + ((SCORE_MAX - SCORE_MIN) / 2) * delta;
}

/** One scoring step. Mutates the domain. */
export function applyPoints(d: DomainCredit, delta: number, multiplier = 1): void {
  const target = targetFor(delta);
  if (delta > 0) d.stats.consecutive_successes++;
  else if (delta < 0) d.stats.consecutive_successes = 0;
  const combo = delta > 0
    ? Math.min(COMBO_CAP, 1 + COMBO_STEP * (d.stats.consecutive_successes - 1))
    : 1;
  const weight = Math.min(MAX_STEP, ALPHA * multiplier * (target > d.score ? combo : 1));
  d.score = round1(clampScore(d.score + weight * (target - d.score)));
}

/** Automatic contraction after any score change: tiers and held actions only ever tighten here. */
function contract(d: DomainCredit): void {
  d.permission_tier = Math.min(d.permission_tier, scoreTier(d.score), d.user_max_tier) as PermissionTier;
  for (const [action, min] of Object.entries(d.credit_limit.min_scores)) {
    if (d.score < min && !d.held_actions.includes(action)) d.held_actions.push(action);
  }
}
function tilt(d: DomainCredit): void {
  d.stats.consecutive_successes = 0;
  d.stats.tilts++;
  d.permission_tier = Math.max(0, effectiveTier(d) - 1) as PermissionTier;
}
function refreshRate(d: DomainCredit): void {
  d.stats.untouched_acceptance_rate = d.stats.reviewed_sessions
    ? Math.round(10000 * d.stats.untouched_acceptances / d.stats.reviewed_sessions) / 10000
    : 0;
}

export function sessionMark(e: Pick<SessionClosedEvent, "outcome" | "delta">): Mark {
  if (e.outcome === "rejected") return "RJ";
  if (e.outcome === "crashed") return "CR";
  if (e.delta === null) return "NR";
  if (e.delta >= 1) return "OK";
  if (e.delta > 0) return "ED";
  if (e.delta > -0.5) return "RW";
  return "HV";
}
const EVIDENCE_MARK: Record<EvidenceLevel, Mark> = {
  verified: "VF", company: "CO", exchange: "EX", helper: "HR", contradicted: "CT",
};
function pct(ratio: number | null): string {
  return ratio === null ? "" : ` (${Math.round(ratio * 100)}% changed)`;
}
function describe(e: CreditEvent): { mark: Mark | null; label: string } {
  switch (e.type) {
    case "baseline":
      return { mark: null, label: "Carried over from the earlier ledger format" };
    case "session_closed": {
      const mark = sessionMark(e);
      const what: Record<Mark, string> = {
        ...MARKS,
        ED: `Light edit${pct(e.edit_ratio)}`,
        RW: `Rewritten${pct(e.edit_ratio)}`,
        HV: `Heavy rewrite${pct(e.edit_ratio)}`,
      };
      return { mark, label: what[mark] + (e.intent ? `: ${e.intent}` : "") };
    }
    case "action_settled": {
      const mark = EVIDENCE_MARK[e.evidence];
      return { mark, label: `${MARKS[mark].replace(" (tilt)", "")}: ${e.ref}` };
    }
    case "grant":
      return {
        mark: null,
        label: e.max_tier === 3 && e.granted_tier < 3
          ? `Grant: ceiling tier 3, active tier ${e.granted_tier} until confirmed`
          : `Grant: ceiling tier ${e.max_tier}, active tier ${e.granted_tier}`,
      };
    case "grant_confirmed":
      return { mark: null, label: `Tier 3 grant confirmed, active tier ${e.granted_tier}` };
    case "blocked_attempt":
      return { mark: "TL", label: `Tried blocked action ${e.action}` };
    case "inquiry":
      return { mark: null, label: `Limits read by ${e.reader}` };
    case "dispute":
      return { mark: null, label: `Disputed ${e.event_id}: ${e.reason}` };
  }
}

/** The events that belong to one product and task domain, in recorded order. */
export function domainEvents(events: CreditEvent[], identity: CreditIdentity): CreditEvent[] {
  return events.filter((e) => e.product_id === identity.productId && e.domain === identity.domain);
}

/**
 * Fold one domain's events into its current state. Pass `trace` to collect a
 * line per event for the report. Disputed events are kept in the trace and
 * left out of the score.
 */
export function foldDomain(events: CreditEvent[], trace?: TraceEntry[]): DomainCredit {
  const disputed = new Set(
    events.filter((e) => e.type === "dispute").map((e) => (e as { event_id: string }).event_id),
  );
  let d = newDomain();
  for (const e of events) {
    const scoreBefore = d.score;
    const tierBefore = effectiveTier(d);
    const isDisputed = disputed.has(e.id) && DISPUTABLE_EVENTS.includes(e.type);
    let tilted = false;
    if (!isDisputed) {
      switch (e.type) {
        case "baseline":
          d = clone(e.state);
          contract(d);
          break;
        case "session_closed":
          d.stats.total_sessions++;
          if (e.delta !== null) {
            d.stats.reviewed_sessions++;
            if (e.outcome === "accepted" && e.delta >= 1) d.stats.untouched_acceptances++;
            applyPoints(d, e.delta);
            contract(d);
          }
          refreshRate(d);
          break;
        case "action_settled":
          d.stats.settled_actions++;
          applyPoints(d, EVIDENCE_DELTA[e.evidence], EVIDENCE_MULTIPLIER[e.evidence]);
          contract(d);
          if (e.evidence === "contradicted") { tilt(d); tilted = true; }
          break;
        case "grant": {
          const limit = d.credit_limit;
          if (e.allowed_paths !== undefined) limit.allowed_paths = [...new Set(e.allowed_paths)];
          if (e.allowed_actions !== undefined) limit.allowed_actions = [...new Set(e.allowed_actions)];
          if (e.blocked_actions !== undefined) limit.blocked_actions = [...new Set(e.blocked_actions)];
          if (e.financial_cap_usd !== undefined) limit.financial_cap_usd = e.financial_cap_usd;
          if (e.min_scores !== undefined) limit.min_scores = { ...e.min_scores };
          // A fresh grant is the only thing that lifts held actions. Anything
          // still under its minimum is held again straight away.
          d.held_actions = [];
          d.user_max_tier = e.max_tier;
          const raisingToThree = e.max_tier === 3 && d.permission_tier < 3;
          const eligible = eligibleTier(d);
          d.permission_tier = Math.min(eligible, e.max_tier, raisingToThree ? 2 : 3, e.granted_tier) as PermissionTier;
          d.pending_grant = raisingToThree && eligible === 3
            ? { requested_at: e.at, not_before: new Date(Date.parse(e.at) + TIER_THREE_WAIT_MS).toISOString() }
            : null;
          contract(d);
          break;
        }
        case "grant_confirmed":
          if (d.pending_grant && Date.parse(e.at) >= Date.parse(d.pending_grant.not_before)) {
            d.permission_tier = Math.min(eligibleTier(d), d.user_max_tier, e.granted_tier) as PermissionTier;
            d.pending_grant = null;
            contract(d);
          }
          break;
        case "blocked_attempt":
          tilt(d);
          tilted = true;
          break;
        case "inquiry":
          d.stats.inquiries++;
          break;
        case "dispute":
          d.stats.disputes++;
          d.permission_tier = Math.min(d.permission_tier, e.tier_cap) as PermissionTier;
          for (const action of e.held_actions) if (!d.held_actions.includes(action)) d.held_actions.push(action);
          break;
      }
    }
    if (trace) {
      const { mark, label } = describe(e);
      trace.push({
        event_id: e.id, at: e.at, type: e.type, mark, label,
        score_before: scoreBefore, score_after: d.score,
        tier_before: tierBefore, tier_after: effectiveTier(d),
        tilt: tilted, disputed: isDisputed,
      });
    }
  }
  return d;
}

/** Every product and domain, folded from the full event list. */
export function foldProducts(events: CreditEvent[]): Record<string, ProductCredit> {
  const groups = new Map<string, Map<string, CreditEvent[]>>();
  for (const e of events) {
    if (!groups.has(e.product_id)) groups.set(e.product_id, new Map());
    const domains = groups.get(e.product_id)!;
    if (!domains.has(e.domain)) domains.set(e.domain, []);
    domains.get(e.domain)!.push(e);
  }
  const products: Record<string, ProductCredit> = {};
  for (const [productId, domains] of groups) {
    const domainMap: Record<string, DomainCredit> = {};
    for (const [domain, list] of domains) {
      Object.defineProperty(domainMap, domain, {
        value: foldDomain(list), configurable: true, enumerable: true, writable: true,
      });
    }
    Object.defineProperty(products, productId, {
      value: { display_name: productId, domains: domainMap },
      configurable: true, enumerable: true, writable: true,
    });
  }
  return products;
}
