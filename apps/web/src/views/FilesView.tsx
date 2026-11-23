// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { formatBytes, formatDateTime } from '@mandate/widgets';
import { useState, type ReactElement, type SyntheticEvent } from 'react';
import type { StagedFile } from '../api.js';

export const FORBIDDEN_TEXT = 'Your roles have no operation that takes a file.';

/** The sentence of an upload refusal code; an unknown code is shown as it is (CS-10). */
const REFUSAL_TEXT: Readonly<Record<string, string>> = {
  forbidden: FORBIDDEN_TEXT,
  payload_too_large: 'The file is larger than the platform allows.',
  quota_exceeded: 'You have reached your limit of staged files. They expire by themselves, or use them in a change.',
  empty_file: 'The file is empty.',
  invalid_name: 'The file name is not allowed.',
  invalid_media_type: 'The file type could not be read.',
};
export const refusalText = (code: string): string => REFUSAL_TEXT[code] ?? `Not uploaded: ${code}`;

export interface FilesViewProps {
  files: readonly StagedFile[];
  /** No role of the user has an operation that takes a file: no form is shown. */
  forbidden: boolean;
  onUpload: (file: File) => Promise<{ ok: true } | { ok: false; error: string }>;
}

function CopyId({ id }: { id: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        // A page without clipboard access leaves the ID selectable as text.
        navigator.clipboard.writeText(id).then(
          () => {
            setCopied(true);
          },
          () => undefined,
        );
      }}
    >
      {copied ? 'Copied' : 'Copy ID'}
    </button>
  );
}

/** The upload form and the user's own staged files (UI-2, CS-10). Every string is rendered as React text (SEC-5). */
export function FilesView({ files, forbidden, onUpload }: FilesViewProps): ReactElement {
  const [chosen, setChosen] = useState<File | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (chosen === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    onUpload(chosen).then(
      (result) => {
        setBusy(false);
        if (result.ok) setChosen(undefined);
        else setError(refusalText(result.error));
      },
      () => {
        setBusy(false);
        setError('The file could not be uploaded.');
      },
    );
  };

  if (forbidden) {
    return (
      <main>
        <h1>Files</h1>
        <p role="alert">{FORBIDDEN_TEXT}</p>
      </main>
    );
  }
  return (
    <main>
      <h1>Files</h1>
      <form onSubmit={submit}>
        <label>
          File
          <input
            type="file"
            onChange={(e) => {
              setChosen(e.target.files?.[0]);
            }}
          />
        </label>
        <button type="submit" disabled={chosen === undefined || busy}>
          Upload
        </button>
      </form>
      {error === undefined ? null : <p role="alert">{error}</p>}
      <h2>{`Your staged files (${String(files.length)})`}</h2>
      {files.length === 0 ? (
        <p>No staged files.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Size</th>
              <th>ID</th>
              <th>Expires</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id}>
                <td>{f.name}</td>
                <td>{f.mediaType}</td>
                <td>{formatBytes(f.size)}</td>
                <td>
                  <code>{f.id}</code> <CopyId id={f.id} />
                </td>
                <td>{formatDateTime(f.expiresAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
