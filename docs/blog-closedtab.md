# closedtab: review the work your AI agents do

An AI agent finishes a task. It made a string of small calls along the way: where
to start, what to assume, when to act on its own. closedtab helps you review that
run and keep a record of it, in about two minutes.

The idea behind it is simple: outputs are easy to measure, and judgment is hard.
A test suite tells you the code passes. It stays quiet about the moment the agent
decided something on its own that you would have wanted to see. closedtab puts
those moments on the page.

> **New to this and want to start?** [`GETTING-STARTED.md`](../GETTING-STARTED.md)
> is a from-zero walkthrough — install, let your coding agent write its first
> record, and see a fully worked example. Start there, then come back for the why.

## Why it exists

Agents now make decisions, take actions, and finish tasks that carry real weight.
After-action reviews are a long-standing practice for exactly this: in the
military and in emergency response, you debrief after the fact, reconstruct what
happened, and surface what to change. closedtab brings that practice to agent
work, and gives the review a fixed shape so the records stay comparable run to
run.

It earns the most when you stay hands-on. Picture yourself as the product owner,
with one agent as engineer and another as PM. There, a record of each run keeps
everyone oriented and keeps the decisions visible. Run it feature by feature, on
the work you are steering, and the records add up into a real history.

## The six-part review

`closedtab new` scaffolds an **Agent Action Record**: six sections you work
through in order.

1. **Intent** — the instruction in its actual wording, how success was defined,
   the authority the agent had to act on its own, and what stayed out of scope.
2. **Action** — what the agent did (from logs where you have them), what it
   produced, where its behavior diverged, and whether it stayed within authority.
3. **Judgment** — the decisions the agent made alone, which of those a human
   should have made or seen, where a human stepped in, where it should have
   escalated, and who is accountable. This is the heart of it.
4. **Deviation** — the gaps between intent and action and their root cause, the
   good deviations (correct departures from a flawed instruction), and the places
   it was confidently wrong.
5. **Consequence** — the outcome, the cost or risk, who was affected downstream,
   and the failure you would expect if this run happened a hundred times.
6. **Change** — what changes before the next run, what to keep doing, what belongs
   with a human, and the signal that proves the change worked.

Read across many records, the Deviation and Change sections are where the value
compounds: they show you the patterns in how a given agent works.

## How to use it: the command line

```
npm install -g closedtab
closedtab new        # scaffold an Agent Action Record to fill in
closedtab guide      # the short how-to
closedtab check ./docs/aar-fall-portal.md     # score a record on what it surfaced
closedtab reconcile --testimony ./aar.md --trace ./trace.jsonl   # line it up with the run
```

`closedtab reconcile` takes the record plus a trace of what the agent actually
did, and reports four things: the claims the run confirms, the claims that still
want evidence, the actions in the run worth adding to the record, and any place
where the record and the run tell different stories. It runs locally and needs
only Node.

The `record-template.md` is a plain form too. Work the six sections by hand, keep
the record, and read them over time. Claude stays optional.

## How to use it: MCP

closedtab also runs as an MCP server, so an agent can write the record of its own
run as part of finishing the work:

```json
{
  "mcpServers": {
    "closedtab": {
      "command": "closedtab-mcp"
    }
  }
}
```

The agent gets four tools — `list_templates`, `new_doc`, `check`, `reconcile`. A
typical loop: the agent finishes a segment, calls `new_doc` to write the record
of what it just did, calls `check` to confirm it surfaced the judgment and the
deviations, and saves the file with the change. You read a clean, consistent
record, and the next agent inherits it.

## Start tonight

Pick the last run an agent did for you and review it:

```
npm install -g closedtab
closedtab new
```

Two minutes, and you have a record of what the agent decided, where you would have
wanted to be in the loop, and what to change before the next run.
