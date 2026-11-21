# Backup and restore

This page backs up an installation with one script and restores it with another. The last part
runs a full cycle on the walkthrough stack: a change-set waits for approval, the stack is backed up
and wiped, and after the restore the change-set is approved and completes.

## What to back up

| What | Where | Taken by |
| --- | --- | --- |
| `aiops` database: configuration revisions, change-sets, approvals, the audit trail, encrypted upstream credentials | PostgreSQL | `backup.sh` |
| `temporal` and `temporal_visibility` databases: the running workflows, for example a change-set waiting for approval | PostgreSQL | `backup.sh` |
| `keycloak` database: realm, users, groups, clients and their secrets, signing keys | PostgreSQL | `backup.sh` |
| Audit archive volume (`audit-archive`): the files audit retention writes before it deletes old rows | Docker volume | `backup.sh` |
| `.env`: `AIOPS_MASTER_KEYS`, `AIOPS_TEMPORAL_KEYS`, `AIOPS_WEB_CLIENT_SECRET`, the database and Keycloak admin passwords | the repository root | you, in your secret store |
| Your configuration directory (for example `my-config/`) | the repository root | you, in version control |

The scripts never copy `.env`. Keep its secrets in your secret store, apart from the backups: the
credentials in the `aiops` database are encrypted with `AIOPS_MASTER_KEYS`, and the workflow data in
Temporal with `AIOPS_TEMPORAL_KEYS`. A backup restored without the same keys starts, but cannot
decrypt either. The configuration files only seed an empty database; the active revision is in the
`aiops` database and comes back with it.

The backup itself holds personal data, password hashes and encrypted credentials. The script
creates its directory readable by your user only; store and transfer it like the database.

## Back up

Run the script from the repository root while the stack is up. It writes to
`backups/<UTC timestamp>/` (git-ignored), or to the directory you name, which must be empty or not
exist yet, and prints that directory as its last line.

```bash
bash deploy/backup/backup.sh
```

The script:

1. stops `api` and `worker`;
2. reads the audit chain head with `audit verify`;
3. dumps the four databases with `pg_dump -Fc` inside the `postgres` service;
4. packs the audit archive volume into `audit-archive.tar`;
5. writes `manifest.json` with the size and SHA-256 sum of every file, the audit head and the `api`
   and `worker` images;
6. starts `api` and `worker` again and waits until they are healthy.

If a step fails, it starts `api` and `worker` again before it exits.

Every Docker call goes through `docker compose` in the repository root, so `COMPOSE_PROJECT_NAME`,
`COMPOSE_FILE` and `.env` apply as for your other commands.

### Consistency

While `api` and `worker` are stopped nothing writes to the `aiops` database: no MCP calls are
served, no change-set moves and no audit row is written or sealed. That is what makes the audit head
in the manifest exact. The stop lasts as long as the dumps, seconds for a small installation. MCP
clients get errors meanwhile; a batch the worker was writing is retried by Temporal after
the start, as after any worker restart.

Temporal, Keycloak and PostgreSQL keep running. Each database is dumped as one consistent snapshot;
with `api` and `worker` stopped, no new workflow starts and no running one makes progress, so the
Temporal databases match the `aiops` database.

Run the script from a scheduler (cron, a systemd timer) and copy the directory off the machine. Keep
as many generations as your recovery policy needs; the script does not delete old backups.

## Restore

Restore into an installation whose `.env` holds the keys of the backed-up one. On a new machine:
clone the repository at the same version, put the `.env` back, copy the backup directory, then:

```bash
docker compose up -d --wait postgres
bash deploy/backup/restore.sh backups/<timestamp>
```

The script:

1. checks the SHA-256 sum of every file against the manifest, before it touches anything;
2. starts `postgres`;
3. refuses with `refusing: database not empty` (exit 1) when the `aiops` database already has audit
   rows, so it never overwrites a live installation by mistake;
4. stops `api`, `worker`, Temporal, Keycloak and their setup jobs;
5. restores each database with `pg_restore --clean --if-exists` in one transaction, its objects owned
   by the database's own role;
6. replaces the contents of the audit archive volume;
7. compares the audit head with the manifest, before `api` and `worker` start, and prints
   `audit head matches: <head>`;
8. starts the whole stack with `--wait` and runs `audit verify` once more.

On a checksum mismatch it stops before step 2. On a head mismatch it exits 1 and leaves the stack
stopped: the restored data is not the data that was backed up, and nothing should run on it.

