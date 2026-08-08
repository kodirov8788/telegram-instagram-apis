# CI status

**GitHub Actions is currently non-functional for this repo.** Every historical
workflow run failed in 4-6 seconds — far too fast for a real lint/test/build
failure, consistent with a runner-provisioning/billing problem, not a code
problem. This repo's git history already contains a commit removing a
workflow for exactly this reason (`7f81b06`, "ci: remove unavailable GitHub
Actions workflow"). Verify with `gh run list --limit 5` if needed.

Because of that, **no `.github/workflows/*.yml` file is checked in.** Adding
one back today would fail immediately on every PR and mislead anyone reading
PR checks.

## What's actually gating PRs right now

- **Vercel's build+deploy check** — already runs automatically on every PR
  (visible as the "Vercel" status check) and is currently the only working
  automated gate for this repo.
- **`scripts/ci-check.sh`** (`npm run ci-check`) — the local substitute for a
  CI workflow. Runs install → lint → typecheck → test → build, in sequence,
  stopping on first failure. Run it manually before opening or updating a PR.

## Interim process

Until GitHub Actions runner availability is restored (billing/plan issue,
outside this repo's control), treat `npm run ci-check` as a required manual
step before pushing, alongside the automatic Vercel check. Once Actions is
working again, `scripts/ci-check.sh`'s steps can be lifted directly into a
`.github/workflows/ci.yml` — the script is written to be workflow-ready.
