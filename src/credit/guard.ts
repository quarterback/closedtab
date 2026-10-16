import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, dirname } from "node:path";
import { commitCreditEvents, creditVaultDir, getDomain, newEventId, readCreditReport } from "./store.js";
import {
  ACTION_TIERS, EXPLICIT_ACTIONS as EXPLICIT_ACTION_LIST,
  assertValidDomain, effectiveTier, validateIdentity,
  type CreditIdentity, type DomainCredit, type PermissionTier, type ToolAttempt,
} from "./types.js";

/**
 * A host must execute tools exclusively through this guard to enforce policy.
 * Passport text alone cannot enforce anything; unknown tools fail closed.
 */
const FILE_ACTIONS = new Set(["read_file", "stage_file", "write_file", "edit_file", "delete_file"]);
const EXPLICIT_ACTIONS = new Set(EXPLICIT_ACTION_LIST);
const PAYMENT_ACTIONS = new Set(["execute_payment"]);
export type ViolationCode = "unknown" | "blocked" | "tier" | "held" | "explicit" | "path" | "payment";
export class CreditViolationError extends Error {
  constructor(message: string, readonly code: ViolationCode = "tier") {
    super(message);
    this.name = "CreditViolationError";
  }
}
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
function canonicalExistingAncestor(path: string): string {
  let current = path;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new CreditViolationError("Path has no accessible ancestor", "path");
    tail.unshift(relative(parent, current));
    current = parent;
  }
  return resolve(realpathSync(current), ...tail);
}
function globRegex(pattern: string): RegExp {
  // Small, predictable glob subset: * matches one path segment; ** matches any depth.
  if (!pattern || isAbsolute(pattern) || pattern.startsWith("..") ||
      pattern.split("/").includes("..") || pattern.includes("\\") || pattern.includes(":")) {
    throw new CreditViolationError("Invalid allowed_paths pattern", "path");
  }
  let s = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") { s += ".*"; i++; }
      else s += "[^/]*";
    } else if (ch === "?") s += "[^/]";
    else s += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(s + "$");
}
export function checkAllowedPath(
  target: string, patterns: string[], root = process.cwd(), vault = creditVaultDir(),
): boolean {
  if (!target || patterns.length === 0) return false;
  const projectRoot = realpathSync(resolve(root));
  const absolute = resolve(projectRoot, target);
  // Reject lexical escapes AND symlinks pointing outside the project.
  if (!inside(projectRoot, absolute)) return false;
  const resolved = canonicalExistingAncestor(absolute);
  if (!inside(projectRoot, resolved)) return false;
  const privateVault = resolve(vault);
  if (inside(privateVault, resolved) || inside(privateVault, absolute)) return false;
  const rel = relative(projectRoot, resolved).split(sep).join("/");
  return patterns.some((pattern) => globRegex(pattern).test(rel));
}
export interface GuardContext {
  root?: string;
  vault?: string;
  spentUsd?: number;
}
/** True when the person's minimum score (or a hold from falling below it) keeps this action off. */
function isHeld(record: DomainCredit, action: string): boolean {
  if (record.held_actions.includes(action)) return true;
  const min = Object.hasOwn(record.credit_limit.min_scores, action) ? record.credit_limit.min_scores[action] : undefined;
  return min !== undefined && record.score < min;
}
export function validateToolExecution(
  record: DomainCredit,
  attempt: ToolAttempt,
  context: GuardContext = {},
): PermissionTier {
  assertValidDomain(record);
  const required = Object.hasOwn(ACTION_TIERS, attempt.action) ? ACTION_TIERS[attempt.action] : undefined;
  if (required === undefined) throw new CreditViolationError(`Unknown tool action "${attempt.action}" (fail closed)`, "unknown");
  const tier = effectiveTier(record);
  if (record.credit_limit.blocked_actions.includes("*") ||
      record.credit_limit.blocked_actions.includes(attempt.action)) {
    throw new CreditViolationError(`Action "${attempt.action}" explicitly blocked by consumer`, "blocked");
  }
  if (tier < required) {
    throw new CreditViolationError(`Action "${attempt.action}" requires Tier ${required}; consumer credit allows Tier ${tier}`, "tier");
  }
  // The message names no score or threshold: the agent sees its limits, not its rating.
  if (isHeld(record, attempt.action)) {
    throw new CreditViolationError(`Action "${attempt.action}" is held by the consumer's credit settings`, "held");
  }
  if (EXPLICIT_ACTIONS.has(attempt.action) && !record.credit_limit.allowed_actions.includes(attempt.action)) {
    throw new CreditViolationError(`Action "${attempt.action}" requires explicit consumer authorization`, "explicit");
  }
  if (FILE_ACTIONS.has(attempt.action)) {
    if (!attempt.target || !checkAllowedPath(attempt.target, record.credit_limit.allowed_paths, context.root, context.vault)) {
      throw new CreditViolationError(`File path not authorized for "${attempt.action}"`, "path");
    }
  }
  if (PAYMENT_ACTIONS.has(attempt.action)) {
    const amount = attempt.amountUsd;
    const cap = record.credit_limit.financial_cap_usd;
    const spent = context.spentUsd ?? 0;
    if (!Number.isFinite(amount) || amount === undefined || amount <= 0 ||
        !Number.isFinite(spent) || spent < 0 || !Number.isFinite(cap) ||
        cap <= 0 || spent + amount > cap) {
      throw new CreditViolationError("Payment exceeds the consumer's remaining credit budget", "payment");
    }
  }
  return tier;
}
/**
 * The actions an agent may attempt right now, before paths and amounts are
 * checked. This is what the passport lists. It carries no score.
 */
