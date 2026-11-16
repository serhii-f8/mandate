// Spike 2: scripted MCP client. For each registration method (pre-registered, DCR, CIMD)
// it runs discovery -> registration -> authorization code + PKCE (Keycloak login form
// submitted over HTTP) -> token -> MCP `whoami`, plus negative controls.
// Prints one PASS/FAIL line per assertion; exits non-zero on any FAIL.
//
// The OAuth steps are hand-written so each step can be asserted; discovery uses the
// official client package's discovery functions, and the MCP call uses its Client +
// StreamableHTTPClientTransport (@modelcontextprotocol/client 2.4.0).
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
    Client,
    StreamableHTTPClientTransport,
    discoverOAuthProtectedResourceMetadata,
    discoverAuthorizationServerMetadata
} from '@modelcontextprotocol/client';
import { setup } from './setup-keycloak.mjs';

const MCP_URL = process.env.MCP_RESOURCE ?? 'http://localhost:4111/mcp';
const KC_URL = process.env.KC_URL ?? 'http://localhost:4180';
const ISSUER = `${KC_URL}/realms/spike`;
const REDIRECT_URI = 'http://localhost:4113/callback'; // never served: the redirect is intercepted
const CIMD_PORT = 4112;
const CIMD_URL = `https://host.docker.internal:${CIMD_PORT}/cimd/client.json`;
const PASSWORD = 'spike-password';
const VERBOSE = process.env.VERBOSE === '1';

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok });
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  -- ${detail}` : ''}`);
}
const log = (...a) => VERBOSE && console.log('   ', ...a);
const b64url = buf => Buffer.from(buf).toString('base64url');
const decodeJwt = t => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- CIMD document server (HTTPS, self-signed CA trusted by Keycloak) ----------
const CIMD_BASE = `https://host.docker.internal:${CIMD_PORT}/cimd`;
const cimdFetches = [];
const cimdKeys = await generateKeyPair('RS256', { extractable: true });
const cimdJwk = { ...(await exportJWK(cimdKeys.publicKey)), kid: 'spike-cimd-1', alg: 'RS256', use: 'sig' };
// The generic document, plus replicas of the *shapes* of the documents Claude and ChatGPT
// publish (fetched 2026-11-16 from claude.ai/oauth/mcp-oauth-client-metadata,
// claude.ai/oauth/claude-code-client-metadata and chatgpt.com/oauth/client.json), re-hosted
// under our own URL. They test how Keycloak treats those shapes; they are not the vendors' clients.
const cimdDocuments = {
    'client.json': {
        client_name: 'Spike 2 CIMD client',
        client_uri: `https://host.docker.internal:${CIMD_PORT}/`,
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
    },
    'claude-desktop-shape.json': {
        client_name: 'Claude (shape replica)',
        client_uri: `https://host.docker.internal:${CIMD_PORT}/`,
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
    },
    'claude-code-shape.json': {
        client_name: 'Claude Code (shape replica)',
        client_uri: `https://host.docker.internal:${CIMD_PORT}/`,
        redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
    },
    'chatgpt-shape.json': {
        client_uri: `https://host.docker.internal:${CIMD_PORT}/`,
        redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
        grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
        response_types: ['code'],
        client_name: 'ChatGPT (shape replica)',
        token_endpoint_auth_signing_alg: 'RS256',
        jwks_uri: `${CIMD_BASE}/jwks.json`
    },
    // Control: the ChatGPT shape minus the one property Keycloak's parser does not know
    // (token_endpoint_auth_methods_supported) -> isolates whether private_key_jwt CIMD works.
    'private-key-jwt-control.json': {
        client_uri: `https://host.docker.internal:${CIMD_PORT}/`,
        redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
        token_endpoint_auth_method: 'private_key_jwt',
        grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
        response_types: ['code'],
        client_name: 'private_key_jwt control',
        token_endpoint_auth_signing_alg: 'RS256',
        jwks_uri: `${CIMD_BASE}/jwks.json`
    },
    // The variant the Keycloak MCP guide describes for ChatGPT: no token_endpoint_auth_method,
    // only token_endpoint_auth_methods_supported.
    'chatgpt-guide-variant.json': {
        client_uri: `https://host.docker.internal:${CIMD_PORT}/`,
        redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
        token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
        grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
        response_types: ['code'],
        client_name: 'ChatGPT guide variant',
        jwks_uri: `${CIMD_BASE}/jwks.json`
    }
};
const cimdUrl = name => `${CIMD_BASE}/${name}`;
function startCimdServer() {
    const server = https.createServer(
        { key: fs.readFileSync('.run/tls/server.key'), cert: fs.readFileSync('.run/tls/server.pem') },
        (req, res) => {
            cimdFetches.push({ path: req.url, ua: req.headers['user-agent'], at: Date.now() });
            const name = req.url.replace(/^\/cimd\//, '');
            if (name === 'jwks.json') {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ keys: [cimdJwk] }));
            }
            if (cimdDocuments[name]) {
                res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=60' });
                return res.end(JSON.stringify({ client_id: cimdUrl(name), ...cimdDocuments[name] }));
            }
            res.writeHead(404).end();
        }
    );
    return new Promise(r => server.listen(CIMD_PORT, '0.0.0.0', () => r(server)));
}
async function clientAssertion(clientId, audience) {
    return new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: cimdJwk.kid })
        .setIssuer(clientId)
        .setSubject(clientId)
        .setAudience(audience)
        .setJti(crypto.randomUUID())
        .setIssuedAt()
        .setExpirationTime('60s')
        .sign(cimdKeys.privateKey);
}

