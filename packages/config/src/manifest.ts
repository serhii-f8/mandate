// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The operation manifest (design phase 4 §3.1; OPS-2, OPS-3, OPS-4): its YAML schema,
 * conversion to the core `ManifestDefinition`, and the loader checks 1–7 that need
 * the registry (enabled read operations and their final input schemas).
 */
import type { ManifestDefinition, ManifestRead, ManifestTemplate, RollbackStrategy } from '@mandate/core';
import { z } from 'zod';
import type { At, RegisteredOperation } from './registry.js';
import { propertiesOf, requiredOf } from './registry.js';
import { isMcpUpstream } from './mcp.js';
import { operationId } from './upstream-schema.js';

const name = z.string().min(1).max(128);
const literal = z.union([z.string().max(4000), z.number(), z.boolean()]);
/** Template values as in `upstream`, without `join`: core `ManifestTemplate` has none. */
const template = z.union([literal, z.strictObject({ arg: name, default: literal.optional() })]);
const templateMap = z.record(z.string().min(1).max(256), template).default({});

const rollback = z.discriminatedUnion('strategy', [
  z.strictObject({ strategy: z.literal('replay_previous_state') }),
  z.strictObject({ strategy: z.literal('none') }),
  z.strictObject({ strategy: z.literal('inverse_operation'), operation: operationId }),
]);

export const manifestSchema = z.strictObject({
  /** What the call does to its targets (OPS-2, ADR 0071); a fixed node in presets. */
  action: z.enum(['update', 'create', 'delete']).default('update'),
  id_field: name,
  ids_arg: name.optional(),
  /** The alternative to `records_arg`: one values object for every target (CS-2). */
  values_arg: name.optional(),
  /** The alternative to `values_arg`: an array of records, each with its own values (CS-2, ADR 0070). */
  records_arg: name.optional(),
  fields: z.array(name).min(1),
  required_fields: z.array(name).default([]),
  /** AUD-4: fields whose values the audit trail redacts; each must be one of fields. */
  sensitive_fields: z.array(name).default([]),
  scope_args: z.record(name, name).default({}),
  read_before: z.strictObject({ operation: operationId, ids_arg: name, args: templateMap }),
  selector: z
    .strictObject({
      operation: operationId,
      args: templateMap,
      page_arg: name,
      page_size_arg: name,
      page_size: z.number().int().min(1).max(1000).default(100),
    })
    .optional(),
  /** Write-time options (OPS-6): record fields the write carries over from the read-before value. */
  write: z.strictObject({ carry_fields: z.array(name).min(1) }).optional(),
  batch_size: z.number().int().min(1).max(1000).default(100),
  max_targets: z.number().int().min(1).max(100_000).default(10_000),
  /** Required: choosing a strategy is a deliberate act (OPS-3). */
  rollback,
});

export type ManifestConfig = z.output<typeof manifestSchema>;
type TemplateConfig = z.output<typeof template>;

/** EXE-5: share of failed items above which execution stops. */
export const DEFAULT_FAILURE_THRESHOLD = 0.5;
/** EXE-9: items one workflow run handles before continuing as new. */
export const DEFAULT_ITEMS_PER_WORKFLOW_RUN = 2000;

/** EXE-8: hours after execution during which a change-set can be rolled back; 0 disables rollback. */
export const DEFAULT_ROLLBACK_WINDOW_HOURS = 168;

export const changesetsSchema = z.strictObject({
  expire_after_hours: z.number().min(1 / 60).max(2160).default(72),
  failure_threshold: z.number().gt(0).max(1).default(DEFAULT_FAILURE_THRESHOLD),
  items_per_workflow_run: z.number().int().min(100).max(1_000_000).default(DEFAULT_ITEMS_PER_WORKFLOW_RUN),
  rollback_window_hours: z.number().min(0).max(2160).default(DEFAULT_ROLLBACK_WINDOW_HOURS),
});

export const DEFAULT_EXPIRE_AFTER_HOURS = 72;

function toTemplates(args: Readonly<Record<string, TemplateConfig>>): Record<string, ManifestTemplate> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]): [string, ManifestTemplate] => [
      key,
      typeof value === 'object' ? { arg: value.arg, ...(value.default === undefined ? {} : { default: value.default }) } : value,
    ]),
  );
}

