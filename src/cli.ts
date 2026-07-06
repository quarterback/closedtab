#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { reconcileText } from "./index.js";
import { runNew } from "./newCommand.js";
import { GUIDE } from "./guide.js";
import { checkDoc, formatCheck } from "./check.js";
import { listPrivateNotes, readPrivateNote } from "./private.js";

// Thin CLI over the closedtab core, for human-agent teams:
//
//   closedtab new [title] [--type generic|bugfix|feature|investigation|adr|handoff|proposal]
//   closedtab guide
//   closedtab check <file.md>
//   closedtab reconcile --testimony <file.md> --trace <file.jsonl|json> [--out <diff.json>]
//
// Authoring (`new`) is the front door: write the doc the way you'd want to read
// it three sprints later. `check` scores the breadcrumbs. `reconcile` is the
// advanced step: check a doc's claims against a record of what actually happened.

type Args = { [k: string]: string | boolean | string[]; _: string[] };

function parseArgs(argv: string[]): { command: string; args: Args } {
  const command = argv[0] ?? "";
  const args: Args = { _: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return { command, args };
}

const USAGE = `closedtab: review the work your AI agents do  (alias: oi)

Usage:
  closedtab new [title] [--type record|bugfix|feature|adr|handoff|private-note] [--dir docs] [--private]
      Scaffold an Agent Action Record (the default) to fill in, or a task doc.
      The record runs the six-part review: Intent, Action, Judgment, Deviation,
      Consequence, Change.
      --private writes the whole doc to the gitignored .closedtab/private store.
      Inline <!-- private -->...<!-- /private --> regions in any doc fork into a
      private companion, leaving an honest redaction stub in the public doc.

  closedtab private list
  closedtab private read <filename>
      List or print notes in the local .closedtab/private store (never committed).

  closedtab guide
      Print a short how-to on the review and why it pays off.

  closedtab check <file.md>
      Score a record on whether it surfaced the things that matter.

  closedtab reconcile --testimony <file.md> --trace <file.jsonl|file.json> [--out <diff.json>]
      Line a record up against a machine trace of what the agent actually did.

  -h, --help    Show this help.`;

function reconcileCommand(args: Args): number {
  const testimonyPath = args.testimony;
  const tracePath = args.trace;
  if (typeof testimonyPath !== "string" || typeof tracePath !== "string") {
    console.error("closedtab reconcile: --testimony and --trace are both required.\n");
    console.error(USAGE);
    return 2;
  }

  let testimony: string;
  let trace: string;
  try {
    testimony = readFileSync(testimonyPath, "utf8");
  } catch (e) {
    console.error(`closedtab: cannot read testimony "${testimonyPath}": ${(e as Error).message}`);
    return 2;
  }
  try {
    trace = readFileSync(tracePath, "utf8");
  } catch (e) {
    console.error(`closedtab: cannot read trace "${tracePath}": ${(e as Error).message}`);
    return 2;
  }

  let diff;
  try {
    diff = reconcileText(testimony, trace);
  } catch (e) {
    console.error(`closedtab: reconcile failed: ${(e as Error).message}`);
    return 2;
  }

  const json = JSON.stringify(diff, null, 2);
  if (typeof args.out === "string") {
    writeFileSync(args.out, json + "\n", "utf8");
    console.error(`closedtab: ${diff.status}, wrote ${args.out}`);
  } else {
    console.log(json);
  }
  return 0;
}

function privateCommand(args: Args): number {
  const sub = args._[0];
  if (sub === "list") {
    const notes = listPrivateNotes();
    if (notes.length === 0) {
      console.log("closedtab: no private notes in .closedtab/private");
      return 0;
    }
    for (const n of notes) console.log(`${n.kind === "note" ? "note     " : "companion"}  ${n.filename}  ${n.title}`);
    return 0;
  }
  if (sub === "read") {
    const filename = args._[1];
    if (typeof filename !== "string") {
      console.error("closedtab private read: pass a filename (see `closedtab private list`).");
      return 2;
    }
    try {
      process.stdout.write(readPrivateNote(filename));
    } catch (e) {
      console.error(`closedtab: ${(e as Error).message}`);
      return 2;
    }
    return 0;
  }
  console.error("closedtab private: expected `list` or `read <filename>`.\n");
  console.error(USAGE);
  return 2;
}

async function main(): Promise<number> {
  const { command, args } = parseArgs(process.argv.slice(2));

  if (command === "" || args.help || args.h || command === "help") {
    console.log(USAGE);
    return command === "" ? 1 : 0;
  }

  switch (command) {
    case "new": {
      const title = typeof args.title === "string" ? args.title : args._[0];
      await runNew({
        type: typeof args.type === "string" ? args.type : undefined,
        title: typeof title === "string" ? title : undefined,
        dir: typeof args.dir === "string" ? args.dir : undefined,
        private: args.private === true,
      });
      return 0;
    }
    case "private":
      return privateCommand(args);
    case "guide":
      console.log(GUIDE);
      return 0;
    case "check": {
      const file = args._[0] ?? (typeof args.file === "string" ? args.file : undefined);
      if (typeof file !== "string") {
        console.error("closedtab check: pass a markdown file to score.\n");
        console.error(USAGE);
        return 2;
      }
      let md: string;
      try {
        md = readFileSync(file, "utf8");
      } catch (e) {
        console.error(`closedtab: cannot read "${file}": ${(e as Error).message}`);
        return 2;
      }
      console.log(formatCheck(checkDoc(md), file));
      return 0; // a nudge, not a gate
    }
    case "reconcile":
      return reconcileCommand(args);
    default:
      console.error(`closedtab: unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`closedtab: ${(e as Error).message}`);
    process.exit(1);
  },
);
