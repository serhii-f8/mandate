# @aiops/magento2-catalog

Magento 2 catalog preset 0.2.0 (CONN-8, OPS-2, OPS-4; designs `docs/design/phase-3-connections-read-upstream.md` §6
and `docs/design/phase-4-changesets.md` §8). Three read operations on `GET /V1/products`, one write
operation with a change-set manifest, a vendored filtered spec, a default connection test and bearer auth.

## Use

```yaml
presets:
  - { id: magento-catalog, package: '@aiops/magento2-catalog', version: '0.2.0' }
connections:
  - id: magento
    adapter: openapi
    base_url: https://shop.example.test/rest/all   # store scope `all` (ADR 0007)
    credential_ref: magento-integration            # an admin or integration token, entered on the credential page
    preset: magento-catalog
```

The api finds the package through `AIOPS_PRESET_DIRS`; `aiops validate <dir> --preset-dir presets`
checks it from the repository.

| Operation | Arguments | Upstream filter |
| --- | --- | --- |
| `catalog.search_products` | `brand`, `fields`, `page_size` (1-100, default 20), `current_page` (default 1), `name_like` | group 0 `brand eq`, group 1 `name like` |
| `catalog.get_product` | `brand`, `sku`, `fields` | group 0 `brand eq`, group 1 `sku eq` |
| `catalog.get_products_by_sku` | `brand`, `skus` (1-100), `fields` | group 0 `brand eq`, group 1 `sku in` (comma-joined) |
| `catalog.update_content` (write) | `brand`, `skus` (1-1000) or `name_like`, `changes` | none: prepared from the two reads above |

`catalog.search_products` sorts by `sku` ascending so pages are stable.

### `catalog.update_content`

Changes `name`, `description`, `short_description`, `meta_title`, `meta_keyword`,
`meta_description` and `url_key` (string values, at least one) for products of one brand, named by
`skus` or selected by `name_like`. Its manifest reads current state with
`catalog.get_products_by_sku` (batches of 100), selects with `catalog.search_products`, caps a
change-set at 10000 targets and uses rollback `replay_previous_state`.

- In Phase 4 the operation is preparation only: it creates a change-set for approval and writes
  nothing upstream. Execution (the `POST /async/bulk/V1/products` route) arrives in Phase 5; its
  consumer prerequisite (the Magento async-bulk consumer) remains for then.
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
the sandbox's answers. `pnpm --filter @aiops/magento2-catalog test` checks that the preset builds
exactly the recorded requests and maps the recorded responses, directly and through the adapter
against a fake upstream. With `MAGENTO_SANDBOX_URL` and `MAGENTO_SANDBOX_TOKEN` set, the cases
also run live.

Re-record (sandbox from `deploy/sandbox/magento/`):

```bash
bash deploy/sandbox/magento/up.sh
node deploy/sandbox/magento/seed.mjs http://127.0.0.1:4390
MAGENTO_SANDBOX_URL=http://127.0.0.1:4390 MAGENTO_SANDBOX_TOKEN=$(bash deploy/sandbox/magento/token.sh) \
  pnpm --filter @aiops/magento2-catalog record
```

The recorder writes the spec (`/rest/all/schema?services=catalogProductRepositoryV1`) and one
recording per case. It never writes request headers and refuses to write anything token-like.
