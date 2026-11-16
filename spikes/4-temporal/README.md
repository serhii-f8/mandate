# Spike 4 — Temporal workflow versioning

Throwaway code. Question: does a workflow that waits for an approval signal survive a code deployment, and
which versioning mechanism (patched/deprecatePatch vs Worker Versioning) should the project use?

Prerequisites: Docker with Compose v2, Node v22, npm, network access (npm packages, image `temporalio/temporal:1.10.1`).
Host ports used: 4233 (Temporal gRPC), 4288 (Temporal UI). Compose project name: `fde-spike-4`.

Run (starts from clean state, waits for server readiness, runs both check scripts, tears down on exit):

    ./run.sh

Prints one `PASS <name>` / `FAIL <name>` line per assertion; exit code non-zero on any failure.

Files
- `docker-compose.yml` dev server, SQLite file on named volume `temporal-data` (`--db-filename /data/temporal.db`)
- `workflows-v1.ts`, `workflows-v2-unsafe.ts`, `workflows-v2-patched.ts` the three code variants
  (`operationWorkflow`: wait, A, B, C; `gatedWorkflow`: A, wait, B, C, used for the negative control)
- `worker.mjs` one worker process, `VARIANT` env selects the variant (`BUILD_ID` opts into Worker Versioning)
- `check.mjs` patching, nondeterminism, restart and replay assertions
- `check-versioning.mjs` Worker Versioning (PINNED) experiment

Tear down manually (run.sh already does it): `docker compose -p fde-spike-4 down -v`.
The UI is at http://127.0.0.1:4288 while the stack is up (not asserted).
