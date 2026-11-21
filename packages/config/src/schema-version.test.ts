import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { configDocumentSchema } from './schema.js';
import { CONFIG_SCHEMA_VERSION } from './schema-version.js';
import { PRODUCT_VERSION } from './product-version.js';

describe('NFR-18 configuration schema and product versions', () => {
  it('NFR-18 the configuration schema major equals the YAML version literal', () => {
    expect(CONFIG_SCHEMA_VERSION).toBe('1.0.0');
    const major = CONFIG_SCHEMA_VERSION.split('.')[0];
    expect(major).toBe('1');
    expect(configDocumentSchema.safeParse({ version: Number(major) }).success).toBe(true);
    expect(configDocumentSchema.safeParse({ version: 2 }).success).toBe(false);
  });

  it('NFR-18 PRODUCT_VERSION equals the root package version', () => {
    const root = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string };
    expect(PRODUCT_VERSION).toBe('1.0.0');
    expect(root.version).toBe(PRODUCT_VERSION);
  });
});
