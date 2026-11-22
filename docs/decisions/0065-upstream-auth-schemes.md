# ADR 0065: Upstream auth schemes: OAuth password grant and OAuth 1.0a

- Status: Accepted
- Date: 2026-11-22

## Context

CONN-3 supports bearer, API key, basic and OAuth client credentials. Some upstreams offer nothing
else than the OAuth resource owner password grant (RFC 6749 section 4.3): the token endpoint takes a
user name and password of a technical user next to the client credentials. This record covers that
grant first; the OAuth 1.0a scheme has its own section below.

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

## OAuth 1.0a

### Context

Magento 2 integrations, among other systems, authenticate with OAuth 1.0a: every request carries a
signature over its method, URL and query, made with the consumer and token secrets. The credential
is therefore not a header value that can be prepared once: it depends on the request.

### Options considered

1. Ask for a pre-signed value. A signature is valid for one URL and one nonce; it cannot be reused.
2. A scheme `oauth1` that signs each attempt in the client (HMAC-SHA256 or HMAC-SHA1).
3. Also support `PLAINTEXT` and RSA-SHA1. `PLAINTEXT` sends the secrets in the header, which a
   server that logs headers records; RSA needs a private key field and a second storage shape.
   Nothing we know of needs them.

### Decision

Option 2. `auth: { scheme: oauth1, signature_method: HMAC-SHA256 | HMAC-SHA1 }`, default
`HMAC-SHA256`. The secret has the fields `consumer_key`, `consumer_secret`, `token` and
`token_secret`.

- `PreparedAuth.header` takes the request (`{ method, url }`). The client and the guarded fetch
  call it once per attempt with the exact URL the transport sends, so a retry has a fresh nonce
  (16 random bytes, hex) and timestamp. The other schemes ignore the argument.
- The signed parameters are the query of the URL and the `oauth_*` parameters (consumer key, nonce,
  signature method, timestamp, token, version `1.0`). Query names and values are form-decoded
  (`+` is a space, a stray `%` stays) and encoded again by the base string rules, so `[` in a name
  such as `searchCriteria[...]` is encoded twice, as the RFC requires. Repeated names sort by value.
- A request body is not part of the signature. The RFC includes a body only when it is
  `application/x-www-form-urlencoded`; the upstream operations of this product send JSON, so the
  case does not arise. A form-encoded body to an `oauth1` connection would fail at the upstream
  with 401.
- The signing key is `enc(consumer_secret)&enc(token_secret)`. The four secret values, the key and
  the encoded secrets are added to the scrubber (SEC-3). The signature in the header is derived and
  not secret; the nonce and timestamp are not secret.
- No token is fetched, so there is nothing to refresh: a 401 is the upstream's answer.
- `oauth1` is refused on `adapter: mcp` connections (a configuration issue at `auth.scheme`, also
  for auth taken from a preset). The MCP SDK transport is not signed; the adapter returns
  `credential_unusable` without sending if it ever sees the scheme.
- `CREDENTIAL_SCHEMES` gains `oauth1` at the end; `AuthSettings` and `SecretMaterial` gain a variant
  at the end; `PreparedAuth` is internal to `adapters`. All additive (SDK 1.1.0, config 1.1.0).

### Consequences

- A consumer that switches over `AuthSettings` or `CredentialScheme` without a default needs a case
  for the new member.
- A clock far from the upstream's makes the upstream refuse the timestamp; the signer uses the
  server clock and no offset.
- HMAC-SHA1 is offered for upstreams that accept nothing else; HMAC-SHA256 is the default.

## Verified

2026-11-22, against RFC 6749 (rfc-editor.org): section 4.3.2 lists `grant_type=password`, `username`,
`password` (required) and `scope` (optional), form-encoded in UTF-8 per appendix B, and requires
client authentication for a confidential client. Section 2.3.1 has the Basic header carry the
form-encoded id and secret, allows `client_id` and `client_secret` in the body and marks that
NOT RECOMMENDED. Section 4.3.3 returns a token response as in 5.1; the client credentials code
already parses it. Unit tests assert the exact request bodies and headers for both client
authentication modes, including `a&b=c` and `p +ü`.

2026-11-22, against RFC 5849 (rfc-editor.org): section 3.4.1.1 builds the base string as the upper-case
method, `&`, the encoded base string URI and `&`, the encoded normalized parameters; its example
request gives `POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D...`.
Section 3.4.1.2 lower-cases scheme and host and drops the default port. Section 3.4.1.3.2 encodes names
and values, sorts by name and then value in byte order and joins them as `name=value` with `&`.
Section 3.4.2 gives the key as the encoded client secret, `&`, the encoded token secret, the `&`
kept when a secret is empty. Section 3.5.1 gives `OAuth ` followed by `name="value"` pairs of
encoded names and values separated by commas. Section 3.6 encodes UTF-8 bytes except ALPHA, DIGIT
and `-._~`, with upper-case hex. A unit test reproduces the example's base string for its query and
oauth parameters (the RFC example also has a form body, which this signer does not sign; the expected
string is the RFC text without the two body parameters) and recomputes each signature with
`node:crypto`. HMAC-SHA256 is not in RFC 5849, which defines HMAC-SHA1, PLAINTEXT and RSA-SHA1: it
is the same construction with SHA-256 and `oauth_signature_method=HMAC-SHA256`, as widely
deployed; no test here runs against a live upstream.
