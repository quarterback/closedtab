import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyReport, ensureDomain, getDomain, initializeCreditReport, readCreditReport, writeCreditReport } from "../src/credit/store.js";
import { setConsumerGrant } from "../src/credit/policy.js";
import { interactionDelta, nextVeracityScore, finalizeCreditSession } from "../src/credit/finalizer.js";
import { effectiveTier, scoreTier } from "../src/credit/types.js";
import { validateToolExecution, CreditViolationError } from "../src/credit/guard.js";
import { generateCreditPassport } from "../src/credit/passport.js";

const CLAUDE = { productId: "anthropic/claude", domain: "code-refactoring" };
const roots: string[] = [];
function temp() {
  const root = mkdtempSync(join(tmpdir(), "ct-ace-"));
  roots.push(root);
  return { root, vault: join(root, "vault") };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("consumer-owned credit", () => {
  it("initializes a private vault without granting autonomy", () => {
    const { vault } = temp();
    const path = initializeCreditReport(vault);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(getDomain(readCreditReport(vault), CLAUDE).user_max_tier).toBe(0);
  });
  it("is scoped to product and task, not a model version", () => {
    const { vault } = temp();
    setConsumerGrant(CLAUDE, { maxTier: 2, allowedPaths: ["src/**"] }, vault);
    expect(getDomain(readCreditReport(vault), CLAUDE).user_max_tier).toBe(2);
    expect(getDomain(readCreditReport(vault), { productId: "google/gemini", domain: "code-refactoring" }).user_max_tier).toBe(0);
  });
  it("uses EMA and does not rate an unreviewed closure as accepted", () => {
    expect(nextVeracityScore(5, 1)).toBe(6);
    expect(nextVeracityScore(6, -1)).toBe(4.8);
    expect(interactionDelta("unreviewed", "draft", "draft").delta).toBeNull();
    expect(interactionDelta("accepted", "draft", "draft").delta).toBe(1);
    const { vault } = temp();
    expect(finalizeCreditSession({ ...CLAUDE, outcome: "unreviewed" }, vault).score).toBe(5);
    const r = finalizeCreditSession({
      ...CLAUDE, outcome: "accepted", intent: "A task",
      agentDraft: "hello world", userFinal: "hello world",
    }, vault);
    expect(r.score).toBe(6);
    expect(readFileSync(r.aar_path, "utf8")).toContain("A task");
  });
  it("keeps consumer tier ceiling separate from the score", () => {
    const domain = ensureDomain(emptyReport(), CLAUDE);
    domain.veracity_score = 9.2;
    domain.user_max_tier = 1;
    domain.permission_tier = 1;
    expect(scoreTier(domain.veracity_score)).toBe(3);
    expect(effectiveTier(domain)).toBe(1);
    expect(() => validateToolExecution(domain, { action: "edit_file", target: "src/app.ts" })).toThrow(CreditViolationError);
  });
  it("refuses unknown actions and unauthorized remote calls", () => {
    const domain = ensureDomain(emptyReport(), CLAUDE);
    domain.veracity_score = 7.5;
    domain.user_max_tier = 2;
    domain.permission_tier = 2;
    expect(() => validateToolExecution(domain, { action: "unknown_action" })).toThrow(/Unknown tool/);
    expect(() => validateToolExecution(domain, { action: "schedule_invite" })).toThrow(/explicit/);
    domain.credit_limit.allowed_actions = ["schedule_invite"];
    expect(validateToolExecution(domain, { action: "schedule_invite" })).toBe(2);
  });
  it("automatically contracts, but never automatically restores, permission after scoring", () => {
    const { vault } = temp();
    const id = CLAUDE;
    // Preexisting consumer approval at a high-performing level.
    const report = emptyReport();
    const approved = ensureDomain(report, id);
    approved.veracity_score = 9.0;
    approved.user_max_tier = 3;
    approved.permission_tier = 3;
    writeCreditReport(report, vault);
    // Poor observed result moves score 9.0 -> 7.2, contracting from 3 to 2.
    finalizeCreditSession({ ...id, outcome: "rejected" }, vault);
    expect(getDomain(readCreditReport(vault), id).permission_tier).toBe(2);
    // Scores can recover, but authority remains at 2 until the consumer signs off.
    for (let i = 0; i < 8; i++) {
      finalizeCreditSession({
        ...id, outcome: "accepted", agentDraft: "abc", userFinal: "abc",
      }, vault);
    }
    const recovered = getDomain(readCreditReport(vault), id);
    expect(scoreTier(recovered.veracity_score)).toBe(3);
    expect(effectiveTier(recovered)).toBe(2);
    setConsumerGrant(id, { maxTier: 3 }, vault);
    expect(effectiveTier(getDomain(readCreditReport(vault), id))).toBe(3);
  });
  it("does not give the agent the private AAR ledger", () => {
    const { vault } = temp();
    const passport = generateCreditPassport(CLAUDE, vault);
    expect(passport).toContain("consumer ceiling");
    expect(passport).not.toContain("recent_aars");
  });
});
