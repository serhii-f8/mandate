# Operations

What to watch and what to run on a live installation. For hardening see
[Production hardening](production.md); for backups see [Backup and restore](backup-and-restore.md).

## Health and readiness

Both processes answer two probes.

| Process | Address | Probes |
| --- | --- | --- |
| `api` | the public port (`MANDATE_API_PORT`, default 8400 on the host) | `/healthz`, `/readyz` |
| `worker` | `MANDATE_WORKER_HTTP_PORT` (default 8081, not published) | `/healthz`, `/readyz` |

- `/healthz` means the process is alive and answers `{"ok":true,"version":"..."}`.
- `/readyz` answers 200 when it can do its work and a JSON body that names each dependency. The `api`
  needs the database and an active configuration; it serves while Temporal is down and reports it.
  The `worker` also needs Temporal. A failing dependency gives a non-200 answer.

```bash
curl -fsS "http://localhost:${MANDATE_API_PORT:-8400}/readyz"
docker compose exec -T worker node -e "fetch('http://127.0.0.1:8081/readyz').then((r) => r.text()).then(console.log)"
```

Compose uses `/readyz` as the container health check. Use the same probes in your orchestrator.

## Metrics

Both processes expose Prometheus text on `GET /metrics`: the `api` on `MANDATE_METRICS_PORT` (default 9464),
the `worker` on its HTTP port. Neither is published by the shipped Compose; scrape them from inside the
network. Series include `mandate_tool_calls_total`, `mandate_policy_denials_total`,
`mandate_upstream_requests_total`, `mandate_upstream_request_duration_seconds` and
`mandate_batch_duration_seconds`.

## Traces

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to an OTLP/HTTP collector, for example `http://jaeger:4318`, for the
`api` and the `worker`. Empty or unset turns trace export off. One trace follows a call from the MCP
endpoint through the workflow to the upstream request. For development, Compose has Jaeger behind a
profile:

```bash
docker compose --profile observability up -d --wait
```

The Jaeger UI is on `http://localhost:${MANDATE_JAEGER_PORT:-16686}`. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to
`http://jaeger:4318` in `.env` first.

## Logs

Both processes write one JSON object per line to standard output; `LOG_LEVEL` is `debug`, `info`, `warn`
or `error`. Logs never carry tokens, credentials or sensitive field values. Collect them with your
container log driver:

```bash
docker compose logs --since 10m api worker
```

## Audit

Every call, denial, approval, execution step and configuration change is an audit event. Events form a
hash chain, and nothing updates or deletes them except the retention job.

- **Browse and export.** The audit page, `/app/audit`, searches by actor, action, outcome, change-set,
  correlation ID and time range, and exports the matches as JSON lines. A role needs `view_audit: true`.
  Searching and exporting are themselves audited.
- **Verify the chain.** This recomputes every hash and exits 0 when the chain is intact, 1 when it is not:

  ```bash
  docker compose exec -T api node dist/cli.js audit verify
  ```

  To check one retention archive file, add `--archive <file>`.
- **Retention.** Set `audit.retention_days` in configuration (see the
  [Configuration reference](configuration.md)). The worker then archives older events to
  `MANDATE_AUDIT_ARCHIVE_DIR` and removes them from the table, but only after the archive is written and
  its chain verified; exactly the archived rows are deleted. It refuses, and deletes nothing, with
  `archive_unavailable` when events are due and the archive directory is not set or not writable, and with `chain_invalid`
  when the archive fails verification. To run the job once with the active configuration:

  ```bash
  docker compose exec -T api node dist/cli.js audit retention --now
  ```

  Back up the archive directory; it is the only copy of the archived events.

## Credential rotation

Upstream credentials are stored encrypted under data keys that the master keys protect.

- **Replace one upstream credential** (a token that was revoked or expired): enter the new value on the
  credential page, `/app/credentials`. Entering one needs a recent login (`MANDATE_FRESH_AUTH_SECONDS`).
- **Rotate the master key.** Add a new entry with a higher id to `MANDATE_MASTER_KEYS`, for example
  `1:<old>,2:<new>`, and restart `api` and `worker`. Then re-wrap the data keys under the newest one:

  ```bash
  docker compose exec -T api node dist/cli.js credentials rotate
  ```

  It prints `rewrapped=<n> on_old_versions=<m>` and names any credential it could not open. When
  `on_old_versions` is 0 and the command exits 0, you may remove the old key. Keep the old key until then.
- **Temporal payload keys** (`MANDATE_TEMPORAL_KEYS`): the highest version encrypts, and every earlier
  version stays readable. Add a new version and restart. Remove an old version only when no open workflow
  was started with it.

## Configuration revisions

Configuration is a stored, active revision (see [Roles and approvals](roles-and-approvals.md)). The files
under `MANDATE_CONFIG_DIR` are the source you edit; the revision is what runs.

```bash
docker compose exec -T api node dist/cli.js config diff /etc/mandate/config
docker compose exec -T api node dist/cli.js config apply /etc/mandate/config --actor <your name>
```

Every apply is audited with the actor `cli:<name>`. If the files and the active revision differ, the
processes log `configuration_files_differ`: someone edited files without applying them, or an upgrade
changed what the files compute to (see [Upgrading](upgrading.md)).

## Command reference

Run the commands in the `api` container: `docker compose exec -T api node dist/cli.js <command>`. Exit
code 0 is success, 1 is a failure, an invalid configuration or a denial, and 2 is a usage or
environment error. Errors name the variable at fault, never its value.

| Command | Purpose |
| --- | --- |
| `validate <dir> [--preset-dir <dir>]...` | Full check of a configuration directory, without storing it |
| `test-connection <connection>` | Runs the connection's declared test read |
| `credentials rotate` | Re-wraps credential data keys under the newest master key |
| `audit verify [--archive <file>]` | Checks the audit hash chain, or one archive |
| `audit retention --now` | Runs the audit retention job once |
| `config diff <dir> [--preset-dir <dir>]...` | Compares a directory with the active revision |
| `config apply <dir> [--preset-dir <dir>]... [--actor <name>]` | Stores a directory as the new active revision |
| `config explain --operation <id> (--groups <g1,g2> \| --service <client_id>) [--subject <s>] [--args <json>] [--records <n>]` | Dry policy check against the active revision |
| `mcp tools <connection> [--show <tool>]` | Lists an MCP connection's tools live, with hashes and pin states |

Backup and restore scripts are described in [Backup and restore](backup-and-restore.md).
