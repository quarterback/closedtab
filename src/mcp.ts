#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { reconcileText } from "./index.js";
import { TEMPLATES, getTemplate, isPrivateOnly } from "./templates.js";
import { renderAar, docFilename, type AarMeta, type Answers } from "./renderAar.js";
import { checkDoc } from "./check.js";
import {
  forkPrivate,
  hasPrivate,
  listPrivateNotes,
  privateCompanionPath,
  privateName,
  readPrivateNote,
  writePrivateDoc,
  writePrivateNote,
} from "./private.js";
import { relative } from "node:path";

// MCP stdio server. Exposes the closedtab core as tools so an agent in a
// human-agent loop can write, score, and reconcile its own docs. Same pure core
// the CLI and library call. Non-interactive: every tool takes all inputs at once.

const server = new McpServer({
  name: "closedtab",
  version: "0.4.0",
});

const TEMPLATE_IDS = TEMPLATES.map((t) => t.id).join(" | ");

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
function errorText(s: string) {
  return { isError: true, content: [{ type: "text" as const, text: s }] };
}

// ---- list_templates: discover what to fill before scaffolding ----
server.tool(
  "list_templates",
  "List the closedtab doc templates (AAR, ADR, handoff, proposal) and the " +
    "sections each one prompts for, with guidance. Call this first to learn the " +
    "section ids to pass to new_doc.",
  {},
  async () => {
    const out = TEMPLATES.map((t) => ({
      type: t.id,
      label: t.label,
      doc_label: t.docLabel,
      file_prefix: t.filePrefix,
      sections: t.sections.map((s) => ({
        id: s.id,
        heading: s.heading,
        guidance: s.guidance,
      })),
    }));
    return text(JSON.stringify(out, null, 2));
  },
);

// ---- new_doc: render a complete doc (AAR/ADR/handoff/proposal) ----
server.tool(
  "new_doc",
  "Scaffold a doc for a human-agent team and return its markdown plus the " +
    "filename to write it to (e.g. aar-<slug>.md, adr-<slug>.md). Provide section " +
    "content via `sections` (a map of section id -> text); omitted sections are " +
    "rendered with their guidance as an HTML comment so they still instruct. Use " +
    "list_templates to learn the section ids.",
  {
    type: z.string().describe(`template id: ${TEMPLATE_IDS}`),
    title: z.string().describe("The doc title."),
    branch: z.string().optional().describe("Git branch, optional."),
    pr: z.string().optional().describe("PR number, optional."),
    commit: z.string().optional().describe("Commit hash, optional."),
    date: z.string().optional().describe("ISO date; defaults to today."),
    sections: z
      .record(z.string())
      .optional()
      .describe("Map of section id -> content. Omitted ids become guidance comments."),
    private: z
      .boolean()
      .optional()
      .describe(
        "Fork <!-- private -->...<!-- /private --> regions out of the doc. UNLIKE the " +
          "default, this WRITES the private companion to the gitignored .closedtab/private " +
          "store (the public markdown is still only returned for you to place). Implied for " +
          'type "private-note".',
      ),
    root: z.string().optional().describe("Repo root for the private store; defaults to cwd."),
  },
  async ({ type, title, branch, pr, commit, date, sections, private: priv, root }) => {
    const template = getTemplate(type);
    if (!template) {
      return errorText(`unknown template "${type}". Valid types: ${TEMPLATE_IDS}`);
    }
    const meta: AarMeta = {
      title,
      date: date ?? todayIso(),
      branch,
      pr,
      commit,
    };
    const answers: Answers = sections ?? {};

    // A private note is private by kind: persist it to the store, don't return a
    // committable public doc.
    if (isPrivateOnly(template)) {
      const note = writePrivateNote({ title, sections: answers, date, branch, pr, commit, root });
      return text(
        JSON.stringify(
          { private_path: note.path, private_markdown: note.markdown, note: "written to the gitignored private store" },
          null,
          2,
        ),
      );
    }

    const markdown = renderAar(template, meta, answers);
    const filename = docFilename(template, title);

    if (priv && hasPrivate(markdown)) {
      const privatePath = privateCompanionPath(filename, root);
      const fork = forkPrivate(markdown, {
        publicRef: filename,
        privateRef: relative(root ?? process.cwd(), privatePath) || privateName(filename),
        title,
        date: meta.date,
      });
      const written = writePrivateDoc(fork.private!, privateName(filename), root);
      return text(
        JSON.stringify(
          {
            filename,
            markdown: fork.public,
            private_path: written,
            private_markdown: fork.private,
            note: "private companion written to the gitignored store; place the public markdown yourself",
          },
          null,
          2,
        ),
      );
    }

    return text(JSON.stringify({ filename, markdown }, null, 2));
  },
);

