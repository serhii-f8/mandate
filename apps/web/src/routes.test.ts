// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { changesetPath, route } from './routes.js';

const ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';

describe('UI-2 routes', () => {
  it('UI-2 path routing maps /app paths to pages', () => {
    expect(route('/app/')).toEqual({ kind: 'index' });
    expect(route('/app')).toEqual({ kind: 'index' });
    expect(route('/app/credentials')).toEqual({ kind: 'credentials' });
    expect(route('/app/approvals')).toEqual({ kind: 'approvals' });
    expect(route('/app/audit')).toEqual({ kind: 'audit' });
    expect(route('/app/files')).toEqual({ kind: 'files' });
    expect(route('/app/audit/')).toEqual({ kind: 'audit' });
    expect(route(`/app/changesets/${ID}`)).toEqual({ kind: 'changeset', id: ID });
    expect(route(`/app/changesets/${ID}/`)).toEqual({ kind: 'changeset', id: ID });
    expect(route('/app/changesets/x')).toEqual({ kind: 'not_found' });
    expect(route('/app/other')).toEqual({ kind: 'not_found' });
    expect(changesetPath(ID)).toBe(`/app/changesets/${ID}`);
  });
});
