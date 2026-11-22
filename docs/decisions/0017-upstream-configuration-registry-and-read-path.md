# ADR 0017: Upstream configuration, operation registry and the direct read path

- Status: Accepted
- Date: 2026-11-16

## Context

Phase 3 connects allowed `read` calls to real systems (MCP-4, CONN-2, OPS-1, MCP-9) and
must pass "a content-manager role searches products of an allowed brand through an AI
client" against a Magento sandbox. [ADR 0015](0015-configuration-format-and-loader.md) left the operation's `upstream` block
open, and `@mandate/config` may not import `@mandate/adapters` (package boundary rules).

## Options considered

1. **Subsystem split:** one subsystem for the phase; two (upstream calls; credentials and
   pages).
2. **How arguments reach the upstream:** a declarative mapping in `upstream` (templates and
   response mapping); raw OpenAPI passthrough; preset code per operation (OPS-5).
3. **Where spec loading happens:** inside `@mandate/config` (needs adapter code); in `api`
   after loading (two configuration stages); an `UpstreamResolver` interface in
   `@mandate/connector-sdk` that the loader calls and `api` implements with the adapter.
4. **Presets before versioned packages (CONN-8 is Phase 9):** operators copy preset YAML;
   presets resolved by package name from preset directories; npm-installed packages.
5. **MCP-9 overrides:** edit the operation; a top-level `overrides` list.
6. **Result shape (MCP-4):** text only; structured content only; summary text +
   structured content + the serialized JSON as a second text block.
7. **CLI for `test-connection`:** in `@mandate/config` (cannot reach adapters or the
   database); a second CLI in `apps/api`.
8. **"Through an AI client" in the acceptance criterion:** block the phase on a manual
   claude.ai run; an MCP client on the same protocol path with a real Keycloak token.

## Decision

1. **Two subsystems**: credentials/pages and upstream calls are independent and meet only
   at the `CredentialSource` interface.
2. **Declarative mapping** (`operation` or `method`+`path`, `path_params`, `query`,
   `headers`, `body`, `response.items|total|flatten|fields_from_arg|max_items`). Derived
   operations get a default mapping. Passthrough cannot express Magento search criteria
   or keep denied fields out of results; preset code belongs to Phase 9.
3. **`UpstreamResolver` in `@mandate/connector-sdk`**, passed to the loader by `api` (and by
   the api CLI). All issues of all stages are reported together and the configuration is
   accepted only as a whole (CFG-2). `mandate-config validate` without a resolver keeps
   checking the static schema; `mandate validate` (api CLI) runs every check.
4. **Preset directories** (`MANDATE_PRESET_DIRS`), resolved by `package.json` name, with an
   exact version check when `version` is given. One connection per preset in Phase 3.
5. **`overrides`** with `tool_name`, `title`, `description`, `enabled`. Grants keep naming
   operation IDs; tool names must be unique.
6. **Summary + `structuredContent` + serialized JSON text.** The summary uses counts and
   configuration text only, never upstream text (SEC-5), and says the data is upstream
   content. The second text block follows the MCP specification's SHOULD for structured
   content; the SDK adds it only for non-object structured content, so `api` writes it
   itself. No `outputSchema` is declared in Phase 3: the low-level `Server` would not
   validate it and clients do (verified below), so a schema would turn a mapping mistake
   into a client error.
7. **`apps/api/src/cli.ts`** (`mandate validate | test-connection <connection> |
   credentials rotate`), which reads the api environment.
8. **MCP client on the same path**, as in Phase 2's acceptance: the criterion tests the
   platform's behaviour, which is identical for any MCP client (SPEC section 1, "Client
   independent"). A run from claude.ai is an optional manual check.

Also: read operations are called from `api` directly (SPEC section 2); non-read classes
answer that change-sets arrive in Phase 4. `tool.call` rows of operation calls add
`operation`, `connection`, `upstreamStatus`, `itemCount`, `upstreamMs` and `errorCode`;
arguments and results are still not stored (AUD-4 is Phase 8).

## Consequences

- `upstream` is now strict; configurations written for Phase 2 must add a mapping.
- Two CLIs exist until Phase 8 unifies `diff`/`apply`/`explain`.
- A preset bound to two connections is rejected until Phase 9 adds aliases.
- Clients that only read `content` still see the data, as JSON text after the summary.

## Verified

2026-11-16:
- MCP 2026-07-28 tools page (https://modelcontextprotocol.io/specification/2026-07-28/server/tools):
  "For backwards compatibility, a tool that returns structured content SHOULD also return
  the serialized JSON in a TextContent block"; `outputSchema` is optional; Security
  Considerations: servers MUST "Sanitize tool outputs", clients SHOULD "Validate tool
  results before passing to LLM".
- `@modelcontextprotocol/server@2.4.0` `dist/mcp-oHn3ureC.mjs:1240-1257` and
  `dist/src-DdvbAHrR.mjs:590-614`: `projectCallToolResult` adds a JSON text block only for
  non-object structured content; output validation exists only in
  `McpServer.validateToolOutput` (`mcp-oHn3ureC.mjs:1648-1655`).
  `@modelcontextprotocol/client@2.4.0` `dist/public-CvV4ZHkX.mjs:3919-3925` validates
  structured content against a declared `outputSchema`.
- The SDK limits only request bodies (4 MiB, `server/dist/index.mjs:37-60`); result size
  caps are the platform's.
