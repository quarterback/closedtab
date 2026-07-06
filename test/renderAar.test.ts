import { describe, it, expect } from "vitest";
import { renderAar, slugify, aarFilename } from "../src/renderAar.js";
import { TEMPLATES, getTemplate, isFielded } from "../src/templates.js";
import { parseAarTestimony } from "../src/parseAar.js";

describe("slugify", () => {
  it("lowercases and dashes", () => {
    expect(slugify("Fix pitcher W/L decisions")).toBe("fix-pitcher-w-l-decisions");
  });
  it("trims and collapses separators", () => {
    expect(slugify("  Box-Score:  pitch  counts!! ")).toBe("box-score-pitch-counts");
  });
  it("falls back to untitled when empty", () => {
    expect(slugify("!!!")).toBe("untitled");
  });
  it("aarFilename wraps the slug", () => {
    expect(aarFilename("Fall transfer portal")).toBe("aar-fall-transfer-portal.md");
  });
});

describe("templates", () => {
  it("ships the Agent Action Record as the flagship plus task variants", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      "record",
      "bugfix",
      "feature",
      "adr",
      "handoff",
      "private-note",
    ]);
    // The record is first (the default) and renders as a labeled form.
    expect(TEMPLATES[0].id).toBe("record");
    expect(getTemplate("record")!.docLabel).toBe("Agent Action Record");
    expect(isFielded(getTemplate("record")!)).toBe(true);
    // Doc type drives the title label and the filename prefix.
    expect(getTemplate("adr")!.docLabel).toBe("ADR");
    expect(getTemplate("handoff")!.filePrefix).toBe("handoff");
  });

  it("the record has the canonical six sections in order", () => {
    expect(getTemplate("record")!.sections.map((s) => s.id)).toEqual([
      "intent",
      "action",
      "judgment",
      "deviation",
      "consequence",
      "change",
    ]);
  });

  it("the Judgment section asks who decided and where a human was in the loop", () => {
    const judgment = getTemplate("record")!.sections.find((s) => s.id === "judgment")!;
    const fieldIds = (judgment.fields ?? []).map((f) => f.id);
    expect(fieldIds).toContain("decided_alone");
    expect(fieldIds).toContain("should_have_escalated");
    expect(fieldIds).toContain("accountable");
  });
});

describe("renderAar", () => {
  const template = getTemplate("bugfix")!;
  const meta = {
    title: "Fix pitcher W/L",
    date: "2026-06-29",
    branch: "claude/fix-wl",
    pr: "73",
    commit: "b1787ef",
  };

  it("renders a title, meta line, and every section heading", () => {
    const md = renderAar(template, meta, {});
    expect(md).toContain("# AAR: Fix pitcher W/L");
    expect(md).toContain("**Date:** 2026-06-29");
    expect(md).toContain("**Branch:** `claude/fix-wl`");
    expect(md).toContain("**PR:** #73"); // normalizes bare number to #73
    expect(md).toContain("**Commit:** `b1787ef`");
    for (const s of template.sections) expect(md).toContain(`## ${s.heading}`);
  });

  it("leaves guidance as an HTML comment for skipped sections", () => {
    const md = renderAar(template, meta, {});
    const decisions = template.sections.find((s) => s.id === "decisions")!;
    expect(md).toContain(`<!-- ${decisions.guidance} -->`);
  });

  it("uses author text when a section is answered", () => {
    const md = renderAar(template, meta, {
      root_cause: "`w`/`l` were season totals, copied in `_aggregate_pitcher_rows`",
    });
    expect(md).toContain("`w`/`l` were season totals, copied in `_aggregate_pitcher_rows`");
    expect(md).not.toContain(`<!-- What was actually wrong`);
  });

  it("omits optional meta fields that are blank", () => {
    const md = renderAar(getTemplate("bugfix")!, { title: "x", date: "2026-06-29" }, {});
    expect(md).toContain("**Date:** 2026-06-29");
    expect(md).not.toContain("**Branch:**");
    expect(md).not.toContain("**PR:**");
  });

  it("produces an AAR the closedtab parser can read back", () => {
    // The authored file should round-trip: its anchor sections parse as anchors.
    const md = renderAar(getTemplate("bugfix")!, { title: "round trip", date: "2026-06-29" }, {
      reported: "The user reported a broken W/L column.",
      fix: "Edited `o27v2/web/box_text.py`.",
      decisions: "Left `o27v2/web/templates/box.html` alone; follow-ups: none.",
      validation: "Ran `pytest o27v2/tests`.",
    });
    const claims = parseAarTestimony(md);
    expect(claims.some((c) => c.section === "intent")).toBe(true);
    expect(claims.some((c) => c.section === "claimed_actions")).toBe(true);
    expect(claims.some((c) => c.section === "negative_space")).toBe(true);
  });
});

describe("Agent Action Record rendering", () => {
  const record = getTemplate("record")!;

  it("renders the labeled header block and the field form", () => {
    const md = renderAar(record, { title: "fall portal", date: "2026-06-29" }, {});
    expect(md).toContain("# Agent Action Record: fall portal");
    expect(md).toContain("**Review date:** 2026-06-29");
    expect(md).toContain("**Task or period under review:** fall portal");
    expect(md).toContain("**Accountable human (name or role):**");
    // Field labels render even when blank, as a form to fill.
    expect(md).toContain("**Instruction given (actual wording):**");
    expect(md).toContain("**Points where it should have escalated and didn't:**");
  });

  it("fills a field with author text and keeps blanks as form fields", () => {
    const md = renderAar(record, { title: "x", date: "2026-06-29" }, {
      instruction: "Build the fall transfer portal.",
    });
    expect(md).toContain("**Instruction given (actual wording):**\n\nBuild the fall transfer portal.");
    expect(md).toContain("**Out of scope:**"); // still present, blank
  });
});
