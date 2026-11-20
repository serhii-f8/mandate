# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x (latest minor) | Yes: security fixes |
| Earlier than 1.0 | No |

## Reporting a vulnerability

Report privately through GitHub private vulnerability reporting: open the repository's
**Security** tab, choose **Report a vulnerability** and fill in the form. Do not open a public
issue or pull request for a vulnerability. No e-mail address is published.

Please include:

- the affected version or commit and how it was deployed (shipped Compose, own deployment);
- what an attacker needs (role, network position, credentials) and what they gain;
- steps or a minimal configuration to reproduce, and any proof of concept;
- logs or traces with secrets and tokens removed.

Response targets: acknowledgement within 5 working days, a first assessment (accepted, declined,
or need more information) within 15 working days. We fix accepted issues in a supported version and
release them with an advisory.

## Coordinated disclosure

Please give us a reasonable time to fix before you publish. We agree a disclosure date with you,
credit you in the advisory if you wish, and publish the advisory when the fix is released.

## Scope

In scope: the platform code in this repository (`api`, `worker`, `web`, packages and presets) and
the shipped Compose stack and Keycloak realm.

Out of scope: upstream business systems, third-party MCP servers that an installation connects to,
the operator's own infrastructure and configuration choices (for example a weak production
secret), and findings that need an already compromised host or administrator account.

## Security model in brief

- Default deny: every tool call and page request is authorized server-side per role; new routes and
  tools are denied until granted.
- No model in the trust path: permission checks, diffs, approval views and execution are
  deterministic server code. Upstream content is data, never instructions.
- Writes are prepared as immutable, hash-identified change-sets and need human approval.
- Upstream credentials live encrypted in the credential vault and never reach logs, audit, tool
  results or workflow history. The user's access token is never forwarded upstream.
- Every decision is written to an append-only, hash-chained audit log.
- Endpoints are rate limited, and the limits are shared across instances.

Details for operators are in the production guide in the project documentation.
