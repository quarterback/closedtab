import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAarTestimony } from "../src/parseAar.js";
import { classifyHeading } from "../src/anchors.js";

// The corpus contains testimony, not traces, so it is used as a parse test:
// the AAR parser and entity extraction run across every real AAR. Traces stay
// synthetic (see examples/) until a trace adapter exists.
//
// This suite is OPT-IN: it runs only when RUN_CORPUS=1 (and the sibling corpus
// repos are checked out alongside this one). Its thresholds are tuned for the
// full corpus, which drifts in size/shape between machines — so gating it keeps
// `npm test` and the `prepublishOnly` publish gate from ever depending on a
// local corpus. Run it deliberately with:  RUN_CORPUS=1 npm test

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const CORPUS_DIRS = [
  join(repoRoot, "..", "hybrid-baseball", "docs"),
  join(repoRoot, "..", "tennis-team-manager", "docs"),
];
const presentDirs = CORPUS_DIRS.filter((d) => existsSync(d));
const runCorpus = process.env.RUN_CORPUS === "1" && presentDirs.length > 0;

function corpusFiles(): { name: string; path: string; text: string }[] {
  const out: { name: string; path: string; text: string }[] = [];
  for (const dir of presentDirs) {
    for (const f of readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"))) {
      out.push({ name: f, path: join(dir, f), text: readFileSync(join(dir, f), "utf8") });
    }
  }
  return out;
}

const HEADING_RE = /^#{1,6}\s+(.*\S)\s*$/;
function headingsOf(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

describe.skipIf(!runCorpus)("AAR corpus parse test", () => {
  const files = runCorpus ? corpusFiles() : [];

  it("has a non-trivial corpus to test against", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("parses every corpus file without throwing", () => {
    for (const f of files) {
      expect(() => parseAarTestimony(f.text), `parsing ${f.name}`).not.toThrow();
    }
  });

  it("extracts exact file paths and function names from a known AAR", () => {
    const f = files.find((f) => f.name === "aar-box-score-pitcher-decisions.md");
    if (!f) return; // corpus drift — covered by the synthetic fixtures regardless
    const claims = parseAarTestimony(f.text);
    const files_ = new Set(claims.flatMap((c) => c.entities.files));
    const tools = new Set(claims.flatMap((c) => c.entities.tools));
    expect(files_).toContain("o27v2/web/app.py");
    expect(files_).toContain("o27v2/web/box_text.py");
    expect(tools).toContain("game_detail");
    expect(tools).toContain("_pick_decisions");
    expect(tools).toContain("_aggregate_pitcher_rows");
  });

  it("extracts commit hashes and PR numbers from real claim prose somewhere in the corpus", () => {
    let commits = 0;
    let prs = 0;
    for (const f of files) {
      for (const c of parseAarTestimony(f.text)) {
        commits += c.entities.commits.length;
        prs += c.entities.prs.length;
      }
    }
    // These identifiers appear in body prose (not just filtered front-matter).
    expect(commits).toBeGreaterThan(10);
    expect(prs).toBeGreaterThan(5);
  });

  it("classifies every obvious negative-space heading as negative_space", () => {
    // The "What I did NOT do" family is the distinctive part of these AARs.
    const obviousNeg =
      /\b(did ?n[o']t|does ?n[o']t|was not|were not|not (?:changed|done|touched|built|shipped)|deliberately (?:not|left)|follow[- ]?ups?|out of scope|deferred)\b/i;
    const misses: string[] = [];
    let checked = 0;
    for (const f of files) {
      for (const h of headingsOf(f.text)) {
        if (obviousNeg.test(h)) {
          checked += 1;
          if (classifyHeading(h) !== "negative_space") misses.push(`${f.name}: ${h}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(misses).toEqual([]);
  });

  it("finds negative-space claims in files that have a negative-space section", () => {
    const filesWithNegHeading = files.filter((f) =>
      headingsOf(f.text).some((h) => classifyHeading(h) === "negative_space"),
    );
    expect(filesWithNegHeading.length).toBeGreaterThan(20);
    // Most such files should yield at least one tagged negative_space claim
    // (a few have empty sections; allow a small slack).
    const withClaims = filesWithNegHeading.filter((f) =>
      parseAarTestimony(f.text).some((c) => c.section === "negative_space"),
    );
    expect(withClaims.length).toBeGreaterThan(filesWithNegHeading.length * 0.8);
  });

  it("recognizes intent and claimed-action anchors broadly across the corpus", () => {
    const withIntent = files.filter((f) =>
      headingsOf(f.text).some((h) => classifyHeading(h) === "intent"),
    );
    const withActions = files.filter((f) =>
      headingsOf(f.text).some((h) => classifyHeading(h) === "claimed_actions"),
    );
    expect(withIntent.length).toBeGreaterThan(20);
    expect(withActions.length).toBeGreaterThan(files.length * 0.5);
  });
});
