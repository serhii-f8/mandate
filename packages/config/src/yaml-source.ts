// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from 'yaml';
import type { ConfigIssue } from './issues.js';

/** One parsed YAML file, able to point at the line of any path in it. */
export interface SourceDocument {
  readonly file: string;
  readonly text: string;
  readonly value: unknown;
  /** Position of the path's last key (or item); the deepest existing parent when it is missing. */
  locate(path: readonly PropertyKey[]): { line: number; column: number } | undefined;
}

/** Fixed, value-free messages: the `yaml` library's own messages quote the source. */
const YAML_MESSAGES: Readonly<Record<string, string>> = {
  DUPLICATE_KEY: 'duplicate key; keys must be unique',
  BAD_INDENT: 'bad indentation',
  MISSING_CHAR: 'missing character',
  BLOCK_AS_IMPLICIT_KEY: 'a block value cannot be an implicit key',
  MULTILINE_IMPLICIT_KEY: 'an implicit key must be on one line',
  TAB_AS_INDENT: 'tabs cannot be used for indentation',
  UNEXPECTED_TOKEN: 'unexpected token',
  TAG_RESOLVE_FAILED: 'unknown tag',
};

export function parseYamlSource(file: string, text: string): { document?: SourceDocument; issues: readonly ConfigIssue[] } {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { uniqueKeys: true, lineCounter, prettyErrors: false });
  const position = (offset: number): { line: number; column: number } => {
    const pos = lineCounter.linePos(offset);
    return { line: pos.line, column: pos.col };
  };
  if (doc.errors.length > 0) {
    return {
      issues: doc.errors.map((error) => ({
        file,
        path: '',
        ...position(error.pos[0]),
        message: `YAML: ${YAML_MESSAGES[error.code] ?? `syntax error (${error.code})`}`,
      })),
    };
  }

  const locate = (path: readonly PropertyKey[]): { line: number; column: number } | undefined => {
    let node: unknown = doc.contents;
    let found: { range?: [number, number, number] | null | undefined } | undefined = node as Node | undefined;
    for (const segment of path) {
      if (isMap(node)) {
        const pair = node.items.find((p) => isScalar(p.key) && p.key.value === segment);
        if (pair === undefined) break;
        found = pair.key as Node;
        node = pair.value;
      } else if (isSeq(node) && typeof segment === 'number') {
        const item: unknown = node.items[segment];
        if (item === undefined || item === null) break;
        found = item;
        node = item;
      } else {
        break;
      }
    }
    const offset = found?.range?.[0];
    return offset === undefined ? undefined : position(offset);
  };

  return { document: { file, text, value: doc.toJS() as unknown, locate }, issues: [] };
}