// ---------- tiny browser: cookie jar + manual redirects ----------
class Browser {
    constructor() {
        this.cookies = new Map();
    }
    _cookieHeader() {
        return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    _store(res) {
        for (const c of res.headers.getSetCookie?.() ?? []) {
            const [pair] = c.split(';');
            const i = pair.indexOf('=');
            this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
        }
    }
    async request(url, { method = 'GET', form } = {}) {
        const res = await fetch(url, {
            method,
            redirect: 'manual',
            headers: { cookie: this._cookieHeader(), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
            body: form ? new URLSearchParams(form) : undefined
        });
        this._store(res);
        return res;
    }
    /** Follows redirects until one leaves Keycloak (returned, never requested) or a non-redirect page. */
    async go(url, opts) {
        let res = await this.request(url, opts);
        for (let i = 0; i < 10 && res.status >= 300 && res.status < 400; i++) {
            const loc = new URL(res.headers.get('location'), url).toString();
            if (!loc.startsWith(KC_URL)) return { redirect: new URL(loc) };
            url = loc;
            res = await this.request(url);
        }
        return { page: await res.text(), status: res.status, url };
    }
}
const decodeHtml = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
function formAction(html, id) {
    const re = id ? new RegExp(`<form[^>]*id="${id}"[^>]*>`, 'i') : /<form[^>]*>/i;
    const tag = html.match(re)?.[0];
    const action = tag?.match(/action="([^"]+)"/i)?.[1];
    return action ? decodeHtml(action) : undefined;
}
function pageError(html) {
    const m =
        html.match(/id="kc-error-message"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ??
        html.match(/class="[^"]*kc-feedback-text[^"]*"[^>]*>([\s\S]*?)</i) ??
        html.match(/<title>([\s\S]*?)<\/title>/i);
    return m ? m[1].replace(/<[^>]+>/g, '').trim() : 'unknown page';
}

// ---------- OAuth steps ----------
async function discover() {
    const res = await fetch(MCP_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    const wwwAuth = res.headers.get('www-authenticate') ?? '';
    const resourceMetadataUrl = wwwAuth.match(/resource_metadata="([^"]+)"/)?.[1];
    const prm = await discoverOAuthProtectedResourceMetadata(MCP_URL, { resourceMetadataUrl });
    const asUrl = prm.authorization_servers[0];
    const asMeta = await discoverAuthorizationServerMetadata(asUrl);
    return { status: res.status, wwwAuth, resourceMetadataUrl, prm, asUrl, asMeta };
}

async function register(method, asMeta) {
    if (method === 'pre-registered') return { client_id: 'spike-mcp-client' };
    if (method === 'cimd') {
        if (asMeta.client_id_metadata_document_supported !== true) throw new Error('AS does not advertise CIMD');
        return { client_id: CIMD_URL };
    }
    if (method === 'dcr') {
        if (!asMeta.registration_endpoint) throw new Error('AS has no registration_endpoint');
        const res = await fetch(asMeta.registration_endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                client_name: 'Spike 2 DCR client',
                redirect_uris: [REDIRECT_URI],
                grant_types: ['authorization_code', 'refresh_token'],
                response_types: ['code'],
                token_endpoint_auth_method: 'none',
                application_type: 'native'
            })
        });
        const body = await res.json();
        if (res.status !== 201) throw new Error(`registration ${res.status}: ${JSON.stringify(body)}`);
        return body;
    }
    throw new Error(`unknown method ${method}`);
}

