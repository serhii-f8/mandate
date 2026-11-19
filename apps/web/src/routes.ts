export type Route = { kind: 'index' } | { kind: 'credentials' } | { kind: 'approvals' } | { kind: 'audit' } | { kind: 'changeset'; id: string } | { kind: 'not_found' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maps a path under `/app` to a page; any other path or a malformed change-set id is `not_found` (UI-2). */
export function route(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '');
  if (path === '/app') return { kind: 'index' };
  if (path === '/app/credentials') return { kind: 'credentials' };
  if (path === '/app/approvals') return { kind: 'approvals' };
  if (path === '/app/audit') return { kind: 'audit' };
  const m = /^\/app\/changesets\/([^/]+)$/.exec(path);
  if (m?.[1] !== undefined && UUID.test(m[1])) return { kind: 'changeset', id: m[1] };
  return { kind: 'not_found' };
}

export const changesetPath = (id: string): string => `/app/changesets/${id}`;
