import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forkPrivate,
  hasPrivate,
  wrapPrivate,
  redactionStub,
  ensureIgnored,
  privateCompanionPath,
  privateName,
  resolveInStore,
  writePrivateDoc,
  writePrivateNote,
  listPrivateNotes,
  readPrivateNote,
} from "../src/private.js";
import { checkDoc } from "../src/check.js";
import { parseAarTestimony } from "../src/parseAar.js";

const SECRET = "the customer's API key is sk-live-DO-NOT-SHIP";

const FORK_OPTS = {
  publicRef: "docs/aar-x.md",
  privateRef: ".closedtab/private/aar-x.private.md",
  title: "x",
  date: "2026-07-06",
};

describe("hasPrivate / wrapPrivate", () => {
  it("detects a private fence, tolerant of whitespace", () => {
    expect(hasPrivate("nothing here")).toBe(false);
    expect(hasPrivate("<!-- private -->x<!-- /private -->")).toBe(true);
    expect(hasPrivate("<!--private-->x<!--/private-->")).toBe(true);
  });
  it("wraps text in a fence that hasPrivate then sees", () => {
    expect(hasPrivate(wrapPrivate("hi"))).toBe(true);
  });
});

describe("redactionStub", () => {
  it("is byte-stable and carries the ref inside an inert fenced block", () => {
    expect(redactionStub(".closedtab/private/aar-x.private.md")).toBe(
      "```closedtab-redacted\n" +
        "Content withheld from the public record — kept in the private companion:\n" +
        ".closedtab/private/aar-x.private.md\n" +
        "```",
    );
  });
});

describe("forkPrivate", () => {
  it("leaves a doc without fences untouched", () => {
    const md = "## Action\n\nedited app.py\n";
    const r = forkPrivate(md, FORK_OPTS);
    expect(r.hadPrivate).toBe(false);
    expect(r.private).toBeNull();
    expect(r.public).toBe(md);
  });

  it("moves a fenced region to the companion and stubs the public doc", () => {
    const md = `## Judgment\n\n**Accountable:**\n\n<!-- private -->\n${SECRET}\n<!-- /private -->\n`;
    const r = forkPrivate(md, FORK_OPTS);
    expect(r.hadPrivate).toBe(true);
    // Public: honest stub, no secret.
    expect(r.public).not.toContain(SECRET);
    expect(r.public).toContain("closedtab-redacted");
    expect(r.public).toContain(".closedtab/private/aar-x.private.md");
    // Companion: the secret, a back-link, and the region label.
    expect(r.private!).toContain(SECRET);
    expect(r.private!).toContain("**Public record:** docs/aar-x.md");
    expect(r.private!).toContain("Judgment — Accountable");
  });

  it("labels multiple regions by their nearest heading", () => {
    const md =
      `## Intent\n\n<!-- private -->secret-A<!-- /private -->\n\n` +
      `## Action\n\n<!-- private -->secret-B<!-- /private -->\n`;
    const r = forkPrivate(md, FORK_OPTS);
    expect(r.public).not.toContain("secret-A");
    expect(r.public).not.toContain("secret-B");
    expect(r.private!).toContain("## Intent");
    expect(r.private!).toContain("secret-A");
    expect(r.private!).toContain("## Action");
    expect(r.private!).toContain("secret-B");
  });

  it("fails closed on an unbalanced fence — redacts to end of document", () => {
    const md = `## Action\n\nkept text\n\n<!-- private -->\n${SECRET}\nmore secret trailing\n`;
    const r = forkPrivate(md, FORK_OPTS);
    expect(r.hadPrivate).toBe(true);
    expect(r.public).toContain("kept text");
    expect(r.public).not.toContain(SECRET);
    expect(r.public).not.toContain("more secret trailing");
    expect(r.private!).toContain(SECRET);
  });
});

describe("redacted public docs are inert to check / parseAar", () => {
  const md = `## Action\n\nedited \`app.py\`\n\n<!-- private -->\n${SECRET}\n<!-- /private -->\n`;
  const pub = forkPrivate(md, FORK_OPTS).public;

  it("check does not crash and does not see the secret or the ref", () => {
    const result = checkDoc(pub);
    expect(typeof result.score).toBe("number");
  });

  it("parseAar extracts no claim carrying the secret or the ref path", () => {
    const claims = parseAarTestimony(pub);
    for (const c of claims) {
      expect(c.text).not.toContain("sk-live");
      expect(c.text).not.toContain("closedtab-redacted");
    }
    // the real action still parses
    expect(claims.some((c) => c.entities.files.includes("app.py"))).toBe(true);
  });
});

describe("store paths", () => {
  it("companion name mirrors the public base with .private.md", () => {
    expect(privateName("aar-x.md")).toBe("aar-x.private.md");
    expect(privateCompanionPath("docs/aar-fall-portal.md", "/repo")).toBe(
      join("/repo", ".closedtab", "private", "aar-fall-portal.private.md"),
    );
  });
  it("resolveInStore rejects a path escaping the store", () => {
    expect(() => resolveInStore("../../etc/passwd", "/repo")).toThrow();
    expect(resolveInStore("note-a.private.md", "/repo")).toBe(
      join("/repo", ".closedtab", "private", "note-a.private.md"),
    );
  });
});

describe("filesystem: gitignore + store I/O", () => {
  const dirs: string[] = [];
  const mkTmp = () => {
    const d = mkdtempSync(join(tmpdir(), "closedtab-priv-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("ensureIgnored creates, then reports present, and is idempotent", () => {
    const root = mkTmp();
    expect(ensureIgnored(root)).toBe("created");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".closedtab/");
    expect(ensureIgnored(root)).toBe("present");
  });

  it("ensureIgnored appends to an existing .gitignore exactly once", () => {
    const root = mkTmp();
    writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\n", "utf8");
    expect(ensureIgnored(root)).toBe("added");
    expect(ensureIgnored(root)).toBe("present");
    const gi = readFileSync(join(root, ".gitignore"), "utf8");
    expect(gi.match(/\.closedtab\//g)?.length).toBe(1);
    expect(gi).toContain("node_modules/");
  });

  it("writePrivateNote writes to the ignored store and round-trips via list/read", () => {
    const root = mkTmp();
    const { path } = writePrivateNote({
      title: "handoff secret",
      sections: { detail: SECRET },
      date: "2026-07-06",
      root,
    });
    expect(existsSync(path)).toBe(true);
    expect(path).toContain(join(".closedtab", "private"));
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".closedtab/");

    const notes = listPrivateNotes(root);
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("note");
    expect(notes[0].filename).toBe("note-handoff-secret.private.md");

    const md = readPrivateNote(notes[0].filename, root);
    expect(md).toContain(SECRET);
  });

  it("writePrivateDoc de-duplicates colliding names", () => {
    const root = mkTmp();
    const p1 = writePrivateDoc("# one\n", "aar-x.private.md", root);
    const p2 = writePrivateDoc("# two\n", "aar-x.private.md", root);
    expect(p1).not.toBe(p2);
    expect(readdirSync(join(root, ".closedtab", "private")).sort()).toEqual([
      "aar-x.private-2.md",
      "aar-x.private.md",
    ]);
  });
});