export function permittedActions(record: DomainCredit): string[] {
  assertValidDomain(record);
  const tier = effectiveTier(record);
  const blocked = record.credit_limit.blocked_actions;
  if (blocked.includes("*")) return [];
  return Object.entries(ACTION_TIERS)
    .filter(([action, required]) =>
      required <= tier && !blocked.includes(action) && !isHeld(record, action) &&
      (!EXPLICIT_ACTIONS.has(action) || record.credit_limit.allowed_actions.includes(action)))
    .map(([action]) => action);
}
/**
 * Per-session host integration point. Only actions invoked with execute() are
 * guarded. This is NOT a hook into unrelated Claude/Gemini/ChatGPT tools.
 *
 * An attempt at an action the person blocked is recorded as a tilt: the
 * passport told the agent it was blocked, so trying anyway drops the active
 * tier one step. Other refusals are not recorded.
 */
export class CreditGuardedSession {
  private spentUsd = 0;
  constructor(
    private readonly identity: CreditIdentity,
    private readonly opts: { vault?: string; root?: string; recordTilts?: boolean } = {},
  ) {
    validateIdentity(identity);
  }
  verify(attempt: ToolAttempt): PermissionTier {
    const vault = this.opts.vault ?? creditVaultDir();
    const domain = getDomain(readCreditReport(vault), this.identity);
    try {
      return validateToolExecution(domain, attempt, { root: this.opts.root, vault, spentUsd: this.spentUsd });
    } catch (e) {
      if (e instanceof CreditViolationError && e.code === "blocked" && this.opts.recordTilts !== false) {
        try {
          commitCreditEvents(vault, (current) => [{
            id: newEventId(current), at: new Date().toISOString(),
            product_id: this.identity.productId, domain: this.identity.domain,
            type: "blocked_attempt", action: attempt.action.slice(0, 200),
          }]);
        } catch {
          // The refusal stands even if the tilt could not be written.
        }
      }
      throw e;
    }
  }
  async execute<T>(attempt: ToolAttempt, handler: () => Promise<T> | T): Promise<T> {
    this.verify(attempt);
    const amount = attempt.action === "execute_payment" ? attempt.amountUsd! : 0;
    // Reserve before awaiting the adapter; protects simultaneous calls inside
    // one session. Cross-process transaction limits require a separate broker.
    this.spentUsd += amount;
    try { return await handler(); }
    catch (e) { this.spentUsd -= amount; throw e; }
  }
  get spent(): number { return this.spentUsd; }
}
