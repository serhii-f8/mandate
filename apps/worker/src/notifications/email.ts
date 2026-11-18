import type { NotificationError } from '@aiops/core';
import nodemailer from 'nodemailer';
import type { EmailSender, SendOutcome } from './senders.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Maps a nodemailer failure to the closed code list (ADR 0034 d). Only `code` is read; the
 * message and response text can echo addresses or the server's reply and never leave here (SEC-3).
 */
function errorOf(err: unknown): NotificationError {
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code : undefined;
  if (code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ECONNECTION' || code === 'ESOCKET' || code === 'EDNS') return 'network';
  // Every other failure, an SMTP answer with `responseCode >= 400` included, is a rejection.
  return 'smtp_rejected';
}

/**
 * Plain-text e-mail over SMTP (NTF-1). `url` is `AIOPS_SMTP_URL`, already validated by
 * `parseWorkerEnv`; user info, when present, is the relay login. One connection per message.
 */
export function createSmtpSender(opts: { url: string; from: string; timeoutMs?: number }): EmailSender {
  const url = new URL(opts.url);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  const transport = nodemailer.createTransport({
    host,
    // Without a port nodemailer picks 465 for `secure` and 587 otherwise.
    ...(url.port === '' ? {} : { port: Number(url.port) }),
    secure: url.protocol === 'smtps:',
    ...(url.username === '' ? {} : { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } }),
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  return {
    async send(mail): Promise<SendOutcome> {
      try {
        await transport.sendMail({ from: opts.from, to: [...mail.to], subject: mail.subject, text: mail.text });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errorOf(err) };
      }
    },
    close() {
      transport.close();
    },
  };
}
