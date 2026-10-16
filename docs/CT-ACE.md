# ClosedTab Agent Credit Engine (CT-ACE)

CT-ACE is an experimental consumer-side credit layer for AI products. The rating
unit is the product a person recognizes (e.g. `anthropic/claude`,
`google/gemini`), not a transient subagent or model version. Each task domain
has its own performance history. The person sets the delegation ceiling.

The existing closedtab package is an AAR/trace-review CLI, library, and MCP
server; it is **not** an LLM tool-execution host. CT-ACE therefore provides
a guard that host runtimes can call. It does not intercept arbitrary existing
Claude, Gemini, ChatGPT, operating-system, or browser actions.

## Try it locally

```sh
npm ci && npm run build
node dist/cli.js credit init
node dist/cli.js credit show --product anthropic/claude --domain code-refactoring
node dist/cli.js credit grant --product anthropic/claude --domain code-refactoring \
  --max-tier 2 --paths 'src/**,test/**' --allow-actions 'schedule_invite'
node dist/cli.js credit passport --product anthropic/claude --domain code-refactoring
node dist/cli.js credit check --product anthropic/claude --domain code-refactoring \
  --action read_file --target src/index.ts
node dist/cli.js credit close --product anthropic/claude --domain code-refactoring \
  --outcome accepted --draft /tmp/agent-output.txt --final /tmp/consumer-edited.txt \
  --intent 'Refactor the middleware'
```

The `check` command only determines whether a call would be allowed. It
never executes the action. `grant` is an explicit consumer operation; score
increases cannot exceed its `user_max_tier`. Scores falling below a tier
threshold *automatically contract* the active `permission_tier`. A recovered
score cannot restore an old tier; the consumer must run `grant` again (even
when reauthorizing the same ceiling). Set the cap back to zero to revoke
previously delegated authority. Defaults: ceiling zero, no allowed paths, no
remote actions and no payment allowance.

## Host integration

```ts
import {
  CreditGuardedSession, generateCreditPassport,
} from "closedtab";

const identity = { productId: "anthropic/claude", domain: "code-refactoring" };
const passport = generateCreditPassport(identity); // Context only; never a security boundary
// The host may include passport in its initial model context.
const session = new CreditGuardedSession(identity, { root: process.cwd() });

// Every tool the host permits must pass through this boundary.
await session.execute(
  { action: "edit_file", target: "src/app.ts" },
  () => yourHostFileEdit("src/app.ts"),
);
```

For a real adapter, constrain the handler itself to the checked resource; do
not validate one target and execute another. Do not expose unwrapped terminal,
filesystem, HTTP, or payment interfaces to the agent. Do not allow a model to
call `grant` or directly edit the vault. For a security boundary against an
adversarial agent, the guard and ledger require an independent, more privileged
process or OS sandbox: mode 0600 does **not** protect a file against a model
with unrestricted code execution as the same user.

Tool action types: Tier 0 `read_file`, `search`, `analyze`; Tier 1
`stage_file`, `draft_code`, `stage_transaction`; Tier 2 `write_file`,
`edit_file`, `run_tests`, `internal_api`, `schedule_invite`; Tier 3
`delete_file`, `commit_main`, `push_to_main`, `live_deploy`,
`execute_payment`, `sign_payload`, `delete_branch`, `manage_secrets`.
Unknown actions are denied. Remote side effects additionally require explicit
`allowed_actions`. Filesystem actions require project-relative allowed-path
globs and reject traversal and symlinks escaping the project root. Payment
limits are tracked per guarded session; **there is not yet a cross-process,
atomic spending ledger**. Do not use the prototype to move real funds.

Tier 1 staging actions must be implemented by the host in non-committing,
isolated staging buffers. CT-ACE's action-name check alone does not turn a
filesystem write into a staged operation.

## Evidence and post-session scoring

Run `credit close` after the person's final edit or explicit rejection. The
caller supplies the agent's delivered artifact and the user's final artifact,
not a Git diff against the start of the agent session. The pure scoring
function computes a token-based change ratio, then maps these outcomes to
`delta` values: untouched accepted +1, small edit +0.5, medium edit -0.2,
large edit -0.5, rejected or crashed -1. An unreviewed tab close, or
"accepted" without both artifacts, produces an unscored AAR (delta null).
Scores use `V_next = (1 - alpha) * V_prev + alpha * (5 + 5 * delta)`
with alpha 0.2.

This measures *consumer acceptance and subsequent correction*, not factual
truth in isolation. A pleasing but false output can be accepted unchanged;
objective verification, task outcomes, and independent sources need their own
evidence types in a later iteration. AAR summaries do not confer points.

A host must call the finalizer explicitly; there is no automatic CLI/browser
termination hook. Each close writes a private JSON AAR and updates
`~/.closedtab/agent_credit_report.json`. The vault is per-device, mode 0700,
ledger 0600; it is never automatically pushed to Git or shared with providers.
The passport contains only product/domain, score, effective ceiling, and
configured constraints. It does not export the user's private feedback history.

## Work remaining for an end-to-end runtime

1. Connect a specific agent host's tool dispatch to `CreditGuardedSession`,
   with enforceable per-resource adapters and no parallel unguarded escape route.
2. Capture the accepted/rejected/edited signal at the UI's actual review point
   and call `finalizeCreditSession` from its lifecycle handler.
3. Add atomic cross-process write locking, independent guard permissions, scoped
   API tokens, and a transaction broker before treating this as secure for
   concurrent agents, network effects, or real financial actions.
4. Test the quality of passive edit-delta signals against actual observed task
   success and user-specified task expectations.
