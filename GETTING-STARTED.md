# Getting started with closedtab

You ship fast with a coding agent, and the *reasoning* behind what got built
evaporates almost immediately. A week later — mid-debug, or handing off to another
agent — you're trying to reconstruct what you asked for, what the agent actually
did, and why it went the way it did.

closedtab fixes that with a small habit: at the end of a chunk of work, you leave a
short **record** — plain markdown, committed next to the code. This guide takes you
from nothing to your first record in a few minutes, using the workflow most people
will actually use: **letting your coding agent write the record for you.**

You do not need any prior experience with after-action reviews. If you can run one
npm command and talk to a coding agent, you can use this.

---

## The idea in one minute

- **A record is a two-minute note**, not a report. It captures: what you asked for,
  what the agent did, *why* it was done that way, and the decisions worth
  remembering.
- **You write one per segment of work** — a feature, a fix, a session with your
  agent — not per commit. Think "every meaningful handoff," not "every change."
- **It lives in your repo**, as `docs/aar-<slug>.md`, committed alongside the code
  it describes. No database, no service, no account. Just markdown.
- **The payoff compounds.** One record is a nice note. Fifty records are the real
  history of how your project got built — and the thing the next agent reads before
  touching anything.

The flagship record is a six-part review — **Intent, Action, Judgment, Deviation,
Consequence, Change** — but you'll rarely think about that structure directly,
because the tool prompts you (or your agent) through it.

---

## Install

