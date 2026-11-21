// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { canonicalJson } from '@aiops/core';
import type { LoadedConfiguration } from './load.js';

export type EntityKind = 'connection' | 'operation' | 'role' | 'service_account' | 'notification' | 'preset' | 'disabled' | 'setting';

export interface EntityChange {
  readonly kind: EntityKind;
  readonly id: string;
  readonly change: 'added' | 'removed' | 'changed';
  /** Sorted names of the keys that differ; empty for added and removed entities. */
  readonly keys: readonly string[];
}

export interface ConfigDiff {
  readonly previousHash: string | null;
  readonly hash: string;
  readonly changes: readonly EntityChange[];
}

const KIND_ORDER: readonly EntityKind[] = ['connection', 'operation', 'role', 'service_account', 'notification', 'preset', 'disabled', 'setting'];

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Makes a value encodable by `canonicalJson`: drops `undefined` properties, turns a Map into
 * sorted entries and a Set into a sorted array (canonicalJson throws on all three).
 */
function normalise(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value instanceof Map) {
    const entries = [...(value as Map<unknown, unknown>)].map(([k, v]) => [normalise(k), normalise(v) ?? null] as const);
    return entries.sort((a, b) => byCodeUnit(canonicalJson(a[0]), canonicalJson(b[0])));
  }
  if (value instanceof Set) {
    return [...(value as Set<unknown>)].map((v) => normalise(v) ?? null).sort((a, b) => byCodeUnit(canonicalJson(a), canonicalJson(b)));
  }
  if (Array.isArray(value)) return value.map((v) => normalise(v) ?? null);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const n = normalise(v);
      if (n !== undefined) out[k] = n;
    }
    return out;
  }
  return value;
}

type Fields = ReadonlyMap<string, string>;
type Entities = ReadonlyMap<string, Fields>;

/** Canonical text per key; a key whose value is undefined is absent. */
function fieldsOf(record: object): Fields {
  const fields = new Map<string, string>();
  for (const [key, value] of Object.entries(record)) {
    const normalised = normalise(value);
    if (normalised !== undefined) fields.set(key, canonicalJson(normalised));
  }
  return fields;
}

function entitiesOf(configuration: LoadedConfiguration): ReadonlyMap<EntityKind, Entities> {
  const kinds = new Map<EntityKind, Map<string, Fields>>(KIND_ORDER.map((kind) => [kind, new Map()]));
  const put = (kind: EntityKind, id: string, record: object): void => {
    kinds.get(kind)?.set(id, fieldsOf(record));
  };

  for (const connection of configuration.connections) put('connection', connection.id, connection);
  for (const operation of configuration.policy.operations) {
    put('operation', operation.id, { ...operation, binding: configuration.bindings.get(operation.id) });
  }
  for (const role of configuration.policy.roles) {
    const mapping = configuration.policy.roleMapping.filter((entry) => entry.roles.includes(role.id)).map((entry) => entry.group).sort(byCodeUnit);
    put('role', role.id, {
      ...role,
      limits: configuration.limits.get(role.id),
      approval: configuration.approval.get(role.id),
      notify: configuration.notify.get(role.id),
      manage_credentials: configuration.credentialManagers.get(role.id),
      view_audit: configuration.auditViewers.has(role.id) ? true : undefined,
      mapping: mapping.length > 0 ? mapping : undefined,
    });
  }
  // AUTH-4: keyed by client ID; keys role, description and rateLimitPerMinute.
  for (const [clientId, account] of configuration.serviceAccounts) put('service_account', clientId, account);
  for (const notification of configuration.notifications) put('notification', notification.id, notification);
  // CONN-8: `files` is the digest of the preset's hash inputs, computed by the loader.
  for (const [id, preset] of configuration.loadedPresets) put('preset', id, { package: preset.package, version: preset.version, files: preset.filesDigest });
  for (const disabled of configuration.disabled) put('disabled', disabled.key, disabled);
  put('setting', 'changesets', configuration.changesets);
  put('setting', 'audit', configuration.audit);
  put('setting', 'rate_limits', configuration.rateLimits);
  return kinds;
}

/** Per-entity difference between two configurations (CFG-3); `before` undefined lists everything as added. */
export function diffConfigurations(before: LoadedConfiguration | undefined, after: LoadedConfiguration): ConfigDiff {
  const old = before === undefined ? undefined : entitiesOf(before);
  const next = entitiesOf(after);
  const changes: EntityChange[] = [];
  for (const kind of KIND_ORDER) {
    const oldEntities: Entities = old?.get(kind) ?? new Map();
    const newEntities: Entities = next.get(kind) ?? new Map();
    const ids = [...new Set([...oldEntities.keys(), ...newEntities.keys()])].sort(byCodeUnit);
    for (const id of ids) {
      const o = oldEntities.get(id);
      const n = newEntities.get(id);
      if (o === undefined && n !== undefined) {
        // Settings always exist; with no previous configuration they still count as added.
        changes.push({ kind, id, change: 'added', keys: [] });
      } else if (o !== undefined && n === undefined) {
        changes.push({ kind, id, change: 'removed', keys: [] });
      } else if (o !== undefined && n !== undefined) {
        const keys = [...new Set([...o.keys(), ...n.keys()])].filter((key) => o.get(key) !== n.get(key)).sort(byCodeUnit);
        if (keys.length > 0) changes.push({ kind, id, change: 'changed', keys });
      }
    }
  }
  return { previousHash: before?.hash ?? null, hash: after.hash, changes };
}

/** Output lines of `aiops config diff`. */
export function formatDiff(diff: ConfigDiff): readonly string[] {
  if (diff.previousHash === diff.hash) return ['No changes'];
  const lines = diff.changes.map((c) =>
    c.change === 'added' ? `+ ${c.kind} ${c.id}` : c.change === 'removed' ? `- ${c.kind} ${c.id}` : `~ ${c.kind} ${c.id}: ${c.keys.join(', ')}`,
  );
  lines.push(`hash ${diff.previousHash ?? 'none'} -> ${diff.hash}`);
  return lines;
}

export function diffCounts(diff: ConfigDiff): { readonly added: number; readonly removed: number; readonly changed: number } {
  const count = (change: EntityChange['change']): number => diff.changes.filter((c) => c.change === change).length;
  return { added: count('added'), removed: count('removed'), changed: count('changed') };
}
