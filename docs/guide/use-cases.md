# Use cases

These are situations the server was built for. The first two run today with the presets in the
repository; the others use the generic adapters and need only configuration for your own system.

## Bulk content changes in an online shop

**Situation.** A content manager wants new meta titles and keywords on a few hundred products
before a campaign. Today that is a spreadsheet import, a developer ticket, or an afternoon of
clicking in the shop's admin.

**With the server.** The manager asks their AI client in plain language. The Magento catalog
preset selects the products of the brands the manager's role covers, reads their current values
and prepares a change-set. The manager checks the diff, removes the products that should stay as
they are and submits. A content lead approves on the trusted page. The worker writes through
Magento's bulk API and reports per product. If the campaign text was wrong, the manager rolls the
change back to the recorded values.

**What makes it safe.** The role limits the brands and hides the `cost` field. Changes above a
record threshold need a second person. The approver sees the stored diff, not the model's
description of it.

Walkthrough: [Your first bulk update](first-bulk-update.md).

## Issue triage in a tracker

**Situation.** A support lead wants to label, close or comment on a batch of issues, without
giving an AI client a personal access token for the tracker.

**With the server.** The Gitea issues preset offers search, title and state updates, labels and
comments. Title, state and label changes are prepared per issue with a diff and can be rolled back. A comment
cannot be previewed as a diff or undone, so it is an opaque write: the approver sees the exact
arguments, approval is always required, and the call is sent at most once.

## Read access for support staff

**Situation.** Support agents should look up orders from their AI client, but must not see cost
prices or change anything.

**With the server.** Attach the order API through its OpenAPI document, grant the role one read
operation, and list the fields it must never return. The agents' tool list contains that one
operation. Every lookup is audited with the agent's identity.

Reference: [Configuration reference](configuration.md).

## Putting an existing MCP server behind approval

**Situation.** A vendor ships an MCP server for their product. It works, but it exposes every tool
to everyone who connects, and its tools can change without notice.

**With the server.** Attach the vendor's server as an upstream. You choose which of its tools
become operations, who gets them, and which need approval. Each tool is pinned to a hash of its
definition: if the vendor changes a tool's description or schema, calls stop until a person
reviews the change and pins it again. Users see your description of the tool, not the vendor's.

Guide: [MCP upstreams](mcp-upstreams.md).

## Automation that still needs a person

**Situation.** A nightly job or a CI pipeline should propose changes, such as fixing product
attributes that fail a quality check, but nobody wants an unattended process writing to
production.

**With the server.** The job uses a service account with exactly one role. It prepares and submits
change-sets like a user. It cannot approve: a person decides on the page the next morning, and the
write happens after that.

Guide: [Service accounts](service-accounts.md).

## One controlled entry point for AI clients

**Situation.** Different teams have started connecting AI clients to business systems, each with
its own tokens pasted into client settings. Nobody can say who can do what, or what was done.

**With the server.** Employees connect their client to one endpoint and log in with the company
identity provider. Credentials for business systems exist only in the server's vault. Roles are
files in version control, reviewed like code. The audit log answers who asked for what, who
approved it, and what was written, and it can be verified and exported.

## A new system of your own

Any REST API with an OpenAPI document can be attached without code: reads work immediately, and a
write gets preview, batching and rollback from a declarative manifest. APIs that do not fit a
manifest can use code operations in a preset package. The repository has a template with contract
tests.

Guide: [Presets](presets.md).

## What it is not for

- **A general admin panel.** The user interface covers approval, credentials, audit and change-set
  detail. Everything else is configuration as code.
- **Several organizations in one installation.** One installation serves one organization.
- **Direct database access.** Business systems are reached through their APIs or MCP servers.
- **Deciding what a change should be.** The server controls and records changes; the business
  system still validates the data.
