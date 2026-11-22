// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { fileURLToPath } from 'node:url';
import type { FakeResponse, FakeUpstream, RecordedRequest } from './fake-upstream.js';

/** Absolute path of the code fixture preset package (OPS-5, OPS-6, CONN-8); `src/` and `dist/` are both one level down. */
export const CODE_FIXTURE_PRESET_DIR: string = fileURLToPath(new URL('../fixtures/presets/code-fixture', import.meta.url));

export interface FakeItem {
  id: string;
  title: string;
  state: 'open' | 'closed';
  tags: string[];
}

export interface FakeItems {
  readonly items: Map<string, FakeItem>;
  /** The next `count` requests matching method and path answer `status` instead. */
  failNext(method: string, path: string, status: number, count?: number): void;
  requestsTo(method: string, path: string): number;
}

const ITEM_PATH = /^\/items\/([^/]+)$/;
const TAGS_PATH = /^\/items\/([^/]+)\/tags$/;
const STATES: readonly string[] = ['open', 'closed'];
/** The one tag the fake refuses, so a code write can end `failed`. */
const UNKNOWN_TAG = 'unknown';

function json(status: number, body: unknown): FakeResponse {
  return { status, body };
}

function parseBody(req: RecordedRequest): unknown {
  try {
    return JSON.parse(req.body) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(value: string | null): number | undefined {
  if (value === null || !/^[1-9][0-9]{0,5}$/.test(value)) return undefined;
  return Number(value);
}

/**
 * The items upstream of the code fixture preset on a fake upstream: `GET /items` (a bare
 * array, filtered by `state`, paged by `page` and `limit`), `GET` and `PATCH /items/{id}`,
 * `PUT /items/{id}/tags` and `POST /ping`. Every route needs `authorization: Bearer <any>`.
 */
export function installFakeItems(fake: FakeUpstream, seed: readonly FakeItem[]): FakeItems {
  const items = new Map<string, FakeItem>(seed.map((item) => [item.id, { ...item, tags: [...item.tags] }]));
  const failures: { method: string; path: string; status: number; left: number }[] = [];
  const copy = (item: FakeItem): FakeItem => ({ ...item, tags: [...item.tags] });

  /** An injected failure or a missing token answers before the route does. */
  const guarded =
    (handler: (req: RecordedRequest) => FakeResponse) =>
    (req: RecordedRequest): FakeResponse => {
      const failure = failures.find((f) => f.left > 0 && f.method === req.method.toUpperCase() && f.path === req.path);
      if (failure !== undefined) {
        failure.left -= 1;
        return json(failure.status, { error: 'injected failure' });
      }
      if (!/^Bearer \S+$/.test(req.headers.authorization ?? '')) return json(401, { error: 'unauthorized' });
      return handler(req);
    };
  const itemOf = (path: string, pattern: RegExp): FakeItem | undefined => {
    const raw = pattern.exec(path)?.[1];
    if (raw === undefined) return undefined;
    try {
      return items.get(decodeURIComponent(raw));
    } catch {
      return undefined;
    }
  };

  fake.route(
    'GET',
    '/items',
    guarded((req) => {
      const state = req.query.get('state');
      const all = [...items.values()].filter((item) => state === null || item.state === state);
      const limit = positiveInt(req.query.get('limit')) ?? 100;
      const page = positiveInt(req.query.get('page')) ?? 1;
      return json(200, all.slice((page - 1) * limit, page * limit).map(copy));
    }),
  );
  fake.routeMatch(
    'GET',
    ITEM_PATH,
    guarded((req) => {
      const item = itemOf(req.path, ITEM_PATH);
      return item === undefined ? json(404, { error: 'not found' }) : json(200, copy(item));
    }),
  );
  fake.routeMatch(
    'PATCH',
    ITEM_PATH,
    guarded((req) => {
      const item = itemOf(req.path, ITEM_PATH);
      if (item === undefined) return json(404, { error: 'not found' });
      const body = parseBody(req);
      if (!isRecord(body)) return json(400, { error: 'body must be an object' });
      for (const [key, value] of Object.entries(body)) {
        const valid = key === 'title' ? typeof value === 'string' : key === 'state' ? typeof value === 'string' && STATES.includes(value) : false;
        if (!valid) return json(400, { error: 'only title and state can change' });
      }
      if (typeof body.title === 'string') item.title = body.title;
      if (body.state === 'open' || body.state === 'closed') item.state = body.state;
      return json(200, copy(item));
    }),
  );
  fake.routeMatch(
    'PUT',
    TAGS_PATH,
    guarded((req) => {
      const item = itemOf(req.path, TAGS_PATH);
      if (item === undefined) return json(404, { error: 'not found' });
      const body = parseBody(req);
      const tags = isRecord(body) ? body.tags : undefined;
      if (!Array.isArray(tags) || !tags.every((t): t is string => typeof t === 'string')) return json(400, { error: 'tags must be strings' });
      if (tags.includes(UNKNOWN_TAG)) return json(400, { error: 'unknown tag' });
      item.tags = [...tags];
      return json(200, { tags: [...tags] });
    }),
  );
  fake.route(
    'POST',
    '/ping',
    guarded(() => json(200, { ok: true })),
  );

  return {
    items,
    failNext(method, path, status, count = 1) {
      failures.push({ method: method.toUpperCase(), path, status, left: count });
    },
    requestsTo(method, path) {
      return fake.requests.filter((r) => r.method.toUpperCase() === method.toUpperCase() && r.path === path).length;
    },
  };
}
