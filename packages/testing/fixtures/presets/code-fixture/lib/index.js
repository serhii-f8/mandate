// Code module of the code fixture preset (OPS-5, OPS-6). Plain ESM with no imports: a preset's
// code runs from a directory outside the app's node_modules, so it uses only its own files.
// The JSDoc types name the connector SDK as types only.

/** @typedef {import('@aiops/connector-sdk').CodeContext} CodeContext */
/** @typedef {import('@aiops/connector-sdk').CodeArgs} CodeArgs */
/** @typedef {import('@aiops/connector-sdk').WriteRecord} WriteRecord */
/** @typedef {import('@aiops/connector-sdk').RecordOutcome} RecordOutcome */
/** @typedef {import('@aiops/connector-sdk').CodeHttpResponse} CodeHttpResponse */
/** @typedef {import('@aiops/connector-sdk').PresetModule} PresetModule */

/** Failures worth another attempt: rate limits, server errors and transport trouble. */
const RETRIABLE_CODES = new Set(['timeout', 'network', 'busy']);

/**
 * @param {CodeHttpResponse} res
 * @returns {boolean}
 */
function retriable(res) {
  if (res.ok) return false;
  if (res.status !== undefined && (res.status === 429 || res.status >= 500)) return true;
  return RETRIABLE_CODES.has(res.code);
}

/** @type {PresetModule} */
export default {
  operations: {
    /** Reads `GET /items/{id}` per ID; an unknown ID (404) is skipped. */
    get_many: {
      kind: 'read',
      /**
       * @param {CodeContext} ctx
       * @param {CodeArgs} args
       */
      async read(ctx, args) {
        const ids = Array.isArray(args.ids) ? args.ids : [];
        const items = [];
        for (const id of ids) {
          const res = await ctx.http.send({ method: 'GET', path: `/items/${encodeURIComponent(String(id))}` });
          if (res.ok) items.push(res.json);
          else if (res.status !== 404) throw new Error(`item read failed (${res.code})`);
        }
        return { items };
      },
    },
    /** `PUT /items/{id}/tags` per record; a refused tag set (4xx) fails that record. */
    set_tags: {
      kind: 'write',
      /**
       * @param {CodeContext} ctx
       * @param {readonly WriteRecord[]} records
       * @returns {Promise<RecordOutcome[]>}
       */
      async write(ctx, records) {
        /** @type {RecordOutcome[]} */
        const outcomes = [];
        for (const record of records) {
          const res = await ctx.http.send({
            method: 'PUT',
            path: `/items/${encodeURIComponent(String(record.id))}/tags`,
            body: { tags: record.tags },
          });
          outcomes.push(res.ok ? 'ok' : retriable(res) ? 'retriable' : 'failed');
        }
        return outcomes;
      },
    },
    /** `POST /ping` with the arguments as body: 2xx accepted, 4xx refused, anything else unknown. */
    ping: {
      kind: 'call',
      /**
       * @param {CodeContext} ctx
       * @param {CodeArgs} args
       */
      async call(ctx, args) {
        const res = await ctx.http.send({ method: 'POST', path: '/ping', body: args });
        if (res.ok) return { ok: true };
        const definite = res.status !== undefined && res.status >= 400 && res.status < 500;
        return { ok: false, definite };
      },
    },
    /** Always throws; the message must never reach a tool result (OPS-5). */
    boom: {
      kind: 'read',
      async read() {
        throw new Error('fixture failure token-sentinel');
      },
    },
  },
};
