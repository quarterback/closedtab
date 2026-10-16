import { readFileSync } from "node:fs";
import { readCreditReport, getDomain, initializeCreditReport } from "./credit/store.js";
import { setConsumerGrant } from "./credit/policy.js";
import { generateCreditPassport } from "./credit/passport.js";
import { validateToolExecution, CreditViolationError } from "./credit/guard.js";
import { finalizeCreditSession } from "./credit/finalizer.js";
import type { CreditIdentity, PermissionTier, SessionOutcome } from "./credit/types.js";

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
const CREDIT_HELP = `closedtab credit: consumer-issued credit for AI products

  closedtab credit init
  closedtab credit show --product anthropic/claude --domain code-refactoring
  closedtab credit passport --product anthropic/claude --domain code-refactoring
  closedtab credit grant --product anthropic/claude --domain code-refactoring --max-tier 2 --paths 'src/**,tests/**'
      Optional: --allow-actions internal_api,schedule_invite --blocked-actions push_to_main,manage_secrets
                --financial-cap 0
      Only grant sets a user's maximum tier. Higher scores never override this limit.
  closedtab credit check --product anthropic/claude --domain code-refactoring --action edit_file --target src/app.ts [--root .]
      Dry-run policy check (never performs the underlying action).
  closedtab credit close --product anthropic/claude --domain code-refactoring
      --outcome accepted --draft /tmp/agent.txt --final /tmp/user.txt
      [--intent "Refactor middleware"] [--summary "Tests passed"]
      Also supports outcomes rejected, crashed, unreviewed. Closing a tab
      without observed user acceptance does not earn a positive score.

Credit state is kept in ~/.closedtab/agent_credit_report.json (0600).
This CLI is a control plane and dry-run checker; host tool calls must be
routed through CreditGuardedSession to receive runtime enforcement.`;

export function runCreditCommand(args: Args): number {
  const sub = args._[0] ?? "help";
  const vault = value(args, "vault");
  try {
    if (sub === "help") { console.log(CREDIT_HELP); return 0; }
    if (sub === "init") {
      console.log(initializeCreditReport(vault));
      return 0;
    }
    const id = identity(args);
    if (sub === "show") {
      const domain = getDomain(readCreditReport(vault), id);
      console.log(JSON.stringify({ product_id: id.productId, domain: id.domain, ...domain }, null, 2));
      return 0;
    }
    if (sub === "passport") {
      console.log(generateCreditPassport(id, vault));
      return 0;
    }
    if (sub === "grant") {
      const rawTier = value(args, "max-tier");
      const maxTier = rawTier === undefined ? NaN : Number(rawTier);
      if (![0, 1, 2, 3].includes(maxTier)) throw new Error("grant requires --max-tier 0, 1, 2, or 3");
      const grant = {
        maxTier: maxTier as PermissionTier,
        ...(value(args, "paths") !== undefined ? { allowedPaths: csv(value(args, "paths")!) } : {}),
        ...(value(args, "allow-actions") !== undefined ? { allowedActions: csv(value(args, "allow-actions")!) } : {}),
        ...(value(args, "blocked-actions") !== undefined ? { blockedActions: csv(value(args, "blocked-actions")!) } : {}),
        ...(value(args, "financial-cap") !== undefined ? { financialCapUsd: Number(value(args, "financial-cap")) } : {}),
      };
      const updated = setConsumerGrant(id, grant, vault);
      console.log(JSON.stringify({ product_id: id.productId, domain: id.domain, ...updated }, null, 2));
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
      }, { root: value(args, "root") });
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
      console.log(JSON.stringify(result, null, 2));
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
