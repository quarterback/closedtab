import { getDomain, readCreditReport } from "./store.js";
import { effectiveTier, type CreditIdentity } from "./types.js";

/** Minimal, non-secret context for the model. The host guard is authoritative. */
export function generateCreditPassport(
  identity: CreditIdentity,
  vault?: string,
): string {
  const domain = getDomain(readCreditReport(vault), identity);
  const tier = effectiveTier(domain);
  const limits = domain.credit_limit;
  return [
    "[CLOSEDTAB CREDIT PASSPORT — CONTEXT, NOT AUTHORIZATION]",
    `Product: ${identity.productId}`,
    `Domain: ${identity.domain}`,
    `Consumer performance score: ${domain.veracity_score.toFixed(2)}/10`,
    `Enforced effective tier: ${tier} (consumer ceiling: ${domain.user_max_tier})`,
    `Allowed project paths: ${limits.allowed_paths.join(", ") || "(none)"}`,
    `Explicitly blocked actions: ${limits.blocked_actions.join(", ") || "(none)"}`,
    `Separately authorized remote actions: ${limits.allowed_actions.join(", ") || "(none)"}`,
    `Session financial cap: USD ${limits.financial_cap_usd.toFixed(2)}`,
    "Do not attempt actions beyond these constraints. The host validates every tool call.",
    "The complete private ledger and feedback history are not supplied to the model.",
  ].join("\n");
}
