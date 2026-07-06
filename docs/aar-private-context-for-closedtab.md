# Agent Action Record: Private context for closedtab

**Review date:** 2026-07-06
**Reviewed by:** Owner (product owner)
**Agent / system:** Claude Code — closedtab session (design + implementation)
**Task or period under review:** Adding a private-context layer to closedtab
**Accountable human (name or role):** Owner / product owner

---

## 1. Intent — what was supposed to happen

**Instruction given (actual wording):**

The owner described overhearing a discussion about "the need for discretion when an
agent is parsing information that's supposed to be left out of a situation" — e.g.
reading an email or working on a project where "only one part of it can be shared
and the rest maybe is superfluous." As it relates to closedtab: figure out whether
there's "either another type of document or a way to fork this so that if there's
specific things that need to be kept out of a repo but need to be saved for the
human or kept as a secret for the agent to recall and reference for other agents but
not meant to be public," and asked "what would that look like?" A follow-up asked
for an Agent Action Record of the session, then to implement the feature on the
designated branch.

**Success defined in advance as:**
Not defined in advance for the design question; once approved, success meant the
feature building cleanly, tests passing, and — the load-bearing property — no marked
private content ever landing in a committed doc.

**Authority granted to the agent:**
Research (read-only), clarifying questions, a written plan; then, after plan approval
and an explicit "implement" choice, authority to write the feature, tests, and this
record on branch `claude/closedtab-private-context-25ksc6`, commit, and push. Not
authorized to open a PR (owner will handle README/repo finishing).

**Out of scope:**
Encryption or any network/secret-store; changing the reconcile core's algorithm;
editing the web/serverless endpoints; opening a pull request.

---

## 2. Action — what actually happened

**What the agent did (step by step, from logs where available):**
Explored the repo (parallel Explore agents + direct reads of every core file),
confirmed no visibility concept existed, surfaced three design forks and had the
owner decide them, drafted and got approval on a plan, then implemented: a new
`src/private.ts` (fork/stub/gitignore/store), a `private?` flag and a `private-note`
template in `src/templates.ts`, fork-on-save wiring plus a `--private` flag in
`src/newCommand.ts`, a `private list`/`read` subcommand and usage text in
`src/cli.ts`, three disk-touching MCP tools plus a `private` option on `new_doc` in
`src/mcp.ts`, library exports in `src/index.ts`, and tests in
`test/private.test.ts` and `test/newCommand.test.ts`.

**What it produced or changed:**
Sensitive spans are marked with an HTML-comment fence `<!-- private -->…<!-- /private
-->`. On save the doc forks into a public copy (each region replaced by an inert,
visible fenced redaction stub pointing at the companion) and a gitignored companion
under `.closedtab/private/` holding the withheld text; `ensureIgnored` appends
`.closedtab/` to `.gitignore` before any private write. Agents reach the store via
`write_private_note`, `list_private_notes`, `read_private_note`.

**Where actual behavior differed from the instruction:**
Scope grew mid-session from "what would this look like?" (a design answer) to a full
implementation, at the owner's explicit direction. The record was widened from a
design-session review to cover the build so the testimony matches the run.

**Stayed within granted authority? (yes / no / unknown)**
Yes. Read-only until the plan was approved; then edits confined to the designated
branch; no PR opened.

---

## 3. Judgment — human in the loop

**Decisions the agent made on its own:**
The fence as the primary marker; the redaction-stub form; `.closedtab/private/` and
the `.private.md` companion naming; a new `src/private.ts` module; making the MCP
private tools write to disk; and — during implementation — switching the stub from a
blockquote-plus-comment to a fenced block after discovering `parseAar.ts` does not
strip HTML comments.

**Of those, which should a human have made or seen:**
The three product-shaping forks (shape, store, agent access) were escalated and
decided by the owner. The stub wording and path naming were agent calls surfaced in
the plan for review.

**Where a human actually intervened (approve / edit / override / redirect):**
Owner answered the three forks, approved the plan, and chose "implement + AAR."

**Points where it should have escalated and didn't:**
None material. The one judgment worth flagging — MCP tools now write to disk, unlike
the current `new_doc` — was called out explicitly rather than slipped in.

**Accountable for these actions:**
Owner / product owner.

---

## 4. Deviation — the gaps

**Gaps between intent and action, and why (root cause, not first answer):**
The plan asserted the redaction stub would be "inert to check and parseAar" because
both strip HTML comments. That was half-wrong: `parseAar.ts` strips only fenced code
blocks, not comments, so a comment-based stub would have been parsed as a claim and
its companion path mis-extracted as a phantom file. Root cause: trusting a
cross-file claim without exercising it. Caught by a test asserting no claim carries
the stub, and fixed by making the stub a fenced block (dropped by both parsers).

**Good deviations (correct departures from a flawed instruction):**
Moving to a fenced stub turned the parser quirk into the mechanism: the stub is now
visible when rendered (honest that content was withheld) yet contributes zero score
and zero claims — verified end-to-end (5 claims parsed, 0 phantom).

**Confidently wrong (high confidence + wrong — flag specifically):**
The plan's "both parsers strip comments" line — stated with confidence, wrong for
`parseAar`. Flagged here because it is exactly the kind of plausible-but-unverified
claim closedtab exists to catch.

---

## 5. Consequence — what it cost or risked

**Actual outcome (did the work hold up):**
Build clean; 92 tests pass (7 pre-existing corpus tests skipped). End-to-end in a
scratch git repo: an inline fence produced a stubbed public doc and a gitignored
companion, `.gitignore` was auto-created, `git` staged zero store files, no secret
appeared in `docs/`, and `parseAar` surfaced no phantom claim or file.

**Harm / cost / risk — realized or narrowly avoided:**
The central risk is a secret reaching a public commit. Mitigated by `ensureIgnored`
running before every private write and by the fail-closed unbalanced-fence handling
(redact to end of document + stderr warning). Residual risk: content hand-authored
into a public doc outside the tool is not protected.

**Downstream affected parties:**
Future agents and humans reading the records; anyone who clones the public repo.

**Expected failure if this run happened 100 times:**
A mistyped or unclosed fence. Handled two ways: the regex tolerates whitespace
(`<!--private-->` and `<!-- private -->` both match), and an unbalanced fence fails
closed rather than leaking.

---

## 6. Change — what happens next

**Specific changes before next run (instruction / scope / authority / escalation / checkpoints):**
Owner to review the stub wording and the `.closedtab/private/` path in use, update
the README to document the fence, `--private`, the `private` subcommand, and the new
MCP tools, and decide whether `private-note` should stay listed in `list_templates`
or be gated. A `--merged` option to check/reconcile the public doc together with its
companion locally is a sensible follow-up, not built here.

**Keep doing:**
Escalating the genuine forks; grounding design in the actual code (the
comment-stripping discovery); writing the test that would catch the plan being wrong
before trusting the plan.

**Should not be delegated to an agent at all:**
The visibility policy — what counts as private in a given record — stays a human
call. The tool enforces the boundary; the owner defines it.

**Signal that the change worked:**
A `<!-- private -->` block never appears in a committed doc, and an agent can recall
prior private context across a handoff without it ever leaving the machine.
