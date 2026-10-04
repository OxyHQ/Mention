#!/usr/bin/env bash
# Run the Jev suite against an OWNED synthetic PostgreSQL cluster, and nowhere
# else. Every identity value is explicit; there are no defaults:
#
#   JEV_TEST_DATA=/tmp/.../data JEV_TEST_SOCKET=/tmp/.../socket JEV_TEST_PORT=5432 \
#   JEV_TEST_DATABASE=<named base> JEV_TEST_USER=<role> scripts/test-jev-owned-pg.sh
#
# Order matters: the variables are checked first, then the cluster on disk, then
# postgres-js's resolved options for the named base and for the `postgres`
# maintenance database the shared test harness rewrites to, then SHOW
# data_directory/listen_addresses on those same clients. Only then does Vitest
# start. See docs/jev-shadow-evaluation.md.
set -euo pipefail
cd /home/nate/Oxy/Mention/.worktrees/jev-atomic-edit-20261004
export PATH="/home/nate/.bun/bin:/home/nate/.nvm/versions/node/v24.21.0/bin:$PATH"

missing=()
for name in JEV_TEST_DATA JEV_TEST_SOCKET JEV_TEST_PORT JEV_TEST_DATABASE JEV_TEST_USER; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done
if (( ${#missing[@]} > 0 )); then
  echo "Refusing to run: required owned-cluster variables are unset: ${missing[*]}" >&2
  exit 2
fi

# Hostless url + explicit PG* routing. postgres-js uses PGHOST only when the url
# hostname is empty; a ?host= parameter on a hostname url is ignored.
export PGHOST="$JEV_TEST_SOCKET" PGPORT="$JEV_TEST_PORT"
export PGUSER="$JEV_TEST_USER" PGUSERNAME="$JEV_TEST_USER"
unset PGDATABASE PGHOSTADDR PGSERVICE
export TEST_DATABASE_URL="postgres:///$JEV_TEST_DATABASE"
export DATABASE_URL="$TEST_DATABASE_URL"

node scripts/lib/jevOwnedPgProof.mjs

cd packages/backend
bun run test --maxWorkers=2 src/__tests__/controllers/updatePostAtomicContent.test.ts src/__tests__/controllers/updatePostDropsMachineVariants.test.ts src/__tests__/controllers/updatePostScheduledWindow.test.ts src/__tests__/controllers/updatePostHashtagValidation.test.ts src/__tests__/controllers/updatePostChannelCorrections.test.ts src/__tests__/controllers/updatePostLocationValidation.test.ts src/__tests__/controllers/postEditSource.test.ts src/__tests__/db/postEvaluationRepository.test.ts src/__tests__/services/jevShadow.test.ts
