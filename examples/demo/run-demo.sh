#!/usr/bin/env bash
# Aletheic demo: one task moves from Codex to Claude Code to Gemini, and each agent starts with
# nothing but the repository.
#
#   examples/demo/run-demo.sh [work-dir]
#
# Each agent is a shell step that sets ALETHIC_AGENT, as a real agent session would. A real
# handoff spans hours, so the demo pins the clock with ALETHIC_NOW: record ids, timestamps, and
# commit dates come out the same on every run.
#
# The Aletheic command is ALETHIC_BIN if set, else `alethic` on PATH, else this checkout's
# dist/cli.js (run `npm run build` first). test/e2e/demo.test.ts runs this script, so it cannot rot.
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DEMO_DIR/../.." && pwd)"
WORK="${1:-$(mktemp -d "${TMPDIR:-/tmp}/alethic-demo.XXXXXX")}"
APP="$WORK/auth-service"
TASK="task-invalidate-sessions-after-password-reset"

if [[ -n "${ALETHIC_BIN:-}" ]]; then
  read -r -a TL <<<"$ALETHIC_BIN"
elif command -v alethic >/dev/null 2>&1; then
  TL=("$(command -v alethic)")
elif [[ -f "$REPO_ROOT/dist/cli.js" ]]; then
  TL=(node "$REPO_ROOT/dist/cli.js")
else
  echo "Aletheic is not built. Run \`npm run build\`, or set ALETHIC_BIN." >&2
  exit 2
fi

# The demo repository is a sandbox: ignore the user's Git configuration (signing, hooks).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

if [[ -t 1 ]]; then BOLD=$'\033[1m' DIM=$'\033[2m' RESET=$'\033[0m'; else BOLD="" DIM="" RESET=""; fi
AGENT=""
NOW=""

say() { printf '\n%s== %s ==%s\n' "$BOLD" "$*" "$RESET"; }

# Prints a command the way a person would type it.
show() {
  local line="\$" arg
  for arg in "$@"; do
    if [[ "$arg" =~ ^[A-Za-z0-9_./:@=,+-]+$ ]]; then line+=" $arg"; else line+=" \"$arg\""; fi
  done
  printf '%s%s%s\n' "$DIM" "$line" "$RESET"
}

# Prints a shell line verbatim, for steps that are clearer shown than quoted.
note() { printf '%s$ %s%s\n' "$DIM" "$*" "$RESET"; }

alethic() {
  show alethic "$@"
  # One session per agent, as a real agent would set with `alethic session new`.
  ALETHIC_AGENT="$AGENT" ALETHIC_SESSION="$AGENT-1" ALETHIC_NOW="$NOW" "${TL[@]}" "$@"
}

commit() {
  show git commit -am "$1"
  git add -A
  GIT_AUTHOR_NAME="$AGENT" GIT_AUTHOR_EMAIL="$AGENT@agents.invalid" GIT_AUTHOR_DATE="$NOW" \
    GIT_COMMITTER_NAME="$AGENT" GIT_COMMITTER_EMAIL="$AGENT@agents.invalid" GIT_COMMITTER_DATE="$NOW" \
    git commit -q -m "$1"
}

# Runs a check, shows its result, and records a receipt. Aletheic records; it never runs checks.
check() {
  local log="$WORK/check.log" code=0
  show "$@"
  "$@" >"$log" 2>&1 || code=$?
  # Node's test reporters print "# pass 3" (TAP) or "ℹ pass 3" (spec).
  sed -nE 's/^(# |ℹ )(pass|fail) ([0-9]+)$/  \2 \3/p' "$log"
  echo "  exit $code"
  alethic receipt add --command "$*" --exit-code "$code" --output-file "$log"
}

apply() {
  show cp -R "steps/$1/src/." src/
  cp -R "$DEMO_DIR/steps/$1/src/." src/
}

say "Setup: a small auth service, with Aletheic and one instruction block for every agent"
mkdir -p "$WORK"
rm -rf "$APP"
cp -R "$DEMO_DIR/app" "$APP"
cd "$APP"
git init -q -b main
AGENT=maintainer NOW=2026-09-14T09:00:00Z
alethic init --name auth-service
alethic render agents-md --write
note "echo @AGENTS.md > CLAUDE.md"
printf '@AGENTS.md\n' >CLAUDE.md
note 'echo '"'"'{ "context": { "fileName": ["AGENTS.md", "GEMINI.md"] } }'"'"' > .gemini/settings.json'
mkdir -p .gemini
printf '{\n  "context": { "fileName": ["AGENTS.md", "GEMINI.md"] }\n}\n' >.gemini/settings.json
commit "Add auth service with Aletheic"

say "Codex starts the task and tries deleting session rows"
AGENT=codex NOW=2026-09-14T09:10:00Z
show git switch -c feat/session-reset
git switch -q -c feat/session-reset
alethic task start "After a password reset, every session issued before it stops working within one request." \
  --summary "Invalidate sessions after password reset" --paths src/password-reset.js src/sessions.js
apply codex
commit "Delete session rows on password reset"
NOW=2026-09-14T09:40:00Z
check node --test
alethic checkpoint create \
  --done "resetPassword deletes the user's session rows" \
  --failed "Delete session rows on reset::refresh() reads the refresh cache first, so cached sessions keep working" \
  --question "Should API keys issued before the reset be revoked too?" \
  --next "Bump users.tokenVersion on reset and compare it in refresh()"
alethic task update "$TASK" --status paused
commit "alethic: checkpoint session reset"

say "Claude Code resumes in a fresh session: the briefing is all it knows"
AGENT=claude-code NOW=2026-09-14T13:00:00Z
alethic resume --target claude-code --budget 1200
alethic task claim "$TASK"
apply claude-code
commit "Compare tokenVersion on refresh"
NOW=2026-09-14T13:30:00Z
check node --test test/password-reset.test.js
alethic decision add --topic auth.session-invalidation \
  --chosen "Bump users.tokenVersion on reset and reject sessions with an older version" \
  --rationale "One write per user revokes every session, including sessions served from the refresh cache." \
  --alternative "Delete session rows on reset::The refresh cache keeps serving deleted sessions" \
  --evidence-file src/sessions.js --link "$TASK" --paths "src/**"
alethic checkpoint create \
  --done "refresh() rejects sessions whose tokenVersion is older than the user's" \
  --next "Run the full test suite, then close the task"
alethic task update "$TASK" --status paused
commit "alethic: record the session invalidation decision"

say "Gemini resumes, runs the full suite, and closes the task"
AGENT=gemini NOW=2026-09-14T18:00:00Z
alethic resume --target gemini --budget 1200
alethic task claim "$TASK"
check node --test
alethic knowledge add --category gotcha \
  --summary "refresh() reads the refresh cache before the sessions table" \
  --body "Deleting session rows does not revoke a session: refresh() serves cached copies first. Revoke by changing what the cached copy is checked against (tokenVersion)." \
  --evidence-file src/sessions.js
alethic task close "$TASK"
commit "alethic: close session reset"

say "What the repository now remembers"
alethic validate
alethic doctor
alethic render pr-summary --task "$TASK"
show git log --format="%h %an: %s"
git log --format="%h %an: %s"

printf '\nDemo repository: %s\n' "$APP"
