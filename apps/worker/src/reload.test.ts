import { EventEmitter } from 'node:events';
import type { ConfigIssue, ConfigurationHolder } from '@aiops/config';
import { describe, expect, it, vi } from 'vitest';
import { installReload, type ReloadLogger } from './reload.js';

type Holder = Pick<ConfigurationHolder, 'reload' | 'current'>;

type LogFn = (fields: object, message: string) => void;

/** Separate mocks, so assertions never take a method off an object (unbound-method). */
function fakeLogger() {
  const info = vi.fn<LogFn>();
  const warn = vi.fn<LogFn>();
  const error = vi.fn<LogFn>();
  const logger: ReloadLogger = { info, warn, error };
  return { logger, info, warn, error };
}

function holderWith(reload: Holder['reload']): Holder {
  return { reload, current: { hash: 'h-previous' } as Holder['current'] };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('worker configuration reload', () => {
  it('NFR-4 CFG-2 SIGHUP reloads the configuration and keeps the previous one when the reload is invalid', async () => {
    const issue: ConfigIssue = { file: 'policy.yaml', path: 'roles[0].name', message: 'is required' };
    const reload = vi.fn<Holder['reload']>().mockResolvedValue({ ok: false, issues: [issue] });
    const signals = new EventEmitter();
    const log = fakeLogger();
    installReload(holderWith(reload), log.logger, signals);

    expect(() => signals.emit('SIGHUP')).not.toThrow();
    await settle();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = log.warn.mock.calls[0] as [{ issue: string }, string];
    expect(fields.issue).toContain('policy.yaml');
    expect(message).toMatch(/previous configuration stays active/);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('NFR-4 CFG-2 a valid reload is logged with the new hash', async () => {
    const holder = holderWith(vi.fn<Holder['reload']>().mockResolvedValue({ ok: true }));
    const signals = new EventEmitter();
    const log = fakeLogger();
    installReload(holder, log.logger, signals);

    signals.emit('SIGHUP');
    await settle();

    expect(log.info).toHaveBeenCalledWith({ hash: 'h-previous' }, 'configuration reloaded');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('NFR-4 a rejected reload promise never ends the process', async () => {
    const holder = holderWith(vi.fn<Holder['reload']>().mockRejectedValue(new Error('EACCES: permission denied')));
    const signals = new EventEmitter();
    const log = fakeLogger();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      installReload(holder, log.logger, signals);
      expect(() => signals.emit('SIGHUP')).not.toThrow();
      await settle();
      await settle();
    } finally {
      process.off('unhandledRejection', unhandled);
    }

    expect(unhandled).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[1]).toMatch(/previous configuration stays active/);
  });

  it('NFR-4 a reload that throws synchronously never ends the process', async () => {
    const holder = holderWith(() => {
      throw new Error('boom');
    });
    const signals = new EventEmitter();
    const log = fakeLogger();
    installReload(holder, log.logger, signals);

    expect(() => signals.emit('SIGHUP')).not.toThrow();
    await settle();

    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
