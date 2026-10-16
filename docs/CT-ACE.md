# closedtab Agent Credit Engine (CT-ACE)

CT-ACE is a credit record you keep on your own device for each AI product you
use, scored by the kind of task you hand it. The record decides how much
authority that product's agents get. The rating unit is the product you
recognize (`anthropic/claude`, `google/gemini`), and each task domain
(`code-refactoring`, `writing`) has its own history. You set the ceiling;
the score can lower authority on its own, and only your grant raises it.

closedtab is a record and review tool. It supplies a guard that an agent host
calls before each tool call; it does not intercept Claude, Gemini, ChatGPT,
browser or operating system actions on its own.

## Try it

```sh
npm ci && npm run build
bash examples/ct-ace/demo.sh            # builds a sample record and writes agent-credit-report-sample.html
```

With your own record:

```sh
node dist/cli.js credit init
node dist/cli.js credit grant --product anthropic/claude --domain code-refactoring \
  --max-tier 1 --paths 'src/**,test/**'
node dist/cli.js credit passport --product anthropic/claude --domain code-refactoring --reader claude-code
node dist/cli.js credit close --product anthropic/claude --domain code-refactoring \
  --outcome accepted --draft /tmp/agent-output.txt --final /tmp/your-final.txt --intent 'Refactor the middleware'
node dist/cli.js credit show --product anthropic/claude --domain code-refactoring
node dist/cli.js credit report --out agent-credit-report.html
```

| Command | What it does |
| --- | --- |
| `credit init` | Creates the private vault at `~/.closedtab` (0700) and the ledger (0600). |
| `credit show` | Your view of one domain: score, band, tiers, limits, and what you could grant next. |
| `credit passport` | The agent's view: its limits only. Each read is recorded as an inquiry. |
| `credit grant` | Sets the ceiling and limits. The only command that raises authority. |
| `credit grant --confirm` | The second confirmation a tier 3 grant needs, 24 hours after it was asked for. |
| `credit check` | A dry run of the guard. It never performs the action. |
| `credit close` | Scores a reviewed session from the agent's draft and your final version. |
| `credit settle` | Scores an action in the world once its proof settles. |
| `credit dispute` | Sets one event aside and recomputes the score. |
| `credit events` | Prints every event in the record, one JSON line each. |
| `credit report` | Writes the printable credit report as HTML, one page per product. |

## The score

Scores run from 100 to 600, a three digit range that reads like a credit
score and stays apart from the 300 to 850 range people know from their own
reports. A new domain starts at 350 with no authority granted.

| Band | Score | Tier the score supports |
| --- | --- | --- |
| Prime | 550 to 600 | 3 |
| Near Prime | 450 to 549 | 2 |
| Subprime | 300 to 449 | 1 |
| Deep Subprime | 100 to 299 | 0 |

Points work the way pinball scores them:

- **Base.** Each scored session or settled action sets a target of
  350 + 250 × delta, and the score moves part of the way toward it.
- **Step.** The score moves 20% of the way. Older play fades as new play
  arrives, the way a moving average does.
- **Multiplier.** Stronger evidence moves the score further: a company's
  confirmation 1.5 times as far, an outside verification or a contradiction
  twice as far.
- **Combo.** Each consecutive success after the first adds 0.25 to the
  multiplier on upward moves, up to 2 at five in a row. Any failure resets it.
- **Tilt.** A contradicted action, or an attempt at an action you blocked,
  resets the combo and drops the active tier one step on the spot.
- **Replay line.** Crossing a tier line earns the right to ask you for a
  grant. `close`, `settle` and `show` say when a higher tier is available;
  nothing changes until you grant it.

No single event moves the score more than 60% of the way to its target.

### What earns credit

Drafted work is scored on how much you changed before you used it:

| What you did | Delta |
| --- | --- |
| Accepted it untouched | +1 |
| Changed under 15% of the words | +0.5 |
| Changed 15% to 50% | −0.2 |
| Changed more than 50% | −0.5 |
| Rejected it, or the session crashed | −1 |
| Closed it without review | not scored |

Edits measure acceptance, and a pleasing but wrong answer can be accepted
unchanged. Actions taken in the world (a calendar change, a payment, a form
sent) are scored on how far the proof got, once it settles:

| Evidence | `--evidence` | Delta | Multiplier |
| --- | --- | --- | --- |
| Verified by a source other than the helper | `verified` | +1 | 2 |
| The company confirmed receipt | `company` | +0.5 | 1.5 |
| The exchange was recorded, nothing back yet | `exchange` | 0 | 1 |
| Only the helper's own report | `helper` | −0.5 | 1 |
| The company or the outcome contradicts the helper | `contradicted` | −1 | 2, and a tilt |

Each action settles once. A contradiction may follow an earlier settlement of
the same action, because evidence against can arrive late.

## Authority

A domain's active tier is the lowest of three numbers: the tier its score
supports, the ceiling you granted, and its current tier.

| Tier | Actions |
| --- | --- |
| 0 | `read_file`, `search`, `analyze` |
| 1 | `stage_file`, `draft_code`, `stage_transaction` |
| 2 | `write_file`, `edit_file`, `run_tests`, `internal_api`, `schedule_invite` |
| 3 | `delete_file`, `commit_main`, `push_to_main`, `live_deploy`, `execute_payment`, `sign_payload`, `delete_branch`, `manage_secrets` |

