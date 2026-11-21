# AI Operations Layer

A self-hosted, open-source MCP server that sits between AI clients and a company's business
systems. It decides who may run which operation, prepares writes as reviewable change-sets, routes
them through human approval, executes them durably and records everything. One MCP endpoint per
installation; credentials for business systems live only on the platform.

## The request path

1. An AI client calls a tool on the single MCP endpoint with an OAuth 2.1 access token.
2. The server checks the caller's role: operations that are not granted are not listed and not callable.
3. A write is prepared as an immutable change-set identified by a content hash, with a diff.
4. A person approves that exact change-set on a trusted page or widget.
5. A durable workflow executes it against the business system and every step is audited.

No model sits in the trust path: permissions, diffs, approvals and execution are deterministic server code.

## Features

- **Access:** OAuth 2.1 / OIDC through Keycloak, role mapping from groups, default deny, service accounts for automation.
- **Operations:** any OpenAPI spec or MCP server attached without code; curated presets add preview, batching and rollback.
- **Writes:** immutable change-sets, per-record diffs, exclusions, approval rules by threshold and role, rollback.
- **Execution:** one Temporal workflow per change-set, retries, bulk batches, at-most-once opaque writes.
- **Audit:** append-only, hash-chained, searchable and exportable; configuration revisions as code.
- **Operations and safety:** health endpoints, traces and metrics, encrypted credential vault, rate limits.

## Quickstart

You need Docker with Compose v2.

```bash
git clone <repository-url> ai-operations-layer
cd ai-operations-layer
cp .env.example .env   # optional: the defaults work when ports 8400, 8480, 17233, 15432, 8025 are free
docker compose up -d --build --wait
```

Then open <http://localhost:8400/app/approvals>. Sign in with a development user from the
[installation guide](docs/guide/installation.md).

## Documentation

- [Guide](docs/guide/README.md): install, connect Magento, roles and approvals, your first bulk update, operations.
- [Installation](docs/guide/installation.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md)

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