async function authorize({ asMeta, clientId, scope, resource, username, redirectUri = REDIRECT_URI }) {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const url = new URL(asMeta.authorization_endpoint);
    url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        ...(scope ? { scope } : {}),
        resource
    }).toString();
    const browser = new Browser();
    let step = await browser.go(url.toString());
    let consentShown = false;
    if (step.page) {
        const action = formAction(step.page, 'kc-form-login');
        if (!action) throw new Error(`no login form (HTTP ${step.status}): ${pageError(step.page)}`);
        step = await browser.go(new URL(action, step.url).toString(), { method: 'POST', form: { username, password: PASSWORD, credentialId: '' } });
    }
    if (step.page && /name="accept"/.test(step.page)) {
        consentShown = true;
        const action = formAction(step.page);
        step = await browser.go(new URL(action, step.url).toString(), { method: 'POST', form: { accept: 'Yes' } });
    }
    if (!step.redirect) throw new Error(`no redirect to client (HTTP ${step.status}): ${pageError(step.page)}`);
    const expected = new URL(redirectUri);
    if (step.redirect.origin + step.redirect.pathname !== expected.origin + expected.pathname) {
        throw new Error(`redirected to unexpected URI ${step.redirect.origin}${step.redirect.pathname}`);
    }
    const q = step.redirect.searchParams;
    if (q.get('error')) throw new Error(`authorization error: ${q.get('error')} ${q.get('error_description') ?? ''}`);
    if (q.get('state') !== state) throw new Error('state mismatch');
    // RFC 9207 check as the MCP spec requires
    if (asMeta.authorization_response_iss_parameter_supported && q.get('iss') !== asMeta.issuer) {
        throw new Error(`iss mismatch: ${q.get('iss')}`);
    }
    return { code: q.get('code'), verifier, iss: q.get('iss'), consentShown };
}

async function token({ asMeta, clientId, code, verifier, resource, redirectUri = REDIRECT_URI, assertion }) {
    const res = await fetch(asMeta.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: verifier,
            resource,
            ...(assertion
                ? { client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion }
                : {})
        })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`token ${res.status}: ${JSON.stringify(body)}`);
    return body;
}

async function mcpWhoami(accessToken) {
    const client = new Client({ name: 'spike-2-check', version: '0.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } }
    });
    await client.connect(transport);
    try {
        const tools = await client.listTools();
        const res = await client.callTool({ name: 'whoami', arguments: {} });
        return { tools: tools.tools.map(t => t.name), who: res.structuredContent ?? JSON.parse(res.content[0].text), protocol: client.getNegotiatedProtocolVersion() };
    } finally {
        await client.close();
    }
}

async function rawMcpStatus(accessToken) {
    const res = await fetch(MCP_URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    await res.arrayBuffer();
    return { status: res.status, wwwAuth: res.headers.get('www-authenticate') ?? '' };
}

async function passwordGrant(clientId, username = 'alice') {
    const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
        method: 'POST',
        body: new URLSearchParams({ grant_type: 'password', client_id: clientId, username, password: PASSWORD })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`password grant ${clientId}: ${JSON.stringify(body)}`);
    return body.access_token;
}

