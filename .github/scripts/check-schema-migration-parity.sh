#!/usr/bin/env bash
#
# Refuse a commit whose Drizzle schema and `drizzle/` migrations disagree.
#
# ## The failure this exists for, which has already happened
#
# `e29c1182` edited `src/db/schema/discovery.ts` to remove two enum values and
# touched nothing under `drizzle/`. The snapshot chain desynced and CI WAS
# GREEN. Two people found it independently, by different routes; nothing
# automated did, and nothing automated would have — `grep -rn "drizzle-kit"
# .github/workflows/` returned no match until this script.
#
# ## Why a green test suite cannot substitute for this, by construction
#
# The vitest harness builds each throwaway database FROM `drizzle/` (see
# `src/db/testDatabase.ts`). So after a schema edit with no migration the suite
# runs against the OLD constraints while the schema object carries the NEW ones.
# Nothing writes a removed enum value, so no assertion can observe the
# disagreement. The suite is blind to this entire class — not by oversight, but
# because the thing it builds from is the half that did not change. Adding tests
# would not help; only diffing the two halves does.
#
# ## Why exit code is not the signal
#
# `drizzle-kit generate` exits 0 whether it writes a migration or not. "Clean"
# and "drift" are both success as far as the process is concerned. So the gate
# asks git what appeared on disk rather than trusting the tool's status.
#
# ## Why a table-count floor
#
# A tool that fails to LOAD the schema also reports no changes to write, and
# "the diff was empty" is indistinguishable from "the diff never ran" by exit
# code or by an unchanged directory. The run enumerates every table it loaded,
# so the count is the evidence that a real comparison happened. Without this
# floor a broken import in `schema/index.ts` would turn the gate permanently
# green — the exact substitution this project has paid for more than once.
set -euo pipefail

# Comfortably below the real count (88 as of f6ce9fa0) so removing a table does
# not trip it, and far above any partial load. This is a vacuity floor, not an
# inventory: it answers "did the schema load at all", not "is the count right".
readonly MIN_TABLES=80

readonly REPO_ROOT="$(git rev-parse --show-toplevel)"
readonly MIGRATIONS_DIR="packages/backend/drizzle"

cd "$REPO_ROOT"

# Refuse to run over uncommitted migration work rather than restoring across it.
# This script resets `drizzle/` afterwards, and a developer part-way through
# writing a migration would lose it. Checking first means the reset below can
# only ever remove what this run itself produced.
if [[ -n "$(git status --porcelain -- "$MIGRATIONS_DIR")" ]]; then
  echo "Refusing to check parity: ${MIGRATIONS_DIR} has uncommitted changes." >&2
  echo "This check regenerates into that directory and resets it afterwards," >&2
  echo "which would destroy work in progress. Commit or stash it first." >&2
  git status --porcelain -- "$MIGRATIONS_DIR" >&2
  exit 1
fi

# `drizzle.config.ts` requires DATABASE_URL and throws without one, but
# `generate` never opens a connection — it diffs the schema against the
# snapshots on disk. A syntactically valid URL pointing nowhere is therefore
# both sufficient and safer than letting the real one leak into CI logs.
readonly UNUSED_URL='postgres://unused:unused@127.0.0.1:1/unused'

output_file="$(mktemp)"
trap 'rm -f "$output_file"' EXIT

set +e
DATABASE_URL="$UNUSED_URL" bun run --cwd packages/backend db:generate >"$output_file" 2>&1
generate_status=$?
set -e

if [[ $generate_status -ne 0 ]]; then
  echo "drizzle-kit generate failed (exit ${generate_status}):" >&2
  cat "$output_file" >&2
  exit 1
fi

# ---- vacuity floor -----------------------------------------------------------
# The run prints a "<N> tables" summary before enumerating them.
table_count="$(grep -oE '^[0-9]+ tables$' "$output_file" | head -1 | cut -d' ' -f1 || true)"

if [[ -z "$table_count" ]]; then
  echo "Cannot verify the schema was loaded: drizzle-kit printed no table count." >&2
  echo "Treating this as a failure rather than a clean diff — a run that read" >&2
  echo "nothing reports no changes, which is indistinguishable from success." >&2
  cat "$output_file" >&2
  exit 1
fi

if (( table_count < MIN_TABLES )); then
  echo "Schema loaded only ${table_count} tables, below the floor of ${MIN_TABLES}." >&2
  echo "That is a broken schema import, not a clean diff: a partial load reports" >&2
  echo "no changes to write and would otherwise pass this gate silently." >&2
  cat "$output_file" >&2
  exit 1
fi

# ---- the actual check --------------------------------------------------------
drift="$(git status --porcelain -- "$MIGRATIONS_DIR")"

if [[ -z "$drift" ]]; then
  echo "Schema and migrations agree (${table_count} tables, no migration generated)."
  exit 0
fi

echo "SCHEMA AND MIGRATIONS DISAGREE." >&2
echo >&2
echo "\`drizzle-kit generate\` produced a migration, which means the Drizzle" >&2
echo "schema has changes that no committed migration applies. Run:" >&2
echo >&2
echo "    bun run --cwd packages/backend db:generate" >&2
echo >&2
echo "and commit what it writes, in the SAME commit as the schema change." >&2
echo >&2
echo "Generated by this run (${table_count} tables loaded):" >&2
echo "$drift" >&2

# Name the change, not just the file. A gate that says "drift" without saying
# what drifted is one somebody disables at an inconvenient moment.
while read -r _status path; do
  case "$path" in
    *.sql)
      echo >&2
      echo "--- ${path} ---" >&2
      cat "$path" >&2
      ;;
  esac
done <<<"$drift"

# Leave the tree as it was found, so the check is repeatable and so a CI job
# cannot accidentally commit or cache the artefact. Safe because the directory
# was asserted clean above, so nothing here predates this run.
git checkout -- "$MIGRATIONS_DIR" 2>/dev/null || true
git clean -fdq -- "$MIGRATIONS_DIR"

exit 1