To replace an installation that has data on purpose, for example to roll a test system back to last
night's state, add `--force`.

## Verify

The restore verifies the audit chain itself: `audit head matches` means every sealed audit row is
back and the hash chain from the newest retention anchor up to the recorded head is intact. Check
the rest as you would after any start:

- `curl -fsS "http://localhost:${AIOPS_API_PORT:-8400}/readyz"` answers 200;
- the connection test on the credential page reports `ok`: the restored credential decrypts with
  your `AIOPS_MASTER_KEYS`;
- the approval queue shows the change-sets that were waiting at backup time; approving one starts its
  writes.

## Retention archives

When `audit.retention_days` is set, the worker moves sealed audit rows older than that into files on
the audit archive volume (`audit-<first>-<last>.jsonl` with a manifest) and deletes them from the
database. Those files are then the only copy of the deleted rows, which is why the backup includes
the volume. After a restore, check an archive against its manifest and its anchor:

```bash
docker compose exec -T api ls /var/lib/aiops/audit-archive
docker compose exec -T api node dist/cli.js audit verify --archive /var/lib/aiops/audit-archive/<file>.jsonl
```

It answers `ok archive count=<n> first=<a> last=<b>`.

## Try a full cycle

This part wipes the stack. Run it only on the walkthrough installation of the previous pages, never
on one with data you need. It reuses the variables of [Your first bulk update](first-bulk-update.md);
run it in the same terminal.

Log in as alice again, because access tokens live five minutes, and leave a change-set waiting for
approval: new keywords for every acme product, with a second value so the products differ from what
the first bulk update wrote.

<!-- doc-test: backup -->
```bash
export DEV_PASSWORD=dev-only-password
ALICE_TOKEN="$(node tooling/acceptance/login.mjs "http://localhost:${AIOPS_KEYCLOAK_PORT:-8480}" alice "$DEV_PASSWORD" "http://localhost:${AIOPS_API_PORT:-8400}/mcp")"
export BACKUP_KEYWORD="guide backup $(date -u +%Y%m%dT%H%M%SZ)"
PREPARED="$(AIOPS_MCP_TOKEN="$ALICE_TOKEN" node tooling/acceptance/mcp-call.mjs "http://localhost:${AIOPS_API_PORT:-8400}/mcp" --tool catalog.update_content --args "{\"brand\":\"acme\",\"name_like\":\"%\",\"changes\":{\"meta_keyword\":\"$BACKUP_KEYWORD\"}}")"
export PENDING_ID="$(node -p 'const r = JSON.parse(process.argv[1]).structuredContent; r.changeset?.id ?? r.changesetId' "$PREPARED")"
for i in $(seq 1 60); do
  CHANGESET="$(AIOPS_MCP_TOKEN="$ALICE_TOKEN" node tooling/acceptance/mcp-call.mjs "http://localhost:${AIOPS_API_PORT:-8400}/mcp" --tool get_changeset --args "{\"changeset_id\":\"$PENDING_ID\"}")"
  STATUS="$(node -p 'JSON.parse(process.argv[1]).structuredContent.changeset.status' "$CHANGESET")"
  test "$STATUS" != preparing && break
  sleep 2
done
test "$STATUS" = prepared || { echo "change-set $PENDING_ID is $STATUS, not prepared" >&2; false; }
export PENDING_HASH="$(node -p 'JSON.parse(process.argv[1]).structuredContent.changeset.hash' "$CHANGESET")"
SUBMITTED="$(AIOPS_MCP_TOKEN="$ALICE_TOKEN" node tooling/acceptance/mcp-call.mjs "http://localhost:${AIOPS_API_PORT:-8400}/mcp" --tool submit_for_approval --args "{\"changeset_id\":\"$PENDING_ID\",\"hash\":\"$PENDING_HASH\"}")"
test "$(node -p 'JSON.parse(process.argv[1]).structuredContent.status' "$SUBMITTED")" = pending_approval
```

Back up, then remove the containers and their volumes, as if the machine had been lost. The
sandbox shop is a separate Compose project and stays.

<!-- doc-test: backup -->
```bash
export BACKUP_DIR="$(bash deploy/backup/backup.sh | tail -1)"
cat "$BACKUP_DIR/manifest.json"
docker compose down -v
```

Start PostgreSQL alone and restore. The last lines are `audit head matches: <head>` and
`restore: done, audit ok ...`.

