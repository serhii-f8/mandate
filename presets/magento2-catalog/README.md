# @mandate/magento2-catalog

Magento 2 catalog preset 1.1.0 (CONN-8, OPS-2, OPS-4). Three read operations on `GET /V1/products`, one write
operation with a change-set manifest, a vendored filtered spec, a default connection test and bearer auth.

## Use

```yaml
presets:
  - { id: magento-catalog, package: '@mandate/magento2-catalog', version: '1.1.0' }
connections:
  - id: magento
    adapter: openapi
    base_url: https://shop.example.test/rest/all   # store scope `all` (ADR 0007)
    credential_ref: magento-integration            # an admin or integration token, entered on the credential page
    preset: magento-catalog
```

The api finds the package through `MANDATE_PRESET_DIRS`; `mandate validate <dir> --preset-dir presets`
checks it from the repository.

| Operation | Arguments | Upstream filter |
| --- | --- | --- |
| `catalog.search_products` | `brand`, `fields`, `page_size` (1-100, default 20), `current_page` (default 1), `name_like` | group 0 `brand eq`, group 1 `name like` |
| `catalog.get_product` | `brand`, `sku`, `fields` | group 0 `brand eq`, group 1 `sku eq` |
| `catalog.get_products_by_sku` | `brand`, `skus` (1-100), `fields` | group 0 `brand eq`, group 1 `sku in` (comma-joined) |
| `catalog.update_content` (write) | `brand`, `skus` (1-1000) or `name_like` (exactly one), `changes` | none: prepared from the two reads above |

`catalog.search_products` sorts by `sku` ascending so pages are stable.

## Parameters

Since 1.1.0 (CONN-8) a connection can set two parameters with `preset_params`; without them the preset
behaves exactly as 1.0.0. The preset declares `"sdk": "^1.1.0"`, so a 1.0.x platform refuses it.

| Parameter | Type | Default | Effect |
| --- | --- | --- | --- |
| `scope_attribute` | string | `brand` | Magento attribute that filter group 0 of the three reads filters on, and that `catalog.update_content` re-checks (`manifest.scope_args`). |
| `read_fields` | string_list | `sku, name, price, status, visibility, type_id, description, short_description, brand, cost, url_key, meta_title, meta_keyword, meta_description, updated_at` | The `fields` the read operations accept. |

```yaml
connections:
  - id: magento
    preset: magento-catalog
    preset_params:
      scope_attribute: manufacturer
      read_fields: [sku, name, status, description, short_description, meta_title, meta_keyword, meta_description, url_key, manufacturer]
```

- The tool argument keeps the name `brand` in 1.x, whatever attribute it filters on; so do its
  descriptions.
- `read_fields` must list the scope attribute (the write's scope check reads it back) and every field
  `catalog.update_content` reads and carries: `status`, `name`, `description`, `short_description`,
  `meta_title`, `meta_keyword`, `meta_description`, `url_key`. Otherwise the connection is refused at
  `connections[N].preset_params`, naming the operation and the field.

### `catalog.update_content`

Changes `name`, `description`, `short_description`, `meta_title`, `meta_keyword`,
`meta_description` and `url_key` (string values, at least one) for products of one brand, named by
`skus` or selected by `name_like` (exactly one of the two; a whole-brand update needs
`name_like: "%"` explicitly, ADR 0026). Its manifest reads current state with
`catalog.get_products_by_sku` (batches of 100), selects with `catalog.search_products`, caps a
change-set at 10000 targets and uses rollback `replay_previous_state`.

- Phase 4 prepares the change-set; Phase 5 executes it through `POST /async/bulk/V1/products`
  (OPS-6) and follows `GET /V1/bulk/{batch_id}/detailed-status`. **Prerequisite: a running
  `async.operations.all` consumer on the Magento side** (`bin/magento queue:consumers:start
  async.operations.all`, or cron with `consumers_wait_for_messages`); restart it after attribute
  schema changes, or it keeps its old attribute metadata. Without it, batches stay open until the
  execution gives up.
- `status` is carried in every record (`write.carry_fields`): Magento async writes reset an
  omitted status (ADR 0007).
- SKUs containing a comma are not supported (Magento's `in` filter takes a comma-separated list);
  the input schema rejects them.
- Unset `meta_*` attributes are absent from Magento's answer and therefore from the current state.
- Grant it by brand scope, e.g. `scope: { brand: [acme, globex] }`.

- Scope a grant by `brand`: the brand is always filter group 0, so a product of another brand is
  not found (no pre-read needed).
- `fields` is an enum of `sku, name, price, status, visibility, type_id, description,
  short_description, brand, cost, url_key, meta_title, meta_keyword, meta_description, updated_at`. `custom_attributes` are
  flattened and every item is projected to exactly `fields`; `deny_fields: [cost]` in a grant
  therefore keeps cost out completely.
- `name_like` is the whole SQL `LIKE` pattern: the caller writes the `%` wildcards (`%lamp%`).
  Template values cannot concatenate. Without it the pattern is `%` (any name).
- Connection test: `catalog.search_products { brand: acme, fields: [sku], page_size: 1 }`;
  override it with the connection's `test` when your shop has no brand `acme`.

## Contract tests (NFR-17)

`test/cases.json` holds the hand-written Magento request of each case; `test/recordings/` holds
the sandbox's answers. `pnpm --filter @mandate/magento2-catalog test` checks that the preset builds
exactly the recorded requests and maps the recorded responses, directly and through the adapter
against a fake upstream. With `MAGENTO_SANDBOX_URL` and `MAGENTO_SANDBOX_TOKEN` set, the cases
also run live.

The write cases (`test/write-cases.json`, `test/recordings/write/`) pin the bulk body, the recorded
detailed-status polls (mapped to item states by index) and the verify read. Live, they submit a
real batch that touches only the GLOBEX `meta_keyword` (or a rejected `url_key`), so the sandbox
must run the `async.operations.all` consumer (`up.sh` starts it).

Re-record (sandbox from `deploy/sandbox/magento/`):

```bash
bash deploy/sandbox/magento/up.sh
node deploy/sandbox/magento/seed.mjs http://127.0.0.1:4390
MAGENTO_SANDBOX_URL=http://127.0.0.1:4390 MAGENTO_SANDBOX_TOKEN=$(bash deploy/sandbox/magento/token.sh) \
  pnpm --filter @mandate/magento2-catalog record
```

The recorder writes the spec (`/rest/all/schema?services=catalogProductRepositoryV1`) and one
recording per case. It never writes request headers and refuses to write anything token-like.
