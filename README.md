# closedtab: a shared record for human-agent teams

You move fast with AI agents and ship a lot, and the reasoning behind a decision
evaporates almost immediately. You knew what you wanted and how you wanted it;
the agent took a different path; and a week later, mid-debug, you are trying to
reconstruct what actually happened. closedtab keeps that record: what you asked
for, what the agent did, and what the agent understood the directive to be.

It is how you pass the baton between agents, keep a multi-agent run legible,
track the decisions and the bugs and fixes along the way, and get better at the
handoff itself. As much about working well with agents as it is about provenance.

It works best when you stay hands-on: you as the product owner, agents as
engineer or PM. Run it feature by feature, on the work you are steering, and the
records add up into a history of how the project actually got built.

```
npm install -g closedtab
```

## The Agent Action Record

```
closedtab new
```

It scaffolds a dated **Agent Action Record** to fill in: a six-part record of one
agent run.

| Part | What it captures |
|---|---|
| **Intent** | the instruction, how success was defined, the authority the agent had, what was out of scope |
| **Action** | what it did (from logs), what it produced, where it diverged, whether it stayed within authority |
| **Judgment** | the decisions it made alone, which a human should have seen, where it should have escalated, who is accountable |
| **Deviation** | the gaps and their root cause, the good deviations, the confidently-wrong |
| **Consequence** | the outcome, the harm or cost or risk, who was affected, the expected failure at 100 runs |
| **Change** | what changes before the next run, what to keep, what belongs with a human, the signal it worked |

The `record-template.md` in this repo is the same form by hand: work through the
six sections in order, no AI required, and keep the record.

## Score a record

```
closedtab check ./docs/aar-fall-portal.md
```

Scores a record on whether it captured what is worth keeping: the intent, the
reasoning, who decided, how it held up, the deviations, and the risks carried
forward.

## Reconcile against a trace

```
closedtab reconcile --testimony ./aar.md --trace ./trace.jsonl --out ./diff.json
```

Lines a record up against a machine trace of what the agent actually did. Intent
and Action go in; the Deviation falls out: where they agree, where the record
claims more than the trace shows, where the trace shows work the record omits,
and any direct contradiction.

## Task docs too

`closedtab new --type bugfix` (also `feature`, `adr`, `handoff`) writes lighter
task docs for the same human-agent team, each to its own prefix (`aar-*`,
`adr-*`, `handoff-*`). The Agent Action Record is the default and the point.

## Keep some of it private

Records get committed alongside the code, often in a public repo. When part of a
run shouldn't be public — a quoted email, an internal name, a customer detail, your
own private reasoning — wrap it in a private fence:

```
<!-- private -->
the part that stays out of the repo
<!-- /private -->
```

On save the doc forks in two: the public `docs/aar-*.md` keeps an honest redaction
stub where the content was, and the full text goes to a gitignored companion at
`.closedtab/private/aar-*.private.md`. closedtab adds `.closedtab/` to your
`.gitignore` on the first private write, so the store is never committed. The stub
still renders — the record is honestly partial — but is inert to `check` and
`reconcile`. An unclosed fence fails closed: it redacts to the end of the document.

Whole docs can be private too:

```
closedtab new --private              # route the whole doc to the private store
closedtab new --type private-note    # a standalone local-only note
closedtab private list               # what's in the store
closedtab private read <file>        # print one
```

The store is plain markdown on your machine — for you, and for a local agent to
recall — but never public.

## Let the agent review its own run (MCP)

```json
{ "mcpServers": { "closedtab": { "command": "closedtab-mcp" } } }
```

That gives the agent tools to write, score, and reconcile its own docs —
`list_templates`, `new_doc`, `check`, `reconcile` — plus a local-only store it can
leave private context in for the next agent: `write_private_note`,
`list_private_notes`, `read_private_note`, and a `private` option on `new_doc` that
forks out `<!-- private -->` regions. The agent finishes a segment, writes the
record of what it just did, checks it, and saves it alongside the change. The
private tools write to the gitignored `.closedtab/private` store; nothing there is
committed.

## Library

```javascript
import { renderAar, TEMPLATES, checkDoc, reconcileText } from "closedtab";
```

## Publish and develop

```
npm publish             # runs prepublishOnly: clean, build, test, ships dist/
npm test                # vitest
npm run build           # tsc to dist/
```

Local and deterministic: it needs only Node. The record format comes from the
Agent After-Action Review skill (github.com/quarterback/AAR), here under MIT.
More on the thinking in `WHY.md`.
