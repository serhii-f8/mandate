import { describe, expect, it } from 'vitest';
import { executionLimits } from './limits.js';
import { loadConfigurationSources, type LoadedConfiguration } from './load.js';

async function loaded(roleExtra: string): Promise<LoadedConfiguration> {
  const result = await loadConfigurationSources([{ file: 'roles.yaml', text: `version: 1\nroles:\n  - id: r\n    grants: []\n${roleExtra}` }]);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.configuration;
}

describe('POL-4 executionLimits', () => {
  it("POL-4 executionLimits maps a role's limits to ExecutionLimits", async () => {
    const config = await loaded('    limits: { records_per_operation: 10, records_per_day: 100, concurrent_executions: 2, calls_per_minute: 5 }\n');
    expect(executionLimits(config, 'r')).toEqual({ role: 'r', recordsPerOperation: 10, recordsPerDay: 100, concurrentExecutions: 2 });
  });

  it('POL-4 executionLimits gives undefined without limits, with only calls_per_minute, or for an unknown role', async () => {
    expect(executionLimits(await loaded(''), 'r')).toBeUndefined();
    expect(executionLimits(await loaded('    limits: { calls_per_minute: 5 }\n'), 'r')).toBeUndefined();
    expect(executionLimits(await loaded('    limits: { records_per_day: 1 }\n'), 'other')).toBeUndefined();
  });

  it('POL-4 executionLimits omits unset keys', async () => {
    expect(executionLimits(await loaded('    limits: { records_per_day: 7 }\n'), 'r')).toEqual({ role: 'r', recordsPerDay: 7 });
  });
});
