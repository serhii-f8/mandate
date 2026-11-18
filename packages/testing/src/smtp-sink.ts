import { createServer, type AddressInfo, type Socket } from 'node:net';

/** One message as the sink accepted it: envelope addresses and the DATA payload (dot-unstuffed, CRLF line ends). */
export interface SinkMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly data: string;
}

export interface SmtpSink {
  /** `smtp://127.0.0.1:<port>`. */
  readonly url: string;
  readonly messages: readonly SinkMessage[];
  /** Answers the end of the next DATA with `code` instead of 250; that message is not recorded. */
  rejectNext(code: 451 | 550): void;
  close(): Promise<void>;
}

const REJECT_TEXT: Record<451 | 550, string> = { 451: '451 4.3.0 rejected by test sink', 550: '550 5.7.1 rejected by test sink' };

/** The address inside `<...>` of a `MAIL FROM:` or `RCPT TO:` argument, or undefined when there is none. */
function pathOf(argument: string): string | undefined {
  return /<([^>]*)>/.exec(argument)?.[1];
}

/**
 * An in-process SMTP server on 127.0.0.1 with a random port, for e-mail sender tests (ADR 0034 k).
 * It speaks EHLO/HELO, MAIL, RCPT, DATA, RSET, NOOP and QUIT, advertises no extensions (no
 * STARTTLS, no AUTH) and answers 502 to anything else.
 */
export async function startSmtpSink(): Promise<SmtpSink> {
  const messages: SinkMessage[] = [];
  const sockets = new Set<Socket>();
  let pendingReject: 451 | 550 | undefined;

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');

    let buffer = '';
    let from: string | undefined;
    let to: string[] = [];
    let dataLines: string[] | undefined;
    const reply = (line: string): void => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };
    const reset = (): void => {
      from = undefined;
      to = [];
      dataLines = undefined;
    };

    const onLine = (line: string): void => {
      if (dataLines !== undefined) {
        if (line !== '.') {
          dataLines.push(line.startsWith('.') ? line.slice(1) : line);
          return;
        }
        const data = dataLines.join('\r\n');
        const envelope = { from: from ?? '', to: [...to] };
        reset();
        const reject = pendingReject;
        pendingReject = undefined;
        if (reject !== undefined) {
          reply(REJECT_TEXT[reject]);
          return;
        }
        messages.push({ ...envelope, data });
        reply('250 2.0.0 queued');
        return;
      }
      const verb = line.slice(0, 4).toUpperCase();
      reply(command(verb, line.slice(4)));
      if (verb === 'QUIT') socket.end();
    };

    /** The reply to one command outside DATA. */
    const command = (verb: string, argument: string): string => {
      switch (verb) {
        case 'EHLO':
        case 'HELO':
          reset();
          return '250 smtp-sink';
        case 'MAIL': {
          const path = pathOf(argument);
          if (path === undefined) return '501 5.5.4 syntax: MAIL FROM:<address>';
          reset();
          from = path;
          return '250 2.1.0 ok';
        }
        case 'RCPT': {
          const path = pathOf(argument);
          if (from === undefined) return '503 5.5.1 MAIL first';
          if (path === undefined) return '501 5.5.4 syntax: RCPT TO:<address>';
          to.push(path);
          return '250 2.1.5 ok';
        }
        case 'DATA':
          if (from === undefined || to.length === 0) return '503 5.5.1 MAIL and RCPT first';
          dataLines = [];
          return '354 end data with <CR><LF>.<CR><LF>';
        case 'RSET':
          reset();
          return '250 2.0.0 ok';
        case 'NOOP':
          return '250 2.0.0 ok';
        case 'QUIT':
          return '221 2.0.0 bye';
        default:
          return '502 5.5.2 command not implemented';
      }
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf('\r\n');
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        onLine(line);
        end = buffer.indexOf('\r\n');
      }
    });
    reply('220 smtp-sink ESMTP');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `smtp://127.0.0.1:${String(port)}`,
    messages,
    rejectNext(code) {
      pendingReject = code;
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
