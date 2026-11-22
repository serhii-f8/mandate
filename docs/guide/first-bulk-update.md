# Your first bulk update

This page runs one change end to end: alice asks for new keywords on every acme product, the server
prepares a change-set, dave approves it on the trusted page, the worker writes it to Magento, and you
check the result in the shop.

You need the stack, the Magento connection and the `content_editor` role from the previous pages:
[Connecting Magento](connecting-magento.md) and [Roles and approvals](roles-and-approvals.md).

## The reference terminal client

Any MCP client can do what this page does; Claude and ChatGPT are covered at the end. For a local
walkthrough the repository has small scripts in `tooling/acceptance/` that act as an MCP client and
as a browser. They need the workspace dependencies once (Node 22 with corepack; the first install
downloads about 650 MB of packages and takes a few minutes):

<!-- doc-test: bulk -->
```bash
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm install --frozen-lockfile
```

If you run `corepack enable` once, you can type `pnpm` instead of `corepack pnpm`; it installs
shims into your Node installation, so it is optional.

Log in as alice. The script runs the login against Keycloak and stores the access token in a
variable without printing it. Access tokens live five minutes: when a command answers 401, run the
login again.

<!-- doc-test: bulk -->
```bash
export DEV_PASSWORD=dev-only-password
ALICE_TOKEN="$(node tooling/acceptance/login.mjs "http://localhost:${AIOPS_KEYCLOAK_PORT:-8480}" alice "$DEV_PASSWORD" "http://localhost:${AIOPS_API_PORT:-8400}/mcp")"
```

List the tools alice has. The list is built from her roles: `catalog.search_products` and
`catalog.update_content` from `content_editor`, plus the built-in change-set tools
(`get_changeset`, `submit_for_approval`, `cancel_changeset`, `rollback_changeset`, ...).

<!-- doc-test: bulk -->
```bash
AIOPS_MCP_TOKEN="$ALICE_TOKEN" node tooling/acceptance/mcp-call.mjs "http://localhost:${AIOPS_API_PORT:-8400}/mcp" --list
```

## Prepare the change

Pick a new keyword. The date makes it differ from whatever the products hold now; a product whose
value already equals the new one drops out of the change-set.

<!-- doc-test: bulk -->
```bash
export NEW_KEYWORD="guide $(date -u +%Y%m%dT%H%M%SZ)"
```

Ask for the change on every acme product (`name_like: "%"` matches all names). Nothing is written
yet: the server reads the current values, computes the diff and stores it as an immutable
change-set with a hash. The command prints the summary (`catalog.update_content prepared
change-set <ID>: 3 change(s) to apply, 0 excluded. Nothing was written upstream. ...`) and keeps
the change-set ID.

<!-- doc-test: bulk -->
```bash
PREPARED="$(AIOPS_MCP_TOKEN="$ALICE_TOKEN" node tooling/acceptance/mcp-call.mjs "http://localhost:${AIOPS_API_PORT:-8400}/mcp" --tool catalog.update_content --args "{\"brand\":\"acme\",\"name_like\":\"%\",\"changes\":{\"meta_keyword\":\"$NEW_KEYWORD\"}}")"
node -p 'JSON.parse(process.argv[1]).content[0]' "$PREPARED"
export CHANGESET_ID="$(node -p 'const r = JSON.parse(process.argv[1]).structuredContent; r.changeset?.id ?? r.changesetId' "$PREPARED")"
```

A large change-set can still be `preparing` when the call returns. Read it with `get_changeset`
until it is `prepared`, then keep its hash: every later step names the exact change-set it acts on
by ID and hash.

<!-- doc-test: bulk -->
```bash
for i in $(seq 1 60); do
  CHANGESET="$(AIOPS_MCP_TOKEN="$ALICE_TOKEN" node tooling/acceptance/mcp-call.mjs "http://localhost:${AIOPS_API_PORT:-8400}/mcp" --tool get_changeset --args "{\"changeset_id\":\"$CHANGESET_ID\"}")"
  STATUS="$(node -p 'JSON.parse(process.argv[1]).structuredContent.changeset.status' "$CHANGESET")"
  test "$STATUS" != preparing && break
  sleep 2
done
node -p 'const c = JSON.parse(process.argv[1]).structuredContent.changeset; JSON.stringify({ status: c.status, stats: c.stats, hash: c.hash })' "$CHANGESET"
test "$STATUS" = prepared || { echo "change-set $CHANGESET_ID is $STATUS, not prepared" >&2; false; }
export CHANGESET_HASH="$(node -p 'JSON.parse(process.argv[1]).structuredContent.changeset.hash' "$CHANGESET")"
```

The change-set includes the three acme products, more than the role's `record_threshold` of 2, so
it needs an approval.

## Submit it for approval

