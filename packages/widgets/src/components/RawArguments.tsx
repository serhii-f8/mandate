import type { ReactElement } from 'react';
import { Notice } from './Notice.js';

/** The arguments of an opaque call, as text only (SEC-5, UI-2, APR-5): the call has no preview. */
export function RawArguments({ args }: { args: Readonly<Record<string, unknown>> }): ReactElement {
  return (
    <section aria-label="Raw arguments">
      <h2>Raw arguments</h2>
      <Notice kind="info">This call has no preview and cannot be rolled back.</Notice>
      <pre>{JSON.stringify(args, null, 2)}</pre>
    </section>
  );
}