The rules:

1. **Downgrades are automatic.** When a score drops below a tier's line, the
   active tier contracts in the same write that records the session.
2. **Upgrades take a fresh grant.** A recovered score never restores an old
   tier. Run `grant` again, even to reauthorize the same ceiling.
3. **History counts.** A grant reaches tier 2 only after 10 scored sessions or
   actions, and tier 3 only after 25. A grant above what the score and history
   support is applied at the highest tier they do support, and the output says
   why.
4. **Tier 3 waits.** A grant that raises a domain to tier 3 applies tier 2
   now and records the request. After 24 hours, `grant --confirm` applies
   tier 3 if the domain still qualifies. Lowering the ceiling cancels it.
5. **Minimum scores.** `--min-score edit_file=470,run_tests=420` attaches a
   minimum to a single action. When the score falls below one, that action is
   held until your next grant, the same way a tier contracts. `--min-score
   none` clears them.
6. **Revoking is one step.** `grant --max-tier 0` takes effect at once.

On top of the tier, the guard enforces the blocked list (which applies at
every tier; `manage_secrets`, `delete_branch` and `push_to_main` are blocked by
default), a separate yes for any action with a remote side effect, project
relative paths with traversal and escaping symlinks rejected, and a spending
cap per guarded session. Unknown actions are denied.

## The passport and the guard

```ts
import { CreditGuardedSession, generateCreditPassport } from "closedtab";

const identity = { productId: "anthropic/claude", domain: "code-refactoring" };
// Context for the model: its limits and nothing else. Recorded as an inquiry.
const passport = generateCreditPassport(identity, undefined, { reader: "my-host" });
const session = new CreditGuardedSession(identity, { root: process.cwd() });

// Every tool the host permits must pass through this boundary.
await session.execute(
  { action: "edit_file", target: "src/app.ts" },
  () => yourHostFileEdit("src/app.ts"),
);
```

The passport lists the active tier and ceiling, the actions the agent may
attempt now, its paths, the blocked actions, the remote actions you have said
yes to and those that still need your yes, and the session spending cap. It
leaves the score out. An agent that can see its own score has a number to
chase; the score is yours, and you set permissions against it. Refusals from
the guard name the rule and never a score or threshold.

`CreditGuardedSession` records an attempt at a blocked action as a tilt,
because the passport told the agent the action was blocked. Other refusals
are not recorded. Pass `recordTilts: false` to turn this off.

For a real adapter, constrain the handler to the checked resource; never
validate one target and execute another. Keep unwrapped terminal, filesystem,
HTTP and payment interfaces away from the agent, and never let a model call
`grant` or edit the vault. Mode 0600 does not protect a file from a model that
can run code as the same user, so a deployment that faces an adversarial agent
runs the guard and the ledger in a separate, more privileged process.

Tier 1 staging actions must be implemented by the host in isolated staging
buffers; the action name alone does not turn a write into a staged write.

## The record

The ledger at `~/.closedtab/agent_credit_report.json` (format 2.0.0) is a list
of events: `grant`, `grant_confirmed`, `session_closed`, `action_settled`,
`blocked_attempt`, `inquiry` and `dispute`. Every score, tier and limit is
computed from that list on every read, so a score always matches its
history. The `products` block in the file is a snapshot for people reading
it; the tool recomputes it and never trusts it. A malformed event fails
closed.

Each change happens under a lock file, so a host's guard and your CLI cannot
overwrite each other's events. Each closed session also writes a private
session file under `~/.closedtab/aars/`. Nothing is sent to a provider or
pushed to Git.

A dispute sets one session, settled action or blocked attempt aside and
recomputes the score from the rest. A dispute can lower authority (if the
recomputed score no longer supports a tier), and it never raises a tier or
releases a held action; grant again for that. A grant records the tier it produced when it was made, and a later
replay never exceeds it.

A ledger from the first prototype (format 1.0.0, scored 0 to 10) is read as one
baseline event per domain, with scores mapped onto the new range
(100 + 50 × the old score), and is saved in the new format on the next change.
Its 30 most recent session summaries are dropped from the ledger; the session
files under `aars/` stay where they are.

## The printable report

`credit report` writes one page per product, laid out like a consumer credit
report:

| Credit report section | In the agent credit report |
| --- | --- |
| Score and reasons | Each task's score and band, with the three events that moved it most |
| Accounts | Each task with its active tier, ceiling, what you could grant next, and the limits you set |
| Payment history | The last 24 sessions and actions as a row of marks, tilts outlined, disputes struck through |
| Inquiries | Which agent read its limits, for which task, how often, first and last |
| Collections and public records | Held, blocked and contradicted actions |
| How to dispute | The `credit dispute` command, with every entry's event id |

The page reads in black and white, prints on letter and A4, uses tabular
figures and system fonts, and has nothing that needs color to read. A
product with three or more tasks adds a summary table and may run past one
page. Print it or save it as a PDF from the browser.

## Limits of this prototype

1. It enforces what a host routes through `CreditGuardedSession`. Connecting a
   specific agent host's tool dispatch is the next step.
2. A host has to capture the accepted, edited or rejected signal at its own
   review point and call `finalizeCreditSession`.
3. Spending caps last one guarded session. There is no shared spending ledger
   across processes, so real money stays out of it.
4. The edit signal needs testing against observed task success.
