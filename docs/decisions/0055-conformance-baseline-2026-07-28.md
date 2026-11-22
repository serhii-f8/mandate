# ADR 0055: Conformance baseline for 2026-07-28: per-check entries in must-pass scenarios

- Status: Accepted
- Date: 2026-11-20

Refs: NFR-16, MCP-1

## Context

The api e2e project runs the official MCP conformance suite (`@modelcontextprotocol/conformance`
pinned to `0.2.0-alpha.12`) with `--requirements 2026-07-28` and a reviewed baseline
([ADR 0053](0053-release-readiness.md) decision 8). A minimum set of scenarios has to pass "in full"
(`server-stateless`, `tools-list`, `caching`, `dns-rebinding-protection`,
`sep-2164-resource-not-found`, `resources-list`). The baseline test at first refused any entry,
wholesale or per check, whose scenario is in that set.

The first run with an empty baseline (`server: []`) failed 30 of the 37 scored scenarios. All
failures need a capability the platform does not offer: the suite's fixture tools
(`test_simple_text`, `test_image_content`, ...), fixture resources (`test://static-text`, ...),
prompts, completion, and the input-required round trips (elicitation, sampling, roots). No failure
exercised implemented behaviour: stateless discovery, the caching hints on `tools/list`,
`resources/list`, `resources/templates/list` and `resources/read`, resource-not-found (-32602,
[ADR 0036](0036-change-set-exclusion-export-and-widget-details.md)), the host and origin checks and every `wire-schema-valid` check passed.

Two must-pass scenarios still contain checks that cannot pass without such a capability:

- `caching` calls `prompts/list` unconditionally (check `sep-2549-prompts-list-caching-hints`;
  source `Hi.run` in the package's `dist/index.js`), and the server answers -32601 because prompts
  are out of scope (SPEC section 8).
- `server-stateless` has four checks that report "Not testable" as FAILURE unless the server lists
  the diagnostic tools `test_missing_capability`, `test_streaming_elicitation` and
  `test_logging_tool`.

## Options considered

1. **Drop `caching` and `server-stateless` from the must-pass set and baseline the five checks.**
   The CLI still enforces their other checks, but the e2e test no longer proves the two scenarios
   ran at all.
2. **Offer the missing capabilities** (an empty `prompts/list`, the diagnostic tools). Rejected:
   prompts are out of scope, and test-only tools on the production endpoint would widen the
   authorised surface (SEC-1).
3. **Keep both scenarios must-pass and allow single-check entries for them.** The baseline test
   refuses a must-pass scenario baselined as a whole and an entry without a reason; a single
   check of a must-pass scenario may be excused with a reason. The e2e test treats a must-pass
   scenario as passed when it ran, reported at least one check and no check failed except one the
   baseline names as `<scenario>:<check-id>`.

## Decision

Option 3. The 2026-07-28 baseline lists 5 per-check entries (4 in `server-stateless`, 1 in
`caching`) and 28 whole-scenario entries, each with its reason as a trailing comment. The must-pass
set adds `server-sse-multiple-streams` (concurrent POST requests, which the stateless endpoint
implements). The `not_scored` scenarios of the requirement set (tasks extension, pending scenarios)
run and are reported but the CLI does not judge them against the baseline, so they are not listed;
the e2e summary counts them apart from the scored ones and names the failing ones.

### not_scored failures, classified

The api offers the Tasks extension (MCP-7, [ADR 0029](0029-mcp-tasks-rulings.md)), so each failing `tasks-*` check
was read in `dist/index.js` and judged: implemented behaviour failing would be a defect. None is:

- Every failing check needs a suite fixture tool the platform does not offer: `slow_compute`,
  `greet`, `failing_job`, `protocol_error_job`, `confirm_delete`, `multi_input`,
  `test_tool_with_task`; the rest are "Not testable" follow-ons of a task such a tool would have
  created (`tasks-get-status-working/-completed`, `tasks-no-early-ttl-expiry`,
  `server-rejects-mismatched-mcp-name-on-tasks-get`).
- `tasks-required-task-error` expects -32021 from `tools/call` of `failing_job`, a fixture tool
  with `TaskSupport=required`. The api has no such tool: a client without the extension gets the
  bounded-wait answer instead ([ADR 0003](0003-mcp-sdk-and-transport.md)); the -32602 it sees is the unknown-tool answer.
  `tasks/get|update|cancel` without the declaration do answer -32021 (`task-handlers.test.ts`).
- The checks that exercise the api without fixtures pass: `tasks-extension-advertised`,
  `sep-2663-tasks-methods-non-declaring`, `sep-2663-tasks-result-removed-method-not-found`,
  `tasks-removed-tasks-list`, `sep-2663-tasks-get-invalid-task-id-32602`,
  `tasks-headers-reject-mismatched-method`, and every `wire-schema-valid`. The task lifecycle
  itself is proved by `apps/api/test/e2e/tasks.e2e.test.ts` (MCP-7).
- `tasks-status-notifications` is skipped by the suite itself.
- `json-schema-2020-12` needs fixture tool `json_schema_2020_12_tool`;
  `http-custom-header-server-validation` needs a tool with `x-mcp-header` annotations, which no
  operation declares. `http-header-validation` passes.

## Consequences

- A pin bump that adds a check to a must-pass scenario fails the run unless someone adds a
  reasoned per-check entry, which the review sees in the baseline diff.
- "In full" for the must-pass set reads "apart from single checks the baseline excuses".
- No api change was needed for the 2026-07-28 set.

## Verified

- Package `@modelcontextprotocol/conformance@0.2.0-alpha.12`, `README.md` sections "Expected
  Failures" and "Baselining a single check"; `requirements/2026-07-28.yaml`.
- `dist/index.js`: `ol()` judges FAILURE and WARNING per check for per-check entries and reports a
  passing baselined check as stale; with `--requirements` only the `server` list is judged.
- Experiment, 2026-11-20: `cd apps/api && pnpm exec vitest run --project e2e
  test/e2e/conformance.e2e.test.ts` with `server: []` -> exit 1, "Total: 108 passed, 64 failed",
  30 unexpected scenarios; with the reviewed baseline -> pass, summary
  `50 scenarios, 108 success, 64 failure, 2 warning, 3 skipped, 1 info` (failures include the
  unjudged `not_scored` scenarios). With scored and not_scored counted apart:
  `scored: 77 success, 31 failure, 2 warning, 2 skipped, 1 info; not_scored: 31 success,
  33 failure, 0 warning, 1 skipped, 0 info`.
