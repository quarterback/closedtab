import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readCreditReport, getDomain, initializeCreditReport, creditVaultDir } from "./credit/store.js";
import { setConsumerGrant, confirmTierThreeGrant, disputeCreditEvent, parseMinScores } from "./credit/policy.js";
import { generateCreditPassport } from "./credit/passport.js";
import { validateToolExecution, CreditViolationError } from "./credit/guard.js";
import { finalizeCreditSession, settleActionEvidence } from "./credit/finalizer.js";
import { renderCreditReportHtml } from "./credit/report.js";
import {
  EVIDENCE_LEVELS, MIN_HISTORY, SCORE_MAX, SCORE_MIN,
  bandFor, effectiveTier, eligibleTier, grantAvailable, scoreTier, scoredEvents,
  type CreditIdentity, type DomainCredit, type EvidenceLevel, type PermissionTier, type SessionOutcome,
} from "./credit/types.js";

type Args = { [k: string]: string | boolean | string[]; _: string[] };
function value(args: Args, key: string): string | undefined {
  return typeof args[key] === "string" ? args[key] as string : undefined;
}
function csv(text: string): string[] {
  return text === "" ? [] : text.split(",").map((s) => s.trim()).filter(Boolean);
}
function identity(args: Args): CreditIdentity {
  const productId = value(args, "product");
  const domain = value(args, "domain");
  if (!productId || !domain) throw new Error("Pass --product provider/product and --domain task-context.");
  return { productId, domain };
}
/** What the person sees about one domain. The agent never gets this. */
function summarize(id: CreditIdentity, d: DomainCredit) {
  const scored = scoredEvents(d);
  return {
    product_id: id.productId,
    domain: id.domain,
    score: Math.round(d.score),
    band: scored === 0 ? "No scored history yet" : bandFor(d.score),
    range: `${SCORE_MIN}-${SCORE_MAX}`,
    effective_tier: effectiveTier(d),
    ceiling: d.user_max_tier,
    score_tier: scoreTier(d.score),
    eligible_tier: eligibleTier(d),
    grant_available: grantAvailable(d),
    scored_events: scored,
    history_needed: { tier_2: MIN_HISTORY[2], tier_3: MIN_HISTORY[3] },
    pending_grant: d.pending_grant,
    held_actions: d.held_actions,
    limits: d.credit_limit,
    stats: d.stats,
  };
}
const CREDIT_HELP = `closedtab credit: a consumer-held credit record for AI products

  closedtab credit init
  closedtab credit show --product anthropic/claude --domain code-refactoring
      Your view: score (${SCORE_MIN} to ${SCORE_MAX}), band, tiers, limits, what you can grant next.
  closedtab credit passport --product anthropic/claude --domain code-refactoring [--reader "claude-code"]
      The agent's view: its limits only, never the score. Each read is recorded as an inquiry.
  closedtab credit grant --product anthropic/claude --domain code-refactoring --max-tier 2 --paths 'src/**,tests/**'
      Optional: --allow-actions internal_api,schedule_invite --blocked-actions push_to_main,manage_secrets
                --financial-cap 0 --min-score edit_file=450,run_tests=400 (or --min-score none)
      Only grant raises authority, and never past what the score and history support:
      tier 2 needs a score of 450 and ${MIN_HISTORY[2]} scored events, tier 3 needs 550 and ${MIN_HISTORY[3]}.
      A grant that raises a domain to tier 3 waits 24 hours, then needs:
  closedtab credit grant --product anthropic/claude --domain code-refactoring --confirm
  closedtab credit check --product anthropic/claude --domain code-refactoring --action edit_file --target src/app.ts [--root .]
      Dry-run policy check (never performs the underlying action).
  closedtab credit close --product anthropic/claude --domain code-refactoring
      --outcome accepted --draft /tmp/agent.txt --final /tmp/user.txt
      [--intent "Refactor middleware"] [--summary "Tests passed"]
      Also supports outcomes rejected, crashed, unreviewed. Closing a tab
      without observed user acceptance does not earn a positive score.
  closedtab credit settle --product stenodisc/helper --domain scheduling --ref job-123
      --evidence verified|company|exchange|helper|contradicted [--summary "City confirmed"]
      Scores an action once its proof settles. A contradiction tilts the domain.
  closedtab credit dispute --event ev_0123456789 --reason "Rejected by mistake"
      Sets one event aside and recomputes the score. Never raises a tier by itself.
  closedtab credit events [--product anthropic/claude] [--domain code-refactoring]
  closedtab credit report [--product anthropic/claude] [--out agent-credit-report.html]
      Writes the printable credit report: one page per product.

The record is kept in ~/.closedtab/agent_credit_report.json (0600) as a list of
events; every score is computed from them. This CLI is a control plane and
dry-run checker; host tool calls must be routed through CreditGuardedSession
to receive runtime enforcement.`;

