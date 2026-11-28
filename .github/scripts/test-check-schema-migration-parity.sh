#!/usr/bin/env bash
#
# Self-test for `check-schema-migration-parity.sh`.
#
# A gate whose refusal nobody has watched fire is a gate-shaped comment. This
# arms each failure the gate claims to catch, asserts it goes red AND says
# something actionable, then disarms and asserts green again — so the green is
# measured after the mutation rather than remembered from before it.
#
# Three cases, and the third is the one most gates get wrong:
#   1. schema changed, no migration      -> red, and NAMES the generated file
#   2. schema cannot load (broken import) -> red, NOT "no changes to report"
#   3. clean tree                         -> green
#
# Case 2 is the anti-vacuity control. A tool that fails to load the schema also
# finds nothing to write, so "clean" and "never ran" are the same observation by
# exit code alone. If this case ever starts passing as green, the gate has
# stopped being able to fail.
set -euo pipefail

readonly REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

readonly GATE=".github/scripts/check-schema-migration-parity.sh"
readonly SCHEMA_FILE="packages/backend/src/db/schema/adminScripts.ts"
readonly SCHEMA_INDEX="packages/backend/src/db/schema/index.ts"
readonly MIGRATIONS_DIR="packages/backend/drizzle"
readonly MARKER="ci_parity_selftest_marker"

fail() { echo "SELF-TEST FAILED: $*" >&2; exit 1; }

# Every mutation is restored here, including on an early exit, so a failed
# assertion cannot leave a poisoned schema behind for the next job or session.
restore() {
  git checkout -- "$SCHEMA_FILE" "$SCHEMA_INDEX" 2>/dev/null || true
  git checkout -- "$MIGRATIONS_DIR" 2>/dev/null || true
  git clean -fdq -- "$MIGRATIONS_DIR" 2>/dev/null || true
}
trap restore EXIT

if [[ -n "$(git status --porcelain -- "$SCHEMA_FILE" "$SCHEMA_INDEX" "$MIGRATIONS_DIR")" ]]; then
  fail "working tree is dirty in the paths this test mutates; commit or stash first"
fi

# ---- baseline: the gate passes on an unmodified tree -------------------------
if ! bash "$GATE" >/dev/null 2>&1; then
  fail "gate is red on a clean tree — every result below would be meaningless"
fi
echo "ok  1/4  clean tree passes"

# ---- case 1: schema changed with no migration -------------------------------
# Mirrors e29c1182: a schema edit that no committed migration applies.
# A real COLUMN, not a bare const: only something that changes the DDL can
# produce a migration, and the whole point is to arm the failure the gate
# exists for rather than one it would catch trivially.
SELFTEST_MARKER="$MARKER" perl -0pi -e "s/('admin_script_cursors',\s*\{)/\$1\n    \$ENV{SELFTEST_MARKER}: text(),/" "$SCHEMA_FILE"

if ! grep -q "$MARKER" "$SCHEMA_FILE"; then
  fail "could not arm the mutation — the pgTable pattern in $SCHEMA_FILE has changed"
fi

set +e
drift_output="$(bash "$GATE" 2>&1)"
drift_status=$?
set -e

[[ $drift_status -ne 0 ]] || fail "gate PASSED a schema change with no migration (case 1)"
grep -q "SCHEMA AND MIGRATIONS DISAGREE" <<<"$drift_output" \
  || fail "gate went red but did not say why (case 1)"
grep -qE "packages/backend/drizzle/[0-9]+_.*\.sql" <<<"$drift_output" \
  || fail "gate did not NAME the generated migration file (case 1)"
grep -q "$MARKER" <<<"$drift_output" \
  || fail "gate did not show the offending change itself (case 1)"
echo "ok  2/4  schema change with no migration is refused, file named, change shown"

git checkout -- "$SCHEMA_FILE"

# The gate must leave no artefact behind, or a second run would disagree with
# the first and CI would depend on job ordering.
[[ -z "$(git status --porcelain -- "$MIGRATIONS_DIR")" ]] \
  || fail "gate left a generated migration behind after refusing"
echo "ok  3/4  refusal leaves the tree as it found it"

# ---- case 2: ANTI-VACUITY — a schema that cannot load must not read green ----
cp "$SCHEMA_INDEX" "$SCHEMA_INDEX.selftest-backup"
printf 'export {};\n' >"$SCHEMA_INDEX"

set +e
empty_output="$(bash "$GATE" 2>&1)"
empty_status=$?
set -e

mv "$SCHEMA_INDEX.selftest-backup" "$SCHEMA_INDEX"

[[ $empty_status -ne 0 ]] \
  || fail "gate reported SUCCESS for a schema that loads no tables (case 2) — it can no longer fail"
grep -qE "below the floor|printed no table count" <<<"$empty_output" \
  || fail "gate refused an unloadable schema but not for the vacuity reason (case 2)"
echo "ok  4/4  a schema that loads nothing is refused, not mistaken for clean"

restore
bash "$GATE" >/dev/null 2>&1 || fail "tree not restored — gate is red after the self-test"

echo "Schema/migration parity gate self-test passed."
