import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, dirname } from "node:path";
import { creditVaultDir, getDomain, readCreditReport } from "./store.js";
import { effectiveTier, type CreditIdentity, type DomainCredit, type PermissionTier, type ToolAttempt } from "./types.js";

/**
 * A host must execute tools exclusively through this guard to enforce policy.
 * Passport text alone cannot enforce anything; unknown tools fail closed.
 */
const REQUIRED_TIER: Record<string, PermissionTier> = {
  read_file: 0, search: 0, analyze: 0,
  stage_file: 1, draft_code: 1, stage_transaction: 1,
  write_file: 2, edit_file: 2, run_tests: 2, internal_api: 2, schedule_invite: 2,
  delete_file: 3, commit_main: 3, push_to_main: 3,
  live_deploy: 3, execute_payment: 3, sign_payload: 3,
  delete_branch: 3, manage_secrets: 3,
};
const FILE_ACTIONS = new Set(["read_file", "stage_file", "write_file", "edit_file", "delete_file"]);
const EXPLICIT_ACTIONS = new Set([
  "internal_api", "schedule_invite", "commit_main", "push_to_main",
  "live_deploy", "execute_payment", "sign_payload", "delete_branch", "manage_secrets",
]);
const PAYMENT_ACTIONS = new Set(["execute_payment"]);
export class CreditViolationError extends Error {
  constructor(message: string) {
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
    if (parent === current) throw new CreditViolationError("Path has no accessible ancestor");
    tail.unshift(relative(parent, current));
    current = parent;
  }
  return resolve(realpathSync(current), ...tail);
}
function globRegex(pattern: string): RegExp {
  // Small, predictable glob subset: * matches one path segment; ** matches any depth.
  if (!pattern || isAbsolute(pattern) || pattern.startsWith("..") ||
      pattern.split("/").includes("..") || pattern.includes("\\") || pattern.includes(":")) {
    throw new CreditViolationError("Invalid allowed_paths pattern");
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
export function checkAllowedPath(target: string, patterns: string[], root = process.cwd()): boolean {
  if (!target || patterns.length === 0) return false;
  const projectRoot = realpathSync(resolve(root));
  const absolute = resolve(projectRoot, target);
  // Reject lexical escapes AND symlinks pointing outside the project.
  if (!inside(projectRoot, absolute)) return false;
  const resolved = canonicalExistingAncestor(absolute);
  if (!inside(projectRoot, resolved)) return false;
  const vault = resolve(creditVaultDir());
  if (inside(vault, resolved) || inside(vault, absolute)) return false;
  const rel = relative(projectRoot, resolved).split(sep).join("/");
  return patterns.some((pattern) => globRegex(pattern).test(rel));
}
export interface GuardContext {
  root?: string;
  spentUsd?: number;
}
export function validateToolExecution(
  record: DomainCredit,
  attempt: ToolAttempt,
  context: GuardContext = {},
): PermissionTier {
  const required = REQUIRED_TIER[attempt.action];
  if (required === undefined) throw new CreditViolationError(`Unknown tool action "${attempt.action}" (fail closed)`);
  const tier = effectiveTier(record);
  if (record.credit_limit.blocked_actions.includes("*") ||
      record.credit_limit.blocked_actions.includes(attempt.action)) {
    throw new CreditViolationError(`Action "${attempt.action}" explicitly blocked by consumer`);
  }
  if (tier < required) {
    throw new CreditViolationError(`Action "${attempt.action}" requires Tier ${required}; consumer credit allows Tier ${tier}`);
  }
  if (EXPLICIT_ACTIONS.has(attempt.action) && !record.credit_limit.allowed_actions.includes(attempt.action)) {
    throw new CreditViolationError(`Action "${attempt.action}" requires explicit consumer authorization`);
  }
  if (FILE_ACTIONS.has(attempt.action)) {
    if (!attempt.target || !checkAllowedPath(attempt.target, record.credit_limit.allowed_paths, context.root)) {
      throw new CreditViolationError(`File path not authorized for "${attempt.action}"`);
    }
  }
  if (PAYMENT_ACTIONS.has(attempt.action)) {
    const amount = attempt.amountUsd;
    const cap = record.credit_limit.financial_cap_usd;
    const spent = context.spentUsd ?? 0;
    if (!Number.isFinite(amount) || amount === undefined || amount <= 0 ||
        !Number.isFinite(spent) || spent < 0 || !Number.isFinite(cap) ||
        cap <= 0 || spent + amount > cap) {
      throw new CreditViolationError("Payment exceeds the consumer's remaining credit budget");
    }
  }
  return tier;
}
/**
 * Per-session host integration point. Only actions invoked with execute() are
 * guarded. This is NOT a hook into unrelated Claude/Gemini/ChatGPT tools.
 */
export class CreditGuardedSession {
  private spentUsd = 0;
  constructor(
    private readonly identity: CreditIdentity,
    private readonly opts: { vault?: string; root?: string } = {},
  ) {}
  verify(attempt: ToolAttempt): PermissionTier {
    const domain = getDomain(readCreditReport(this.opts.vault), this.identity);
    return validateToolExecution(domain, attempt, { root: this.opts.root, spentUsd: this.spentUsd });
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