// ---- write_private_note: persist a local-only note to the gitignored store ----
// Deliberately DOES write to disk, unlike new_doc. A private note's whole point is
// a durable, gitignored, cross-agent scratch the agent can later RECALL — recall
// is impossible if the tool only hands back text. The write is confined to the
// gitignored .closedtab/private dir and never touches a committed file.
server.tool(
  "write_private_note",
  "Write a local-only note to the gitignored .closedtab/private store and return " +
    "its path. Use for rationale scrubbed from public docs, sensitive context, or a " +
    "handoff for the next agent that must not enter the repo. Never committed. " +
    "Inline <!-- private -->...<!-- /private --> is honored in section text too.",
  {
    title: z.string().describe("The note title."),
    sections: z
      .record(z.string())
      .optional()
      .describe("Map of private-note section id -> text (context, detail, for_agents)."),
    date: z.string().optional().describe("ISO date; defaults to today."),
    root: z.string().optional().describe("Repo root for the private store; defaults to cwd."),
  },
  async ({ title, sections, date, root }) => {
    const { path, markdown } = writePrivateNote({ title, sections, date, root });
    return text(JSON.stringify({ path, markdown }, null, 2));
  },
);

// ---- list_private_notes: recall index of the local store ----
server.tool(
  "list_private_notes",
  "List the notes and companions in the local .closedtab/private store so a " +
    "downstream agent can recall private context left by an earlier one. Returns " +
    "filename, title, and kind (note | companion). Local-only; never leaves the machine.",
  {
    root: z.string().optional().describe("Repo root for the private store; defaults to cwd."),
  },
  async ({ root }) => {
    return text(JSON.stringify(listPrivateNotes(root), null, 2));
  },
);

// ---- read_private_note: recall one note by filename ----
server.tool(
  "read_private_note",
  "Read one note from the local .closedtab/private store by filename (from " +
    "list_private_notes). Path-guarded to the store. Local-only; never committed.",
  {
    filename: z.string().describe("A filename from list_private_notes."),
    root: z.string().optional().describe("Repo root for the private store; defaults to cwd."),
  },
  async ({ filename, root }) => {
    try {
      return text(readPrivateNote(filename, root));
    } catch (e) {
      return errorText(`read_private_note failed: ${(e as Error).message}`);
    }
  },
);

// ---- check: score a doc on the quality vector ----
server.tool(
  "check",
  "Score a doc on the quality vector a human-agent team relies on: scope, " +
    "rationale, delegation record (who decided), validation, negative space, and " +
    "residual risks. Returns the score (0-6), per-dimension flags, and suggestions.",
  {
    markdown: z.string().describe("The doc's markdown."),
  },
  async ({ markdown }) => {
    return text(JSON.stringify(checkDoc(markdown), null, 2));
  },
);

// ---- reconcile: check a doc's claims against a trace ----
server.tool(
  "reconcile",
  "Reconcile a doc (testimony, markdown) against a machine trace of what the " +
    "agent actually did (JSON array or JSONL text). Returns a ReconciliationDiff: " +
    "where they agree, where the doc is unsupported, what the trace shows that the " +
    "doc omits, and direct contradictions.",
  {
    testimony: z.string().describe("The doc markdown."),
    trace: z
      .string()
      .describe("The trace as JSON (array of events) or JSONL (one per line)."),
  },
  async ({ testimony, trace }) => {
    try {
      const diff = reconcileText(testimony, trace);
      return text(JSON.stringify(diff, null, 2));
    } catch (e) {
      return errorText(`reconcile failed: ${(e as Error).message}`);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr so it never pollutes the stdio JSON-RPC channel.
  console.error("closedtab MCP server running on stdio");
}

main().catch((e) => {
  console.error("closedtab MCP server failed to start:", e);
  process.exit(1);
});