<!-- doc-test: bulk -->
```bash
SUBMITTED="$(AIOPS_MCP_TOKEN="$ALICE_TOKEN" node tooling/acceptance/mcp-call.mjs "http://localhost:${AIOPS_API_PORT:-8400}/mcp" --tool submit_for_approval --args "{\"changeset_id\":\"$CHANGESET_ID\",\"hash\":\"$CHANGESET_HASH\"}")"
node -p 'JSON.parse(process.argv[1]).text' "$SUBMITTED"
test "$(node -p 'JSON.parse(process.argv[1]).structuredContent.status' "$SUBMITTED")" = pending_approval
```

The status is now `pending_approval`. The approval request goes to the members of `content_lead`
other than alice.

## Approve it as dave

Approval happens on the trusted page, which the server renders from what it stored, never from
what a model wrote.

1. Open `http://localhost:8400/app/approvals` and log in as `dave` with the password
   `dev-only-password`. The change-set is in the queue; its page is
   `http://localhost:8400/app/changesets/<change-set ID>`.
2. Check the request text, the requester, the policy checks, the statistics and the sample of
   items, and open the full item list if you want.
3. Choose **Approve**. The page sends the hash and the item count you saw, so an approval can only
   apply to exactly that change-set.

Without a browser, the reference scripts do the same as dave: log in to the page, read the
change-set the page shows, check its hash, and approve with that hash and item count.

<!-- doc-test: bulk -->
```bash
DAVE_COOKIE="$(node tooling/acceptance/page-login.mjs "http://localhost:${AIOPS_API_PORT:-8400}" dave "$DEV_PASSWORD" "/app/changesets/$CHANGESET_ID")"
VIEW="$(AIOPS_PAGE_COOKIE="$DAVE_COOKIE" node tooling/acceptance/page-api.mjs "http://localhost:${AIOPS_API_PORT:-8400}" changeset "$CHANGESET_ID")"
test "$(node -p 'JSON.parse(process.argv[1]).body.hash' "$VIEW")" = "$CHANGESET_HASH"
DECIDED="$(AIOPS_PAGE_COOKIE="$DAVE_COOKIE" node tooling/acceptance/page-api.mjs "http://localhost:${AIOPS_API_PORT:-8400}" decide "$CHANGESET_ID" approve "$CHANGESET_HASH" "$(node -p 'JSON.parse(process.argv[1]).body.stats.included' "$VIEW")")"
echo "$DECIDED"
test "$(node -p 'JSON.parse(process.argv[1]).status' "$DECIDED")" = 200
```

With the last approval step done, the worker starts writing.

## Watch it run

Follow the change-set until it reaches a final status. The worker sends the change to Magento's
bulk API and checks the result of every product. The loop logs in again first, because the token
from the start of the page may have expired.

<!-- doc-test: bulk -->
```bash
ALICE_TOKEN="$(node tooling/acceptance/login.mjs "http://localhost:${AIOPS_KEYCLOAK_PORT:-8480}" alice "$DEV_PASSWORD" "http://localhost:${AIOPS_API_PORT:-8400}/mcp")"
for i in $(seq 1 120); do
  CHANGESET="$(AIOPS_MCP_TOKEN="$ALICE_TOKEN" node tooling/acceptance/mcp-call.mjs "http://localhost:${AIOPS_API_PORT:-8400}/mcp" --tool get_changeset --args "{\"changeset_id\":\"$CHANGESET_ID\"}")"
  STATUS="$(node -p 'JSON.parse(process.argv[1]).structuredContent.changeset.status' "$CHANGESET")"
  case "$STATUS" in completed|completed_with_errors|failed|cancelled|expired|rolled_back) break ;; esac
  sleep 2
done
echo "$STATUS"
test "$STATUS" = completed || { echo "change-set $CHANGESET_ID ended the wait with status $STATUS, not completed" >&2; false; }
```

## Check the result in Magento

Ask the shop for the acme products and compare their keywords with the new value. The token is
minted again in case you opened a new terminal; `curl` reads the authorization header from stdin so
the token does not show in the process list.

<!-- doc-test: bulk -->
```bash
export MAGENTO_TOKEN="$(bash deploy/sandbox/magento/token.sh)"
PRODUCTS="$(printf 'authorization: Bearer %s\n' "$MAGENTO_TOKEN" | curl -fsS -g -H @- "http://127.0.0.1:${AIOPS_MAGENTO_PORT:-4390}/rest/all/V1/products?searchCriteria[filter_groups][0][filters][0][field]=brand&searchCriteria[filter_groups][0][filters][0][value]=acme&searchCriteria[filter_groups][0][filters][0][condition_type]=eq")"
node -p 'JSON.parse(process.argv[1]).items.map((p) => p.sku + ": " + p.custom_attributes.find((a) => a.attribute_code === "meta_keyword")?.value).join("\n")' "$PRODUCTS"
test "$(node -p 'JSON.parse(process.argv[1]).items.filter((p) => p.custom_attributes.some((a) => a.attribute_code === "meta_keyword" && a.value === process.argv[2])).length' "$PRODUCTS" "$NEW_KEYWORD")" -eq 3
```