<!-- doc-test: backup -->
```bash
docker compose up -d --wait postgres
bash deploy/backup/restore.sh "$BACKUP_DIR"
```

The first change-set is still `completed`:

<!-- doc-test: backup -->
```bash
ALICE_TOKEN="$(node tooling/acceptance/login.mjs "http://localhost:${AIOPS_KEYCLOAK_PORT:-8480}" alice "$DEV_PASSWORD" "http://localhost:${AIOPS_API_PORT:-8400}/mcp")"
FIRST="$(AIOPS_MCP_TOKEN="$ALICE_TOKEN" node tooling/acceptance/mcp-call.mjs "http://localhost:${AIOPS_API_PORT:-8400}/mcp" --tool get_changeset --args "{\"changeset_id\":\"$CHANGESET_ID\"}")"
node -p 'JSON.parse(process.argv[1]).structuredContent.changeset.status' "$FIRST"
test "$(node -p 'JSON.parse(process.argv[1]).structuredContent.changeset.status' "$FIRST")" = completed
```

Approve the waiting change-set as dave, as on the previous page: open
`http://localhost:8400/app/approvals`, log in as `dave`, open the change-set and choose **Approve**.
Its workflow was restored with the Temporal databases and continues from where it waited.

<!-- doc-test-alt: backup
DAVE_COOKIE="$(node tooling/acceptance/page-login.mjs "http://localhost:${AIOPS_API_PORT:-8400}" dave "$DEV_PASSWORD" "/app/changesets/$PENDING_ID")"
VIEW="$(AIOPS_PAGE_COOKIE="$DAVE_COOKIE" node tooling/acceptance/page-api.mjs "http://localhost:${AIOPS_API_PORT:-8400}" changeset "$PENDING_ID")"
test "$(node -p 'JSON.parse(process.argv[1]).body.hash' "$VIEW")" = "$PENDING_HASH"
DECIDED="$(AIOPS_PAGE_COOKIE="$DAVE_COOKIE" node tooling/acceptance/page-api.mjs "http://localhost:${AIOPS_API_PORT:-8400}" decide "$PENDING_ID" approve "$PENDING_HASH" "$(node -p 'JSON.parse(process.argv[1]).body.stats.included' "$VIEW")")"
echo "$DECIDED"
test "$(node -p 'JSON.parse(process.argv[1]).status' "$DECIDED")" = 200
-->

Follow it to the end:

<!-- doc-test: backup -->
```bash
ALICE_TOKEN="$(node tooling/acceptance/login.mjs "http://localhost:${AIOPS_KEYCLOAK_PORT:-8480}" alice "$DEV_PASSWORD" "http://localhost:${AIOPS_API_PORT:-8400}/mcp")"
for i in $(seq 1 120); do
  CHANGESET="$(AIOPS_MCP_TOKEN="$ALICE_TOKEN" node tooling/acceptance/mcp-call.mjs "http://localhost:${AIOPS_API_PORT:-8400}/mcp" --tool get_changeset --args "{\"changeset_id\":\"$PENDING_ID\"}")"
  STATUS="$(node -p 'JSON.parse(process.argv[1]).structuredContent.changeset.status' "$CHANGESET")"
  case "$STATUS" in completed|completed_with_errors|failed|cancelled|expired|rolled_back) break ;; esac
  sleep 2
done
echo "$STATUS"
test "$STATUS" = completed || { echo "change-set $PENDING_ID ended the wait with status $STATUS, not completed" >&2; false; }
```

Finally, run the connection test on the credential page as carol (`http://localhost:8400/app/credentials`,
connection `magento`). It reports `ok`: the restored credential decrypts.

<!-- doc-test-alt: backup
CAROL_COOKIE="$(node tooling/acceptance/page-login.mjs "http://localhost:${AIOPS_API_PORT:-8400}" carol "$DEV_PASSWORD" /app/credentials)"
REPORT="$(AIOPS_PAGE_COOKIE="$CAROL_COOKIE" node tooling/acceptance/page-api.mjs "http://localhost:${AIOPS_API_PORT:-8400}" test magento)"
echo "$REPORT"
test "$(node -p 'JSON.parse(process.argv[1]).body.ok' "$REPORT")" = true
-->

### Background

- [ADR 0012](../decisions/0012-compose-topology.md): the Compose topology, with one PostgreSQL role
  and database per component.

## Next

[Upgrading](upgrading.md) and [Production hardening](production.md).
