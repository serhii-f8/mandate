// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startSmtpSink, type SmtpSink } from './smtp-sink.js';

/** A minimal SMTP client: sends one line at a time and returns each reply line block. */
class RawClient {
  private buffer = '';
  private waiters: ((reply: string) => void)[] = [];

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.flush();
    });
  }

  static async open(url: string): Promise<{ client: RawClient; greeting: string }> {
    const u = new URL(url);
    const socket = connect(Number(u.port), u.hostname);
    const client = new RawClient(socket);
    const greeting = await client.reply();
    return { client, greeting };
  }

  /** The next complete reply (last line has a space after the code). */
  reply(): Promise<string> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.flush();
    });
  }

  async send(line: string): Promise<string> {
    this.socket.write(`${line}\r\n`);
    return this.reply();
  }

  close(): void {
    this.socket.destroy();
  }

  private flush(): void {
    for (;;) {
      const match = /^(?:\d{3}-[^\r\n]*\r\n)*\d{3}(?: [^\r\n]*)?\r\n/.exec(this.buffer);
      const waiter = this.waiters[0];
      if (!match || !waiter) return;
      this.buffer = this.buffer.slice(match[0].length);
      this.waiters.shift();
      waiter(match[0]);
    }
  }
}

async function deliver(client: RawClient, body: string): Promise<string> {
  expect(await client.send('MAIL FROM:<mandate@localhost>')).toMatch(/^250/);
  expect(await client.send('RCPT TO:<leads@example.test>')).toMatch(/^250/);
  expect(await client.send('RCPT TO:<ops@example.test>')).toMatch(/^250/);
  expect(await client.send('DATA')).toMatch(/^354/);
  return client.send(`${body}\r\n.`);
}

describe('smtp sink', () => {
  let sink: SmtpSink | undefined;
  let client: RawClient | undefined;

  afterEach(async () => {
    client?.close();
    await sink?.close();
  });

  it('NTF-1 the sink records one message per DATA and answers rejectNext once', async () => {
    sink = await startSmtpSink();
    expect(sink.url).toMatch(/^smtp:\/\/127\.0\.0\.1:\d+$/);
    const opened = await RawClient.open(sink.url);
    client = opened.client;
    expect(opened.greeting).toMatch(/^220 /);
    const ehlo = await client.send('EHLO test.local');
    expect(ehlo).toMatch(/^250/);
    expect(ehlo).not.toMatch(/STARTTLS/i);
    expect(await client.send('NOOP')).toMatch(/^250/);

    expect(await deliver(client, 'Subject: one\r\n\r\nfirst body\r\n..dot-stuffed')).toMatch(/^250/);
    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]).toEqual({
      from: 'mandate@localhost',
      to: ['leads@example.test', 'ops@example.test'],
      data: 'Subject: one\r\n\r\nfirst body\r\n.dot-stuffed',
    });

    sink.rejectNext(550);
    expect(await deliver(client, 'Subject: two\r\n\r\nrejected')).toMatch(/^550 /);
    expect(sink.messages).toHaveLength(1);

    sink.rejectNext(451);
    expect(await client.send('RSET')).toMatch(/^250/);
    expect(await deliver(client, 'Subject: three\r\n\r\ntemporary')).toMatch(/^451 /);
    expect(await deliver(client, 'Subject: four\r\n\r\naccepted')).toMatch(/^250/);
    expect(sink.messages.map((m) => m.data)).toEqual(['Subject: one\r\n\r\nfirst body\r\n.dot-stuffed', 'Subject: four\r\n\r\naccepted']);

    expect(await client.send('HELO again')).toMatch(/^250/);
    expect(await client.send('VRFY someone')).toMatch(/^502/);
    expect(await client.send('QUIT')).toMatch(/^221/);
  });
});
