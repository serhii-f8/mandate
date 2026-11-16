import { useState, type SyntheticEvent, type ReactElement } from 'react';

/** One credential ref the user manages, as `GET /api/v1/credentials` returns it (no secret value, ever). */
export interface CredentialRow {
  ref: string;
  scheme: string;
  connections: string[];
  set: boolean;
  updatedAt?: string;
  updatedBy?: string;
  keyVersion?: number;
}

/** The connection test report of CONN-7. */
export interface ConnectionTestReport {
  ok: boolean;
  operation: string;
  status?: number;
  durationMs: number;
  itemCount?: number;
  code?: string;
  message?: string;
  scopes: { detectable: boolean; source: string; values: string[] };
}

export type SaveResult = 'saved' | 'reauthentication_required' | { error: string };

export interface CredentialsViewProps {
  credentials: readonly CredentialRow[];
  onSave: (ref: string, secret: Record<string, string>) => Promise<SaveResult>;
  onTest: (connection: string) => Promise<ConnectionTestReport>;
  /** The form field names of a scheme. */
  fields: (scheme: string) => readonly string[];
}

// Every string below comes from configuration or the api and is rendered as React text (escaped, SEC-5).

function ScopeLine({ scopes }: { scopes: ConnectionTestReport['scopes'] }): ReactElement {
  if (!scopes.detectable) return <p>Scopes: not detectable</p>;
  return <p>Scopes ({scopes.source}): {scopes.values.length === 0 ? 'none' : scopes.values.join(', ')}</p>;
}

function TestResult({ report }: { report: ConnectionTestReport }): ReactElement {
  return (
    <div data-test-result>
      <p>
        {report.ok ? 'ok' : 'failed'} · {report.operation}
        {report.status === undefined ? '' : ` · HTTP ${String(report.status)}`} · {String(report.durationMs)} ms
        {report.itemCount === undefined ? '' : ` · ${String(report.itemCount)} items`}
      </p>
      {report.ok ? null : (
        <p>
          {report.code ?? 'error'}
          {report.message === undefined ? '' : `: ${report.message}`}
        </p>
      )}
      <ScopeLine scopes={report.scopes} />
    </div>
  );
}

function ConnectionTest({ connection, onTest }: { connection: string; onTest: CredentialsViewProps['onTest'] }): ReactElement {
  const [state, setState] = useState<{ busy: boolean; report?: ConnectionTestReport; failed?: boolean }>({ busy: false });
  const run = (): void => {
    setState({ busy: true });
    onTest(connection).then(
      (report) => {
        setState({ busy: false, report });
      },
      () => {
        setState({ busy: false, failed: true });
      },
    );
  };
  return (
    <li>
      <span>{connection}</span>{' '}
      <button type="button" disabled={state.busy} onClick={run}>
        Test {connection}
      </button>
      {state.report === undefined ? null : <TestResult report={state.report} />}
      {state.failed === true ? <p role="alert">The test could not be run.</p> : null}
    </li>
  );
}

function CredentialCard({ row, props }: { row: CredentialRow; props: CredentialsViewProps }): ReactElement {
  const names = props.fields(row.scheme);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'saved' | 'error'; text: string } | undefined>(undefined);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    setBusy(true);
    props.onSave(row.ref, values).then(
      (result) => {
        setBusy(false);
        if (result === 'saved') {
          // The secret leaves the page once; nothing keeps it.
          setValues({});
          setMessage({ kind: 'saved', text: 'Saved.' });
        } else if (result === 'reauthentication_required') {
          setMessage({ kind: 'error', text: 'Please log in again to confirm your identity.' });
        } else {
          setValues({});
          setMessage({ kind: 'error', text: result.error });
        }
      },
      () => {
        setBusy(false);
        setMessage({ kind: 'error', text: 'The credential could not be saved.' });
      },
    );
  };

  return (
    <section className="card">
      <h2>{row.ref}</h2>
      <p>
        <span data-status={row.set ? 'set' : 'unset'}>{row.set ? 'Set' : 'Not set'}</span>
        {row.updatedAt === undefined ? '' : ` · updated ${row.updatedAt}`}
        {row.updatedBy === undefined ? '' : ` by ${row.updatedBy}`}
        {row.keyVersion === undefined ? '' : ` · key version ${String(row.keyVersion)}`}
      </p>
      <p>Scheme: {row.scheme}</p>
      <form onSubmit={submit} autoComplete="off">
        {names.map((name) => {
          const id = `${row.ref}:${name}`;
          return (
            <div key={name} className="field">
              <label htmlFor={id}>{name}</label>
              <input
                id={id}
                name={name}
                type={name === 'username' ? 'text' : 'password'}
                autoComplete="off"
                value={values[name] ?? ''}
                onChange={(event) => {
                  setValues({ ...values, [name]: event.target.value });
                }}
              />
            </div>
          );
        })}
        <button type="submit" disabled={busy}>
          Save
        </button>
      </form>
      {message === undefined ? null : message.kind === 'saved' ? <p role="status">{message.text}</p> : <p role="alert">{message.text}</p>}
      <h3>Connections</h3>
      <ul>
        {row.connections.map((connection) => (
          <ConnectionTest key={connection} connection={connection} onTest={props.onTest} />
        ))}
      </ul>
    </section>
  );
}

/** The credential entry page body (UI-5): props in, callbacks out, no I/O of its own. */
export function CredentialsView(props: CredentialsViewProps): ReactElement {
  if (props.credentials.length === 0) return <p>You do not manage any credentials.</p>;
  return (
    <div>
      {props.credentials.map((row) => (
        <CredentialCard key={row.ref} row={row} props={props} />
      ))}
    </div>
  );
}
