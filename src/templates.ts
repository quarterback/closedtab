// Doc templates for reviewing AI agent work. The flagship is the Agent Action
// Record: a manager-led, six-part review (Intent, Action, Judgment, Deviation,
// Consequence, Change) that surfaces the decisions an agent made on its own, the
// moments a human should have been in the loop, where it was confidently wrong,
// and what that cost. The record format is the canonical artifact from the
// Agent After-Action Review skill (github.com/quarterback/AAR), here under MIT.
//
// The other templates are lighter task-doc variants for a human-agent team; the
// Agent Action Record is the default and the point. "Outputs are easy to
// measure; judgment is not."

// A labeled field inside a section (the record renders as a form of these).
export type Field = {
  id: string;
  label: string;
  hint?: string; // shown as an HTML comment when the field is blank
  private?: boolean; // authored content is wrapped in a private fence and forked out
};

export type SectionSpec = {
  id: string;
  heading: string;
  guidance: string; // prompt for prose sections; summary for fielded sections
  fields?: Field[]; // when present, the section renders as a labeled form
  private?: boolean; // authored content is wrapped in a private fence and forked out
};

// A header field, auto-filled from date/title or left blank for the reviewer.
export type MetaField = { label: string; auto?: "date" | "title" };

export type Template = {
  id: string;
  label: string;
  description: string;
  docLabel: string; // title prefix, e.g. "Agent Action Record", "AAR", "ADR"
  filePrefix: string; // filename prefix, e.g. "aar", "adr", "handoff"
  sections: SectionSpec[];
  metaFields?: MetaField[]; // when present, the header is a labeled block (the record)
};

// ---- The Agent Action Record (flagship, default) ----

const RECORD: Template = {
  id: "record",
  label: "Agent Action Record",
  description:
    "Manager-led review of an agent run: Intent, Action, Judgment, Deviation, Consequence, Change.",
  docLabel: "Agent Action Record",
  filePrefix: "aar",
  metaFields: [
    { label: "Review date", auto: "date" },
    { label: "Reviewed by" },
    { label: "Agent / system" },
    { label: "Task or period under review", auto: "title" },
    { label: "Accountable human (name or role)" },
  ],
  sections: [
    {
      id: "intent",
      heading: "1. Intent — what was supposed to happen",
      guidance: "What the agent was meant to do, and the authority it was given.",
      fields: [
        { id: "instruction", label: "Instruction given (actual wording)" },
        {
          id: "success",
          label: "Success defined in advance as",
          hint: 'or: "not defined in advance"',
        },
        {
          id: "authority",
          label: "Authority granted to the agent",
          hint: "what it was allowed to decide/act on without a human",
        },
        { id: "out_of_scope", label: "Out of scope" },
      ],
    },
    {
      id: "action",
      heading: "2. Action — what actually happened",
      guidance: "What the agent did, from logs where available.",
      fields: [
        {
          id: "did",
          label: "What the agent did (step by step, from logs where available)",
        },
        {
          id: "produced",
          label: "What it produced or changed",
          hint: "files, messages, records, actions in the world",
        },
        { id: "differed", label: "Where actual behavior differed from the instruction" },
        {
          id: "within_authority",
          label: "Stayed within granted authority? (yes / no / unknown)",
          hint: "if no/unknown, explain",
        },
      ],
    },
    {
      id: "judgment",
      heading: "3. Judgment — human in the loop",
      guidance: "Where the agent decided alone, and where a human was or should have been involved.",
      fields: [
        { id: "decided_alone", label: "Decisions the agent made on its own" },
        { id: "should_have_seen", label: "Of those, which should a human have made or seen" },
        {
          id: "intervened",
          label: "Where a human actually intervened (approve / edit / override / redirect)",
        },
        { id: "should_have_escalated", label: "Points where it should have escalated and didn't" },
        { id: "accountable", label: "Accountable for these actions" },
      ],
    },
    {
      id: "deviation",
      heading: "4. Deviation — the gaps",
      guidance: "Where action and intent came apart, and why.",
      fields: [
        {
          id: "gaps",
          label: "Gaps between intent and action, and why",
          hint: "root cause, not first answer",
        },
        {
          id: "good_deviations",
          label: "Good deviations (correct departures from a flawed instruction)",
        },
        {
          id: "confidently_wrong",
          label: "Confidently wrong",
          hint: "high confidence + wrong — flag specifically",
        },
      ],
    },
    {
      id: "consequence",
      heading: "5. Consequence — what it cost or risked",
      guidance: "The outcome, the cost, and what a bad run would look like.",
      fields: [
        { id: "outcome", label: "Actual outcome (did the work hold up)" },
        { id: "harm", label: "Harm / cost / risk — realized or narrowly avoided" },
        { id: "downstream", label: "Downstream affected parties" },
        { id: "if_100x", label: "Expected failure if this run happened 100 times" },
      ],
    },
    {
      id: "change",
      heading: "6. Change — what happens next",
      guidance: "What changes before the next run.",
      fields: [
        {
          id: "changes",
          label: "Specific changes before next run",
          hint: "instruction / scope / authority / escalation / checkpoints",
        },
        { id: "keep_doing", label: "Keep doing" },
        { id: "no_delegate", label: "Should not be delegated to an agent at all" },
        { id: "signal", label: "Signal that the change worked" },
      ],
    },
  ],
};

