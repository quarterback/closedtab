import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, lstatSync, rmSync, writeFileSync, mkdirSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyReport, getDomain, initializeCreditReport, readCreditReport, writeCreditReport,
  ledgerPath, withVaultLock,
} from "../src/credit/store.js";
import { setConsumerGrant, confirmTierThreeGrant, disputeCreditEvent, parseMinScores } from "../src/credit/policy.js";
import { interactionDelta, finalizeCreditSession, settleActionEvidence } from "../src/credit/finalizer.js";
import { applyPoints, foldDomain, targetFor } from "../src/credit/engine.js";
import {
  effectiveTier, scoreTier, bandFor, eligibleTier, grantAvailable, newDomain,
  type CreditStats, type DomainCredit,
} from "../src/credit/types.js";
import { CreditGuardedSession, validateToolExecution, CreditViolationError } from "../src/credit/guard.js";
import { generateCreditPassport } from "../src/credit/passport.js";

const CLAUDE = { productId: "anthropic/claude", domain: "code-refactoring" };
const roots: string[] = [];
function temp() {
  const root = mkdtempSync(join(tmpdir(), "ct-ace-"));
  roots.push(root);
  return { root, vault: join(root, "vault") };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Seed = Partial<Omit<DomainCredit, "stats" | "credit_limit">> & {
  stats?: Partial<CreditStats>;
  credit_limit?: Partial<DomainCredit["credit_limit"]>;
};
/** Start a ledger from a known state, the way a migrated ledger starts. */
function seed(vault: string, s: Seed, id = CLAUDE) {
  const d = newDomain();
  const state: DomainCredit = {
    ...d, ...s,
    credit_limit: { ...d.credit_limit, ...s.credit_limit },
    stats: { ...d.stats, ...s.stats },
  };
  const report = emptyReport();
  report.events.push({
    id: "ev_00000000aa", at: "2026-10-01T12:00:00.000Z",
    product_id: id.productId, domain: id.domain, type: "baseline", state,
  });
  writeCreditReport(report, vault);
}
const accept = (vault: string, at?: Date) => finalizeCreditSession({
  ...CLAUDE, outcome: "accepted", agentDraft: "same words", userFinal: "same words", at,
}, vault);
const domainOf = (vault: string) => getDomain(readCreditReport(vault), CLAUDE);

describe("the record", () => {
  it("initializes a private vault without granting autonomy", () => {
    const { vault } = temp();
    const path = initializeCreditReport(vault);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    const d = domainOf(vault);
    expect(d.user_max_tier).toBe(0);
    expect(d.score).toBe(350);
    expect(effectiveTier(d)).toBe(0);
  });
  it("is scoped to product and task, not a model version", () => {
    const { vault } = temp();
    setConsumerGrant(CLAUDE, { maxTier: 2, allowedPaths: ["src/**"] }, vault);
    expect(domainOf(vault).user_max_tier).toBe(2);
    expect(getDomain(readCreditReport(vault), { productId: "google/gemini", domain: "code-refactoring" }).user_max_tier).toBe(0);
  });
  it("keeps every change as an event and recomputes the view on read", () => {
    const { vault } = temp();
    setConsumerGrant(CLAUDE, { maxTier: 1 }, vault);
    accept(vault);
    const onDisk = JSON.parse(readFileSync(ledgerPath(vault), "utf8"));
    expect(onDisk.version).toBe("2.0.0");
    expect(onDisk.events.map((e: { type: string }) => e.type)).toEqual(["grant", "session_closed"]);
    // Editing the snapshot grants nothing: the view comes from the events.
    onDisk.products[CLAUDE.productId].domains[CLAUDE.domain].permission_tier = 3;
    onDisk.products[CLAUDE.productId].domains[CLAUDE.domain].user_max_tier = 3;
    writeFileSync(ledgerPath(vault), JSON.stringify(onDisk));
    expect(effectiveTier(domainOf(vault))).toBe(1);
  });
  it("fails closed on a corrupted event instead of treating it as permission", () => {
    const { vault } = temp();
    setConsumerGrant(CLAUDE, { maxTier: 2 }, vault);
    const onDisk = JSON.parse(readFileSync(ledgerPath(vault), "utf8"));
    onDisk.events[0].max_tier = "invalid";
    writeFileSync(ledgerPath(vault), JSON.stringify(onDisk));
    expect(() => readCreditReport(vault)).toThrow(/Invalid CT-ACE/);
    expect(() => generateCreditPassport(CLAUDE, vault)).toThrow(/Invalid CT-ACE/);
    writeFileSync(ledgerPath(vault), "{not json");
    expect(() => readCreditReport(vault)).toThrow(/Invalid CT-ACE/);
  });
  it("migrates a 1.0.0 ledger onto the 100 to 600 range", () => {
    const { vault } = temp();
    mkdirSync(vault, { recursive: true });
    const d = {
      veracity_score: 8, permission_tier: 2, user_max_tier: 2,
      credit_limit: { allowed_paths: ["src/**"], blocked_actions: ["push_to_main"], allowed_actions: [], financial_cap_usd: 0 },
      stats: { total_sessions: 12, reviewed_sessions: 11, untouched_acceptances: 6, untouched_acceptance_rate: 0.5455, consecutive_successes: 2 },
    };
    writeFileSync(ledgerPath(vault), JSON.stringify({
      version: "1.0.0", updated_at: "2026-10-16T12:00:00.000Z",
      products: { [CLAUDE.productId]: { display_name: CLAUDE.productId, domains: { [CLAUDE.domain]: d } } },
      recent_aars: [],
    }));
    const migrated = domainOf(vault);
    expect(migrated.score).toBe(500);
    expect(migrated.permission_tier).toBe(2);
    expect(migrated.credit_limit.allowed_paths).toEqual(["src/**"]);
    expect(migrated.stats.reviewed_sessions).toBe(11);
    accept(vault);
    expect(JSON.parse(readFileSync(ledgerPath(vault), "utf8")).version).toBe("2.0.0");
  });
  it("clears a stale lock left by a crashed process", () => {
    const { vault } = temp();
    initializeCreditReport(vault);
    const lock = join(vault, ".agent_credit_report.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(withVaultLock(vault, () => "ran")).toBe("ran");
    expect(existsSync(lock)).toBe(false);
  });
});

describe("the score", () => {
  it("reads like a credit score: 100 to 600 with bands mapped to tiers", () => {
    expect(targetFor(1)).toBe(600);
    expect(targetFor(-1)).toBe(100);
    expect([scoreTier(299.9), scoreTier(300), scoreTier(450), scoreTier(550)]).toEqual([0, 1, 2, 3]);
    expect([bandFor(299), bandFor(300), bandFor(450), bandFor(550)])
      .toEqual(["Deep Subprime", "Subprime", "Near Prime", "Prime"]);
  });
  it("does not rate an unreviewed closure as accepted", () => {
    expect(interactionDelta("unreviewed", "draft", "draft").delta).toBeNull();
    expect(interactionDelta("accepted", "draft", "draft").delta).toBe(1);
    const { vault } = temp();
    expect(finalizeCreditSession({ ...CLAUDE, outcome: "unreviewed" }, vault).score).toBe(350);
    const r = finalizeCreditSession({
      ...CLAUDE, outcome: "accepted", intent: "A task", agentDraft: "hello world", userFinal: "hello world",
    }, vault);
    expect(r.score).toBe(400);
    expect(readFileSync(r.aar_path, "utf8")).toContain("A task");
    expect(r.aar.score_change).toBe(50);
  });
  it("builds a combo on a streak and resets it on a failure", () => {
    const { vault } = temp();
    const scores = [1, 2, 3, 4, 5].map(() => accept(vault).score);
    expect(scores.slice(0, 3)).toEqual([400, 450, 495]);
    expect(scores[4]).toBeGreaterThanOrEqual(550);
    expect(domainOf(vault).stats.consecutive_successes).toBe(5);
    finalizeCreditSession({ ...CLAUDE, outcome: "rejected" }, vault);
    expect(domainOf(vault).stats.consecutive_successes).toBe(0);
  });
  it("lets stronger evidence move the score further", () => {
    const fresh = () => newDomain();
    const draft = fresh(); applyPoints(draft, 1);
    const company = fresh(); applyPoints(company, 0.5, 1.5);
    const verified = fresh(); applyPoints(verified, 1, 2);
    expect(draft.score).toBe(400);
    expect(company.score).toBe(387.5);
    expect(verified.score).toBe(450);
  });
  it("settles an action once, and lets a contradiction follow and tilt", () => {
    const { vault } = temp();
    seed(vault, { score: 520, permission_tier: 2, user_max_tier: 2, stats: { reviewed_sessions: 12, total_sessions: 12 } });
    const ok = settleActionEvidence({ ...CLAUDE, ref: "job-1", evidence: "company" }, vault);
    expect(ok.score_change).toBeLessThan(0); // 475 is the company target; a 520 score drifts toward it
    expect(() => settleActionEvidence({ ...CLAUDE, ref: "job-1", evidence: "verified" }, vault)).toThrow(/already settled/);
    const bad = settleActionEvidence({ ...CLAUDE, ref: "job-1", evidence: "contradicted" }, vault);
    expect(bad.tilt).toBe(true);
    const d = domainOf(vault);
    expect(d.stats.tilts).toBe(1);
    expect(d.stats.consecutive_successes).toBe(0);
    // The score fell into tier 1's band, and the tilt took one more step.
    expect(scoreTier(d.score)).toBe(1);
    expect(d.permission_tier).toBe(0);
  });
});

describe("authority", () => {
  it("contracts automatically and never restores itself", () => {
    const { vault } = temp();
    seed(vault, { score: 560, permission_tier: 3, user_max_tier: 3, stats: { reviewed_sessions: 30, total_sessions: 30 } });
    finalizeCreditSession({ ...CLAUDE, outcome: "rejected" }, vault);
    expect(domainOf(vault).permission_tier).toBe(2);
    for (let i = 0; i < 6; i++) accept(vault);
    const recovered = domainOf(vault);
    expect(scoreTier(recovered.score)).toBe(3);
    expect(effectiveTier(recovered)).toBe(2);
    expect(grantAvailable(recovered)).toBe(3);
  });
  it("holds a grant to what the score and history support", () => {
    const { vault } = temp();
    for (let i = 0; i < 5; i++) accept(vault);
    const r = setConsumerGrant(CLAUDE, { maxTier: 2 }, vault);
    // Score is past 450, but 5 scored sessions is short of the 10 tier 2 needs.
    expect(eligibleTier(r)).toBe(1);
    expect(r.permission_tier).toBe(1);
    expect(r.notes.join(" ")).toMatch(/needs 10 scored/);
    for (let i = 0; i < 5; i++) accept(vault);
    expect(domainOf(vault).permission_tier).toBe(1);
    expect(setConsumerGrant(CLAUDE, { maxTier: 2 }, vault).permission_tier).toBe(2);
  });
  it("makes a tier 3 grant wait a day and ask again", () => {
    const { vault } = temp();
    seed(vault, { score: 570, permission_tier: 2, user_max_tier: 2, stats: { reviewed_sessions: 30, total_sessions: 30 } });
    const t0 = new Date("2026-10-16T12:00:00.000Z");
    const g = setConsumerGrant(CLAUDE, { maxTier: 3 }, vault, { at: t0 });
    expect(g.permission_tier).toBe(2);
    expect(g.pending_grant?.not_before).toBe("2026-10-17T12:00:00.000Z");
    expect(() => confirmTierThreeGrant(CLAUDE, vault, { at: new Date("2026-10-17T11:59:00.000Z") })).toThrow(/after/);
    const c = confirmTierThreeGrant(CLAUDE, vault, { at: new Date("2026-10-17T12:00:00.000Z") });
    expect(c.permission_tier).toBe(3);
    expect(c.pending_grant).toBeNull();
    expect(() => confirmTierThreeGrant(CLAUDE, vault)).toThrow(/no tier 3 grant/);
  });
  it("revokes in one step and cancels a waiting tier 3 grant", () => {
    const { vault } = temp();
    seed(vault, { score: 570, permission_tier: 2, user_max_tier: 2, stats: { reviewed_sessions: 30, total_sessions: 30 } });
    setConsumerGrant(CLAUDE, { maxTier: 3 }, vault);
    const r = setConsumerGrant(CLAUDE, { maxTier: 0 }, vault);
    expect(effectiveTier(r)).toBe(0);
    expect(r.pending_grant).toBeNull();
  });
  it("holds an action when the score falls below its minimum, until the next grant", () => {
    const { vault } = temp();
    seed(vault, { score: 530, permission_tier: 2, user_max_tier: 2, stats: { reviewed_sessions: 12, total_sessions: 12 } });
    setConsumerGrant(CLAUDE, { maxTier: 2, allowedPaths: ["src/**"], minScores: parseMinScores("edit_file=520") }, vault);
    expect(domainOf(vault).held_actions).toEqual([]);
    finalizeCreditSession({ ...CLAUDE, outcome: "accepted", agentDraft: "a b c d e f g h i j", userFinal: "a b c d e f g h i x" }, vault);
    const dropped = domainOf(vault);
    expect(dropped.score).toBeLessThan(520);
    expect(effectiveTier(dropped)).toBe(2);
    expect(dropped.held_actions).toEqual(["edit_file"]);
    for (let i = 0; i < 3; i++) accept(vault);
    const back = domainOf(vault);
    expect(back.score).toBeGreaterThan(520);
    expect(back.held_actions).toEqual(["edit_file"]);
    expect(() => validateToolExecution(back, { action: "edit_file", target: "src/a.ts" })).toThrow(/held/);
    setConsumerGrant(CLAUDE, { maxTier: 2 }, vault);
    expect(domainOf(vault).held_actions).toEqual([]);
  });
  it("rejects minimum scores outside the range or for unknown actions", () => {
    expect(() => parseMinScores("edit_file=50")).toThrow();
    expect(() => parseMinScores("launch_rocket=400")).toThrow(/Unknown action/);
    expect(parseMinScores("none")).toEqual({});
  });
  it("records an attempt at a blocked action as a tilt", () => {
    const { root, vault } = temp();
    seed(vault, { score: 500, permission_tier: 2, user_max_tier: 2, stats: { reviewed_sessions: 12, total_sessions: 12 } });
    const session = new CreditGuardedSession(CLAUDE, { root, vault });
    expect(() => session.verify({ action: "push_to_main" })).toThrow(CreditViolationError);
    const d = domainOf(vault);
    expect(d.stats.tilts).toBe(1);
    expect(d.permission_tier).toBe(1);
    // A refusal for any other reason is not a tilt.
    expect(() => session.verify({ action: "live_deploy" })).toThrow(CreditViolationError);
    expect(domainOf(vault).stats.tilts).toBe(1);
  });
});

describe("disputes", () => {
  it("sets an event aside, recomputes, and never raises the tier", () => {
    const { vault } = temp();
    seed(vault, { score: 560, permission_tier: 3, user_max_tier: 3, stats: { reviewed_sessions: 30, total_sessions: 30 } });
    const rejected = finalizeCreditSession({ ...CLAUDE, outcome: "rejected" }, vault);
    expect(domainOf(vault).permission_tier).toBe(2);
    const r = disputeCreditEvent(rejected.event_id, "I rejected the wrong draft", vault);
    expect(r.after.score).toBe(560);
    expect(r.after.permission_tier).toBe(2);
    expect(() => disputeCreditEvent(rejected.event_id, "again", vault)).toThrow(/already/);
    const grantId = readCreditReport(vault).events.find((e) => e.type === "baseline")!.id;
    expect(() => disputeCreditEvent(grantId, "no", vault)).toThrow(/Only sessions/);
    expect(() => disputeCreditEvent("ev_ffffffffff", "no", vault)).toThrow(/No event/);
  });
  it("replays never exceed the tier a grant produced when it was made", () => {
    const { vault } = temp();
    for (let i = 0; i < 10; i++) accept(vault);
    finalizeCreditSession({ ...CLAUDE, outcome: "rejected" }, vault);
    const g = setConsumerGrant(CLAUDE, { maxTier: 2 }, vault);
    const events = readCreditReport(vault).events;
    const grant = events.find((e) => e.type === "grant")!;
    expect(grant.type === "grant" && grant.granted_tier).toBe(g.permission_tier);
    expect(foldDomain(events).permission_tier).toBe(g.permission_tier);
  });
});

describe("the passport", () => {
  it("carries the limits and leaves the score out", () => {
    const { vault } = temp();
    seed(vault, { score: 500, permission_tier: 2, user_max_tier: 2, stats: { reviewed_sessions: 12, total_sessions: 12 } });
    setConsumerGrant(CLAUDE, { maxTier: 2, allowedPaths: ["src/**"], minScores: { run_tests: 590 } }, vault);
    const passport = generateCreditPassport(CLAUDE, vault, { reader: "claude-code" });
    expect(passport).toContain("consumer ceiling");
    expect(passport).toContain("edit_file");
    expect(passport).not.toMatch(/score|veracity|500|590|Prime/i);
    expect(passport).not.toMatch(/run_tests/); // held by its minimum, so not offered
    expect(passport).not.toContain("events");
  });
  it("records each read as an inquiry", () => {
    const { vault } = temp();
    generateCreditPassport(CLAUDE, vault, { reader: "claude-code" });
    generateCreditPassport(CLAUDE, vault, { record: false });
    const inquiries = readCreditReport(vault).events.filter((e) => e.type === "inquiry");
    expect(inquiries).toHaveLength(1);
    expect(inquiries[0].type === "inquiry" && inquiries[0].reader).toBe("claude-code");
    expect(domainOf(vault).stats.inquiries).toBe(1);
  });
});