export function runCreditCommand(args: Args): number {
  const sub = args._[0] ?? "help";
  const vault = value(args, "vault") ?? creditVaultDir();
  try {
    if (sub === "help") { console.log(CREDIT_HELP); return 0; }
    if (sub === "init") {
      console.log(initializeCreditReport(vault));
      return 0;
    }
    if (sub === "dispute") {
      const event = value(args, "event");
      const reason = value(args, "reason");
      if (!event || !reason) throw new Error("dispute requires --event ev_... and --reason \"what was wrong\"");
      const r = disputeCreditEvent(event, reason, vault);
      const id = { productId: r.product_id, domain: r.domain };
      console.log(JSON.stringify({
        disputed: event, product_id: r.product_id, domain: r.domain,
        score_before: Math.round(r.before.score), score_after: Math.round(r.after.score),
        after: summarize(id, r.after),
      }, null, 2));
      return 0;
    }
    if (sub === "events") {
      const product = value(args, "product");
      const domain = value(args, "domain");
      const events = readCreditReport(vault).events.filter((e) =>
        (!product || e.product_id === product) && (!domain || e.domain === domain));
      for (const e of events) console.log(JSON.stringify(e));
      return 0;
    }
    if (sub === "report") {
      const product = value(args, "product");
      const out = resolve(value(args, "out") ?? "agent-credit-report.html");
      const html = renderCreditReportHtml(readCreditReport(vault), {
        productId: product,
        recordLabel: vault === creditVaultDir() && !process.env.CLOSEDTAB_CREDIT_DIR ? "~/.closedtab on this device" : `${vault} on this device`,
      });
      writeFileSync(out, html, { encoding: "utf8", mode: 0o600 });
      console.log(out);
      return 0;
    }
    const id = identity(args);
    if (sub === "show") {
      console.log(JSON.stringify(summarize(id, getDomain(readCreditReport(vault), id)), null, 2));
      return 0;
    }
    if (sub === "passport") {
      console.log(generateCreditPassport(id, vault, { reader: value(args, "reader") }));
      return 0;
    }
    if (sub === "grant") {
      if (args.confirm === true) {
        const confirmed = confirmTierThreeGrant(id, vault);
        console.log(JSON.stringify({ ...summarize(id, confirmed), notes: confirmed.notes }, null, 2));
        return 0;
      }
      const rawTier = value(args, "max-tier");
      const maxTier = rawTier === undefined ? NaN : Number(rawTier);
      if (![0, 1, 2, 3].includes(maxTier)) throw new Error("grant requires --max-tier 0, 1, 2, or 3 (or --confirm)");
      const minScore = value(args, "min-score");
      const grant = {
        maxTier: maxTier as PermissionTier,
        ...(value(args, "paths") !== undefined ? { allowedPaths: csv(value(args, "paths")!) } : {}),
        ...(value(args, "allow-actions") !== undefined ? { allowedActions: csv(value(args, "allow-actions")!) } : {}),
        ...(value(args, "blocked-actions") !== undefined ? { blockedActions: csv(value(args, "blocked-actions")!) } : {}),
        ...(value(args, "financial-cap") !== undefined ? { financialCapUsd: Number(value(args, "financial-cap")) } : {}),
        ...(minScore !== undefined ? { minScores: parseMinScores(minScore) } : {}),
      };
      const updated = setConsumerGrant(id, grant, vault);
      console.log(JSON.stringify({ ...summarize(id, updated), notes: updated.notes }, null, 2));
      return 0;
    }
    if (sub === "check") {
      const action = value(args, "action");
      if (!action) throw new Error("check requires --action");
      const domain = getDomain(readCreditReport(vault), id);
      const tier = validateToolExecution(domain, {
        action,
        target: value(args, "target"),
        amountUsd: value(args, "amount") !== undefined ? Number(value(args, "amount")) : undefined,
      }, { root: value(args, "root"), vault });
      console.log(JSON.stringify({ allowed: true, tier, action, product_id: id.productId, domain: id.domain }, null, 2));
      return 0;
    }
    if (sub === "close") {
      const outcome = value(args, "outcome") as SessionOutcome | undefined;
      if (!outcome || !["accepted", "rejected", "crashed", "unreviewed"].includes(outcome))
        throw new Error("close requires --outcome accepted|rejected|crashed|unreviewed");
      const draft = value(args, "draft");
      const final = value(args, "final");
      const result = finalizeCreditSession({
        ...id,
        outcome,
        intent: value(args, "intent"),
        summary: value(args, "summary"),
        agentDraft: draft ? readFileSync(draft, "utf8") : undefined,
        userFinal: final ? readFileSync(final, "utf8") : undefined,
      }, vault);
      console.log(JSON.stringify({
        ...result,
        score: Math.round(result.score),
        note: result.grant_available === null ? undefined
          : `This domain now qualifies for tier ${result.grant_available}. It stays where it is until you run grant.`,
      }, null, 2));
      return 0;
    }
    if (sub === "settle") {
      const ref = value(args, "ref");
      const evidence = value(args, "evidence") as EvidenceLevel | undefined;
      if (!ref || !evidence || !EVIDENCE_LEVELS.includes(evidence)) {
        throw new Error(`settle requires --ref and --evidence ${EVIDENCE_LEVELS.join("|")}`);
      }
      const result = settleActionEvidence({ ...id, ref, evidence, summary: value(args, "summary") }, vault);
      console.log(JSON.stringify({ ...result, score: Math.round(result.score) }, null, 2));
      return 0;
    }
    console.error(`closedtab credit: unknown subcommand "${sub}"\n\n${CREDIT_HELP}`);
    return 2;
  } catch (e) {
    const denied = e instanceof CreditViolationError;
    console.error(`closedtab credit: ${denied ? "DENIED: " : ""}${(e as Error).message}`);
    return denied ? 3 : 2;
  }
}