const audIsExactly = (aud, resource) => (Array.isArray(aud) ? aud.length === 1 && aud[0] === resource : aud === resource);

async function runMethod(method, d, username = 'alice', expectedGroups = ['content'], prefix = method) {
    try {
        const reg = await register(method, d.asMeta);
        log(`${method}: client_id=${reg.client_id}`);
        const scope = d.prm.scopes_supported?.join(' '); // MCP scope selection: no `scope` in challenge -> scopes_supported
        const az = await authorize({ asMeta: d.asMeta, clientId: reg.client_id, scope, resource: d.prm.resource, username });
        log(`${method}: code received, consent screen shown=${az.consentShown}, iss=${az.iss}`);
        const tok = await token({ asMeta: d.asMeta, clientId: reg.client_id, code: az.code, verifier: az.verifier, resource: d.prm.resource });
        const claims = decodeJwt(tok.access_token);
        log(`${method}: aud=${JSON.stringify(claims.aud)} azp=${claims.azp} groups=${JSON.stringify(claims.groups)} scope="${claims.scope}"`);
        const mcp = await mcpWhoami(tok.access_token);
        log(`${method}: tools=${mcp.tools} who=${JSON.stringify(mcp.who)} protocol=${mcp.protocol}`);
        check(`${prefix}-flow-completes`, mcp.who.sub === claims.sub && mcp.who.preferred_username === username,
            `client_id=${reg.client_id} consent=${az.consentShown} protocol=${mcp.protocol}`);
        check(`${prefix}-audience-is-resource`, audIsExactly(claims.aud, d.prm.resource), `aud=${JSON.stringify(claims.aud)}`);
        check(`${prefix}-groups-claim`,
            JSON.stringify(mcp.who.groups) === JSON.stringify(expectedGroups) && JSON.stringify(claims.groups) === JSON.stringify(expectedGroups),
            `groups=${JSON.stringify(mcp.who.groups)}`);
        return { reg, claims };
    } catch (err) {
        check(`${prefix}-flow-completes`, false, err.message);
        check(`${prefix}-audience-is-resource`, false, 'flow did not complete');
        check(`${prefix}-groups-claim`, false, 'flow did not complete');
        return undefined;
    }
}

