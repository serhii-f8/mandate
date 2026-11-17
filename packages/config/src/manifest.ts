/**
 * The operation manifest (design phase 4 §3.1; OPS-2, OPS-3, OPS-4): its YAML schema,
 * conversion to the core `ManifestDefinition`, and the loader checks 1–7 that need
 * the registry (enabled read operations and their final input schemas).
 */
import type { ManifestDefinition, ManifestRead, ManifestTemplate, RollbackStrategy } from '@aiops/core';
import { z } from 'zod';
import type { At, RegisteredOperation } from './registry.js';
import { propertiesOf, requiredOf } from './registry.js';
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
  id_field: name,
  ids_arg: name.optional(),
  values_arg: name,
  fields: z.array(name).min(1),
  required_fields: z.array(name).default([]),
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

export const changesetsSchema = z.strictObject({
  expire_after_hours: z.number().int().min(1).max(2160).default(72),
  failure_threshold: z.number().gt(0).max(1).default(DEFAULT_FAILURE_THRESHOLD),
  items_per_workflow_run: z.number().int().min(100).max(1_000_000).default(DEFAULT_ITEMS_PER_WORKFLOW_RUN),
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
    idField: m.id_field,
    ...(m.ids_arg === undefined ? {} : { idsArg: m.ids_arg }),
    valuesArg: m.values_arg,
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
    if (manifest.ids_arg === undefined && manifest.selector === undefined) mAt([], 'must declare ids_arg, selector or both');
    if (value.fields_arg !== undefined && value.fields_arg !== manifest.values_arg) {
      at(source, [...path, 'fields_arg'], 'must equal manifest.values_arg');
    }
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
      const values = propertySchema(schema, manifest.values_arg);
      if (values?.type !== 'object') mAt(['values_arg'], 'must name a top-level object property of input_schema');
      else if (!requiredOf(schema).has(manifest.values_arg)) mAt(['values_arg'], 'must name a required property of input_schema');
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
      if (ids?.type !== 'array') mAt(['read_before', 'ids_arg'], `must name an array property of operation ${read.definition.id}`);
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

    // Check 7: the inverse is an enabled write operation on the same connection.
    if (manifest.rollback.strategy === 'inverse_operation') {
      const inverse = all.get(manifest.rollback.operation);
      if (inverse === undefined) {
        if (!input.operationsIncomplete) mAt(['rollback', 'operation'], 'must name an enabled write operation');
      } else if (!inverse.enabled || inverse.definition.risk !== 'write') mAt(['rollback', 'operation'], 'must name an enabled write operation');
      else if (inverse.definition.connection !== op.definition.connection) mAt(['rollback', 'operation'], 'must name an operation of the same connection');
    }
  }
}
