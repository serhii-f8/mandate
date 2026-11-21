// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { execFile } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../acceptance/mcp-call.mjs', import.meta.url));

/** Runs mcp-call.mjs against a server that records the first request's headers and refuses it. */
async function firstRequestHeaders(argv: string[], env: Record<string, string>): Promise<IncomingHttpHeaders> {
  let seen: IncomingHttpHeaders | undefined;
  const server = createServer((req, res) => {
    seen ??= req.headers;
    res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid_token"}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
  try {
    // The refused request makes the script exit non-zero; only the headers matter here.
    await new Promise<void>((resolve) => {
      execFile(process.execPath, [SCRIPT, url, ...argv], { env: { PATH: process.env.PATH ?? '', ...env } }, () => {
        resolve();
      });
    });
  } finally {
    server.close();
  }
  if (seen === undefined) throw new Error('mcp-call.mjs sent no request');
  return seen;
}

describe('SEC-3 mcp-call.mjs bearer token', () => {
  it('SEC-3 reads the token from AIOPS_MCP_TOKEN, so it never has to appear in argv', async () => {
    const headers = await firstRequestHeaders(['--list'], { AIOPS_MCP_TOKEN: 'env-token-fake' });
    expect(headers.authorization).toBe('Bearer env-token-fake');
  });

  it('SEC-3 still accepts --token for the earlier phases scripts', async () => {
    const headers = await firstRequestHeaders(['--token', 'argv-token-fake', '--list'], {});
    expect(headers.authorization).toBe('Bearer argv-token-fake');
  });
});
