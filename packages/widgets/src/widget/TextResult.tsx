import { useState, type ReactElement } from 'react';
import { Notice } from '../components/Notice.js';
import { openPage, type WidgetApp } from './bridge.js';

const NO_TEXT = 'The answer could not be read.';

/** `Open as page`: the host opens the trusted page; a refusal leaves the address as text. */
export function PageLink(props: { app: WidgetApp | null; url: string }): ReactElement {
  const { app, url } = props;
  const [message, setMessage] = useState<string>();
  return (
    <>
      <button
        type="button"
        disabled={app === null}
        onClick={() => {
          if (app === null) return;
          void openPage(app, url).then((r) => {
            setMessage(r.ok ? undefined : r.message);
          });
        }}
      >
        Open as page
      </button>
      {message === undefined ? null : <Notice kind="error">{message}</Notice>}
    </>
  );
}

/** A result the widget does not understand: its first text block and the page link, never a blank frame (UI-1). */
export function TextResult(props: { app: WidgetApp | null; text: string; pageUrl: string | undefined }): ReactElement {
  return (
    <section className="view text">
      <p>{props.text === '' ? NO_TEXT : props.text}</p>
      {props.pageUrl === undefined ? null : <PageLink app={props.app} url={props.pageUrl} />}
    </section>
  );
}