export function toManifestDefinition(m: ManifestConfig): ManifestDefinition {
  const readBefore: ManifestRead & { idsArg: string } = { operation: m.read_before.operation, idsArg: m.read_before.ids_arg, args: toTemplates(m.read_before.args) };
  const strategy: RollbackStrategy = m.rollback.strategy === 'inverse_operation' ? { strategy: 'inverse_operation', operation: m.rollback.operation } : { strategy: m.rollback.strategy };
  return {
    ...(m.action === 'update' ? {} : { action: m.action }),
    idField: m.id_field,
    ...(m.ids_arg === undefined ? {} : { idsArg: m.ids_arg }),
    ...(m.values_arg === undefined ? {} : { valuesArg: m.values_arg }),
    ...(m.records_arg === undefined ? {} : { recordsArg: m.records_arg }),
    fields: [...m.fields],
    requiredFields: [...m.required_fields],
    scopeArgs: { ...m.scope_args },
    readBefore,
    ...(m.selector === undefined
      ? {}
      : {
          selector: {
            operation: m.selector.operation,
            args: toTemplates(m.selector.args),
            pageArg: m.selector.page_arg,
            pageSizeArg: m.selector.page_size_arg,
            pageSize: m.selector.page_size,
          },
        }),
    ...(m.write === undefined ? {} : { write: { carryFields: [...m.write.carry_fields] } }),
    batchSize: m.batch_size,
    maxTargets: m.max_targets,
    rollback: strategy,
  };
}

