// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { DefaultFailureConverter, defaultPayloadConverter, type Payload } from '@temporalio/common';
import { isLoadedDataConverter, loadDataConverter } from '@temporalio/common/internal/internal-non-workflow';
import { describe, expect, it } from 'vitest';
import { createPayloadCodec, parseTemporalKeys } from './codec.js';
import { clientDataConverter, FAILURE_CONVERTER_PATH, workerDataConverter } from './converters.js';

// Fixed, obviously fake 32-byte test keys.
const KEY_1 = Buffer.alloc(32, 7).toString('base64');
const KEY_2 = Buffer.alloc(32, 9).toString('base64');
const PLAINTEXT = 'changeset-0b7d-plaintext-marker';

const text = (bytes: Uint8Array | null | undefined): string => Buffer.from(bytes ?? new Uint8Array()).toString('utf8');

function plainPayload(): Payload {
  return defaultPayloadConverter.toPayload(PLAINTEXT);
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

async function encodeOne(codec: ReturnType<typeof createPayloadCodec>, payload: Payload): Promise<Payload> {
  const [encoded] = await codec.encode([payload]);
  if (encoded === undefined) throw new Error('no encoded payload');
  return encoded;
}

describe('SEC-4 payload codec', () => {
  const codec = createPayloadCodec(parseTemporalKeys(`1:${KEY_1},2:${KEY_2}`));

  it('SEC-4 round-trips a payload and marks it binary/encrypted with the key version', async () => {
    const original = plainPayload();
    const encoded = await encodeOne(codec, original);
    expect(text(encoded.metadata?.encoding)).toBe('binary/encrypted');
    expect(text(encoded.metadata?.['encryption-key-id'])).toBe('2');
    expect(Object.keys(encoded.metadata ?? {}).sort()).toEqual(['encoding', 'encryption-key-id']);
    expect(text(encoded.data)).not.toContain(PLAINTEXT);
    expect(encoded.data?.length ?? 0).toBeGreaterThan(12 + 16);

    const [decoded] = await codec.decode([encoded]);
    if (decoded === undefined) throw new Error('no decoded payload');
    expect(defaultPayloadConverter.fromPayload(decoded)).toBe(PLAINTEXT);
    expect(text(decoded.metadata?.encoding)).toBe(text(original.metadata?.encoding));
  });

  it('SEC-4 encrypts each payload with a fresh IV', async () => {
    const a = await encodeOne(codec, plainPayload());
    const b = await encodeOne(codec, plainPayload());
    expect(Buffer.from(a.data ?? []).subarray(0, 12).equals(Buffer.from(b.data ?? []).subarray(0, 12))).toBe(false);
  });

  it('SEC-4 decoding fails on a tampered payload with a fixed message', async () => {
    const encoded = await encodeOne(codec, plainPayload());
    const data = Buffer.from(encoded.data ?? []);
    data[data.length - 1] = (data[data.length - 1] ?? 0) ^ 0xff;
    const message = await rejection(codec.decode([{ ...encoded, data }]));
    expect(message).toMatch(/payload cannot be decrypted/);
    expect(message).not.toContain(PLAINTEXT);
  });

  it('SEC-4 decoding fails on an unknown key version with a fixed message', async () => {
    const encoded = await encodeOne(codec, plainPayload());
    const onlyV1 = createPayloadCodec(parseTemporalKeys(`1:${KEY_1}`));
    expect(await rejection(onlyV1.decode([encoded]))).toMatch(/payload cannot be decrypted: unknown key version/);
  });

  it('SEC-4 SEC-3 decoding refuses an unencrypted payload', async () => {
    const message = await rejection(codec.decode([plainPayload()]));
    expect(message).toMatch(/payload is not encrypted/);
    expect(message).not.toContain(PLAINTEXT);
  });

  it('SEC-4 rotation: payloads written under version 1 decode after version 2 was added', async () => {
    const before = createPayloadCodec(parseTemporalKeys(`1:${KEY_1}`));
    const encoded = await encodeOne(before, plainPayload());
    expect(text(encoded.metadata?.['encryption-key-id'])).toBe('1');
    const [decoded] = await codec.decode([encoded]);
    if (decoded === undefined) throw new Error('no decoded payload');
    expect(defaultPayloadConverter.fromPayload(decoded)).toBe(PLAINTEXT);
  });

  it('SEC-3 key parse errors name MANDATE_TEMPORAL_KEYS and the entry, never the value', () => {
    let message = '';
    try {
      parseTemporalKeys(`1:${KEY_1},2:not-a-key`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^MANDATE_TEMPORAL_KEYS: entry 2 /);
    expect(message).not.toContain('not-a-key');
    expect(message).not.toContain(KEY_1);
  });
});

describe('SEC-4 SEC-3 data converters', () => {
  const keys = parseTemporalKeys(`1:${KEY_1}`);

  it('SEC-3 the client converter encodes failure messages and carries the codec', async () => {
    const converter = clientDataConverter(keys);
    // The client uses a loaded converter as is and otherwise ignores everything but the paths
    // (base-client.js and data-converter-helpers.js, @temporalio 1.25.0).
    expect(isLoadedDataConverter(converter)).toBe(true);
    const loaded = isLoadedDataConverter(converter) ? converter : loadDataConverter(converter);
    expect(loaded.payloadCodecs).toHaveLength(1);
    const failure = loaded.failureConverter.errorToFailure(new Error('secret-detail'), loaded.payloadConverter);
    expect(failure.message).not.toContain('secret-detail');
    expect(failure.encodedAttributes).toBeTruthy();
    const codec = loaded.payloadCodecs[0];
    if (codec === undefined) throw new Error('no codec');
    const [encoded] = await codec.encode([plainPayload()]);
    expect(text(encoded?.metadata?.encoding)).toBe('binary/encrypted');
  });

  it('SEC-3 the worker converter loads the failure converter module by path and encodes failure messages', () => {
    const converter = workerDataConverter(keys);
    expect(converter.failureConverterPath).toBe(FAILURE_CONVERTER_PATH);
    expect(converter.payloadCodecs).toHaveLength(1);
    const loaded = loadDataConverter(converter);
    expect(loaded.failureConverter).toBeInstanceOf(DefaultFailureConverter);
    const failure = loaded.failureConverter.errorToFailure(new Error('secret-detail'), loaded.payloadConverter);
    expect(failure.message).not.toContain('secret-detail');
    expect(failure.encodedAttributes).toBeTruthy();
  });
});
