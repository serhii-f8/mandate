# ADR 0026: update_content names its targets without a root-level combinator

- Status: Accepted
- Date: 2026-11-17

## Context

A review at the end of Phase 4 found that `catalog.update_content` (preset
`magento2-catalog`) accepts a call with neither `skus` nor `name_like`. The manifest then
falls back to the selector with an empty name pattern, so an omitted argument turns into
"every product of the brand". The first proposed fix was
`anyOf: [{required: [skus]}, {required: [name_like]}]` plus
`not: {required: [skus, name_like]}` at the root of the input schema, if Ajv strict mode and
the loader accept it.

The input schema is published unchanged in `tools/list`, and MCP clients pass it to their
model API as the tool's input schema.

## Options considered

1. Root `anyOf` + `not`, as first proposed. Ajv strict accepts it, but the Anthropic API
   answers 400 "input_schema does not support oneOf, allOf, or anyOf at the top level" for
   such a tool, and in Claude Code and Claude Desktop that error fails every request of the
   conversation, not only calls of this tool.
2. Enforce it in the server only (preparation refuses a call without either argument): the
   model gets no schema hint, and the rule lives outside the preset.
3. `minProperties: 3` and `maxProperties: 3` at the root. With `brand` and `changes` required
   and `additionalProperties: false`, the only properties are `brand`, `skus`, `name_like` and
   `changes`, so exactly three properties means exactly one of `skus` or `name_like`. No
   combinator; both keywords are plain JSON Schema that Ajv strict accepts.

## Decision

Option 3, with the rule spelled out in the `skus` and `name_like` descriptions. A whole-brand
update needs `name_like: "%"` explicitly (preset README). The preset contract test proves the
rule and that the schema has no root `anyOf`, `oneOf`, `allOf` or `not`.

## Consequences

- The counting trick depends on the property list: adding a property to the schema requires
  revisiting `minProperties`/`maxProperties` (a comment next to them says so).
- Validation errors name the property count, not the two arguments; the descriptions carry
  the meaning for the model.

## Verified

2026-11-17: the 400 error text and its effect on Claude clients are reported in
anthropics/claude-code issues #4886, #27337 and #40075 (github.com/anthropics/claude-code/issues),
including every request of the conversation failing for a connector with a top-level `anyOf`.
`pnpm aiops validate deploy/config --preset-dir presets` → `Configuration valid: 1
connections, 5 operations, 3 roles` (exit 0) with the new schema; preset contract test
`NFR-17 OPS-4 catalog.update_content names its targets by exactly one of skus or name_like`
passes.