function propertySchema(schema: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> | undefined {
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null) return undefined;
  const value: unknown = (properties as Record<string, unknown>)[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** The `items.enum` of the read operation's field-list argument, when it declares one (check 6). */
function fieldEnum(read: RegisteredOperation): ReadonlySet<unknown> | undefined {
  const fieldsArg = read.definition.fieldsArg;
  if (fieldsArg === undefined) return undefined;
  const property = propertySchema(read.definition.inputSchema, fieldsArg);
  if (property?.type !== 'array') return undefined;
  const items = property.items;
  if (typeof items !== 'object' || items === null) return undefined;
  const values: unknown = (items as Record<string, unknown>).enum;
  return Array.isArray(values) ? new Set(values) : undefined;
}

/**
 * Check 3 for `records_arg` (ADR 0070): a required top-level array whose items are closed objects
 * (`properties` within `id_field` and `fields`, `additionalProperties: false`) that require
 * `id_field`, typed string or integer. Messages never quote configuration values.
 */
function checkRecordsSchema(schema: Readonly<Record<string, unknown>>, manifest: ManifestConfig): string | undefined {
  const recordsArg = manifest.records_arg;
  if (recordsArg === undefined) return undefined;
  const records = propertySchema(schema, recordsArg);
  if (records?.type !== 'array') return 'must name a top-level array property of input_schema';
  if (!requiredOf(schema).has(recordsArg)) return 'must name a required property of input_schema';
  const items = records.items;
  const item = typeof items === 'object' && items !== null ? (items as Record<string, unknown>) : undefined;
  const declared = item?.properties;
  if (item?.type !== 'object' || typeof declared !== 'object' || declared === null || item.additionalProperties !== false) {
    return 'must declare items as objects with properties and additionalProperties: false in input_schema';
  }
  const allowed = new Set([manifest.id_field, ...manifest.fields]);
  if (Object.keys(declared).some((k) => !allowed.has(k))) return 'declares item properties that are not id_field or in fields';
  if (!requiredOf(item).has(manifest.id_field)) return 'must require the id_field in the items of input_schema';
  const idType = (declared as Record<string, unknown>)[manifest.id_field];
  const type = typeof idType === 'object' && idType !== null ? (idType as Record<string, unknown>).type : undefined;
  if (type !== 'string' && type !== 'integer') return 'must type the id_field of the items as string or integer in input_schema';
  return undefined;
}

function inverseMessage(wanted: 'create' | 'delete'): string {
  return wanted === 'delete'
    ? 'must name an enabled delete operation of the same connection with the same id_field'
    : 'must name an enabled create operation of the same connection whose manifest lists every field of this one';
}

export interface ManifestCheckInput {
  readonly all: ReadonlyMap<string, RegisteredOperation>;
  /** A bound preset failed to load, so an unknown operation ID may be one of its operations. */
  readonly operationsIncomplete: boolean;
  readonly at: At;
}

/**
 * Loader checks 1–7 of design §3.1. Check 1 (presence by risk class) applies to every
 * operation; the cross-checks apply to enabled operations only.
 */
export function checkManifests(input: ManifestCheckInput): void {
  const { all, at } = input;
  for (const op of all.values()) {
    const { value, source, path } = op.located;
    // An MCP-backed operation carries no manifest; the registry already refused one (ADR 0050 decision 7).
    if (isMcpUpstream(value.upstream)) continue;
    const manifest = value.manifest;
    const mAt = (sub: readonly PropertyKey[], message: string): void => {
      at(source, [...path, 'manifest', ...sub], message);
    };

    // Check 1: write requires a manifest; destructive may have one; read and write_opaque must not.
    if (manifest === undefined) {
      if (value.risk === 'write') mAt([], 'is required for a write operation');
      continue;
    }
    if (value.risk === 'read' || value.risk === 'write_opaque') {
      mAt([], `is not allowed on a ${value.risk} operation`);
      continue;
    }
    const action = manifest.action;
    // The one place that decides how the values arrive; a delete takes none.
    if (action === 'delete') {
      if (manifest.values_arg !== undefined) mAt(['values_arg'], 'is not allowed with action delete');
      if (manifest.records_arg !== undefined) mAt(['records_arg'], 'is not allowed with action delete');
      if (value.fields_arg !== undefined) at(source, [...path, 'fields_arg'], 'is not allowed with action delete');
      if (value.risk !== 'destructive') mAt(['action'], 'action delete needs risk destructive');
      if (manifest.ids_arg === undefined && manifest.selector === undefined) mAt([], 'must declare ids_arg, selector or both');
    } else if ((manifest.values_arg === undefined) === (manifest.records_arg === undefined)) {
      mAt([], 'must declare exactly one of values_arg and records_arg');
    }
    if (action === 'create') {
      if (manifest.records_arg === undefined) mAt(['action'], 'action create needs records_arg');
      if (manifest.write !== undefined) mAt(['write'], 'is not allowed with action create');
      // The scope is checked against the new record's own values (ADR 0071).
      for (const [arg, field] of Object.entries(manifest.scope_args)) {
        if (!manifest.fields.includes(field)) mAt(['scope_args', arg], 'must be one of fields for action create');
      }
    }
    if (action !== 'update' && manifest.rollback.strategy === 'replay_previous_state') {
      mAt(['rollback', 'strategy'], `is not available for action ${action}`);
    }
    const valuesKey = manifest.records_arg === undefined ? 'values_arg' : 'records_arg';
    if (action === 'delete') {
      // Reported above; the targets of a delete come from ids_arg or the selector.
    } else if (manifest.records_arg !== undefined) {
      // The records name the targets (CS-2, ADR 0070).
      if (manifest.ids_arg !== undefined) mAt(['ids_arg'], 'is not allowed with records_arg');
      if (manifest.selector !== undefined) mAt(['selector'], 'is not allowed with records_arg');
    } else if (manifest.values_arg !== undefined && manifest.ids_arg === undefined && manifest.selector === undefined) {
      mAt([], 'must declare ids_arg, selector or both');
    }
    if (action !== 'delete' && value.fields_arg !== undefined && value.fields_arg !== (manifest.records_arg ?? manifest.values_arg)) {
      at(source, [...path, 'fields_arg'], `must equal manifest.${valuesKey}`);
    }
    manifest.sensitive_fields.forEach((f, index) => {
      if (!manifest.fields.includes(f)) mAt(['sensitive_fields', index], 'must be one of fields');
    });
    if (!op.enabled) continue;

    const schema = op.definition.inputSchema;
    const writeProps = propertiesOf(schema);

    // Check 3 (write side).
    if (op.schemaKnown) {
      if (manifest.ids_arg !== undefined) {
        const ids = propertySchema(schema, manifest.ids_arg);
        const items = ids?.items;
        const itemType = typeof items === 'object' && items !== null ? (items as Record<string, unknown>).type : undefined;
        // Target IDs are compared as strings: only string or integer items convert without loss.
        if (ids?.type !== 'array' || (itemType !== 'string' && itemType !== 'integer')) {
          mAt(['ids_arg'], 'must name a top-level array property of input_schema whose items are strings or integers');
        }
      }
      // Declaring both or neither is reported once above; the schema checks follow what is declared.
      if (manifest.records_arg !== undefined && action !== 'delete') {
        const recordsIssue = checkRecordsSchema(schema, manifest);
        if (recordsIssue !== undefined) mAt(['records_arg'], recordsIssue);
      }
      const valuesArg = action === 'delete' ? undefined : manifest.values_arg;
      const values = valuesArg === undefined ? undefined : propertySchema(schema, valuesArg);
      if (valuesArg === undefined) {
        // No values object to check.
      } else if (values?.type !== 'object') mAt(['values_arg'], 'must name a top-level object property of input_schema');
      else if (!requiredOf(schema).has(valuesArg)) mAt(['values_arg'], 'must name a required property of input_schema');
      else {
        const declared = values.properties;
        // Keys outside fields would be dropped silently; the schema must refuse them instead.
        if (typeof declared !== 'object' || declared === null || values.additionalProperties !== false) {
          mAt(['values_arg'], 'must declare properties and additionalProperties: false in input_schema');
        } else {
          const fields = new Set(manifest.fields);
          const outside = Object.keys(declared).filter((k) => !fields.has(k));
          if (outside.length > 0) mAt(['values_arg'], 'declares properties that are not in fields');
        }
      }
      // Check 4 (write side): scope arguments are write arguments.
      for (const arg of Object.keys(manifest.scope_args)) {
        if (!writeProps.has(arg)) mAt(['scope_args', arg], 'is not a property of input_schema');
      }
    }

    // Checks 2, 4, 5 and 6 for each read.
    const resolveRead = (sub: 'read_before' | 'selector', target: string): RegisteredOperation | undefined => {
      const read = all.get(target);
      if (read === undefined) {
        if (!input.operationsIncomplete) mAt([sub, 'operation'], 'must name an enabled read operation');
        return undefined;
      }
      if (!read.enabled || read.definition.risk !== 'read') mAt([sub, 'operation'], 'must name an enabled read operation');
      else if (read.definition.connection !== op.definition.connection) mAt([sub, 'operation'], 'must name an operation of the same connection');
      else if (read.definition.fieldsArg === undefined) mAt([sub, 'operation'], 'must name an operation with fields_arg');
      else return read;
      return undefined;
    };
    const checkArgs = (sub: 'read_before' | 'selector', args: Readonly<Record<string, TemplateConfig>>, read: RegisteredOperation | undefined): void => {
      const referenced = new Set<string>();
      for (const [key, tpl] of Object.entries(args)) {
        if (typeof tpl === 'object') {
          referenced.add(tpl.arg);
          if (op.schemaKnown && !writeProps.has(tpl.arg)) mAt([sub, 'args', key, 'arg'], 'names an argument that is not in input_schema');
        }
        if (read?.schemaKnown === true && !propertiesOf(read.definition.inputSchema).has(key)) {
          mAt([sub, 'args', key], `is not an argument of operation ${read.definition.id}`);
        }
      }
      for (const arg of Object.keys(manifest.scope_args)) {
        if (!referenced.has(arg)) mAt([sub, 'args'], `must pass scope argument ${arg} as { arg: ${arg} }`);
      }
    };

    const rb = manifest.read_before;
    const read = resolveRead('read_before', rb.operation);
    checkArgs('read_before', rb.args, read);
    if (read?.schemaKnown === true) {
      const ids = propertySchema(read.definition.inputSchema, rb.ids_arg);
      const items = ids?.items;
      const itemType = typeof items === 'object' && items !== null ? (items as Record<string, unknown>).type : undefined;
      if (ids?.type !== 'array') mAt(['read_before', 'ids_arg'], `must name an array property of operation ${read.definition.id}`);
      // Core passes target IDs to the read as strings; items without a type stay accepted.
      else if (itemType !== undefined && itemType !== 'string') mAt(['read_before', 'ids_arg'], 'must be an array of strings: target IDs are passed as strings');
      else if (typeof ids.maxItems === 'number' && ids.maxItems < manifest.batch_size) {
        mAt(['batch_size'], `exceeds the maxItems of read_before.ids_arg in operation ${read.definition.id}`);
      }
      const known = fieldEnum(read);
      if (known !== undefined) {
        const notReturned = `is not a field operation ${read.definition.id} can return`;
        if (!known.has(manifest.id_field)) mAt(['id_field'], notReturned);
        manifest.fields.forEach((f, index) => {
          if (!known.has(f)) mAt(['fields', index], notReturned);
        });
        manifest.required_fields.forEach((f, index) => {
          if (!known.has(f)) mAt(['required_fields', index], notReturned);
        });
        for (const [arg, field] of Object.entries(manifest.scope_args)) {
          if (!known.has(field)) mAt(['scope_args', arg], notReturned);
        }
      }
    }

    const carry = manifest.write?.carry_fields ?? [];
    carry.forEach((f, index) => {
      if (manifest.fields.includes(f)) mAt(['write', 'carry_fields', index], 'must not be one of fields');
    });
    if (read?.schemaKnown === true) {
      const known = fieldEnum(read);
      if (known !== undefined) {
        carry.forEach((f, index) => {
          if (!known.has(f)) mAt(['write', 'carry_fields', index], `is not a field operation ${read.definition.id} can return`);
        });
      }
    }

    const selector = manifest.selector;
    if (selector !== undefined) {
      const sel = resolveRead('selector', selector.operation);
      checkArgs('selector', selector.args, sel);
      if (sel?.schemaKnown === true) {
        const selProps = propertiesOf(sel.definition.inputSchema);
        if (!selProps.has(selector.page_arg)) mAt(['selector', 'page_arg'], `is not an argument of operation ${sel.definition.id}`);
        if (!selProps.has(selector.page_size_arg)) mAt(['selector', 'page_size_arg'], `is not an argument of operation ${sel.definition.id}`);
        // The selector is asked for the ID field only.
        const known = fieldEnum(sel);
        if (known !== undefined && !known.has(manifest.id_field)) mAt(['id_field'], `is not a field operation ${sel.definition.id} can return`);
      }
    }

    // Check 7: the inverse is an enabled write operation on the same connection. A create is undone by
    // a delete (destructive) with the same id_field, a delete by a create covering its fields (ADR 0071).
    if (manifest.rollback.strategy === 'inverse_operation') {
      const inverse = all.get(manifest.rollback.operation);
      const wanted = action === 'create' ? 'delete' : action === 'delete' ? 'create' : undefined;
      if (inverse === undefined) {
        if (!input.operationsIncomplete) mAt(['rollback', 'operation'], wanted === undefined ? 'must name an enabled write operation' : inverseMessage(wanted));
      } else if (wanted !== undefined) {
        const inverseManifest = inverse.located.value.manifest;
        const inverseAction = inverseManifest?.action ?? 'update';
        const covers = inverseManifest !== undefined && manifest.fields.every((f) => inverseManifest.fields.includes(f));
        const matches =
          inverse.enabled &&
          inverse.definition.connection === op.definition.connection &&
          inverseManifest !== undefined &&
          inverseAction === wanted &&
          (wanted === 'delete' ? inverse.definition.risk === 'destructive' && inverseManifest.id_field === manifest.id_field : inverse.definition.risk === 'write' && inverseManifest.id_field === manifest.id_field && covers);
        if (!matches) mAt(['rollback', 'operation'], inverseMessage(wanted));
      } else if ((inverse.located.value.manifest?.action ?? 'update') !== 'update') {
        // A create or delete writes records of another shape: it undoes only its own action (ADR 0071).
        mAt(['rollback', 'operation'], 'must name an update operation');
      } else if (!inverse.enabled || inverse.definition.risk !== 'write') mAt(['rollback', 'operation'], 'must name an enabled write operation');
      else if (inverse.definition.connection !== op.definition.connection) mAt(['rollback', 'operation'], 'must name an operation of the same connection');
      else {
        const inverseManifest = inverse.located.value.manifest;
        if (inverseManifest !== undefined) {
          if (inverseManifest.id_field !== manifest.id_field) mAt(['rollback', 'operation'], 'must name an operation with the same id_field');
          else if (!manifest.fields.every((f) => inverseManifest.fields.includes(f))) mAt(['rollback', 'operation'], 'must name an operation whose manifest lists every field of this one');
        }
      }
    }
  }
}
