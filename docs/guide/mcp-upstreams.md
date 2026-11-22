# MCP upstreams

Besides REST APIs, a connection can be another MCP server. Its tools become operations of this
platform, checked, approved and audited like any other. Nothing from the upstream is trusted: every
tool starts disabled, and you enable one by pinning exactly the definition you reviewed.

## Attach a server

Add a connection with `adapter: mcp` and the server's URL:

```yaml
version: 1
connections:
  - id: tools
    adapter: mcp
    mcp_url: https://mcp.example.com/mcp
    credential_ref: tools-token
    auth: { scheme: bearer }
    pin_check_seconds: 300
```

`pin_check_seconds` (10 to 86400, default 300) is how often the platform lists the server's tools
again. Add the credential on the credential page, then apply the configuration (see
[Roles and approvals](roles-and-approvals.md) for `config apply`). With no operations yet, every
tool of the server is known but disabled: it is not offered and cannot be called.

## List the tools

`aiops mcp tools` lists the connection's tools live, with the stored credential:

```bash
docker compose exec -T api node dist/cli.js mcp tools tools
```

The first `tools` is the CLI subcommand, the second is the connection ID. One line per tool:

```text
<tool> <hash> <operation id or -> <pin state or unreferenced>
```

and a last line `listed <n> tools (dropped <d>)`. A tool no operation uses shows `-` and
`unreferenced`. The hash is `sha256:` and 64 hex digits, computed from the tool's name, title,
description, input schema, output schema and annotations. Tools with a name the platform cannot
carry are dropped and counted. The exit code is 0 when the list worked, 1 when listing failed or the
tool is not listed, and 2 for a usage error or a connection that is not an `mcp` connection of the
active revision.

## Review a tool and pin it

Print one tool's definition:

```bash
docker compose exec -T api node dist/cli.js mcp tools tools --show echo
```

The output is for you only. It shows the upstream's description and schema so you can read them,
and no client ever sees that text. After the definition it prints an operation skeleton with the
current pin:

```yaml
operations:
  - id: tools.echo
    connection: tools
    risk: read
    description: <write your own description>
    upstream: { tool: echo, pin: sha256:<64 hex digits> }
```

Read the definition as you would read code you are about to run. Then paste the skeleton into a
configuration file and write your own `description`: the text clients see always comes from your
configuration, never from the server. `risk` is `read`, `write_opaque` or `destructive`. An opaque
write is one approved call, sent at most once, and the approver sees the raw arguments. Grant the
operation to a role as usual, run `config diff` and `config apply`, and the operation is offered.

The input schema is derived from the pinned tool, keeping only its validation keywords and dropping
descriptions and other prose. If the derived schema does not compile (the checker is strict), give
the operation its own `input_schema`.

## Pin states

Every operation has a pin state, kept per process and refreshed every `pin_check_seconds`, and before
a call whose last check is older than a minute. Only `ok` operations are offered and callable.

| State | Meaning |
| --- | --- |
| `ok` | The live hash equals the pin. |
| `changed` | The tool is listed and its hash differs from the pin. |
| `missing` | The server no longer lists the tool. |
| `unverified` | No list has succeeded yet, or the last success is too old. |
| `schema_invalid` | The hash matches but the derived input schema does not compile. |
| `unreferenced` | No operation uses the tool (only shown by `aiops mcp tools`). |

A call to an operation that is not `ok` is refused after the policy check, with `upstream_changed`
(`changed`, `missing`) or `upstream_unavailable` (`unverified`), and the refusal is audited.
`list_my_operations` shows the state, so the requester sees why the operation is gone. Each state
change writes one `upstream.pin` audit row with the connection, the tool, the old and new state and
the live hash, and no upstream text. A server that is down fails closed: after one
`pin_check_seconds` without a successful list, its operations become `unverified`.

## Re-pin after a change

A tool that changed is disabled until you approve the new definition. There is no other way to
enable it:

1. List the tools. The operation shows `changed` and the new hash.
2. Review the new definition with `--show <tool>`. Look at the description and the schema. This is
   the step that matters.
3. Replace `pin` in the operation with the new hash. Keep your own `description`, but check that it
   still tells the truth.
4. Run `config diff`, then `config apply`.

```bash
docker compose exec -T api node dist/cli.js config diff /etc/aiops/config
docker compose exec -T api node dist/cli.js config apply /etc/aiops/config --actor you
```

The pin monitor sees the applied revision within seconds, and the operation returns to `ok` with no
restart. Pins are in files you commit, so a re-pin has a review trail.

## Limits to know

- A server that needs mirrored `Mcp-Param` headers refuses opaque calls.
- Binary content in a tool result (images, audio) is omitted from what clients receive.
- A tool result is data. It is never treated as an instruction.
