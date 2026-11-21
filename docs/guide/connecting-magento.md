# Connecting Magento

This page attaches a Magento shop to the stack from [Installation](installation.md). For the
walkthrough you use the Mage-OS sandbox that ships with the repository: a local Magento 2 with three
small brands of products. At the end the connection test passes and the `catalog.*` operations can
reach the shop.

Run every command from the repository root, with the stack from the previous page running.

## Start the Magento sandbox

The sandbox runs as its own Compose project on a Docker network called `aiops-sandbox`. The first
run downloads Mage-OS and installs it, which takes several minutes; later runs take seconds.

<!-- doc-test: attach -->
```bash
bash deploy/sandbox/magento/up.sh
```

The script prints `CONSUMER async.operations.all running` and `SANDBOX UP <seconds>`. The shop
answers on `http://127.0.0.1:4390` (set `AIOPS_MAGENTO_PORT` to use another port).

Add the demo products: brands `acme` (3 products), `globex` (2), `initech` (2) and `umbrella`
(3000). Seeding is idempotent.

<!-- doc-test: attach -->
```bash
node deploy/sandbox/magento/seed.mjs "http://127.0.0.1:${AIOPS_MAGENTO_PORT:-4390}"
```

Seeding adds the `brand` attribute. Restart Magento's bulk consumer so it sees the new attribute;
the product writes of a later page go through it.

<!-- doc-test: attach -->
```bash
AIOPS_RESTART_CONSUMER=1 bash deploy/sandbox/magento/up.sh
```

## Get an integration token

The stack calls Magento's REST API with a bearer token. On the sandbox, mint an admin token (valid
for 24 hours). The command stores it in a variable and never prints it.

<!-- doc-test: attach -->
```bash
export MAGENTO_TOKEN="$(bash deploy/sandbox/magento/token.sh)"
```

On a real shop, create an integration in the Magento admin (System > Integrations), give it access
to the catalog resources only, activate it and use its access token instead.

## Point the configuration at the sandbox

The development configuration in `deploy/config/` describes a connection called `magento` that
uses the Magento catalog preset, but its `base_url` is a placeholder
(`https://shop.example.test/rest/all`), and the `api` and `worker` containers are not on the
sandbox network. Make a working copy of the configuration; you edit this copy from now on, and the
next page adds a role to it. `my-config/` is git-ignored.

<!-- doc-test: attach -->
```bash
cp -R deploy/config my-config
```

Replace the connection file in the copy. Only `base_url` changes: inside the sandbox network the
shop is called `magento-sandbox`.

<!-- doc-test: attach -->
```bash
cat > my-config/connections.yaml <<'EOF'
version: 1
presets:
  - { id: magento-catalog, package: '@aiops/magento2-catalog', version: '1.0.0' }
connections:
  - id: magento
    adapter: openapi
    base_url: http://magento-sandbox/rest/all
    credential_ref: magento-integration
    auth: { scheme: bearer }
    preset: magento-catalog
    # Development only: lets the connection reach a shop on a private address (the sandbox).
    # Leave it out, or false, in production.
    allow_private_network: true
EOF
```

The configuration names the credential (`credential_ref: magento-integration`) but never holds it;
you enter the token on the credential page below.

Tell Compose to add the sandbox override
[`deploy/sandbox/magento/attach.compose.yaml`](../../deploy/sandbox/magento/attach.compose.yaml).
It puts `api` and `worker` on the sandbox network and mounts `my-config/` in place of
`deploy/config/`. Compose reads `COMPOSE_FILE` from `.env`, so every later `docker compose` command
uses the override too. The command adds the line only once.

<!-- doc-test: attach -->
```bash
grep -qs '^COMPOSE_FILE=' .env || printf 'COMPOSE_FILE=compose.yaml:deploy/sandbox/magento/attach.compose.yaml\n' >> .env
docker compose up -d --wait
```

On Windows outside WSL, Compose separates the files with `;` instead of `:`.

The files in the configuration directory only seed an empty database. Once the stack has an active
configuration revision, only `config apply` changes it. Apply your copy:

<!-- doc-test: attach -->
```bash
docker compose exec -T api node dist/cli.js config apply /etc/aiops/config --actor guide
```

The command prints the changed connection and the new revision hash. A running `api` and `worker`
follow the new revision within seconds, without a restart.

## Enter the credential

Credentials are entered by a person with the `integration_admin` role on the trusted credential
page, never in configuration files or in a chat. In the development realm that person is carol.

1. Open `http://localhost:8400/app/credentials` and log in as `carol` with the password
   `dev-only-password`.
2. Under `magento-integration`, paste the token and save.
3. Under the connection `magento`, run the connection test. It reports `ok`.

To print the token for pasting, run `bash deploy/sandbox/magento/token.sh` in a terminal nobody else
can see.

<!-- doc-test-alt: attach
export DEV_PASSWORD=dev-only-password
CAROL_COOKIE="$(node tooling/acceptance/page-login.mjs "http://localhost:${AIOPS_API_PORT:-8400}" carol "$DEV_PASSWORD" /app/credentials)"
SAVED="$(printf '%s\n' "$MAGENTO_TOKEN" | AIOPS_PAGE_COOKIE="$CAROL_COOKIE" node tooling/acceptance/page-api.mjs "http://localhost:${AIOPS_API_PORT:-8400}" put-credential magento-integration)"
echo "$SAVED"
test "$SAVED" = '{"status":204}'
REPORT="$(AIOPS_PAGE_COOKIE="$CAROL_COOKIE" node tooling/acceptance/page-api.mjs "http://localhost:${AIOPS_API_PORT:-8400}" test magento)"
echo "$REPORT"
test "$(node -p 'JSON.parse(process.argv[1]).body.ok' "$REPORT")" = true
-->

The token is stored encrypted in PostgreSQL. It never appears in logs, the audit trail, tool results
or notifications.

## What the preset offers

The connection applies the Magento catalog preset (`@aiops/magento2-catalog` 1.0.0), which brings
four operations:

| Operation | Risk | What it does |
| --- | --- | --- |
| `catalog.search_products` | read | Search the products of one brand, optionally by name pattern; returns only the requested fields, at most 100 per page |
| `catalog.get_product` | read | Read one product of a brand by SKU |
| `catalog.get_products_by_sku` | read | Read up to 100 products of a brand by SKU in one call |
| `catalog.update_content` | write | Change content fields (`name`, `description`, `short_description`, `meta_title`, `meta_keyword`, `meta_description`, `url_key`) of the products of one brand, chosen by SKU list or name pattern |

An operation exists for a user only when one of the user's roles grants it. The next page writes a
role that decides who may call which operation, on which brands, and when a person must approve.

## Next

[Roles and approvals](roles-and-approvals.md).
