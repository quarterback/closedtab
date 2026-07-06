import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { execSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Readable, Writable } from "node:stream";
import {
  TEMPLATES,
  getTemplate,
  isFielded,
  isPrivateOnly,
  type Template,
} from "./templates.js";
import {
  renderAar,
  docFilename,
  type AarMeta,
  type Answers,
} from "./renderAar.js";
import {
  ensureIgnored,
  forkPrivate,
  hasPrivate,
  privateCompanionPath,
  privateStoreDir,
  privateName,
  uniquePath,
  wrapPrivate,
  writePrivateDoc,
} from "./private.js";

export type NewOptions = {
  type?: string;
  title?: string;
  dir?: string;
  private?: boolean; // route the whole doc to the gitignored private store
  root?: string; // repo root for the private store / .gitignore (defaults to cwd)
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function gitValue(args: string): string {
  try {
    return execSync(`git ${args}`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/** Read a possibly multi-line answer for one section. */
async function readSection(
  rl: readline.Interface,
  out: Writable,
  heading: string,
  guidance: string,
): Promise<string> {
  out.write(`\n## ${heading}\n  ${guidance}\n`);
  out.write(
    `  (write as many lines as you like; finish with a line containing just "." or press Enter now to skip)\n`,
  );
  const lines: string[] = [];
  for (;;) {
    const line = await rl.question("  > ");
    if (line.trim() === ".") break;
    if (lines.length === 0 && line.trim() === "") break; // immediate Enter = skip
    lines.push(line);
  }
  return lines.join("\n").trim();
}

async function chooseTemplate(
  rl: readline.Interface,
  out: Writable,
  preset?: string,
): Promise<Template> {
  if (preset) {
    const t = getTemplate(preset);
    if (t) return t;
    out.write(`Unknown template "${preset}", pick one below.\n`);
  }
  out.write("\nPick a template:\n");
  TEMPLATES.forEach((t, i) => {
    out.write(`  ${i + 1}) ${t.label.padEnd(22)} ${t.description}\n`);
  });
  for (;;) {
    const ans = (await rl.question("\nTemplate [1]: ")).trim();
    if (ans === "") return TEMPLATES[0];
    const byNum = TEMPLATES[Number(ans) - 1];
    if (byNum) return byNum;
    const byId = getTemplate(ans);
    if (byId) return byId;
    out.write("  Enter a number or template id.\n");
  }
}

async function ask(
  rl: readline.Interface,
  prompt: string,
  fallback = "",
): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const ans = (await rl.question(`${prompt}${suffix}: `)).trim();
  return ans || fallback;
}

export function resolveDir(optDir?: string): string {
  if (optDir) {
    mkdirSync(optDir, { recursive: true });
    return optDir;
  }
  if (existsSync("docs") && statSync("docs").isDirectory()) return "docs";
  return ".";
}

/**
 * Interactive `closedtab new`: walk the author through a template question by
 * question, then write a dated aar-<slug>.md. Returns the written path.
 */
export async function runNew(
  opts: NewOptions,
  io: { input?: Readable; output?: Writable } = {},
): Promise<string> {
  const input = io.input ?? stdin;
  const out = io.output ?? stdout;
  const rl = readline.createInterface({ input, output: out });
  try {
    out.write("closedtab: review an agent run (or write a task doc)\n");

    const template = await chooseTemplate(rl, out, opts.type);

    let title =
      opts.title?.trim() ??
      "";
    while (!title) {
      const prompt = isFielded(template) ? "\nTask or period under review: " : "\nTitle: ";
      title = (await rl.question(prompt)).trim();
    }

    out.write("\nOptional context (press Enter to skip any):\n");
    const branch = await ask(rl, "  Branch", gitValue("rev-parse --abbrev-ref HEAD"));
    const pr = await ask(rl, "  PR #");
    const commit = await ask(rl, "  Commit", gitValue("rev-parse --short HEAD"));

    const meta: AarMeta = { title, date: todayIso(), branch, pr, commit };
    const answers: Answers = {};

    if (isFielded(template)) {
      // The record is a form you fill by hand (no AI required). Scaffold it
      // blank, with every field labeled, and let the reviewer work through it.
      out.write(
        `\nScaffolding a blank ${template.docLabel}. Work through the six sections in order; the field labels and hints are in the file.\n`,
      );
    } else {
      out.write(
        `\nNow the sections. Skip any you don't have yet; a skipped section keeps its guidance as a comment so you can fill it in later.\n`,
      );
      for (const section of template.sections) {
        const answer = await readSection(rl, out, section.heading, section.guidance);
        // A section marked private in the template is fenced so it forks out.
        answers[section.id] =
          section.private && answer ? wrapPrivate(answer) : answer;
      }
    }

    const markdown = renderAar(template, meta, answers);
    const root = opts.root ?? process.cwd();

    // Private by kind (the private note) or by flag (--private): the whole doc
    // goes to the gitignored store, no public doc is written.
    if (opts.private || isPrivateOnly(template)) {
      const path = writePrivateDoc(
        markdown,
        privateName(docFilename(template, title)),
        root,
      );
      out.write(`\n✓ Wrote ${path}\n`);
      out.write(`  Private — kept in the gitignored .closedtab/private store, never committed.\n`);
      return path;
    }

    const dir = resolveDir(opts.dir);
    const publicPath = uniquePath(dir, docFilename(template, title));

    // Inline <!-- private --> regions fork into a companion; otherwise write as-is.
    if (hasPrivate(markdown)) {
      const storeDir = privateStoreDir(root);
      mkdirSync(storeDir, { recursive: true });
      ensureIgnored(root);
      const privatePath = uniquePath(storeDir, privateName(basename(publicPath)));
      const fork = forkPrivate(markdown, {
        publicRef: relative(root, publicPath) || basename(publicPath),
        privateRef: relative(root, privatePath) || basename(privatePath),
        title,
        date: meta.date,
      });
      writeFileSync(publicPath, fork.public, "utf8");
      writeFileSync(privatePath, fork.private!, "utf8");
      out.write(`\n✓ Wrote ${publicPath}\n`);
      out.write(`  + private companion ${privatePath} (gitignored, never committed)\n`);
      return publicPath;
    }

    writeFileSync(publicPath, markdown, "utf8");
    out.write(`\n✓ Wrote ${publicPath}\n`);
    out.write(`  Open it, fill it in, and keep it alongside the work. Read records across runs: the Deviation and Change sections tell you the most over time.\n`);
    return publicPath;
  } finally {
    rl.close();
  }
}