async function main() {
    const cimdServer = await startCimdServer();
    try {
        // --- Keycloak defaults before our setup: anonymous DCR blocked by Trusted Hosts ---
        const d0 = await discover();
        try {
            await register('dcr', d0.asMeta);
            check('dcr-blocked-by-default-trusted-hosts', false, 'registration unexpectedly succeeded with default policies');
        } catch (e) {
            check('dcr-blocked-by-default-trusted-hosts', /Trusted Hosts/.test(e.message), e.message.slice(0, 160));
        }
        // CIMD advertised by the feature flag alone, before any client policy exists
        check('cimd-advertised-by-feature-flag', d0.asMeta.client_id_metadata_document_supported === true,
            `client_id_metadata_document_supported=${d0.asMeta.client_id_metadata_document_supported}`);
        // ...but without the client policy a URL client_id is just an unknown client
        try {
            await authorize({ asMeta: d0.asMeta, clientId: CIMD_URL, resource: MCP_URL, username: 'alice' });
            check('cimd-rejected-without-client-policy', false, 'unexpectedly accepted');
        } catch (e) {
            check('cimd-rejected-without-client-policy', true, e.message.slice(0, 120));
        }

        const s = await setup();
        log('setup:', JSON.stringify(s));

        // --- discovery assertions ---
        const d = await discover();
        check('no-token-401', d.status === 401, `HTTP ${d.status}`);
        check('www-authenticate-has-resource-metadata',
            d.resourceMetadataUrl === `${new URL(MCP_URL).origin}/.well-known/oauth-protected-resource${new URL(MCP_URL).pathname}` &&
                d.prm.resource === MCP_URL,
            d.wwwAuth);
        const rootPrm = await (await fetch(`${new URL(MCP_URL).origin}/.well-known/oauth-protected-resource`)).json();
        check('prm-root-and-path-variants', rootPrm.resource === MCP_URL && d.prm.authorization_servers[0] === ISSUER,
            `authorization_servers=${JSON.stringify(d.prm.authorization_servers)}`);
        check('as-metadata-discovered-by-sdk',
            d.asMeta?.issuer === ISSUER && d.asMeta.code_challenge_methods_supported?.includes('S256'),
            `issuer=${d.asMeta?.issuer} S256=${d.asMeta?.code_challenge_methods_supported?.includes('S256')} iss_param=${d.asMeta?.authorization_response_iss_parameter_supported} none_auth=${d.asMeta?.token_endpoint_auth_methods_supported?.includes('none')}`);

        // --- one full flow per registration method ---
        await runMethod('pre-registered', d);
        const dcr = await runMethod('dcr', d);
        const fetchesBefore = cimdFetches.length;
        await runMethod('cimd', d);
        check('cimd-document-fetched-by-keycloak', cimdFetches.length > fetchesBefore,
            `fetches=${cimdFetches.length - fetchesBefore} ua=${cimdFetches.at(-1)?.ua ?? '-'}`);
        // CIMD document shapes of the real clients, re-hosted under our URL (see cimdDocuments)
        const shapes = [
            ['cimd-shape-claude-desktop', 'claude-desktop-shape.json', 'https://claude.ai/api/mcp/auth_callback', false],
            ['cimd-shape-claude-code-loopback-any-port', 'claude-code-shape.json', 'http://localhost:54321/callback', false],
            ['cimd-shape-chatgpt-private-key-jwt', 'chatgpt-shape.json', 'https://chatgpt.com/connector_platform_oauth_redirect', true],
            ['cimd-private-key-jwt-control', 'private-key-jwt-control.json', 'https://chatgpt.com/connector_platform_oauth_redirect', true]
        ];
        for (const [name, doc, redirectUri, confidential] of shapes) {
            try {
                const clientId = cimdUrl(doc);
                const az = await authorize({ asMeta: d.asMeta, clientId, scope: 'mcp:tools', resource: d.prm.resource, username: 'alice', redirectUri });
                const assertion = confidential ? await clientAssertion(clientId, d.asMeta.issuer) : undefined;
                const tok = await token({ asMeta: d.asMeta, clientId, code: az.code, verifier: az.verifier, resource: d.prm.resource, redirectUri, assertion });
                const claims = decodeJwt(tok.access_token);
                const who = (await mcpWhoami(tok.access_token)).who;
                check(name, audIsExactly(claims.aud, d.prm.resource) && who.preferred_username === 'alice',
                    `aud=${JSON.stringify(claims.aud)} azp=${claims.azp.split('/').pop()}${confidential ? ' (private_key_jwt at token endpoint)' : ''}`);
            } catch (e) {
                check(name, false, e.message.slice(0, 200));
            }
        }
        // The variant the Keycloak MCP guide says Keycloak rejects (auth method only in *_supported)
        try {
            const clientId = cimdUrl('chatgpt-guide-variant.json');
            const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
            const az = await authorize({ asMeta: d.asMeta, clientId, scope: 'mcp:tools', resource: d.prm.resource, username: 'alice', redirectUri });
            try {
                await token({ asMeta: d.asMeta, clientId, code: az.code, verifier: az.verifier, resource: d.prm.resource, redirectUri });
                check('cimd-chatgpt-guide-variant-rejected', false, 'authorization and token (as public client) both succeeded');
            } catch (e) {
                check('cimd-chatgpt-guide-variant-rejected', true, `authorization succeeded, token refused: ${e.message.slice(0, 120)}`);
            }
        } catch (e) {
            check('cimd-chatgpt-guide-variant-rejected', true, e.message.slice(0, 160));
        }

        // AUTH-3: a second user in a different group
        await runMethod('pre-registered', d, 'bob', ['support'], 'bob-pre-registered');

        // DCR redirect URI outside the trusted hosts must be refused
        try {
            const res = await fetch(d.asMeta.registration_endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ client_name: 'evil', redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none' })
            });
            const body = await res.text();
            check('dcr-untrusted-redirect-rejected', res.status === 403, `HTTP ${res.status} ${body.slice(0, 120)}`);
        } catch (e) {
            check('dcr-untrusted-redirect-rejected', false, e.message);
        }

        // --- RFC 8707: a resource the AS does not know must not yield a token for it ---
        try {
            const other = 'http://localhost:4111/other';
            const az = await authorize({ asMeta: d.asMeta, clientId: 'spike-mcp-client', scope: 'mcp:tools', resource: other, username: 'alice' });
            try {
                const tok = await token({ asMeta: d.asMeta, clientId: 'spike-mcp-client', code: az.code, verifier: az.verifier, resource: other });
                check('unknown-resource-invalid-target', false, `token issued, aud=${JSON.stringify(decodeJwt(tok.access_token).aud)}`);
            } catch (e) {
                check('unknown-resource-invalid-target', /invalid_target/.test(e.message), `at token endpoint: ${e.message.slice(0, 140)}`);
            }
        } catch (e) {
            check('unknown-resource-invalid-target', /invalid_target/.test(e.message), `at authorization endpoint: ${e.message.slice(0, 140)}`);
        }

        // --- RFC 8707 in Keycloak validates/narrows an audience, it does not create one:
        //     a client whose scopes carry no MCP audience gets invalid_target for resource=MCP ---
        {
            const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
                method: 'POST',
                body: new URLSearchParams({ grant_type: 'password', client_id: 'spike-negative-wrong-aud', username: 'alice', password: PASSWORD, resource: MCP_URL })
            });
            const body = await res.json();
            check('resource-param-alone-does-not-set-audience', res.status === 400 && body.error === 'invalid_target',
                `HTTP ${res.status} ${body.error ?? 'token issued'}`);
        }

        // --- negative controls at the resource server ---
        const wrongAud = await passwordGrant('spike-negative-wrong-aud');
        const wa = await rawMcpStatus(wrongAud);
        // same issuer, valid signature, unexpired — only the audience is another resource
        check('wrong-audience-401', wa.status === 401 && audIsExactly(decodeJwt(wrongAud).aud, 'http://localhost:4199/other-mcp'),
            `HTTP ${wa.status} aud=${JSON.stringify(decodeJwt(wrongAud).aud ?? null)}`);

        const short = await passwordGrant('spike-negative-short');
        const shortClaims = decodeJwt(short);
        const before = await rawMcpStatus(short); // control: same token accepted while valid
        const waitMs = shortClaims.exp * 1000 - Date.now() + 1500;
        await sleep(Math.max(waitMs, 0));
        const after = await rawMcpStatus(short);
        check('expired-token-401', before.status === 200 && after.status === 401,
            `before-expiry HTTP ${before.status}, after-expiry HTTP ${after.status} (lifetime ${shortClaims.exp - shortClaims.iat}s)`);

        const good = await passwordGrant('spike-negative-short');
        const [h, p, sig] = good.split('.');
        const flipped = sig[5] === 'A' ? 'B' : 'A';
        const tampered = `${h}.${p}.${sig.slice(0, 5)}${flipped}${sig.slice(6)}`;
        const tp = await rawMcpStatus(tampered);
        const goodNow = await rawMcpStatus(good);
        check('tampered-signature-401', goodNow.status === 200 && tp.status === 401, `untampered HTTP ${goodNow.status}, tampered HTTP ${tp.status}`);
        void dcr;
    } finally {
        cimdServer.close();
    }
    console.log(`\n${results.length - failures}/${results.length} assertions passed`);
    process.exit(failures ? 1 : 0);
}

main().catch(err => {
    console.error('FATAL', err);
    process.exit(2);
});
