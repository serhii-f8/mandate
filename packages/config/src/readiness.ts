import type { ConfigurationState } from './holder.js';

export type Probe = 'ok' | 'unavailable';

/** The `/readyz` body of api and worker (NFR-10). */
export interface ReadinessReport {
  readonly database: Probe;
  readonly configuration: { readonly revision: string | null; readonly hash: string } | 'none' | 'configuration_mismatch';
  readonly temporal: Probe;
}

/** 200 when every required part is ready (NFR-10); `requireTemporal` is false for api, true for worker. */
export function readinessStatus(report: ReadinessReport, requireTemporal: boolean): 200 | 503 {
  if (report.database !== 'ok') return 503;
  if (typeof report.configuration === 'string') return 503;
  if (requireTemporal && report.temporal !== 'ok') return 503;
  return 200;
}

export function configurationProbe(state: ConfigurationState): ReadinessReport['configuration'] {
  if (state.status === 'active') return { revision: state.revision, hash: state.hash };
  return state.status;
}

/** Runs `probe` with a deadline; a rejection or the deadline gives 'unavailable'. */
export async function probeWithin(probe: () => Promise<unknown>, ms: number): Promise<Probe> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'unavailable'>((resolve) => {
    timer = setTimeout(() => {
      resolve('unavailable');
    }, ms);
  });
  try {
    return await Promise.race([probe().then((): Probe => 'ok'), deadline]);
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}
