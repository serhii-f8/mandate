# Roles and approvals

A role says which operations its members may call, on which records, which fields they never see,
and when a change needs a person's approval. Users get roles through their Keycloak groups. This
page adds a role for content editors of one brand and checks it before anyone uses it.

You need the stack and the working copy `my-config/` from [Connecting Magento](connecting-magento.md).

## The configuration workflow

Configuration is a directory of YAML files. The stack does not read the files while it runs; it
runs an active **revision** stored in PostgreSQL. Changing the configuration always takes three
steps:

1. Edit the files in your working copy (`my-config/`, mounted into the containers at
   `/etc/mandate/config`).
2. `config diff` compares the files with the active revision and lists what would change.
3. `config apply` validates the files and stores them as the new active revision. Every apply is
   audited with the actor you name. The running `api` and `worker` follow the new revision within
   seconds, without a restart.

`config explain` then answers "would this group be allowed to make this call?" against the active
revision, without calling anything.

## Write the role

The role `content_editor` lets the group `content` search and update the acme products only. It
never returns or accepts the `cost` field. A change to more than two products needs one approval by
a member of `content_lead`:

```yaml
  - id: content_editor
    description: Edits the content of acme products.
    grants:
      - operation: catalog.search_products
        id: acme-search
        scope: { brand: [acme] }
        deny_fields: [cost]
      - operation: catalog.update_content
        id: acme-content
        scope: { brand: [acme] }
        deny_fields: [cost]
    approval: { required: above_threshold, record_threshold: 2, steps: [{ role: content_lead }] }
```

- `grants` lists the operations. A grant's `scope` constrains call arguments: here `brand` must be
  `acme`, so a call for any other brand is denied before anything reaches Magento.
- `deny_fields` removes fields from results and refuses them in changes.
- `approval` decides when a prepared change needs a person. `above_threshold` with
  `record_threshold: 2` means a change of three or more products waits for approval; smaller
  changes start as soon as the requester submits them. Each entry in `steps` is one approval
  round by a member of the named role; the requester never approves their own change.

The development configuration maps the group `content` to the broader role `content_manager`
(three brands, approval above 25 products). Lists in configuration files add up across files, so
adding a second file could not take that mapping away. Replace the whole roles file instead. The
file [`examples/guide/roles.yaml`](../../examples/guide/roles.yaml) holds the development roles,
the new `content_editor`, and a mapping of the group `content` to `content_editor` only.
`content_manager` stays defined, but no group maps to it.

<!-- doc-test: role -->
```bash
cp examples/guide/roles.yaml my-config/roles.yaml
```

The complete file:

```yaml
# Roles of the guide (docs/guide/roles-and-approvals.md): the development roles plus
# content_editor. The group `content` now maps to content_editor only. content_manager stays
# defined but no group maps to it, so `config explain` for the group `content` has one answer.
version: 1
roles:
  # Edits the content of the acme products. Changes to more than two products need one approval
  # by a content lead.
  - id: content_editor
    description: Edits the content of acme products.
    grants:
      - operation: catalog.search_products
        id: acme-search
        scope: { brand: [acme] }
        deny_fields: [cost]
      - operation: catalog.update_content
        id: acme-content
        scope: { brand: [acme] }
        deny_fields: [cost]
    approval: { required: above_threshold, record_threshold: 2, steps: [{ role: content_lead }] }
  - id: content_manager
    description: Edits product content.
    grants:
      - operation: catalog.search_products
        id: own-brands
        scope: { brand: [acme, globex, umbrella] }
        deny_fields: [cost]
      - operation: catalog.update_content
        id: own-brands-content
        scope: { brand: [acme, globex, umbrella] }
        deny_fields: [cost]
    approval: { required: above_threshold, record_threshold: 25, steps: [{ role: content_lead }] }
  - id: support_agent
    grants:
      - operation: support.lookup_order
  - id: integration_admin
    description: Enters and rotates upstream credentials on the trusted credential page (SEC-1, UI-5).
    grants: []
    manage_credentials: [magento-integration]
    view_audit: true
  - id: content_lead
    description: Approves content changes (APR-1).
    grants: []
role_mapping:
  - group: content
    roles: [content_editor]
  - group: support
    roles: [support_agent]
  - group: admins
    roles: [integration_admin]
  - group: content-leads
    roles: [content_lead]
```

## Route price changes to another approver

One role can send different changes to different approvers. `field_rules` lists fields and the
rule that applies when a call touches one of them; the first matching entry replaces the role's
rule. A content change goes to the content lead, a change that touches `price` to the pricing
owner:

```yaml
  - id: content_editor
    grants:
      - operation: catalog.update_content
        scope: { brand: [acme] }
    approval:
      required: always
      steps: [{ role: content_lead }]
      field_rules:
        - fields: [price]
          required: always
          steps: [{ role: pricing_owner }]
```

A change of `name` alone waits for `content_lead`; a change that includes `price` waits for
`pricing_owner` only. A grant can carry its own `approval`, which replaces the role's for the calls
that grant allows. The operation needs `fields_arg` (a manifest operation uses its `values_arg`).
`config explain` with `--args` naming `price` in `changes` prints the approval line with the steps
that apply. If the fields of a call cannot be read, the first field rule applies.

## Review and apply

See what would change:

<!-- doc-test: role -->
```bash
docker compose exec -T api node dist/cli.js config diff /etc/mandate/config
```

The output lists the added role and the role that lost its mapping, then the old and new
configuration hash:

```
+ role content_editor
~ role content_manager: mapping
hash <old> -> <new>
```

Apply it:

<!-- doc-test: role -->
```bash
docker compose exec -T api node dist/cli.js config apply /etc/mandate/config --actor guide
```

If the files are invalid, `config apply` prints the errors, exits with 1, and the active revision
stays as it was.

## Check the role with `config explain`

Ask whether the group `content` may change the keywords of three acme products. The answer names
the rule that allowed it and the approval the change would need (`--records 3`). Exit code 0 means
allowed:

<!-- doc-test: role -->
```bash
docker compose exec -T api node dist/cli.js config explain --operation catalog.update_content --groups content --args '{"brand":"acme","skus":["ACME-001","ACME-002","ACME-003"],"changes":{"meta_keyword":"spring"}}' --records 3
```

The same call for the brand `globex` is denied: no grant of `content_editor` covers it. Exit code 1
means denied; the commands below expect it:

<!-- doc-test: role -->
```bash
code=0
docker compose exec -T api node dist/cli.js config explain --operation catalog.update_content --groups content --args '{"brand":"globex","skus":["GLOBEX-001"],"changes":{"meta_keyword":"spring"}}' || code=$?
test "$code" -eq 1
```

## Users and groups in Keycloak

The walkthrough uses the users of the development realm: alice is in `content` and
`content-leads`, dave is in `content-leads`. Keycloak shows group paths with a leading slash
(`/content`); `role_mapping` names the group without it. With the new mapping alice is a `content_editor` (and
a content lead, who cannot approve her own changes), and dave approves.

On a real installation you manage people in the Keycloak admin console:

1. Open the admin console (`http://localhost:8480/admin` in development) and switch to the realm
   `mandate`.
2. **Groups > Create group**: create a group per team, named as in `role_mapping` (for example
   `content` and `content-leads`).
3. **Users > Add user**: enter the username and email, then on the **Credentials** tab set a
   password, or let the user set one through your identity provider.
4. On the user's **Groups** tab, **Join group** and choose the groups.

The access token carries the group names; a change to a user's groups applies from their next
login.

## Next

[Your first bulk update](first-bulk-update.md).
