import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCreditReport } from "../src/credit/store.js";
import { setConsumerGrant } from "../src/credit/policy.js";
import { finalizeCreditSession, settleActionEvidence } from "../src/credit/finalizer.js";
import { generateCreditPassport } from "../src/credit/passport.js";
import { CreditGuardedSession } from "../src/credit/guard.js";
import { renderCreditReportHtml } from "../src/credit/report.js";
import { runCreditCommand } from "../src/creditCli.js";

const CLAUDE = { productId: "anthropic/claude", domain: "code-refactoring" };
const GEMINI = { productId: "google/gemini", domain: "research" };
const roots: string[] = [];
function temp() {
  const root = mkdtempSync(join(tmpdir(), "ct-report-"));
  roots.push(root);
  return { root, vault: join(root, "vault") };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sample(vault: string, root: string) {
  setConsumerGrant(CLAUDE, { maxTier: 2, allowedPaths: ["src/**"], minScores: { edit_file: 400 } }, vault);
  for (let i = 0; i < 4; i++) {
    finalizeCreditSession({ ...CLAUDE, outcome: "accepted", agentDraft: "x y", userFinal: "x y", intent: `Task ${i}` }, vault);
  }
  finalizeCreditSession({ ...CLAUDE, outcome: "rejected", intent: "<script>alert(1)</script>" }, vault);
  finalizeCreditSession({ ...CLAUDE, outcome: "unreviewed" }, vault);
  settleActionEvidence({ ...CLAUDE, ref: "deploy-7", evidence: "contradicted" }, vault);
  generateCreditPassport(CLAUDE, vault, { reader: "claude-code" });
  const session = new CreditGuardedSession(CLAUDE, { root, vault });
  try { session.verify({ action: "push_to_main" }); } catch { /* recorded as a tilt */ }
  finalizeCreditSession({ ...GEMINI, outcome: "accepted", agentDraft: "a", userFinal: "a" }, vault);
}

describe("printable credit report", () => {
  it("renders one page per product with each section", () => {
    const { root, vault } = temp();
    sample(vault, root);
    const html = renderCreditReportHtml(readCreditReport(vault), { now: new Date("2026-10-16T12:00:00Z") });
    expect(html.match(/<section class="page">/g)).toHaveLength(2);
    for (const heading of ["Account", "Inquiries", "Held, blocked and contradicted actions", "How to dispute an entry", "Marks in the history row, oldest first"]) {
      expect(html).toContain(`<h2>${heading}</h2>`);
    }
    expect(html).toContain("anthropic/claude");
    expect(html).toContain("google/gemini");
    expect(html).toContain("claude-code");
    expect(html).toContain("Tried blocked action push_to_main");
    expect(html).toContain("deploy-7");
    for (const mark of ["OK", "RJ", "NR", "CT", "TL"]) expect(html).toContain(`<span class="mark">${mark}</span>`);
    const ids = readCreditReport(vault).events.filter((e) => e.type === "session_closed").map((e) => e.id);
    expect(ids.some((id) => html.includes(id))).toBe(true);
  });
  it("adds a summary table once a product has three or more accounts", () => {
    const { root, vault } = temp();
    sample(vault, root);
    for (const domain of ["writing", "research"]) {
      finalizeCreditSession({ ...CLAUDE, domain, outcome: "unreviewed" }, vault);
    }
    const html = renderCreditReportHtml(readCreditReport(vault), { productId: "anthropic/claude" });
    expect(html).toContain("<h2>Summary</h2>");
    expect(html).toContain("<h2>Accounts</h2>");
    expect(html).toContain("No history");
  });
  it("escapes everything that came from a session", () => {
    const { root, vault } = temp();
    sample(vault, root);
    const html = renderCreditReportHtml(readCreditReport(vault));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("prints in black and white: every color is a grey", () => {
    const { root, vault } = temp();
    sample(vault, root);
    const html = renderCreditReportHtml(readCreditReport(vault));
    const colors = html.match(/#[0-9a-f]{3,6}\b/gi) ?? [];
    expect(colors.length).toBeGreaterThan(0);
    for (const c of colors) {
      const hex = c.length === 4 ? c.slice(1).split("").map((x) => x + x).join("") : c.slice(1);
      expect(hex.slice(0, 2) === hex.slice(2, 4) && hex.slice(2, 4) === hex.slice(4, 6)).toBe(true);
    }
    expect(html).toContain("tabular-nums");
    expect(html).not.toMatch(/text-transform:\s*uppercase/);
  });
  it("filters to one product and handles an empty record", () => {
    const { root, vault } = temp();
    sample(vault, root);
    const one = renderCreditReportHtml(readCreditReport(vault), { productId: "google/gemini" });
    expect(one.match(/<section class="page">/g)).toHaveLength(1);
    expect(one).not.toContain("anthropic/claude");
    const empty = renderCreditReportHtml({ version: "2.0.0", updated_at: "", events: [], products: {} });
    expect(empty).toContain("no events yet");
  });
});

describe("credit CLI", () => {
  it("runs grant, close, settle, dispute, show and report end to end", () => {
    const { root, vault } = temp();
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(String(s)); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { out.push(String(s)); });
    const run = (...argv: string[]) => {
      const args: { [k: string]: string | boolean | string[]; _: string[] } = { _: [] };
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith("--")) { args[a.slice(2)] = next; i++; }
          else args[a.slice(2)] = true;
        } else args._.push(a);
      }
      out.length = 0;
      return runCreditCommand({ ...args, vault });
    };
    const id = ["--product", "anthropic/claude", "--domain", "code-refactoring"];
    expect(run("grant", ...id, "--max-tier", "2", "--paths", "src/**", "--min-score", "edit_file=420")).toBe(0);
    expect(JSON.parse(out[0]).limits.min_scores).toEqual({ edit_file: 420 });
    const draft = join(root, "draft.txt");
    writeFileSync(draft, "the same words");
    expect(run("close", ...id, "--outcome", "accepted", "--draft", draft, "--final", draft)).toBe(0);
    expect(JSON.parse(out[0]).score).toBe(400);
    expect(run("settle", ...id, "--ref", "job-1", "--evidence", "verified")).toBe(0);
    expect(run("close", ...id, "--outcome", "rejected")).toBe(0);
    const rejectedId = JSON.parse(out[0]).event_id;
    expect(run("dispute", "--event", rejectedId, "--reason", "wrong draft")).toBe(0);
    expect(JSON.parse(out[0]).score_after).toBeGreaterThan(JSON.parse(out[0]).score_before);
    expect(run("show", ...id)).toBe(0);
    const shown = JSON.parse(out[0]);
    expect(shown.range).toBe("100-600");
    expect(shown.scored_events).toBe(2);
    expect(run("passport", ...id, "--reader", "test-agent")).toBe(0);
    expect(out[0]).not.toMatch(/score/i);
    expect(run("check", ...id, "--action", "push_to_main")).toBe(3);
    expect(out[0]).toMatch(/DENIED/);
    expect(run("grant", ...id, "--confirm")).toBe(2);
    expect(run("grant", ...id, "--max-tier", "2", "--min-score", "edit_file=9000")).toBe(2);
    const file = join(root, "report.html");
    expect(run("report", "--out", file)).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("test-agent");
    expect(run("events", "--product", "anthropic/claude")).toBe(0);
    expect(out.map((l) => JSON.parse(l).type)).toContain("dispute");
  });
});
