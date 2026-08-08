#!/usr/bin/env bash
#
# scripts/ci-check.sh
#
# Local/manual validation gate — the "minimal CI workflow" content, run
# locally instead of via GitHub Actions.
#
# WHY THIS ISN'T A GITHUB ACTIONS WORKFLOW: GitHub Actions is enabled on
# this repo, but every historical workflow run has failed in 4-6 seconds —
# far too fast to be a real lint/test/build failure, consistent with a
# runner-provisioning/billing problem. This repo's history already has a
# commit removing a workflow for the same reason ("ci: remove unavailable
# GitHub Actions workflow"). Adding a new workflow file today would just
# fail immediately on every PR and mislead reviewers. See docs/CI_STATUS.md.
#
# Run this manually before opening/updating a PR, or wire it into whatever
# CI provider replaces GitHub Actions later — it's provider-agnostic.
#
# Usage: bash scripts/ci-check.sh   (or: npm run ci-check)

set -euo pipefail

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$1"; exit 1; }
pass() { printf '\033[1;32m✓ %s\033[0m\n' "$1"; }

cd "$(dirname "$0")/.."

step "Install dependencies"
if [ -f package-lock.json ]; then
  npm ci || fail "npm ci failed"
else
  npm install || fail "npm install failed"
fi
pass "dependencies installed"

step "Lint"
npm run lint || fail "lint failed"
pass "lint passed"

step "Typecheck"
npm run typecheck || fail "typecheck failed"
pass "typecheck passed"

step "Test"
npm test || fail "tests failed"
pass "tests passed"

step "Build"
npm run build || fail "build failed"
pass "build passed"

printf '\n\033[1;32mAll checks passed.\033[0m\n'
