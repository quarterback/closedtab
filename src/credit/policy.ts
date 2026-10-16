import { commitCreditEvents, creditVaultDir, getDomain, newEventId } from "./store.js";
import { domainEvents, foldDomain } from "./engine.js";
import {
  ACTION_TIERS, DISPUTABLE_EVENTS, MIN_HISTORY, TIER_LINES,
  assertValidMinScores, eligibleTier, scoreTier, scoredEvents, validateIdentity,
  type CreditIdentity, type DomainCredit, type GrantConfirmedEvent, type GrantEvent, type PermissionTier,
} from "./types.js";

export interface ConsumerGrant {
  maxTier: PermissionTier;
  allowedPaths?: string[];
  allowedActions?: string[];
  blockedActions?: string[];
  financialCapUsd?: number;
  /** Replaces the whole set of minimum scores. Pass {} to clear them. */
  minScores?: Record<string, number>;
}
export interface GrantResult extends DomainCredit {
  notes: string[];
}

function eligibilityNotes(d: DomainCredit, wanted: PermissionTier): string[] {
  const notes: string[] = [];
  const scored = scoredEvents(d);
  for (const tier of [2, 3] as const) {
    if (wanted < tier || d.permission_tier >= tier) continue;
    if (scoreTier(d.score) < tier) {
      notes.push(`Tier ${tier} needs a score of ${TIER_LINES[tier]}; this domain has ${Math.round(d.score)}.`);
    }
    if (scored < MIN_HISTORY[tier]) {
      notes.push(`Tier ${tier} needs ${MIN_HISTORY[tier]} scored sessions or actions; this domain has ${scored}.`);
    }
  }
  if (d.pending_grant) {
    notes.push(`Tier 3 waits until ${d.pending_grant.not_before}. Run grant --confirm after that to apply it.`);
  }
  for (const action of d.held_actions) {
    notes.push(`${action} is held: the score is below the minimum you set for it.`);
  }
  return notes;
}

function now(at?: Date): string {
  return (at ?? new Date()).toISOString();
}

/** An explicit consumer operation, not an agent-controlled score adjustment. */
export function setConsumerGrant(
  identity: CreditIdentity,
  grant: ConsumerGrant,
  vault = creditVaultDir(),
  opts: { at?: Date } = {},
): GrantResult {
  validateIdentity(identity);
  if (![0, 1, 2, 3].includes(grant.maxTier)) throw new Error("maxTier must be 0, 1, 2, or 3");
  if (grant.financialCapUsd !== undefined &&
      (!Number.isFinite(grant.financialCapUsd) || grant.financialCapUsd < 0)) {
    throw new Error("financialCapUsd must be nonnegative");
  }
  if (grant.allowedPaths !== undefined) {
    // Absolute and traversal paths are never valid authorization roots.
    for (const p of grant.allowedPaths) {
      if (!p || p.startsWith("/") || p.includes("\\") || p.split("/").includes("..") ||
          p.includes(":")) throw new Error(`Invalid allowed path pattern: ${p}`);
    }
  }
  if (grant.minScores !== undefined) assertValidMinScores(grant.minScores);
  const report = commitCreditEvents(vault, (current) => {
    const event: GrantEvent = {
      id: newEventId(current), at: now(opts.at),
      product_id: identity.productId, domain: identity.domain,
      type: "grant", max_tier: grant.maxTier, granted_tier: grant.maxTier,
      ...(grant.allowedPaths !== undefined ? { allowed_paths: [...new Set(grant.allowedPaths)] } : {}),
      ...(grant.allowedActions !== undefined ? { allowed_actions: [...new Set(grant.allowedActions)] } : {}),
      ...(grant.blockedActions !== undefined ? { blocked_actions: [...new Set(grant.blockedActions)] } : {}),
      ...(grant.financialCapUsd !== undefined ? { financial_cap_usd: grant.financialCapUsd } : {}),
      ...(grant.minScores !== undefined ? { min_scores: { ...grant.minScores } } : {}),
    };
    // Stamp the tier this grant actually produces now, so a later replay can
    // lower it but never raise it.
    event.granted_tier = foldDomain([...domainEvents(current.events, identity), event]).permission_tier;
    return [event];
  });
  const domain = getDomain(report, identity);
  return { ...domain, notes: eligibilityNotes(domain, grant.maxTier) };
}