All three products carry the new keyword. The audit page (`http://localhost:8400/app/audit`, as
carol) shows the request, the approval and the batch; it is a browser check, and nothing later
depends on it.

## Roll it back (optional)

A completed change-set can be rolled back to the values recorded before the write. The rollback is
confirmed on the trusted page by the requester, who must have logged in within the last five minutes
(`AIOPS_FRESH_AUTH_SECONDS`, 300 by default); an older page session is asked to log in again:

1. Open `http://localhost:8400/app/changesets/<change-set ID>` as alice.
2. Choose **Roll back 3 items**. The rollback starts at once, without a second confirmation: the
   page sends the hash it shows, the products get their previous keywords back, and the change-set
   ends `rolled_back`.

From an MCP client, `rollback_changeset` checks that a rollback is possible and answers with the
link to this page; it does not roll back by itself.

Without a browser, in the same shell: ask `rollback_changeset` until the rollback is available (it
opens when the change-set's workflow has finished), log in to the page as alice, confirm the
rollback with the hash, and follow the change-set to `rolled_back`.

<!-- doc-test: rollback -->
```bash
ALICE_TOKEN="$(node tooling/acceptance/login.mjs "http://localhost:${AIOPS_KEYCLOAK_PORT:-8480}" alice "$DEV_PASSWORD" "http://localhost:${AIOPS_API_PORT:-8400}/mcp")"
for i in $(seq 1 30); do
  OFFER="$(AIOPS_MCP_TOKEN="$ALICE_TOKEN" node tooling/acceptance/mcp-call.mjs "http://localhost:${AIOPS_API_PORT:-8400}/mcp" --tool rollback_changeset --args "{\"changeset_id\":\"$CHANGESET_ID\",\"hash\":\"$CHANGESET_HASH\"}")"
  test "$(node -p 'JSON.parse(process.argv[1]).structuredContent.rollback.available' "$OFFER")" = true && break
  sleep 2
done
node -p 'JSON.stringify(JSON.parse(process.argv[1]).structuredContent.rollback)' "$OFFER"
ALICE_COOKIE="$(node tooling/acceptance/page-login.mjs "http://localhost:${AIOPS_API_PORT:-8400}" alice "$DEV_PASSWORD" "/app/changesets/$CHANGESET_ID")"
ROLLBACK="$(AIOPS_PAGE_COOKIE="$ALICE_COOKIE" node tooling/acceptance/page-api.mjs "http://localhost:${AIOPS_API_PORT:-8400}" rollback "$CHANGESET_ID" "$CHANGESET_HASH")"
echo "$ROLLBACK"
test "$(node -p 'JSON.parse(process.argv[1]).status' "$ROLLBACK")" = 200
for i in $(seq 1 120); do
  CHANGESET="$(AIOPS_MCP_TOKEN="$ALICE_TOKEN" node tooling/acceptance/mcp-call.mjs "http://localhost:${AIOPS_API_PORT:-8400}/mcp" --tool get_changeset --args "{\"changeset_id\":\"$CHANGESET_ID\"}")"
  STATUS="$(node -p 'JSON.parse(process.argv[1]).structuredContent.changeset.status' "$CHANGESET")"
  case "$STATUS" in rolled_back|failed) break ;; esac
  sleep 2
done
echo "$STATUS"
test "$STATUS" = rolled_back || { echo "change-set $CHANGESET_ID ended the wait with status $STATUS, not rolled_back" >&2; false; }
```

The products have their earlier keywords again: run the query of
[Check the result in Magento](#check-the-result-in-magento) once more to see them.

## Connect Claude or ChatGPT (optional)

The terminal client stands in for an AI client. A real one needs to reach the MCP endpoint and
Keycloak over public HTTPS: run the stack behind a TLS proxy or a tunnel with a real host name, and
set `AIOPS_KEYCLOAK_PUBLIC_URL`, `AIOPS_MCP_RESOURCE` and `AIOPS_PUBLIC_URL` to the public URLs (see
[Production hardening](production.md)).

- **Claude** (claude.ai, Claude Desktop): add a custom connector with the MCP URL, for example
  `https://ops.example.com/mcp`. Claude registers itself with its client metadata document (CIMD),
  which the bundled realm trusts for `claude.ai`.
- **ChatGPT**: add the MCP server with Authentication **OAuth** (not "OAuth or no
  authentication"), registration method **User-Defined OAuth Client**, client ID `aiops-mcp`, no
  client secret, token endpoint auth method `none`. Its automatic registration fails against the
  bundled realm.

Both then show the same login, the same per-user tool list and the same approval flow you used
above.

## Next

[Backup and restore](backup-and-restore.md) before you put real data in, and
[Production hardening](production.md) before real users.
