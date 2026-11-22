# ADR 0067: Preset parameters bound per connection

- Status: Accepted
- Date: 2026-11-22

## Context

A preset fixes its operations at publish time (CONN-8, ADR 0050). Shops that run the same upstream
differ in details the preset cannot know: the attribute a catalog is filtered by (`brand` in one shop,
`manufacturer` in another), or the list of fields a read may return. Today an operator who needs another
value copies the whole preset into configuration and loses its upgrades, or the preset author publishes
one variant per shop. `operation_prefix` already lets one preset serve two connections (ADR 0050 item
11), so a value has to belong to the binding, not to the preset.

## Options considered

1. Overrides on the bound operations (a JSON patch per operation in configuration). Powerful, but an
   operator then edits the preset's internals, and a preset upgrade silently breaks the patch.
2. Templating the preset file as text (`${scope}` inside YAML). A value could change the structure of
   the file, and issues would point at text the operator never wrote.
3. Typed parameters the preset declares, with defaults, set per connection, substituted as whole YAML
   nodes before the operation schema applies.

## Decision

Option 3.

- `preset.yaml` gains `params: { <name>: { type, default, description? } }`. `type` is `string`,
  `number`, `boolean` or `string_list`; `default` is required and must be of the type, so a preset
  always loads without a binding. Names match `^[a-z][a-z0-9_]{0,63}$`; at most 50 parameters, strings
  up to 4000 characters, lists up to 500 strings.
- A connection gains `preset_params: { <name>: <value> }`. It requires `preset`. An unknown name or a
  value of another type is an issue at `connections[N].preset_params.<name>`. Values are not coerced: a
  string for a `string_list`, a numeric string for a `number`, an object or a nested list is refused.
- Substitution: inside the preset's `operations` and `test`, a mapping whose only key is `$param` (a
  string) is replaced by the parameter's value. A list value stays one node (a whole `enum`, never
  spliced into a surrounding list). The walk covers the preset's own nodes once: a substituted value is
  never searched for `$param`, so a value cannot introduce another substitution. A `$param` naming an
  undeclared parameter is an issue in the preset file. The nodes that identify an operation or its
  field list are not parameters: a `{ $param }` under `operations[*].id`, `operations[*].fields_arg`,
  `operations[*].manifest.values_arg` or `test.operation` is an issue in the preset file at that node
  (`must not be a parameter`). A binding could otherwise rename an operation that grants name, point
  the test elsewhere, or move the field list that deny and allow fields and approval field rules read.
- `resolvePreset` substitutes the defaults and validates the result with the unchanged preset schema;
  `LoadedPreset.operations` is that default-bound form, and the raw nodes are kept
  (`rawOperations`, `rawTest`). A binding without `preset_params` reuses the default-bound operations.
  A binding with `preset_params` substitutes its values into a fresh deep copy of the raw nodes and
  validates again, so two bindings of one preset share no mutable state. An issue found then is reported
  at `connections[N].preset_params`, naming the operation (or the test) and the path inside it. A
  binding whose values fail is still bound with the defaults, so the load reports no follow-on issues
  (ADR 0021).
- The later checks (Ajv compile of `input_schema`, registry and manifest cross-checks, the connection
  test's arguments) see a binding with `preset_params` through a source object of its own, with the
  preset file's text and positions. The loader's issue sink recognises that source and reports the
  issue at the connection's `preset_params`, naming the preset operation ID (or the test and its
  operation) and the inner path. So with two bindings of one preset, only the binding whose values
  broke something is named. A binding without `preset_params` keeps the preset's own source: an issue
  there is the preset's defect and is reported in the preset file.
- The preset format report (`mandate-preset.v1.json`) describes the file after substitution plus the
  new `params` key, and says so in its description. A `{ $param }` node may stand anywhere inside
  `operations` and `test`; describing that in the schema would mean accepting anything there.
- A preset that declares `params` requires connector SDK 1.1.0 and says so with `mandate.sdk: ^1.1.0`
  (the preset template does). A 1.0.x platform then refuses it with `preset_sdk_incompatible` rather
  than with an unknown key `params`.
- Code modules receive the binding's values, defaults filled in, as `ctx.params` (`{}` when the preset
  declares none). The loader puts them on `ConnectionSettings.presetParams`, since a connection binds at
  most one preset, and the code runner hands each invocation a frozen copy.
- The configuration hash (CFG-4) covers the values without a change: `preset_params` is in the hashed
  connection file and the declarations are in the hashed preset file. The secret-key scan (CFG-5) runs
  over both files, so a parameter named like a secret is refused on either side.

## Consequences

- Public interface: the configuration schema gains `connections[].preset_params` and the preset format
  gains `params` (config 1.1.0 and SDK 1.1.0, additive); the connector SDK gains the optional members
  `CodeContext.params` and `ConnectionSettings.presetParams`.
- A preset author who parameterizes an existing preset keeps its behaviour by choosing today's value as
  the default; recordings and contract tests stay valid.
- Parameter values are data, never instructions (SEC-5): they pass the same operation schema as the
  preset's own values and can neither add keys nor nest further substitutions.
- Parameters are not secrets. A value that must stay secret belongs in the credential, not in
  `preset_params`.

## Verified

Unit tests of declaration parsing, value resolution and substitution (`preset-params.test.ts`); loader
tests for defaults, two bindings of one preset with different values, a wrong type, an unknown name, an
object and a nested list, a value that breaks the operation schema, `preset_params` without `preset`, an
undeclared `$param`, a `$param` under each identity node, a default of the wrong type, per-binding substitution of the test, the
configuration hash and the secret scan, and the location of issues the later checks find: test args and
an uncompilable input schema caused by a value land at `preset_params`, only the offending binding of
two is named, and a preset broken by its defaults reports in the preset file (`load.test.ts`); code runner tests for `ctx.params` on read,
write and call (`runner.test.ts`); the preset template's contract test with its `search_fields`
parameter; the semver gate reports all three surfaces additive.
