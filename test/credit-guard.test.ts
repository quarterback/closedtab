import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyReport, ensureDomain, getDomain, readCreditReport, writeCreditReport } from "../src/credit/store.js";
import { validateToolExecution, permittedActions, CreditGuardedSession, CreditViolationError } from "../src/credit/guard.js";
import { newDomain } from "../src/credit/types.js";

const id = { productId: "anthropic/claude", domain: "code-refactoring" };
const roots: string[] = [];
function tmp() {
  const root = mkdtempSync(join(tmpdir(), "ct-credit-"));
  roots.push(root);
  return { root, vault: join(root, "vault") };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tierTwo() {
  const record = ensureDomain(emptyReport(), id);
  record.score = 500;
  record.user_max_tier = 2;
  record.permission_tier = 2;
  return record;
}

describe("tool enforcement", () => {
  it("allows only whitelisted project files and rejects traversal", () => {
    const { root } = tmp();
    mkdirSync(join(root, "src"));
    const record = tierTwo();
    record.credit_limit.allowed_paths = ["src/**"];
    expect(validateToolExecution(record, { action: "write_file", target: "src/a.ts" }, { root })).toBe(2);
    expect(() => validateToolExecution(record, { action: "write_file", target: "../a.ts" }, { root })).toThrow();
    expect(() => validateToolExecution(record, { action: "write_file", target: "README.md" }, { root })).toThrow();
  });
  it("rejects symlink exits even when the lexical path is allowed", () => {
    const { root } = tmp();
    const external = mkdtempSync(join(tmpdir(), "ct-external-"));
    roots.push(external);
    mkdirSync(join(root, "src"));
    symlinkSync(external, join(root, "src", "jump"));
    const d = tierTwo();
    d.credit_limit.allowed_paths = ["src/**"];
    expect(() => validateToolExecution(d, { action: "write_file", target: "src/jump/data" }, { root })).toThrow();
  });
  it("refuses unknown actions and unauthorized remote calls", () => {
    const d = tierTwo();
    expect(() => validateToolExecution(d, { action: "unknown_action" })).toThrow(/Unknown tool/);
    expect(() => validateToolExecution(d, { action: "schedule_invite" })).toThrow(/explicit/);
    d.credit_limit.allowed_actions = ["schedule_invite"];
    expect(validateToolExecution(d, { action: "schedule_invite" })).toBe(2);
  });
  it("keeps the consumer's ceiling separate from the score", () => {
    const d = tierTwo();
    d.score = 590;
    d.user_max_tier = 1;
    d.permission_tier = 1;
    expect(() => validateToolExecution(d, { action: "edit_file", target: "src/app.ts" })).toThrow(CreditViolationError);
  });
  it("enforces a minimum score without telling the agent the number", () => {
    const { root } = tmp();
    mkdirSync(join(root, "src"));
    const d = tierTwo();
    d.credit_limit.allowed_paths = ["src/**"];
    d.credit_limit.min_scores = { edit_file: 520 };
    let message = "";
    try { validateToolExecution(d, { action: "edit_file", target: "src/a.ts" }, { root }); }
    catch (e) { message = (e as Error).message; expect((e as CreditViolationError).code).toBe("held"); }
    expect(message).toMatch(/held/);
    expect(message).not.toMatch(/\d{3}/);
    expect(permittedActions(d)).not.toContain("edit_file");
    expect(permittedActions(d)).toContain("write_file");
    d.score = 530;
    expect(validateToolExecution(d, { action: "edit_file", target: "src/a.ts" }, { root })).toBe(2);
  });
  it("lists only what the tier, blocks and separate yeses allow", () => {
    const d = newDomain();
    expect(permittedActions(d)).toEqual(["read_file", "search", "analyze"]);
    d.credit_limit.blocked_actions = ["*"];
    expect(permittedActions(d)).toEqual([]);
  });
  it("checks cumulative payment budget and default action blocks", async () => {
    const { root, vault } = tmp();
    const state = newDomain();
    state.score = 580; state.user_max_tier = 3; state.permission_tier = 3;
    state.stats.reviewed_sessions = 30; state.stats.total_sessions = 30;
    state.credit_limit.allowed_actions = ["execute_payment"];
    state.credit_limit.financial_cap_usd = 19;
    const report = emptyReport();
    report.events.push({ id: "ev_00000000bb", at: new Date().toISOString(), product_id: id.productId, domain: id.domain, type: "baseline", state });
    writeCreditReport(report, vault);
    const session = new CreditGuardedSession(id, { root, vault });
    expect(await session.execute({ action: "execute_payment", amountUsd: 10 }, () => "ok")).toBe("ok");
    await expect(session.execute({ action: "execute_payment", amountUsd: 10 }, () => "no")).rejects.toThrow();
    expect(session.spent).toBe(10);
    expect(() => session.verify({ action: "push_to_main" })).toThrow();
    // That was a tilt: tier 3 drops to 2, so payments stop.
    expect(getDomain(readCreditReport(vault), id).permission_tier).toBe(2);
    await expect(session.execute({ action: "execute_payment", amountUsd: 1 }, () => "no")).rejects.toThrow(/Tier 3/);
  });
});
