# ADR 0076: Multipart sending

- Status: Accepted
- Date: 2026-11-23

## Context

[ADR 0075](0075-file-arguments.md) lets an opaque operation take staged, hash-sealed file arguments.
`send: base64` puts the content into the JSON body and needs nothing new in the connector SDK. Many
upstreams take a file only as a `multipart/form-data` part (an attachment, an image upload), so the
second way to send must be a request body that is not JSON and not a string.

Three things hold the design in place. The request is still sent once and the idempotency key and
the resend rule stay as they are (EXE-4). The bytes sent are the bytes the change-set sealed, so the
adapter receives them as bytes and never as text. And an adapter built against an older SDK must
never send a call without its file: a call target it does not know must send nothing.

## Options considered

How the adapter learns that a call has files:

1. **A new call target `http_multipart` with the file parts.** `CallTarget` gains
   `{ kind: 'http_multipart', mapping, parts }` and the SDK exports `FilePart`. The OpenAPI adapter
   already answers `not_sent` for a target other than `http`, so an adapter that predates the kind
   sends nothing. Additive (SDK 1.4.0).
2. **Parts on the existing `http` target.** An optional `parts` on `{ kind: 'http' }`. An adapter
   built against 1.3 would ignore the unknown key and send the request without its file. Rejected.
3. **Multipart assembled by the worker and passed as a body.** The adapter would receive finished
   bytes and a content type: a second raw-body path through the SDK, and the adapter could no longer
   apply its pre-flight to the headers it did not build. Rejected.

How the body is written:

1. **By hand, per RFC 7578.** Short, covers exactly what is needed, and every byte is under test. The
   test writes the expected literal out and also reads the body back with Node's own parser.
2. **`FormData` and `Blob` from the platform.** It chooses its own boundary and escaping and would
   add an in-memory copy; the layout would not be pinned by a test.
3. **A multipart library.** A new dependency for forty lines.

## Decision

Option 1 in each question.

- **The SDK** (since 1.4.0, additive). `FilePart { name, filename, mediaType, content: Uint8Array }`
  and the third `CallTarget` member `{ kind: 'http_multipart', mapping, parts }`. No existing member
  changes. The semver gate reports it as additive; the API report is regenerated.
- **Layout** (`multipartBody(fields, parts, boundary)`): the text fields first in key order, then the
  file parts in order. Each part is `--<boundary>\r\nContent-Disposition: form-data;
  name="<name>"[; filename="<filename>"]\r\n[Content-Type: <mediaType>\r\n]\r\n<bytes>\r\n`, and the
  body ends with `--<boundary>--\r\n`. The boundary is `mandate-` and 32 hex digits from
  `randomBytes(16)`, new for every request; file content is never searched or altered, so content
  that contains a boundary-like line is carried as data and a random boundary does not occur in it
  in practice.
- **Escaping.** In `name` and `filename` a `"` becomes `%22`, a CR `%0D` and an LF `%0A` (the rule
  of the HTML form-data encoding); the file name is otherwise written as UTF-8. A file name can
  therefore neither end its header line nor begin another header or part **(call: percent escapes,
  not RFC 5987 `filename*`; the common receivers read `filename` as the browsers write it)**. A text
  field name or part name must match `^[A-Za-z0-9_.-]{1,64}$`, else the call is a mapping failure
  (`MappingError`, nothing sent); the configuration already restricts `part` to the same pattern.
- **What `callOnce` does with the target.** The same pre-flight as `http` (an unsafe method or a
  bulk mapping is `not_sent`). The request is built from the mapping with its `body` template
  removed. When the mapping has a `body` template it is resolved as `buildRequest` resolves it; it
  must render a plain object whose every value is a string, number or boolean, and these become the
  text fields. Anything else (an array, a nested object, `null`) is a mapping failure, `not_sent`,
  and `beforeSend` is not called. Empty `parts` is `not_sent` too: a multipart call exists to send a
  file. `content-type` is `multipart/form-data; boundary=<boundary>`, `accept` stays, and the
  idempotency header, header checks, `beforeSend`, `discardBody` and the classification of the
  outcome are exactly those of `http`. It is never retried.
- **The client.** `HttpRequestSpec.body` is `string | Uint8Array`; `content-length` is the byte
  length of either. OAuth 1.0a signs method, URL and query only, so the body is not in the
  signature base string (RFC 5849 section 3.4.1.3 takes a body parameter only from an
  `application/x-www-form-urlencoded` body).
- **Unknown kinds.** The OpenAPI adapter answers `not_sent/mapping` for any kind it does not list,
  and the MCP adapter for any kind but `mcp`; the composite adapter routes by connection kind and so
  adds no path of its own. An adapter built against SDK 1.3 is the same case: `http_multipart` is a
  kind it does not know, so no request leaves.
- Wiring the worker's opaque caller to this target is a separate step; until then the caller
  refuses `send: multipart` as `file_unavailable`.

## Consequences

- A preset keeps working. The bundled adapters refuse the new kind, which the worker reports as
  `not_sent`. A third-party adapter stays safe only if it answers `not_sent` for any `target.kind` it
  does not handle: one that narrows with `kind === 'http' ? ... : target.tool`, or was compiled
  against 1.3, would read `http_multipart` as `mcp` and could send a call without its file. This is
  the exhaustive-handling case that `docs/guide/versioning.md` leaves to review; the SDK's
  `CallTarget` comment and that guide say so.
- Files are held in memory twice at most (the stored content and the assembled body), bounded by the
  global `files.max_bytes` (at most 25 MiB) and five files per operation.
- A text field value that contains a line looking like the boundary cannot end its part, because the
  boundary is random per request and not derivable from the content.
- A backslash in a file name is sent as is: the WHATWG form-data rule escapes only `"`, CR and LF.
- Upstreams that need `filename*` or another encoding for non-ASCII names are not served; a later
  option on the declaration would add it.

## Verified

2026-11-23: `multipart.test.ts` writes the expected body for one field and one part out by hand and
compares bytes; a file name `a"b\r\nX-Evil: 1.png` is one `Content-Disposition` line (`a%22b%0D%0AX-Evil:
1.png`) with no injected header and as many separators as parts; `café.png` is UTF-8 bytes; content
holding `\r\n--B--\r\n` is carried unchanged and Node's `Response.formData()` reads the right fields and
file back for a boundary from `newBoundary()`. `adapter.call.test.ts` sends through the real client to
the fake upstream: content type, `content-length`, idempotency header, the text fields and the file
read back; a non-scalar field, an array body and empty `parts` are `not_sent` with `beforeSend`
never called; 2xx, 422, 5xx and a timeout are `accepted`, `refused`, `unknown`, `unknown` with one
request each. The MCP adapter answers `not_sent/mapping` for the kind, and `client.test.ts` verifies
an OAuth 1.0a multipart request with a verifier that sees method, URL and query only.
