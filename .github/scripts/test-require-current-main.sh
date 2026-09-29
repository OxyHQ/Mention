#!/usr/bin/env bash

# Offline cases for require-current-main.sh, against throwaway local repos.
#
# The skip mode exists so a deploy that main overtook ends neutral instead of
# red. The cases that matter are the ones where that must NOT happen: a skip
# mode with nowhere to report the skip, and a checked-out tree that is not the
# candidate, both still fail — and the default mode, which the one-shot `run-*`
# workflows depend on, still fails on a stale SHA.

set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/require-current-main.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

git_quiet() { git -c init.defaultBranch=main -c user.name=t -c user.email=t@example.invalid "$@" >/dev/null 2>&1; }

git_quiet init --bare "$work/origin.git"
git_quiet clone "$work/origin.git" "$work/checkout"
git_quiet -C "$work/checkout" commit --allow-empty -m first
git_quiet -C "$work/checkout" push origin HEAD:refs/heads/main
first="$(git -C "$work/checkout" rev-parse HEAD)"

# Run the guard in the checkout. Prints "<exit> <outputs>" where outputs is the
# GITHUB_OUTPUT content with newlines folded into spaces.
run() {
  local output_file="$work/output"
  : >"$output_file"
  local status=0
  (cd "$work/checkout" && env -i PATH="$PATH" HOME="$work" GITHUB_OUTPUT="$output_file" "$@" bash "$script") \
    >/dev/null 2>&1 || status=$?
  echo "$status $(tr '\n' ' ' <"$output_file")"
}

run_without_output() {
  local status=0
  (cd "$work/checkout" && env -i PATH="$PATH" HOME="$work" "$@" bash "$script") >/dev/null 2>&1 || status=$?
  echo "$status"
}

expect() {
  local case_name="$1" want="$2" got="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL $case_name: want '$want', got '$got'" >&2
    failures=$((failures + 1))
  fi
}

# Current head: both modes pass and say so.
expect 'current-default' '0 current=true ' "$(run DEPLOY_SHA="$first")"
expect 'current-skip' '0 current=true ' "$(run DEPLOY_SHA="$first" STALE_RELEASE=skip)"

# Main moves on from somewhere else.
git_quiet clone "$work/origin.git" "$work/other"
git_quiet -C "$work/other" commit --allow-empty -m second
git_quiet -C "$work/other" push origin HEAD:refs/heads/main

# Stale: the default still fails (the run-* workflows rely on it) ...
expect 'stale-default-fails' '1 ' "$(run DEPLOY_SHA="$first")"
# ... skip mode ends clean, and says `current=false` so later steps skip.
expect 'stale-skip-is-neutral' '0 current=false ' "$(run DEPLOY_SHA="$first" STALE_RELEASE=skip)"
# ... but never without somewhere to say it.
expect 'stale-skip-without-output-fails' '1' "$(run_without_output DEPLOY_SHA="$first" STALE_RELEASE=skip)"

# A checkout that is not the candidate is an integrity fault in either mode.
second="$(git -C "$work/other" rev-parse HEAD)"
expect 'wrong-checkout-default' '1 ' "$(run DEPLOY_SHA="$second")"
expect 'wrong-checkout-skip' '1 ' "$(run DEPLOY_SHA="$second" STALE_RELEASE=skip)"

# Inputs the guard must refuse outright.
expect 'short-sha' '1 ' "$(run DEPLOY_SHA="${first:0:12}" STALE_RELEASE=skip)"
expect 'unknown-mode' '1 ' "$(run DEPLOY_SHA="$first" STALE_RELEASE=maybe)"

if [[ "$failures" -gt 0 ]]; then
  echo "$failures require-current-main case(s) failed" >&2
  exit 1
fi
echo "require-current-main: all cases passed"
