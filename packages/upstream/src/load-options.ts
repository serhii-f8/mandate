/**
 * How `api` and `worker` wire the upstream side: the configuration is always loaded with the
 * adapter's spec resolver and the installed presets, so neither process ever runs on a
 * configuration whose specs or presets were not checked (CONN-2, CFG-2).
 */
import type { UpstreamResolver } from '@aiops/connector-sdk';
import type { ApiEnv, LoadedConfiguration, LoadOptions } from '@aiops/config';

/** Load options for start-up and for every SIGHUP reload (the holder keeps them). */
export function configurationLoadOptions(adapter: { readonly resolver: UpstreamResolver }, env: Pick<ApiEnv, 'presetDirs'>): LoadOptions {
  return { resolver: adapter.resolver, presetDirs: env.presetDirs };
}

/** Throws when a check was skipped; neither process may start on a partly checked configuration. */
export function assertFullyChecked(configuration: LoadedConfiguration): void {
  if (configuration.specChecksSkipped) throw new Error('configuration was loaded without spec checks (no resolver)');
  if (configuration.presetChecksSkipped) throw new Error('configuration was loaded without preset checks (no preset directories)');
}
