# ADR 0075: File arguments

- Status: Accepted
- Date: 2026-11-23

## Context

A script-driven catalog workflow also sends files: a product image, an attachment, an import
sheet. Mandate cannot. Arguments are JSON that travels through the model, request bodies are JSON
only, and nothing binary exists anywhere in the product. A file pushed through the model as
base64 is slow, limited to small sizes, lands in the model's context, and the approver would see a
wall of characters instead of the picture they are asked to approve.

The goals are: a person uploads a file to the platform once, outside the model; a tool call names it
by ID; the change-set seals exactly those bytes (their SHA-256); the approver sees what the file is
before approving; the worker sends exactly the sealed bytes, as base64 inside a JSON body or as a
multipart part. It stays generic: declared per operation, no system-specific code.

Non-goals, each a later plan if wanted: file arguments on manifest (diff) operations, so no
per-record files; MCP-backed and code operations; a raw binary request body; fetching a file from a
URL; uploads by service accounts (they have no page session); staging through an MCP tool or a
widget; optional files and files inside arrays; malware scanning; encryption of file content at rest
(it is business data like item values, which are stored plain); chunked or resumable uploads.

Anti-goals: bytes other than the approved ones being sent; an uploaded file served back as active
content on the platform's origin; a process from before the upgrade sending the stored file
descriptor upstream as JSON; file content in a log, the audit, a tool result, a notification or
workflow history (SEC-3).

## Options considered

How the bytes reach the platform:

1. **Upload on a trusted page, referenced by ID.** `POST /api/v1/files` behind the page session and
   CSRF; the tool call carries the file's UUID. The bytes never pass the model, the size limit is the
   platform's, and the upload is tied to a logged-in person.
2. **Base64 in the tool arguments.** Nothing to build on the way in, but everything in Context.
3. **A `stage_file` tool called by a widget over the MCP Apps bridge.** Stays in the chat and skips
   the model, but depends on each host's bridge size limits and adds a second upload path. Left for
   later.

Where the bytes live:

1. **PostgreSQL `bytea`.** The only store the stack has; the reference, the quota check and the
   change-set link are one transaction; backup is the database backup. Limit 25 MiB a file.
2. **An object store.** Right for large files, but a new dependency, new credentials and a second
   thing to keep consistent with the change-set.

How the hash binds the file:

1. **A descriptor in the stored arguments.** At creation the platform replaces the file ID in the
   arguments with `{ "$file": { id, name, media_type, size, sha256 } }`. The opaque item's `after` is
   the arguments, so the existing hash covers the content hash, and the approver reads it in "Raw
   arguments" exactly where it will be sent. Sealed with hash version 3, which differs from 2 only in
   its format string, so an old process refuses it (`hash_mismatch`) instead of sending the
   descriptor.
2. **The file list in the hash header.** A second place for the same fact, and the arguments would
   still need a placeholder.

## Decision

Option 1 in each of the three questions.

**Declaring (OPS-8).**

- Operation key `files`, 1 to 5 entries, on an opaque operation with an HTTP binding only
  (`write_opaque`, or `destructive` without a manifest; not MCP-backed, not code) **(call)**. Each
  entry has `at`, `send` (`base64` or `multipart`), `media_types` (1 to 20 declared types the caller
  may send), an optional `max_bytes` (1 to `files.max_bytes`, default `files.max_bytes`) and, for
  multipart, `part` (default: the argument name).
