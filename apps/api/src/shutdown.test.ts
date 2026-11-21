// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import { enableShutdown } from './shutdown.js';

@Module({})
class EmptyModule {}

// Nest's start-up lines would clutter the output; the test file runs in its own module instance.
Logger.overrideLogger(false);

describe('CFG-2 shutdown signals', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('CFG-2 SIGHUP stays a reload: the shutdown hooks listen to SIGTERM and SIGINT only', async () => {
    const app = await NestFactory.createApplicationContext(EmptyModule);
    close = () => app.close();
    const before = { hup: process.listenerCount('SIGHUP'), term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') };

    enableShutdown(app);

    expect(process.listenerCount('SIGHUP')).toBe(before.hup);
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
  });
});
