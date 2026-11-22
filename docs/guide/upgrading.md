# Upgrading

This page covers moving a running installation to a new release. Take a backup first (see
[Backup and restore](backup-and-restore.md)): migrations only go forward, so a backup is the way back.

## Upgrade steps

From your working copy of the repository:

```bash
git pull
docker compose build
docker compose up -d --wait
```

- `docker compose build` rebuilds the `api` and `worker` images from the new source. If you pin images
  by digest (see [Production hardening](production.md)), change the digests instead of building.
- `docker compose up -d --wait` replaces the containers whose image changed and waits for their
  health checks.
- Database migrations run when the `api` and `worker` start, and they take a lock, so starting several
  instances at once is safe. You run nothing by hand.

Then check the version and readiness:

```bash
curl -fsS "http://localhost:${MANDATE_API_PORT:-8400}/healthz"
curl -fsS "http://localhost:${MANDATE_API_PORT:-8400}/readyz"
```

`/healthz` answers with the product `version`. `/readyz` answers 200 when the database is reachable
and a configuration is active.

## Re-run `config apply`

After every upgrade, re-run `config apply` on your configuration directory:

```bash
docker compose exec -T api node dist/cli.js config diff /etc/mandate/config
docker compose exec -T api node dist/cli.js config apply /etc/mandate/config --actor upgrade
```

The active configuration revision is stored in PostgreSQL together with a hash that covers the files
and the preset code. A release can change that hash without any change to your files, for example when
a preset's code changes. Until you apply again, the stored revision no longer matches what the release
computes, and the platform refuses it with `configuration_mismatch` rather than run something
different from what an operator reviewed. `config diff` shows what changes; `config apply` stores a
new revision. Running workflows and change-sets already prepared are not affected.

A release may also tighten what the loader accepts. If `config diff` or `config apply` reports an
error after an upgrade, fix the named key and run them again. The notes of each release list such
changes (see the [CHANGELOG](../../CHANGELOG.md)).

## Running change-sets survive an upgrade

Change-sets execute as Temporal workflows, and one can wait days for an approval. Replacing the `worker`
does not lose them: Temporal keeps the history and the new worker replays it. The release process
guarantees this with workflow patching: every change to the steps of a deployed workflow type sits
behind a patch marker, and CI replays committed histories of old executions against the new code. See
[Versioning](versioning.md).

Two rules for you:

- Never send a signal or terminate a workflow from the Temporal CLI or UI. Payloads are encrypted, and
  plaintext input makes the workflow impossible to replay.
- Keep `MANDATE_TEMPORAL_KEYS` and `MANDATE_MASTER_KEYS` the same across the upgrade, and never remove a
  key that open workflows or stored credentials still use.

## Upgrading to 1.3.0

1.3.0 is additive: the configuration schema and the connector SDK are 1.3.0, and a configuration that
loaded before still loads, unless an operation's ID or tool name is `create_plan`: that is now the name
of a built-in tool, so rename the operation. A change-set whose operation declares no
`verify_after` runs exactly as before.

Upgrade every `worker` and `api` instance before you add `verify_after` to an operation. A 1.2
process does not know the key or the verification stage, so a configuration that uses it must not
reach one. With the single-host Compose setup, `docker compose up -d --wait` replaces both
containers together and there is nothing more to do.

A preset of your own that uses `verify_after` in a manifest declares `"sdk": "^1.3.0"` in its
`package.json` (`mandate.sdk`), which an older platform refuses with `preset_sdk_incompatible`. The
template preset does so, and shows the stage on `notes.update_title`.

The migration `0016_verification` adds nullable (or defaulted) columns to `change_item` and
`change_set` that record how far a verification got, and runs on start, as every migration does.
Change-sets that are already running or finished are not affected.

## Upgrading to 1.2.0

Upgrade every `api` and `worker` instance before anyone prepares a new change-set. From 1.2.0 on, a
change-set records the version of its hash format, and new change-sets use version 2. Change-sets
prepared before the upgrade keep version 1 and verify, execute and roll back as before. A 1.1
process that is still running cannot compute a version 2 hash: it refuses such a change-set as
`hash_mismatch` when it checks the hash before execution or rollback, so the change-set fails
instead of running. A 1.1 `api` can still derive a new change-set from a version 2 one: it produces a
version 1 copy without an action, which runs as before for an update, and which the 1.2.0 execution
guard refuses for a create or delete operation. With the single-host Compose setup,
`docker compose up -d --wait` replaces both containers together and there is nothing more to do.

A preset of your own that uses `records_arg`, `action`, `checks` or `lookups` declares
`"sdk": "^1.2.0"` in its `package.json` (`mandate.sdk`), which an older platform refuses with
`preset_sdk_incompatible`. The template preset does so.

The migration `0015_change_set_hash_version` adds two columns to `change_set` with defaults and runs
on start, as every migration does.

## Upgrading to 1.1.0

1.1.0 is additive, with one step for most installations. The image ships the Magento preset 1.1.0
only. If your configuration pins it exactly, as the 1.0.0 `deploy/config/connections.yaml`, the preset
README and [Connecting Magento](connecting-magento.md) showed:

```yaml
  - { id: magento-catalog, package: '@mandate/magento2-catalog', version: '1.0.0' }
```

the pin no longer resolves and `config diff` and `config apply` fail. Change it before you apply, to
the exact new version or to a range that follows 1.x:

```yaml
  - { id: magento-catalog, package: '@mandate/magento2-catalog', version: '1.1.0' }
```

Without `preset_params` the 1.1.0 preset loads the same operations as 1.0.0. A preset of your own
keeps loading with `mandate.sdk: ^1.0.0`; if you add `params` to it, declare `^1.1.0`, which a 1.0.x
platform refuses with `preset_sdk_incompatible` (see [Presets](presets.md#parameters)). The rest of
the notes are in the [CHANGELOG](../../CHANGELOG.md).

## Upgrading to 1.0.0

The 1.0.0 notes (changes in what the loader accepts, the SDK range, and credential entry) are in the
[CHANGELOG](../../CHANGELOG.md). Read them before you upgrade from a release before 1.0.

## Roll back

There is no downgrade of the database. To go back to an earlier release, restore the backup you took
before the upgrade together with that release's images (see [Backup and restore](backup-and-restore.md)).

## Background

- [ADR 0069](../decisions/0069-change-set-hash-version.md): why a change-set records the version of
  its hash format, and how version 1 change-sets keep verifying.