- `at` is a path of 1 to 8 property names, each `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, written `/a/b/c`; no
  array index, no `~` escape **(call)**. Paths are distinct and none is a prefix of another.
- The operation needs an explicit `input_schema`. Along the path every parent is `type: object` with
  the next name in `required`, and the leaf is exactly `{ type: string, format: uuid }` (plus
  `title` and `description`). So a file argument is always present **(call: no optional files)**.
- All entries of one operation use the same `send`. With `multipart` each path has one segment,
  `part` matches `^[A-Za-z0-9_.-]{1,64}$` and is unique; `part` is refused with `base64`.
- `media_types` entries match
  `^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$`.
- A grant `scope` must not name an argument that is a one-segment file path (it could never match).
- Global settings, at most one document: `files.max_bytes` (1 to 26214400, default 10485760),
  `staged_ttl_hours` (1 to 720, default 24), `keep_days` (0 to 365, default 7), `per_user_count`
  (1 to 1000, default 50), `per_user_bytes` (1 to 10737418240, default 262144000).

**Staging (CS-10).**

- **Upload.** `POST /api/v1/files`, page session, `Origin` and CSRF. The body is the raw bytes;
  `Content-Type` is the declared media type (parameters dropped, lower-cased); `X-File-Name` is the
  percent-encoded UTF-8 name: 1 to 255 code points, no control character, no `/` or `\`, not `.` or
  `..`. Allowed only when a role of the user grants at least one operation that declares `files`
  (403 `forbidden` otherwise; routes are denied by default). Fixed refusals: 400 `invalid_name`,
  `invalid_media_type`, `empty_file`; 413 `payload_too_large` (above `files.max_bytes`); 409
  `quota_exceeded`. Answer 201: `{ id, name, mediaType, size, sha256, preview, createdAt,
  expiresAt }`. Audited as `file.staged` with id, size, media type and hash; never the name or
  content **(call)**.
- **Stored** in `staged_file`: id, owner (subject), client, name, media type, size,
  `sha256:<hex>`, `preview`, content (`bytea`), created, purged. A trigger allows one change only:
  content to NULL together with `purged_at`. The media type is what the uploader declared; it is
  never trusted for serving. The preview kind is decided by the server from the bytes: an image only
  when the leading bytes are that image's PNG, JPEG, GIF or WebP signature, text only for
  `text/plain`, `text/csv` and `application/json` whose first 65536 bytes hold no NUL and decode as
  UTF-8.
- **Quota** is counted over the owner's files that still have content, inside the insert's
  transaction under a per-owner advisory lock, so two uploads at once cannot both pass.
- **Listing.** `GET /api/v1/files`: the user's own files with content, newest first, at most 200.
  A new built-in tool `list_staged_files` (MCP-11), visible to the same callers as the upload,
  answers the upload page URL and the same list, so the model can find the ID after the person
  uploaded. Metadata only.
- **A file belongs to its uploader.** Only the owner can name it in a call. It can be used by any
  number of the owner's change-sets while it has content.
- **Lifetime.** A worker job (hourly, beside the audit jobs) removes content when the file has no
  change-set and is older than `staged_ttl_hours`, or when every change-set using it is in a final
  status (`completed`, `completed_with_errors`, `failed`, `rejected`, `expired`, `cancelled`,
  `rolled_back`) and the latest of them ended more than `keep_days` ago. The row and its metadata
  stay. The job locks candidates `FOR UPDATE SKIP LOCKED` and re-checks "no live change-set" in a
  second statement of the same transaction; creation locks the file rows `FOR SHARE` before it links
  them, so a file is never purged under a change-set being created. One audit event `files.purged`
  per run that removed something, with the count.

**Sealing (amends CS-4 and MCP-3; part of CS-10).**

- The tool call passes the file's UUID at each declared path, schema-validated as today. In
  `createChangeSet`, for an operation with `files`: each ID (lower-cased) is looked up; the file must
  exist, belong to the caller and have content, else `file_not_found` (one code for all three,
  SEC-1); its size must not exceed the entry's limit (`file_too_large`); its declared media type must
  be in `media_types` (`file_type_not_allowed`). The call is refused before anything is created, with
  the path in the answer, never the name of someone else's file.
- The stored arguments carry, at the path, `{ "$file": { "id", "name", "media_type", "size",
  "sha256" } }`, with no other key at either level. The change-set row is created together with its
  `change_set_file(change_set_id, pointer, file_id)` rows in one transaction; a file that vanished
  meanwhile refuses the creation (`file_not_found`). The record the repository returns carries
  `files: [{ pointer, fileId }]`, ordered by pointer.
- A change-set with files is sealed with **hash version 3**: header
  `{ format: 'mandate.changeset.v3', operation, action, args }`, items as before. Change-sets without
  files keep version 2, so nothing changes for them. Version 3 is known to this release for
  verification; an older process treats it as unknown and fails closed.
- **Execution guard**, before the policy re-evaluation: the paths of the operation's `files` under the
  current configuration must equal the stored paths, and each stored argument at a path must be the
  descriptor of the linked file (`policy_denied` otherwise: the operation changed); each file's stored
  content must be present and hash to the descriptor's `sha256` (`hash_mismatch` otherwise: what was
  approved is not what is stored) **(call: no new guard outcome; a live change-set never loses its
  file by purge)**. An operation that has `files` now while the change-set has none, or the reverse,
  is `policy_denied`.

**In this step** the pure rules live in `packages/core/src/files`: the model, the descriptor and
path helpers, the resolution of call arguments (`resolveFileArgs`), the guard's comparison
(`storedFilesMatch`), the preview kind and the `FileStore` port. Core hashes with `node:crypto`, as
`changeset/hash.ts` does.

## Consequences

- A person can attach a real file to a write without it passing the model, and the approver sees what
  it is before approving.
- The approval covers the file's bytes through their hash: changing them after approval fails the
  guard.
- Content lives in the database, so backups grow with staged files and 25 MiB is the ceiling per file;
  an object store is a later option behind the same `FileStore` port.
- A file is the uploader's alone; sharing a file between people means uploading it again.
- A purged file keeps its metadata, so an old change-set still names what it sent.
- Optional files, files in arrays and files on manifest operations need a later plan.
- A process from before the upgrade refuses a version 3 change-set instead of sending the descriptor.

## Verified

2026-11-23: core unit tests (`files/file-args.test.ts`, `files/preview.test.ts`) cover the file name
and media type rules, the SHA-256 of empty content, resolution (another owner, purged, non-UUID,
unknown, too large, wrong type, declaration order, link order, input not mutated), the guard
comparison, the exact descriptor shape and the preview kind (image only when type and bytes agree,
SVG and HTML never, NUL and invalid UTF-8 are not text, a character cut at byte 65536 is text).
