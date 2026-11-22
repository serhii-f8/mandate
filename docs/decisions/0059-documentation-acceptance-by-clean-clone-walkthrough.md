# ADR 0059: Acceptance of the public guide by clean-clone walkthroughs

- Status: Accepted
- Date: 2026-11-21

## Context

The Phase 10 acceptance criterion (SPEC section 7) names a newcomer with only the public
documentation who installs the system, attaches a Magento sandbox, configures one role and completes
an approved bulk update. The scripted clean-room dry run alone does not meet it
([ADR 0053](0053-release-readiness.md) decision 13), and no newcomer run had been recorded. [ADR 0041](0041-widget-acceptance-on-local-reference-host.md) set
the same kind of precedent for the Phase 7 client checks.

## Options considered

1. Leave the criterion open until a newcomer run records the four results.
2. Count clean-clone walkthroughs as the acceptance. Each walkthrough starts with no knowledge of the
   repository, works in a clean clone and reads only `README.md`, `docs/guide/`, `examples/` and
   files the guide names, in rendered form (HTML comments ignored). It follows the four pages, times
   each milestone and reports every unclear place. Every finding is fixed and the walkthrough is
   repeated until one run passes with no blocking finding. The scripted clean-room dry run
   (`scripts/acceptance/phase-10.sh`), whose doc-test runner executes the guide's command blocks,
   must pass on the final commit as well.
3. Drop the criterion.

## Decision

Option 2. The guide is accepted by clean-clone walkthroughs that follow only the rendered public
guide, plus the doc-test runner that executes the guide's command blocks. SPEC section 7, Phase 10
acceptance, names the walkthrough as the way the criterion is met, and says that a further run
remains welcome, recorded under the same checks.

## Consequences

- A walkthrough that reads carefully and types exactly misses the confusion a hurried reader has.
  The walkthroughs used the terminal path; the trusted pages were checked separately in headless
  Chromium, which proves they work but not that a person finds them clear. A person's look at the
  pages stays an optional check.
- The sandbox and the pnpm store were warm in these runs, so the times are lower bounds for a first
  install.

## Verified

- Walkthrough 1: all four milestones passed. It found six problems, all fixed, most importantly the
  terminal commands of the browser steps being hidden in HTML comments; a doc lint test now rejects
  hidden commands.
- Walkthrough 2, reading the rendered pages only: all four milestones passed, with no blocker. It
  found rollback available only through the browser, plus minor polish. Both are fixed; the terminal
  rollback is a doc-test section run by `phase-10.sh` (`docs-rollback`).
- Walkthrough 3: all four milestones and the rollback passed, with no blocker and no lookup outside
  the public files. Its polish findings (Node version, install size, port note, rollback check) are
  fixed.
- Dry run on the final commit: `bash scripts/acceptance/phase-10.sh` -> `# RESULT: PASS`, 10 checks
  including `docs-rollback`.
- Trusted pages in headless Chromium (Playwright 1.65.1) on the guide's stack, 2026-11-21:
  credential page as carol, approval queue and change-set page as dave, **Approve 3 changes** ->
  `executing`, **Roll back 3 items** as alice -> `rolled_back` with `restored: 3`, audit page as
  carol; no console error and no HTTP error after login. Two findings: the guide said the rollback
  is confirmed, but the button acts at once (the wording is fixed); the requester and actors show as
  Keycloak subject IDs, not names (a known gap).