/** The second confirmation a tier 3 grant needs, at least 24 hours after it was requested. */
export function confirmTierThreeGrant(
  identity: CreditIdentity,
  vault = creditVaultDir(),
  opts: { at?: Date } = {},
): GrantResult {
  validateIdentity(identity);
  const at = now(opts.at);
  const report = commitCreditEvents(vault, (current) => {
    const d = getDomain(current, identity);
    if (!d.pending_grant) throw new Error("There is no tier 3 grant waiting for confirmation.");
    if (Date.parse(at) < Date.parse(d.pending_grant.not_before)) {
      throw new Error(`The tier 3 grant can be confirmed after ${d.pending_grant.not_before}.`);
    }
    if (eligibleTier(d) < 3) {
      throw new Error(["This domain no longer qualifies for tier 3.", ...eligibilityNotes(d, 3)].join(" "));
    }
    const event: GrantConfirmedEvent = {
      id: newEventId(current), at, product_id: identity.productId, domain: identity.domain,
      type: "grant_confirmed", granted_tier: 3,
    };
    event.granted_tier = foldDomain([...domainEvents(current.events, identity), event]).permission_tier;
    return [event];
  });
  const domain = getDomain(report, identity);
  return { ...domain, notes: eligibilityNotes(domain, 3) };
}

/**
 * Set one recorded event aside. The score is recomputed from the rest. A
 * dispute can lower authority (by recomputing) but never raises it: the
 * person grants again for that.
 */
export function disputeCreditEvent(
  eventId: string,
  reason: string,
  vault = creditVaultDir(),
  opts: { at?: Date } = {},
): { product_id: string; domain: string; before: DomainCredit; after: DomainCredit } {
  if (!reason.trim()) throw new Error("A dispute needs a reason.");
  let before: DomainCredit | undefined;
  let identity: CreditIdentity | undefined;
  const report = commitCreditEvents(vault, (current) => {
    const target = current.events.find((e) => e.id === eventId);
    if (!target) throw new Error(`No event with id ${eventId} in this record.`);
    if (!DISPUTABLE_EVENTS.includes(target.type)) {
      throw new Error(`Only sessions, settled actions and blocked attempts can be disputed; ${eventId} is a ${target.type}.`);
    }
    if (current.events.some((e) => e.type === "dispute" && e.event_id === eventId)) {
      throw new Error(`${eventId} has already been disputed.`);
    }
    identity = { productId: target.product_id, domain: target.domain };
    before = getDomain(current, identity);
    return [{
      id: newEventId(current), at: now(opts.at),
      product_id: target.product_id, domain: target.domain,
      type: "dispute", event_id: eventId, reason: reason.trim().slice(0, 2000),
      tier_cap: before.permission_tier,
    }];
  });
  return { product_id: identity!.productId, domain: identity!.domain, before: before!, after: getDomain(report, identity!) };
}

export function parseMinScores(text: string): Record<string, number> {
  if (text.trim().toLowerCase() === "none") return {};
  const out: Record<string, number> = {};
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [action, value, ...rest] = part.split("=");
    if (!action || value === undefined || rest.length) throw new Error(`Write minimum scores as action=score, e.g. edit_file=450 (got "${part}")`);
    if (!Object.hasOwn(ACTION_TIERS, action.trim())) throw new Error(`Unknown action in minimum score: ${action}`);
    Object.defineProperty(out, action.trim(), { value: Number(value), enumerable: true, configurable: true, writable: true });
  }
  assertValidMinScores(out);
  return out;
}
