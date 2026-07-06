// Private context for closedtab. A record can carry content that must stay OUT
// of the committed (often public) doc but be kept locally for the human and
// recalled by local agents. Sensitive spans are marked with a single canonical,
// deterministic anchor — an HTML-comment fence:
//
//     <!-- private -->
//     ...sensitive text...
//     <!-- /private -->
//
// On save, `forkPrivate` splits a rendered doc into a public copy (each fenced
// region replaced by an honest redaction stub) and a private companion (the
// withheld text, cross-linked). Private files live only in a gitignored
// `.closedtab/private/` sidecar; `ensureIgnored` guarantees the ignore entry
// exists before any private byte is written, so the store can never be committed
// by accident. Local, deterministic, no network — the same ethos as the core.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { getTemplate } from "./templates.js";
import { renderAar, docFilename, type AarMeta, type Answers } from "./renderAar.js";

// The canonical private fence. Whitespace-tolerant so `<!--private-->` and
// `<!-- private -->` both match; non-greedy so adjacent regions stay separate.
export const PRIVATE_OPEN_RE = /<!--\s*private\s*-->/;
export const PRIVATE_CLOSE_RE = /<!--\s*\/private\s*-->/;
const PRIVATE_PAIR_RE = /<!--\s*private\s*-->[\s\S]*?<!--\s*\/private\s*-->/;

export type PrivateRegion = { label: string; content: string };
export type ForkResult = {
  public: string;
  private: string | null;
  hadPrivate: boolean;
};

/** True when the doc contains at least one private fence (open marker). */
export function hasPrivate(markdown: string): boolean {
  return PRIVATE_OPEN_RE.test(markdown);
}

/** Wrap text in a private fence, e.g. for a `private: true` template field. */
export function wrapPrivate(text: string): string {
  return `<!-- private -->\n${text}\n<!-- /private -->`;
}

/**
 * The honest redaction stub left in the public doc where content was removed. A
 * fenced block, so it is BOTH visible (it renders, so a human reading the doc can
 * tell the record is deliberately partial — silently dropping content would make
 * the doc lie by omission) AND machine-inert: `parseAar.ts` and `check.ts` both
 * drop fenced blocks, so the withheld region adds no score and no spurious
 * claim/anchor (the companion path never leaks in as a phantom file).
 */
export function redactionStub(privateRef: string): string {
  return (
    "```closedtab-redacted\n" +
    `Content withheld from the public record — kept in the private companion:\n${privateRef}\n` +
    "```"
  );
}

// The nearest preceding heading (and field label, for the record form) before a
// position, used to label a withheld region in the companion.
const HEADING_RE = /^#{1,6}\s+(.*\S)\s*$/;
const FIELD_RE = /^\*\*([^*]+):\*\*/;

function labelBefore(markdown: string, index: number): string {
  let heading = "";
  let field = "";
  for (const raw of markdown.slice(0, index).split(/\r?\n/)) {
    const line = raw.trim();
    const h = HEADING_RE.exec(raw);
    if (h) {
      heading = h[1].trim();
      field = "";
      continue;
    }
    const f = FIELD_RE.exec(line);
    if (f) field = f[1].trim();
  }
  if (heading && field) return `${heading} — ${field}`;
  return heading || field || "(preamble)";
}

