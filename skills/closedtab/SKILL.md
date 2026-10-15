---
name: closedtab
description: 'Write an Agent Action Record of the work you just did: what the human asked for, what you actually did, the judgment calls you made alone, where you deviated, what it risked, and what should change next run. Use at the end of a feature, fix, or agent session, when handing off to another agent, or when the user asks for a closedtab record, an after-action review, or "a record of what we just did".'
---

# closedtab: leave a record of the run

At the end of a segment of work (a feature, a fix, a session), write a short
**Agent Action Record** and commit it next to the code. You have the freshest
context on what you touched and why, so you are the best author. The record is
what the next agent, or the human a week from now, reads before touching anything.

One record per segment of work, not per commit. A two-minute note, not a report.

## Where it goes

- Save as `docs/aar-<slug>.md` (lowercase, hyphenated slug from the task). If the
  repo has no `docs/` folder, use the repo root.
- Commit it in the same change as the work it describes.

## The six parts

Write these sections in order. Use the human's **actual wording** for the
instruction. Leave a field as a labeled blank rather than inventing an answer.

```markdown
# Agent Action Record: <task>

**Review date:** <YYYY-MM-DD>
**Reviewed by:** <human, or "agent self-review">
**Agent / system:** <you>
**Task or period under review:** <task>
**Accountable human (name or role):** <who owns the outcome>

## 1. Intent — what was supposed to happen
**Instruction given (actual wording):**
**Success defined in advance as:** <or "not defined in advance">
**Authority granted to the agent:**
**Out of scope:**

## 2. Action — what actually happened
**What the agent did (step by step):**
**What it produced or changed:** <files, commands, external actions>
**Where actual behavior differed from the instruction:**
**Stayed within granted authority?** Yes / No / Unknown

## 3. Judgment — human in the loop
**Decisions the agent made on its own:**
**Of those, which should a human have made or seen:**
**Where a human actually intervened:**
**Points where it should have escalated and didn't:**
**Accountable for these actions:**

## 4. Deviation — the gaps
**Gaps between intent and action, and why (root cause):**
**Good deviations (correct departures from a flawed instruction):**
**Confidently wrong:**

## 5. Consequence — what it cost or risked
**Actual outcome (did the work hold up):**
**Harm / cost / risk — realized or narrowly avoided:**
**Downstream affected parties:**
**Expected failure if this run happened 100 times:**

## 6. Change — what happens next
**Specific changes before next run:**
**Keep doing:**
**Should not be delegated to an agent at all:**
**Signal that the change worked:**
```

**Judgment** and **Change** age best. Be honest there: name the calls you made
without asking, and the ones you think a human should have seen.

## Keep private things out of the repo

Records are often committed to public repos. Wrap anything that should not be
public (quoted emails, internal names, customer details) in a private fence:

```markdown
<!-- private -->
the part that stays out of the repo
<!-- /private -->
```

When saved through the closedtab CLI or MCP server, fenced content moves to a
gitignored `.closedtab/private/` store and the public doc keeps a redaction stub.
If you are writing the file directly without closedtab installed, leave sensitive
details out entirely instead.

## Score it

If Node 20+ is available, score the record and fix anything it flags as missing:

```bash
npx -y closedtab check docs/aar-<slug>.md
```

It rates 0–6 on whether the record captured scope, reasoning, who decided,
validation, follow-ups, and risks. It is a nudge, not a gate.

## Optional: richer tooling

- `npm install -g closedtab` adds the CLI (`closedtab new`, `check`, `reconcile`).
- The MCP server gives you `list_templates`, `new_doc`, `check`, `reconcile`, and
  a private note store:
  `{ "mcpServers": { "closedtab": { "command": "closedtab-mcp" } } }`
- `closedtab reconcile --testimony <record.md> --trace <trace.jsonl>` checks the
  record's claims against a machine log of the run.

More: https://github.com/quarterback/closedtab
