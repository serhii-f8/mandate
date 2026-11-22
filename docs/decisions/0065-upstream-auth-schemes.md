# ADR 0065: Upstream auth schemes: OAuth password grant and OAuth 1.0a

- Status: Accepted
- Date: 2026-11-22

## Context

CONN-3 supports bearer, API key, basic and OAuth client credentials. Some upstreams offer nothing
else than the OAuth resource owner password grant (RFC 6749 section 4.3): the token endpoint takes a
user name and password of a technical user next to the client credentials. This record covers that
grant; the OAuth 1.0a scheme is added to it separately.

## Options considered

1. Do not support it and ask for a token to be pasted as a bearer credential. The token expires and
   nobody renews it.
2. Add a scheme `oauth_password` that reuses the token cache of the client credentials scheme with a
   different grant.
3. Add refresh token handling so the password is used once.

## Decision

Option 2. `auth: { scheme: oauth_password, token_url, scopes: [], client_auth: basic | body }`;
`client_auth` defaults to `basic`. The secret has the fields `client_id`, `client_secret`,
`username` and `password`, stored like any other credential (ADR 0019).

- `basic` authenticates the client with `client_secret_basic`: the form-encoded id and secret in a
  Basic header. `body` sends `client_id` and `client_secret` as form fields and no
  `Authorization` header, for token endpoints that do not take the header.
- The request is `grant_type=password`, `username`, `password` and, when scopes are configured,
  `scope`, all form-encoded (UTF-8). A 4xx answer is `credential_unusable`, a 5xx answer is
  `http_status`, as for client credentials.
- No refresh token is used. On expiry or an upstream 401 the token is fetched again with the
  stored password, exactly as for client credentials, so nothing but the credential is persisted.
- The token cache fingerprint covers grant, user name, password and client authentication, so a
  rotated password never reuses a token of the old one.
- The password, the client secret, their form-encoded forms, the Basic pair and the fetched token are
  added to the scrubber. The user name is an identifier and is not, as for basic.
- The token URL host joins the allowed hosts of the connection. Token requests are not paced (ADR 0064).
- `CREDENTIAL_SCHEMES` gains `oauth_password` at the end and `AuthSettings` a variant, both additive
  (SDK 1.1.0); the configuration schema gains the scheme and `client_auth` (config 1.1.0).

## Consequences

- The configuration holds a user's password on the server. The guide marks the scheme "for
  upstreams that offer nothing else": OAuth 2.1 removes the grant, and a technical user with narrow
  rights is the way to use it.
- A consumer that switches over `AuthSettings` or `CredentialScheme` without a default needs a case
  for the new member (the caveat of the versioning guide).
- The Basic header cannot carry a client id with a colon unambiguously; that is the RFC's rule, not ours.

## Verified

2026-11-22, against RFC 6749 (rfc-editor.org): section 4.3.2 lists `grant_type=password`, `username`,
`password` (required) and `scope` (optional), form-encoded in UTF-8 per appendix B, and requires
client authentication for a confidential client. Section 2.3.1 has the Basic header carry the
form-encoded id and secret, allows `client_id` and `client_secret` in the body and marks that
NOT RECOMMENDED. Section 4.3.3 returns a token response as in 5.1; the client credentials code
already parses it. Unit tests assert the exact request bodies and headers for both client
authentication modes, including `a&b=c` and `p +ü`.
