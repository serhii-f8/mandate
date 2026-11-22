// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { startSmtpSink, type SmtpSink } from '@mandate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createSmtpSender } from './email.js';
import type { EmailSender } from './senders.js';

describe('smtp sender', () => {
  let sink: SmtpSink | undefined;
  let sender: EmailSender | undefined;

  afterEach(async () => {
    sender?.close();
    await sink?.close();
    sink = undefined;
    sender = undefined;
  });

  it('NTF-1 createSmtpSender delivers plain text with subject and recipients', async () => {
    sink = await startSmtpSink();
    sender = createSmtpSender({ url: sink.url, from: 'mandate@localhost' });
    const outcome = await sender.send({ to: ['leads@example.test'], subject: 'Approval requested: X', text: 'Change-set 1 awaits approval.' });
    expect(outcome).toEqual({ ok: true });
    expect(sink.messages).toHaveLength(1);
    const message = sink.messages[0];
    expect(message?.from).toBe('mandate@localhost');
    expect(message?.to).toEqual(['leads@example.test']);
    expect(message?.data).toContain('Subject: Approval requested: X');
    expect(message?.data).toContain('Change-set 1 awaits approval.');
    expect(message?.data).toMatch(/Content-Type: text\/plain/i);
    expect(message?.data).not.toMatch(/text\/html/i);
  });

  it('NTF-3 a 550 answer gives smtp_rejected', async () => {
    sink = await startSmtpSink();
    sender = createSmtpSender({ url: sink.url, from: 'mandate@localhost' });
    sink.rejectNext(550);
    const outcome = await sender.send({ to: ['leads@example.test'], subject: 's', text: 't' });
    expect(outcome).toEqual({ ok: false, error: 'smtp_rejected' });
    expect(sink.messages).toHaveLength(0);
  });

  it('NTF-3 a closed port gives network', async () => {
    const closed = await startSmtpSink();
    await closed.close();
    sender = createSmtpSender({ url: closed.url, from: 'mandate@localhost' });
    const outcome = await sender.send({ to: ['leads@example.test'], subject: 's', text: 't' });
    expect(outcome).toEqual({ ok: false, error: 'network' });
  });

  it('SEC-3 a failed send carries the fixed code only', async () => {
    sink = await startSmtpSink();
    sender = createSmtpSender({ url: sink.url, from: 'mandate@localhost' });
    sink.rejectNext(451);
    const outcome = await sender.send({ to: ['secret-recipient@example.test'], subject: 'secret subject', text: 'secret text' });
    expect(JSON.stringify(outcome)).toBe('{"ok":false,"error":"smtp_rejected"}');
  });
});