You need [Node](https://nodejs.org) (v20+). Then:

```
npm install -g closedtab
```

Check it's there:

```
closedtab --help
```

---

## The main way: let your coding agent write the record

Your agent just did the work — it has the freshest possible context on which files
it touched and which calls it made. So the best author of the record is the agent
itself. closedtab ships an **MCP server** that gives your agent the tools to do it.

### 1. Add the MCP server to your agent

In Claude Code, Cursor, or any MCP-aware assistant, add:

```json
{ "mcpServers": { "closedtab": { "command": "closedtab-mcp" } } }
```

(In Claude Code: put this in your MCP config. In Cursor: add it under MCP servers.
Restart the assistant so it picks up the server.)

That gives the agent these tools:

- `list_templates` — see the record shapes and the sections each one asks for
- `new_doc` — render a filled-in record from what it just did
- `check` — score the record on whether it captured what matters
- `reconcile` — (advanced) compare the record against a machine log of the run
- `write_private_note`, `list_private_notes`, `read_private_note` — a local-only,
  gitignored scratch for context that should **not** go in the repo

### 2. Ask for a record at the end of a segment

When you finish a piece of work, tell your agent something like:

> Write a closedtab record of what we just did and save it in `docs/`.

The agent will typically: call `list_templates` to learn the sections, call
`new_doc` to render the record from the session, write it to
`docs/aar-<slug>.md`, run `check` on it, and commit it with the change.

### 3. Make it automatic (optional but recommended)

Add a line to your `CLAUDE.md` (or `.cursorrules`, or your agent's house rules) so
you don't have to ask every time:

> When you finish a feature or fix, write a closedtab record of it to `docs/` and
> commit it alongside the change. Say who decided the judgment calls (me, you, or
> jointly), and note anything the next person shouldn't touch.

Now the record gets written as a natural part of finishing work, while the context
is still hot.

---

## What a good record looks like

Here's a realistic one, so you can see what "good" is before you write your own.
The scenario: *you asked your agent to add rate limiting to a public API endpoint.*

```markdown
# Agent Action Record: Rate-limit the public search endpoint

**Review date:** 2026-07-06
**Reviewed by:** Ron
**Agent / system:** Claude Code
**Task or period under review:** Rate-limit the public search endpoint
**Accountable human (name or role):** Ron (owner)

## 1. Intent — what was supposed to happen
**Instruction given (actual wording):** "People are hammering /api/search. Add
rate limiting so one client can't take it down."
**Success defined in advance as:** not defined in advance — "make it not fall over."
**Authority granted to the agent:** pick the limit and the storage; don't add a new
paid dependency without asking.
**Out of scope:** auth, billing, the rest of the API.

## 2. Action — what actually happened
**What the agent did:** added a token-bucket limiter in `api/middleware/rate.ts`,
wired it into `/api/search` only, backed by the in-process store already in the repo.
**What it produced or changed:** `api/middleware/rate.ts` (new), `api/search.ts`
(one line), a test in `test/rate.test.ts`.
**Where behavior differed from the instruction:** limit is per-IP, not per-client —
we have no client IDs yet.
**Stayed within granted authority?** Yes — no new dependency.

## 3. Judgment — human in the loop
**Decisions the agent made on its own:** 60 req/min; per-IP; in-memory store.
**Which should a human have seen:** the in-memory store — it resets on deploy and
won't hold across multiple instances. Flagged, not decided alone.
**Where a human intervened:** Ron approved per-IP for now.
**Accountable:** Ron.

## 4. Deviation — the gaps
**Gaps and why:** per-IP is coarse (shared offices hit one bucket) — accepted as a
known limitation until client IDs exist.
**Good deviations:** scoped to `/api/search` only rather than globally, to avoid
throttling internal calls.

## 5. Consequence — what it cost or risked
**Actual outcome:** endpoint holds under a simple flood test.
**Risk realized or avoided:** the in-memory store means the limit is per-instance;
behind a load balancer the effective limit is N× higher. Documented, not fixed.
**Expected failure if run 100 times:** the store choice is the thing most likely to
bite at scale.

## 6. Change — what happens next
**Before next run:** decide on a shared store (Redis) before this goes
multi-instance.
**Keep doing:** scoping the change narrowly.
**Should not be delegated:** the "how hard do we limit real users" call.
**Signal it worked:** no more search-driven outages; complaints stay near zero.
```

Notice the two sections that age best: **Judgment** (who decided what, and what got
flagged for a human) and the **Change / follow-ups** (the Redis decision left for
later). Those are exactly what a future you — or a future agent — needs and almost
never has.

You don't have to fill every field. A skipped field stays in the file as a labeled
blank, so the record is still a usable scaffold.

---

## The by-hand way (no AI)

You can write records without an agent at all:

```
closedtab new
```

It asks you to pick a template, then walks you through the sections one prompt at a
time, and writes `docs/aar-<slug>.md` (or the current folder if you have no `docs/`).
Prefer a lighter doc for small work:

```
closedtab new --type bugfix     # also: feature, adr, handoff
```

There's also a paper version — `record-template.md` in the repo — that you can copy
and fill in by hand, no tool required.

---

## Where records live, and the habit

- **Location:** `docs/aar-*.md`, committed with the change. If you keep docs
  elsewhere, `closedtab new --dir <path>`.
- **Cadence:** one per segment of work. Writing them is the whole point; the
  structure just lowers the friction until it's a reflex.
- **Reading them back:** over time, skim the **Deviation** and **Change** sections
  across records — the patterns there teach you more than any single note.

---

## Keeping some of it private

Sometimes part of a run shouldn't be public — a quoted email, an internal name, a
customer detail. Wrap it in a fence:

```
<!-- private -->
the part that stays out of the repo
<!-- /private -->
```

On save, the public `docs/aar-*.md` keeps a visible redaction marker, and the real
content goes to a gitignored companion under `.closedtab/private/`. closedtab adds
`.closedtab/` to your `.gitignore` automatically, so it's never committed. See the
README's "Keep some of it private" section for the whole-doc `--private` flag and
the `closedtab private list` / `read` commands.

---

## Leveling up: score and reconcile

Once you're writing records, two commands help you trust them:

- **Score one:**
  ```
  closedtab check ./docs/aar-rate-limit-search.md
  ```
  Rates the record 0–6 on whether it captured the scope, the reasoning, who decided,
  how it was validated, the follow-ups, and the risks. It's a nudge, not a gate.

- **Reconcile against a run (advanced):**
  ```
  closedtab reconcile --testimony ./aar.md --trace ./trace.jsonl --out ./diff.json
  ```
  When you have a machine log of what the agent actually did, this checks the
  record's claims against it: where they agree, where the record claims more than
  the log shows, and any direct contradiction.

---

## A good first move

Don't try to backfill your whole history. Next time you finish something with your
agent, ask it to write one record and commit it. That single note — and the habit it
starts — is the whole idea.
