/**
 * CT-ACE rates consumer-facing products (anthropic/claude, google/gemini),
 * not ephemeral model sessions or subagents. A domain is a task context.
 */
export type PermissionTier = 0 | 1 | 2 | 3;
export type SessionOutcome = "accepted" | "rejected" | "crashed" | "unreviewed";

export interface CreditLimit {
  allowed_paths: string[];
  blocked_actions: string[];
  allowed_actions: string[];
  financial_cap_usd: number;
}
export interface CreditStats {
  total_sessions: number;
  reviewed_sessions: number;
  untouched_acceptances: number;
  untouched_acceptance_rate: number;
  consecutive_successes: number;
}
export interface DomainCredit {
  veracity_score: number;
  permission_tier: PermissionTier;
  user_max_tier: PermissionTier;
  credit_limit: CreditLimit;
  stats: CreditStats;
}
export interface ProductCredit {
  display_name: string;
  domains: Record<string, DomainCredit>;
}
export interface CreditAar {
  aar_id: string;
  timestamp: string;
  product_id: string;
  domain: string;
  intent: string;
  outcome: SessionOutcome;
  interaction_delta: number | null;
  edit_ratio: number | null;
  score_change: number;
  summary: string;
}
export interface CreditReport {
  version: "1.0.0";
  updated_at: string;
  products: Record<string, ProductCredit>;
  recent_aars: CreditAar[];
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
export const DEFAULT_BLOCKED_ACTIONS = ["manage_secrets", "delete_branch", "push_to_main"];
export function scoreTier(score: number): PermissionTier {
  if (score >= 8.5) return 3;
  if (score >= 6.5) return 2;
  if (score >= 4) return 1;
  return 0;
}
export function effectiveTier(record: DomainCredit): PermissionTier {
  return Math.min(scoreTier(record.veracity_score), record.user_max_tier) as PermissionTier;
}
export function newDomain(): DomainCredit {
  return {
    veracity_score: 5,
    permission_tier: 0,
    user_max_tier: 0,
    credit_limit: {
      allowed_paths: [],
      blocked_actions: [...DEFAULT_BLOCKED_ACTIONS],
      allowed_actions: [],
      financial_cap_usd: 0,
    },
    stats: {
      total_sessions: 0,
      reviewed_sessions: 0,
      untouched_acceptances: 0,
      untouched_acceptance_rate: 0,
      consecutive_successes: 0,
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