// ---- Lighter task-doc variants (prose sections) ----

const DECISIONS: SectionSpec = {
  id: "decisions",
  heading: "Decisions and follow-ups",
  guidance:
    "The part that ages best: deliberate choices, who made them (owner, agent, or joint), any call the agent inferred that the owner should sanity-check, plus known gaps and deferred follow-ups.",
};

const VERIFIED: SectionSpec = {
  id: "validation",
  heading: "Verified",
  guidance:
    "How you know it works: tests run, what was checked by hand, stated so it's checkable against the repo later.",
};

const TASK_TEMPLATES: Template[] = [
  {
    id: "bugfix",
    label: "Bug fix",
    description: "A fix: symptom, root cause, the change, verification.",
    docLabel: "AAR",
    filePrefix: "aar",
    sections: [
      {
        id: "reported",
        heading: "What was reported",
        guidance: "The symptom as observed, ideally in the reporter's words.",
      },
      {
        id: "root_cause",
        heading: "Root cause",
        guidance: "What was actually wrong underneath, not the symptom but the cause.",
      },
      { id: "fix", heading: "The fix", guidance: "What you changed. Exact paths." },
      DECISIONS,
      VERIFIED,
    ],
  },
  {
    id: "feature",
    label: "Feature / what was built",
    description: "New work: what shipped, design decisions, verification.",
    docLabel: "AAR",
    filePrefix: "aar",
    sections: [
      {
        id: "asked",
        heading: "What was asked for",
        guidance: "The owner's request, in their words.",
      },
      {
        id: "built",
        heading: "What was built",
        guidance: "What shipped. Files touched or added, with exact paths.",
      },
      {
        id: "design",
        heading: "Design decisions",
        guidance: "What you considered and rejected, which gaps you left on purpose.",
      },
      VERIFIED,
    ],
  },
  {
    id: "adr",
    label: "Decision record (ADR)",
    description: "A design decision: context, decision, alternatives, consequences.",
    docLabel: "ADR",
    filePrefix: "adr",
    sections: [
      { id: "context", heading: "Context", guidance: "What prompted this decision and the constraints." },
      { id: "decision", heading: "Decision", guidance: "What we're doing, in the present tense." },
      { id: "alternatives", heading: "Alternatives considered", guidance: "What else was on the table and why it was set aside." },
      { id: "consequences", heading: "Consequences", guidance: "What this enables, what it costs, the residual risks." },
      { id: "decided_by", heading: "Decided by", guidance: "Owner, agent, or joint." },
    ],
  },
  {
    id: "handoff",
    label: "Sprint handoff",
    description: "State transfer to the next agent.",
    docLabel: "Handoff",
    filePrefix: "handoff",
    sections: [
      { id: "state", heading: "Current state", guidance: "What works end-to-end, and what's confirmed broken (with evidence)." },
      { id: "pick_up", heading: "Where to pick up", guidance: "The next concrete steps, in priority order." },
      { id: "do_not_touch", heading: "What not to touch", guidance: "Settled decisions, each with a one-line reason." },
      { id: "open_questions", heading: "Open questions for the owner", guidance: "Decisions that need the owner, not more code." },
    ],
  },
];

// ---- Private note (local-only; never committed) ----
//
// A standalone doc that lives only in the gitignored private store: rationale
// scrubbed from the public record, sensitive context, or a handoff meant for the
// next agent but not for the repo. Distinct from the redaction fence, which forks
// part of an otherwise-public record; this is a whole doc that is private by kind.

const PRIVATE_NOTE: Template = {
  id: "private-note",
  label: "Private note",
  description: "A local-only note for the private store — never committed.",
  docLabel: "Private note",
  filePrefix: "note",
  sections: [
    { id: "context", heading: "Context", guidance: "What this note is about." },
    {
      id: "detail",
      heading: "Detail",
      guidance:
        "The private content: rationale scrubbed from the public docs, sensitive context, or cross-agent handoff.",
    },
    {
      id: "for_agents",
      heading: "For the next agent",
      guidance: "What a downstream agent should know or do with this.",
    },
  ],
};

export const TEMPLATES: Template[] = [RECORD, ...TASK_TEMPLATES, PRIVATE_NOTE];

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** True for a template whose docs are private by kind (the private note). */
export function isPrivateOnly(template: Template): boolean {
  return template.id === "private-note";
}

/** True when a template renders as a labeled form (the Agent Action Record). */
export function isFielded(template: Template): boolean {
  return template.sections.some((s) => s.fields && s.fields.length > 0);
}
