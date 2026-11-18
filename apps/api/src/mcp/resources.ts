import { ResourceNotFoundError } from '@modelcontextprotocol/server';
import { UI_MIME_TYPE, type WidgetCatalog } from './widget-bundles.js';

/** The `_meta` of every UI resource: the bundles are self-contained, so they ask for no network origin (UI-6). */
export const UI_RESOURCE_META = { ui: { csp: {}, prefersBorder: true } } as const;

interface ResourceEntry {
  uri: string;
  name: string;
  title: string;
  mimeType: string;
  _meta: typeof UI_RESOURCE_META;
}

/**
 * `resources/list` (MCP-5): the present bundles. They hold no data, so the answer is the same for
 * every caller and is not audited (ADR 0035).
 */
export function listResources(widgets: WidgetCatalog): { resources: ResourceEntry[] } {
  return {
    resources: widgets.list().map(({ uri, name, title }) => ({ uri, name, title, mimeType: UI_MIME_TYPE, _meta: UI_RESOURCE_META })),
  };
}

/**
 * `resources/read` (MCP-5): an exact URI match, never a path lookup.
 * Throws ResourceNotFoundError(uri) for any URI that is not a present bundle.
 */
export function readResource(widgets: WidgetCatalog, uri: string): { contents: [{ uri: string; mimeType: string; text: string; _meta: typeof UI_RESOURCE_META }] } {
  const resource = widgets.read(uri);
  if (resource === undefined) throw new ResourceNotFoundError(uri);
  return { contents: [{ uri: resource.uri, mimeType: UI_MIME_TYPE, text: resource.html, _meta: UI_RESOURCE_META }] };
}
