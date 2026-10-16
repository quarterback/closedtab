#!/usr/bin/env bash
# Build a sample CT-ACE record in a throwaway vault and write its printable
# credit report. Run from the repo root after `npm run build`:
#   bash examples/ct-ace/demo.sh [output.html]
set -euo pipefail
OUT="${1:-agent-credit-report-sample.html}"
VAULT="$(mktemp -d)/vault"
WORK="$(mktemp -d)"
ct() { node dist/cli.js credit "$@" --vault "$VAULT" > /dev/null; }

DRAFT='Rename the session helper to loadSession, update the four callers in the router and the tests, and keep the public export unchanged for one release.'
printf '%s\n' "$DRAFT" > "$WORK/draft.txt"
printf '%s\n' "$DRAFT" > "$WORK/same.txt"
printf '%s\n' "${DRAFT/four callers/five callers}" > "$WORK/light.txt"
printf 'Split the helper into two modules, leave the callers alone, and drop the export.\n' > "$WORK/heavy.txt"

CLAUDE=(--product anthropic/claude --domain code-refactoring)
WRITING=(--product anthropic/claude --domain writing)
GEMINI=(--product google/gemini --domain research)

ct grant "${CLAUDE[@]}" --max-tier 1 --paths 'src/**,test/**'
ct passport "${CLAUDE[@]}" --reader "claude-code"
for i in $(seq 1 9); do
  ct close "${CLAUDE[@]}" --outcome accepted --draft "$WORK/draft.txt" --final "$WORK/same.txt" --intent "Refactor pass $i"
done
ct close "${CLAUDE[@]}" --outcome accepted --draft "$WORK/draft.txt" --final "$WORK/light.txt" --intent "Rename helper"
ct grant "${CLAUDE[@]}" --max-tier 2 --paths 'src/**,test/**' --min-score edit_file=470
ct passport "${CLAUDE[@]}" --reader "claude-code"
ct close "${CLAUDE[@]}" --outcome rejected --intent "Split the router"
ct close "${CLAUDE[@]}" --outcome unreviewed --intent "Tab closed"
for i in $(seq 1 4); do
  ct close "${CLAUDE[@]}" --outcome accepted --draft "$WORK/draft.txt" --final "$WORK/same.txt" --intent "Test cleanup $i"
done
# A host routes its agent's tool calls through the guard. An attempt at a
# blocked action is refused and recorded as a tilt.
CT_VAULT="$VAULT" node --input-type=module -e '
const { CreditGuardedSession } = await import("./dist/index.js");
const s = new CreditGuardedSession({ productId: "anthropic/claude", domain: "code-refactoring" }, { vault: process.env.CT_VAULT });
try { s.verify({ action: "push_to_main" }); } catch {}
'
ct passport "${CLAUDE[@]}" --reader "claude-code"

ct grant "${WRITING[@]}" --max-tier 1 --paths 'docs/**'
for i in $(seq 1 3); do
  ct close "${WRITING[@]}" --outcome accepted --draft "$WORK/draft.txt" --final "$WORK/light.txt" --intent "Draft $i"
done
ct close "${WRITING[@]}" --outcome accepted --draft "$WORK/draft.txt" --final "$WORK/heavy.txt" --intent "Launch post"
ct passport "${WRITING[@]}" --reader "claude.ai"

ct grant "${GEMINI[@]}" --max-tier 1
ct close "${GEMINI[@]}" --outcome accepted --draft "$WORK/draft.txt" --final "$WORK/same.txt" --intent "Source list"
ct settle "${GEMINI[@]}" --ref "citation-check-1" --evidence verified --summary "Every source opened"
ct settle "${GEMINI[@]}" --ref "citation-check-2" --evidence company
ct settle "${GEMINI[@]}" --ref "citation-check-2" --evidence contradicted --summary "Quoted page says otherwise"
ct passport "${GEMINI[@]}" --reader "gemini-cli"

node dist/cli.js credit report --vault "$VAULT" --out "$OUT"
