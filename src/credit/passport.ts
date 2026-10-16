import { commitCreditEvents, creditVaultDir, getDomain, newEventId, readCreditReport } from "./store.js";
import { permittedActions } from "./guard.js";
import { EXPLICIT_ACTIONS, effectiveTier, validateIdentity, type CreditIdentity } from "./types.js";

export interface PassportOptions {
  /** Who is reading the limits (an agent or host name). Recorded as an inquiry. */
  reader?: string;
  /** Record this read as an inquiry on the person's credit report. Default true. */
  record?: boolean;
}

/**
 * Minimal, non-secret context for the model: its limits and nothing else.
 * The score stays out, so the agent has no number to optimize toward; the
 * score is for the person, who sets permissions against it. The host guard
 * is authoritative. Each read is recorded as an inquiry unless record is false.
 */
export function generateCreditPassport(
  identity: CreditIdentity,
  vault: string = creditVaultDir(),
  opts: PassportOptions = {},
): string {
  validateIdentity(identity);
  const reader = (opts.reader ?? "unnamed agent").trim().slice(0, 200) || "unnamed agent";
  const report = opts.record === false
    ? readCreditReport(vault)
    : commitCreditEvents(vault, (current) => [{
        id: newEventId(current), at: new Date().toISOString(),
        product_id: identity.productId, domain: identity.domain,
        type: "inquiry", reader,
      }]);
  const domain = getDomain(report, identity);
  const limits = domain.credit_limit;
  const allowedRemote = EXPLICIT_ACTIONS.filter((a) => limits.allowed_actions.includes(a));
  const needYes = EXPLICIT_ACTIONS.filter((a) =>
    !limits.allowed_actions.includes(a) && !limits.blocked_actions.includes(a));
  return [
    "[CLOSEDTAB CREDIT PASSPORT — CONTEXT, NOT AUTHORIZATION]",
    `Product: ${identity.productId}`,
    `Domain: ${identity.domain}`,
    `Enforced effective tier: ${effectiveTier(domain)} (consumer ceiling: ${domain.user_max_tier})`,
    `Actions you may attempt now: ${permittedActions(domain).join(", ") || "(none)"}`,
    `Allowed project paths: ${limits.allowed_paths.join(", ") || "(none)"}`,
    `Explicitly blocked actions: ${limits.blocked_actions.join(", ") || "(none)"}`,
    `Remote actions the person has said yes to: ${allowedRemote.join(", ") || "(none)"}`,
    `Remote actions that need the person's separate yes: ${needYes.join(", ") || "(none)"}`,
    `Session financial cap: USD ${limits.financial_cap_usd.toFixed(2)}`,
    "Do not attempt actions beyond these constraints. The host validates every tool call,",
    "and an attempt at a blocked action lowers the authority you are given.",
    "The person's private record of your work is not supplied to the model.",
  ].join("\n");
}
