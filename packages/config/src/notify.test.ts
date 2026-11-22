// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { ConfigIssue } from './issues.js';
import { loadConfigurationSources, type LoadedConfiguration, type LoadResult } from './load.js';

const CONNECTIONS = `version: 1
connections:
  - { id: shop, adapter: openapi, base_url: https://shop.example.test/rest, credential_ref: shop-token, auth: { scheme: bearer } }
`;
const NOTIFICATIONS = `version: 1
notifications:
  - { id: content-leads-mail, kind: email, to: [leads@example.test] }
  - { id: content-chat, kind: webhook, url_credential_ref: content-chat-webhook, allowed_hosts: [hooks.slack.com] }
`;
const ROLES = `version: 1
roles:
  - { id: content_manager, grants: [], notify: { results: [content-chat] } }
  - { id: content_lead, grants: [], notify: { approval_requests: [content-leads-mail] }, manage_credentials: [content-chat-webhook] }
  - { id: support, grants: [] }
`;

function load(overrides: Record<string, string> = {}): Promise<LoadResult> {
  const files: Record<string, string> = { 'connections.yaml': CONNECTIONS, 'notifications.yaml': NOTIFICATIONS, 'roles.yaml': ROLES, ...overrides };
  return loadConfigurationSources(Object.entries(files).map(([file, text]) => ({ file, text })));
}

function ok(result: LoadResult): LoadedConfiguration {
  if (!result.ok) throw new Error(`expected valid configuration: ${JSON.stringify(result.issues)}`);
  return result.configuration;
}

function issues(result: LoadResult): readonly ConfigIssue[] {
  if (result.ok) throw new Error('expected issues');
  return result.issues;
}

describe('NTF-1 role notify targets', () => {
  it('NTF-1 role notify is mapped to LoadedConfiguration.notify', async () => {
    const config = ok(await load());
    expect(config.notify.get('content_lead')).toEqual({ approvalRequests: ['content-leads-mail'], results: [] });
    expect(config.notify.get('content_manager')).toEqual({ approvalRequests: [], results: ['content-chat'] });
    expect(config.notify.has('support')).toBe(false);
  });

  it('NTF-1 an unknown notification ID in notify is a located issue', async () => {
    const found = issues(await load({ 'roles.yaml': ROLES.replace('results: [content-chat]', 'results: [ghost]') }));
    expect(found).toEqual([
      expect.objectContaining({ file: 'roles.yaml', path: 'roles[0].notify.results[0]', message: 'names a notification that is not defined' }),
    ]);
  });

  it('NTF-1 notify is a strict object', async () => {
    const found = issues(await load({ 'roles.yaml': ROLES.replace('notify: { results: [content-chat] }', 'notify: { result: [content-chat] }') }));
    expect(found).toEqual([expect.objectContaining({ file: 'roles.yaml', path: 'roles[0].notify', message: 'unknown key: result' })]);
  });
});

describe('CONN-5 webhook allowed hosts', () => {
  it('CONN-5 a webhook without allowed_hosts is a located issue', async () => {
    for (const replacement of ['', ', allowed_hosts: []']) {
      const found = issues(await load({ 'notifications.yaml': NOTIFICATIONS.replace(', allowed_hosts: [hooks.slack.com]', replacement) }));
      expect(found).toEqual([
        expect.objectContaining({ file: 'notifications.yaml', path: 'notifications[1].allowed_hosts', message: 'is required for a webhook notification (CONN-5)' }),
      ]);
    }
  });

  it('CONN-5 allowed_hosts entries are lower-case host names without port', async () => {
    for (const host of ['Hooks.Slack.com', 'hooks.slack.com:443']) {
      const found = issues(await load({ 'notifications.yaml': NOTIFICATIONS.replace('allowed_hosts: [hooks.slack.com]', `allowed_hosts: ["${host}"]`) }));
      expect(found).toEqual([expect.objectContaining({ file: 'notifications.yaml', path: 'notifications[1].allowed_hosts[0]' })]);
    }
    expect((await load({ 'notifications.yaml': NOTIFICATIONS.replace('[hooks.slack.com]', '[hooks.slack.com, 192.168.1.20]') })).ok).toBe(true);
  });

  it('CONN-5 allow_private_network defaults to false', async () => {
    const config = ok(await load());
    expect(config.notifications[1]).toMatchObject({ id: 'content-chat', kind: 'webhook', allowed_hosts: ['hooks.slack.com'], allow_private_network: false });
    const opted = ok(await load({ 'notifications.yaml': NOTIFICATIONS.replace('[hooks.slack.com]', '[hooks.slack.com], allow_private_network: true') }));
    expect(opted.notifications[1]).toMatchObject({ allow_private_network: true });
  });
});

describe('SEC-2 webhook credential references', () => {
  it('SEC-2 a webhook credential ref joins credentialRefs with scheme webhook_url', async () => {
    const config = ok(await load());
    expect(config.credentialRefs.get('content-chat-webhook')).toEqual({ scheme: 'webhook_url', connections: [], notifications: ['content-chat'] });
    expect(config.credentialRefs.get('shop-token')).toEqual({ scheme: 'bearer', connections: ['shop'], notifications: [] });
  });

  it('SEC-2 manage_credentials may name a webhook credential', async () => {
    const config = ok(await load());
    expect(config.credentialManagers.get('content_lead')).toEqual(['content-chat-webhook']);
  });

  it('SEC-2 a ref shared by a connection and a webhook is a located issue', async () => {
    const found = issues(await load({ 'notifications.yaml': NOTIFICATIONS.replace('url_credential_ref: content-chat-webhook', 'url_credential_ref: shop-token') }));
    expect(found).toContainEqual(
      expect.objectContaining({ file: 'notifications.yaml', path: 'notifications[1].url_credential_ref', message: 'is used with another scheme by connection shop' }),
    );
  });

  it('SEC-2 two webhooks may share a ref', async () => {
    const twice = `${NOTIFICATIONS}  - { id: other-chat, kind: webhook, url_credential_ref: content-chat-webhook, allowed_hosts: [hooks.slack.com] }\n`;
    const config = ok(await load({ 'notifications.yaml': twice }));
    expect(config.credentialRefs.get('content-chat-webhook')).toEqual({ scheme: 'webhook_url', connections: [], notifications: ['content-chat', 'other-chat'] });
  });
});
