# ADR 0064: Per-connection pacing of upstream requests

- Status: Accepted
- Date: 2026-11-22

## Context

CONN-6 bounds the time, the retries and the concurrency of a connection, but not the rate. An
upstream that allows a few requests per second answers a burst of four concurrent reads with 429,
and each retry adds load. A `Retry-After` the client honoured delayed only the call that received
it; a concurrent call on the same connection went on sending.

## Options considered

1. A token bucket with a burst size.
2. A fixed minimum interval between request starts, booked in arrival order.
3. Leave pacing to the upstream's 429 and the existing backoff.

## Decision

Option 2. A connection may set `rate.requests_per_second` (0.01 to 1000); the loader turns it into
`ConnectionSettings.minIntervalMs` (`ceil(1000 / value)`, optional, since SDK 1.1.0). A `Pacer` per
connection id keeps the next free start time. `reserve(now, maxWaitMs)` books a slot
synchronously, so callers that arrive together get distinct slots in order, and returns the wait,
or `undefined` with nothing booked when the wait would exceed `maxWaitMs`.

The HTTP client and the MCP adapter reserve after the semaphore slot is held, before each attempt,
so a retry is paced like a first attempt. The bound is the connection timeout; a refused
reservation is the same `busy` failure as a semaphore wait that times out. The wait does not count
against the attempt's own timeout. The OAuth token request is not paced. A connection without
`rate` still has a pacer, because a `Retry-After` the client honours calls `holdUntil` and so holds
every later request of the connection until then.

## Consequences

- No burst: the first request starts at once, the next ones are spaced.
- A request waits while holding its concurrency slot, so a low rate with a high `max_concurrency`
  fills the slots with waiting calls; the timeout bounds that.
- The state is per process. With several `api` or `worker` instances each paces separately and the
  upstream sees up to the rate times the number of instances. A shared limiter is not built.
- Only the HTTP client reads `Retry-After`; the MCP adapter paces by interval and keeps its backoff.
- The MCP adapter reserves one slot per attempt of a tool operation (a tool list, a tool call, a
  call-once), not per HTTP request. One operation can be several requests (`initialize`, the
  initialized notification, the call, the session `DELETE`), so the upstream can see more requests per
  second than the rate during an operation; the rate bounds how often operations start.

## Verified

2026-11-22: unit tests in `packages/adapters/src/http/pacer.test.ts` (slot order, refusal books
nothing, hold, twenty simultaneous callers) and `client.test.ts` (interval, `busy`, retry paced,
`Retry-After` hold across calls); loader and schema tests in `packages/config`; the MCP adapter
integration test for the pause between two calls.
