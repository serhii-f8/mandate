// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { useEffect, useState, type ReactElement } from 'react';
import { formatBytes } from '../format.js';
import type { FileItem, FilesSource } from '../model.js';
import { visible } from './RawArguments.js';

type Loaded = { kind: 'loading' } | { kind: 'error' } | { kind: 'text'; text: string; truncated: boolean };

/** The text of a file as React text only, invisible and bidi characters shown as escapes (SEC-5). */
function TextPreview({ id, source }: { id: string; source: FilesSource }): ReactElement {
  const [state, setState] = useState<Loaded>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    source.text(id).then(
      (r) => {
        if (live) setState({ kind: 'text', ...r });
      },
      () => {
        if (live) setState({ kind: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, [id, source]);
  if (state.kind === 'loading') return <p>Loading the text…</p>;
  if (state.kind === 'error') return <p role="alert">The text could not be loaded.</p>;
  return (
    <>
      <pre>{visible(state.text)}</pre>
      {state.truncated ? <p>Showing the first 64 KB.</p> : null}
    </>
  );
}

function Content({ file, source }: { file: FileItem; source: FilesSource | undefined }): ReactElement {
  if (source === undefined) return <p>Open the page to see the file.</p>;
  if (!file.available) return <p>The file&apos;s content was removed after the retention period.</p>;
  return (
    <>
      {file.preview === 'image' ? <img src={source.imageUrl(file.id)} alt={file.name} /> : null}
      {file.preview === 'text' ? <TextPreview id={file.id} source={source} /> : null}
      <a href={source.downloadUrl(file.id)}>Download</a>
    </>
  );
}

/**
 * The files a call sends (APR-5, UI-2): name, type, size and the full hash as text, and on a trusted
 * page the content. A widget has no source and never loads a file (UI-6). Nothing for a call without files.
 */
export function FilesSection({ files, source }: { files: readonly FileItem[]; source?: FilesSource }): ReactElement | null {
  if (files.length === 0) return null;
  return (
    <section aria-label="Files">
      <h2>{`Files sent with this call (${String(files.length)})`}</h2>
      <ul className="files">
        {files.map((file) => (
          <li key={`${file.pointer}:${file.id}`}>
            <p>
              <strong>{file.name}</strong>
            </p>
            <p>
              <span>{file.mediaType}</span>
              {' · '}
              <span>{formatBytes(file.size)}</span>
            </p>
            <p>
              <code>{file.sha256}</code>
            </p>
            <Content file={file} source={source} />
          </li>
        ))}
      </ul>
    </section>
  );
}
