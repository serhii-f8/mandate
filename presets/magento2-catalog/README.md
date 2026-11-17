# @aiops/magento2-catalog

Magento 2 catalog preset, first cut (CONN-8; design `docs/design/phase-3-connections-read-upstream.md` §6).
Two read operations on `GET /V1/products`, a vendored filtered spec, a default connection test
and bearer auth. Writes follow in later phases.

## Use

```yaml
presets:
  - { id: magento-catalog, package: '@aiops/magento2-catalog', version: '0.1.0' }
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

- Scope a grant by `brand`: the brand is always filter group 0, so a product of another brand is
  not found (no pre-read needed).
- `fields` is an enum of `sku, name, price, status, visibility, type_id, description,
  short_description, brand, cost, url_key, meta_title, updated_at`. `custom_attributes` are
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
