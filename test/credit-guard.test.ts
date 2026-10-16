import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyReport, ensureDomain, writeCreditReport } from "../src/credit/store.js";
import { validateToolExecution, CreditGuardedSession } from "../src/credit/guard.js";

const id = { productId: "anthropic/claude", domain: "code-refactoring" };
const roots: string[] = [];
function tmp() {
  const root = mkdtempSync(join(tmpdir(), "ct-credit-"));
  roots.push(root);
  return { root, vault: join(root, "vault") };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("tool enforcement", () => {
  it("allows only whitelisted project files and rejects traversal", () => {
    const { root } = tmp();
    mkdirSync(join(root, "src"));
    const record = ensureDomain(emptyReport(), id);
    record.veracity_score = 8;
    record.user_max_tier = 2;
    record.permission_tier = 2;
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
    const d = ensureDomain(emptyReport(), id);
    d.veracity_score = 8;
    d.user_max_tier = 2;
    d.permission_tier = 2;
    d.credit_limit.allowed_paths = ["src/**"];
    expect(() => validateToolExecution(d, { action: "write_file", target: "src/jump/data" }, { root })).toThrow();
  });
  it("checks cumulative payment budget and default action blocks", async () => {
    const { root, vault } = tmp();
    const report = emptyReport();
    const d = ensureDomain(report, id);
    d.veracity_score = 9; d.user_max_tier = 3; d.permission_tier = 3;
    d.credit_limit.allowed_actions = ["execute_payment"];
    d.credit_limit.financial_cap_usd = 19;
    writeCreditReport(report, vault);
    const session = new CreditGuardedSession(id, { root, vault });
    expect(await session.execute({ action: "execute_payment", amountUsd: 10 }, () => "ok")).toBe("ok");
    await expect(session.execute({ action: "execute_payment", amountUsd: 10 }, () => "no")).rejects.toThrow();
    expect(session.spent).toBe(10);
    expect(() => session.verify({ action: "push_to_main" })).toThrow();
  });
});