function renderCompanion(
  opts: { title: string; date: string; publicRef: string },
  regions: PrivateRegion[],
): string {
  const lines: string[] = [
    `# Private companion: ${opts.title}`,
    "",
    `**Date:** ${opts.date}`,
    `**Public record:** ${opts.publicRef}`,
    "",
    "> Local-only, gitignored, never committed. This holds the content redacted from the public record.",
    "",
  ];
  for (const r of regions) {
    lines.push(`## ${r.label}`, "", r.content, "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Split a rendered/authored doc into a stubbed public copy and a private
 * companion. When no fence is present, returns the input unchanged with
 * `hadPrivate: false`. An unbalanced fence (open without close) FAILS CLOSED:
 * everything from the open marker to end of document is redacted, and a warning
 * is written to stderr, so nothing private can leak through a typo.
 */
export function forkPrivate(
  markdown: string,
  opts: { publicRef: string; privateRef: string; title: string; date: string },
): ForkResult {
  if (!hasPrivate(markdown)) {
    return { public: markdown, private: null, hadPrivate: false };
  }

  const regions: PrivateRegion[] = [];
  let pub = "";
  let rest = markdown;
  let consumed = 0;
  let unbalanced = false;

  for (;;) {
    const om = PRIVATE_OPEN_RE.exec(rest);
    if (!om) {
      pub += rest;
      break;
    }
    pub += rest.slice(0, om.index);
    const label = labelBefore(markdown, consumed + om.index);
    const afterOpen = rest.slice(om.index + om[0].length);
    const cm = PRIVATE_CLOSE_RE.exec(afterOpen);

    let content: string;
    if (!cm) {
      unbalanced = true;
      content = afterOpen;
    } else {
      content = afterOpen.slice(0, cm.index);
    }
    regions.push({ label, content: content.trim() });
    pub += redactionStub(opts.privateRef);

    if (!cm) break;
    const advance = om.index + om[0].length + cm.index + cm[0].length;
    consumed += advance;
    rest = afterOpen.slice(cm.index + cm[0].length);
  }

  if (unbalanced) {
    process.stderr.write(
      "closedtab: warning — unbalanced <!-- private --> fence; redacted to end of document.\n",
    );
  }

  const priv = renderCompanion(
    { title: opts.title, date: opts.date, publicRef: opts.publicRef },
    regions,
  );
  return { public: pub, private: priv, hadPrivate: true };
}

// ---- store paths ----

/** The gitignored private store directory, `<root>/.closedtab/private`. */
export function privateStoreDir(root: string = process.cwd()): string {
  return join(root, ".closedtab", "private");
}

/** Turn a public filename base into its `.private.md` companion form. */
export function privateName(base: string): string {
  return base.replace(/\.md$/, "") + ".private.md";
}

/** The companion path in the store for a given public doc path. */
export function privateCompanionPath(
  publicPath: string,
  root: string = process.cwd(),
): string {
  return join(privateStoreDir(root), privateName(basename(publicPath)));
}

/**
 * Resolve a filename inside the private store, refusing any path that escapes it
 * (e.g. `../../etc/passwd`). Used by the recall tools so a caller-supplied name
 * can never read outside the store.
 */
export function resolveInStore(
  filename: string,
  root: string = process.cwd(),
): string {
  const dir = privateStoreDir(root);
  const resolved = resolve(dir, filename);
  const rel = relative(dir, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`refusing path outside the private store: ${filename}`);
  }
  return resolved;
}

/** Pick a non-colliding path in a dir (base.md, base-2.md, ...). */
export function uniquePath(dir: string, base: string): string {
  let candidate = join(dir, base);
  if (!existsSync(candidate)) return candidate;
  const stem = base.replace(/\.md$/, "");
  for (let n = 2; ; n++) {
    candidate = join(dir, `${stem}-${n}.md`);
    if (!existsSync(candidate)) return candidate;
  }
}

// ---- gitignore ----

/**
 * Ensure the private store is gitignored. Appends `.closedtab/` to the root
 * `.gitignore` (creating it if absent, no-op if already covered). Idempotent.
 * Returns what it did so callers/tests can assert. This is the single guarantee
 * that private content is never committed, so it runs before every private write.
 */
export function ensureIgnored(
  root: string = process.cwd(),
  entry = ".closedtab/",
): "created" | "added" | "present" {
  const gi = join(root, ".gitignore");
  const bare = entry.replace(/\/$/, "");
  if (!existsSync(gi)) {
    writeFileSync(gi, `# closedtab private store (never commit)\n${entry}\n`, "utf8");
    return "created";
  }
  const current = readFileSync(gi, "utf8");
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry) || lines.includes(bare)) return "present";
  const prefix = current.endsWith("\n") || current === "" ? current : current + "\n";
  writeFileSync(gi, `${prefix}\n# closedtab private store (never commit)\n${entry}\n`, "utf8");
  return "added";
}

// ---- store I/O (also the bodies behind the MCP private tools) ----

/** Write already-rendered markdown into the store; ensures the ignore entry. */
export function writePrivateDoc(
  markdown: string,
  filename: string,
  root: string = process.cwd(),
): string {
  const dir = privateStoreDir(root);
  mkdirSync(dir, { recursive: true });
  ensureIgnored(root);
  const path = uniquePath(dir, filename);
  writeFileSync(path, markdown, "utf8");
  return path;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Render a standalone private note from the `private-note` template and write it
 * to the store. The note never becomes a committable public doc.
 */
export function writePrivateNote(args: {
  title: string;
  sections?: Answers;
  date?: string;
  branch?: string;
  pr?: string;
  commit?: string;
  root?: string;
}): { path: string; markdown: string } {
  const template = getTemplate("private-note");
  if (!template) throw new Error("private-note template is not registered");
  const meta: AarMeta = {
    title: args.title,
    date: args.date ?? todayIso(),
    branch: args.branch,
    pr: args.pr,
    commit: args.commit,
  };
  const markdown = renderAar(template, meta, args.sections ?? {});
  const path = writePrivateDoc(
    markdown,
    privateName(docFilename(template, args.title)),
    args.root,
  );
  return { path, markdown };
}

export type PrivateListing = {
  filename: string;
  title: string;
  kind: "note" | "companion";
};

/** List the private notes and companions in the store (recall index). */
export function listPrivateNotes(root: string = process.cwd()): PrivateListing[] {
  const dir = privateStoreDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((filename) => {
      const md = readFileSync(join(dir, filename), "utf8");
      const heading = /^#\s+(.*\S)\s*$/m.exec(md);
      const title = heading ? heading[1].trim() : filename;
      const kind: PrivateListing["kind"] = filename.startsWith("note-")
        ? "note"
        : "companion";
      return { filename, title, kind };
    });
}

/** Read one private doc by filename (path-guarded to the store). */
export function readPrivateNote(
  filename: string,
  root: string = process.cwd(),
): string {
  return readFileSync(resolveInStore(filename, root), "utf8");
}
