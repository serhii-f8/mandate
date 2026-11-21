// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
// Doc-test extraction (NFR-9): marked command blocks of the public guide, by section.

const MARK = /^<!-- doc-test: (\S+) -->\s*$/;
const ALT = /^<!-- doc-test-alt: (\S+)\s*$/;
const FENCE = /^(`{3,}|~{3,})/;

/**
 * @typedef {{ path: string; index: number; code: string; alt: boolean }} DocBlock
 * @param {{ path: string; text: string }[]} pages pages in reading order
 * @param {string[]} sections the known section names
 * @returns {Map<string, DocBlock[]>} blocks per section in page order; `index` is 1-based per section
 */
export function extract(pages, sections) {
  /** @type {Map<string, DocBlock[]>} */
  const result = new Map(sections.map((s) => [s, []]));
  /** @param {string} section @param {string} path @param {number} line */
  const known = (section, path, line) => {
    const list = result.get(section);
    if (!list) throw new Error(`${path}:${String(line)}: unknown doc-test section "${section}"`);
    return list;
  };
  for (const { path, text } of pages) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const alt = ALT.exec(line);
      if (alt) {
        const list = known(alt[1] ?? '', path, i + 1);
        let j = i + 1;
        const code = [];
        while (j < lines.length && lines[j] !== '-->') code.push(lines[j++]);
        if (j >= lines.length) throw new Error(`${path}:${String(i + 1)}: unterminated doc-test-alt block`);
        list.push({ path, index: list.length + 1, code: code.join('\n') + '\n', alt: true });
        i = j;
        continue;
      }
      const mark = MARK.exec(line);
      if (!mark) continue;
      const list = known(mark[1] ?? '', path, i + 1);
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
      const open = FENCE.exec(lines[j] ?? '');
      if (!open) throw new Error(`${path}:${String(i + 1)}: doc-test marker without a following code fence`);
      const fence = open[1] ?? '```';
      const code = [];
      let k = j + 1;
      while (k < lines.length && !(lines[k] ?? '').startsWith(fence)) code.push(lines[k++]);
      if (k >= lines.length) throw new Error(`${path}:${String(j + 1)}: unterminated code fence`);
      list.push({ path, index: list.length + 1, code: code.join('\n') + '\n', alt: false });
      i = k;
    }
  }
  return result;
}
