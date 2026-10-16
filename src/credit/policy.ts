import { ensureDomain, readCreditReport, writeCreditReport, creditVaultDir } from "./store.js";
import { scoreTier, type CreditIdentity, type PermissionTier } from "./types.js";

export interface ConsumerGrant {
  maxTier: PermissionTier;
  allowedPaths?: string[];
  allowedActions?: string[];
  blockedActions?: string[];
  financialCapUsd?: number;
}
/** An explicit consumer operation, not an agent-controlled score adjustment. */
export function setConsumerGrant(identity: CreditIdentity, grant: ConsumerGrant, vault = creditVaultDir()) {
  if (![0, 1, 2, 3].includes(grant.maxTier)) throw new Error("maxTier must be 0, 1, 2, or 3");
  if (grant.financialCapUsd !== undefined &&
      (!Number.isFinite(grant.financialCapUsd) || grant.financialCapUsd < 0)) {
    throw new Error("financialCapUsd must be nonnegative");
  }
  const report = readCreditReport(vault);
  const domain = ensureDomain(report, identity);
  domain.user_max_tier = grant.maxTier;
  if (grant.allowedPaths !== undefined) {
    // Validate all glob patterns before writing them. Absolute/traversal paths
    // are never valid authorization roots.
    for (const p of grant.allowedPaths) {
      if (!p || p.startsWith("/") || p.includes("\\") || p.split("/").includes("..") ||
          p.includes(":")) throw new Error(`Invalid allowed path pattern: ${p}`);
    }
    domain.credit_limit.allowed_paths = [...new Set(grant.allowedPaths)];
  }
  if (grant.allowedActions !== undefined)
    domain.credit_limit.allowed_actions = [...new Set(grant.allowedActions)];
  if (grant.blockedActions !== undefined)
    domain.credit_limit.blocked_actions = [...new Set(grant.blockedActions)];
  if (grant.financialCapUsd !== undefined)
    domain.credit_limit.financial_cap_usd = grant.financialCapUsd;
  // This API is the explicit consumer authorization event. It can restore a
  // previously reduced tier, but never exceed current demonstrated eligibility.
  domain.permission_tier = Math.min(scoreTier(domain.veracity_score), grant.maxTier) as PermissionTier;
  writeCreditReport(report, vault);
  return domain;
}
