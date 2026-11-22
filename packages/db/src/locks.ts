// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Every PostgreSQL advisory-lock key this system takes, in one place so no two subsystems collide.
 * The 64-bit keys are ASCII tags read as signed big-endian integers.
 */

/**
 * Schema migrations (ADR 0011): session lock `pg_advisory_lock`, held by the migrating connection
 * for the whole run and released with `pg_advisory_unlock`. Serialises concurrent instance starts.
 * ASCII "mandate-mg".
 */
export const MIGRATION_LOCK_KEY = 0x6169_6f70_732d_6d67n;

/**
 * First key of the two-key transaction lock `pg_advisory_xact_lock(START_LOCK_NAMESPACE,
 * hashtext(requester))` that `startExecution` takes. Serialises execution starts per requester so
 * concurrency limits count exactly. ASCII "aex1" as a 32-bit integer.
 */
export const START_LOCK_NAMESPACE = 0x6165_7831;

/**
 * Audit chain sealing (AUD-3): transaction lock `pg_try_advisory_xact_lock`, taken at the start of
 * each sealing transaction and released by its commit or rollback. Serialises sealers so no chain
 * position is assigned twice; a sealer that finds it held skips the round. Inserts never take it.
 * ASCII "mandate-as".
 */
export const AUDIT_SEAL_LOCK_KEY = 0x6169_6f70_732d_6173n;

/**
 * Audit retention (AUD-7): session lock `pg_try_advisory_lock`, held for one whole retention run
 * (archive files, anchor, delete) and released with `pg_advisory_unlock` in `finally`. Serialises
 * retention runs across instances; a run that finds it held is refused as `locked`.
 * ASCII "mandate-ar".
 */
export const AUDIT_RETENTION_LOCK_KEY = 0x6169_6f70_732d_6172n;

/**
 * Configuration revisions (CFG-4): transaction lock `pg_advisory_xact_lock`, the first statement of
 * every `bootstrap` and `apply` transaction and released by its commit or rollback. Serialises them
 * across instances so two bootstraps insert one row and two applies against one previous hash
 * cannot both win (NFR-3). Nothing else may use it. ASCII "mandate-cf".
 */
export const CONFIG_LOCK_KEY = 0x6169_6f70_732d_6366n;
