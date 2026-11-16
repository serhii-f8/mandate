// Spike 2: minimal protected MCP endpoint (OAuth 2.1 resource server).
//
// - RFC 9728 protected resource metadata at /.well-known/oauth-protected-resource and at
//   the path-suffixed variant /.well-known/oauth-protected-resource/mcp.
// - /mcp is served by @modelcontextprotocol/server 2.4.0 `createMcpHandler` (stateless,
//   modern 2026-07-28 envelope plus the default stateless 2025 fallback) behind the SDK's
//   `requireBearerAuth` gate; token verification (signature via JWKS, issuer, audience,
//   expiry) is done here with `jose`.
// - One tool, `whoami`, returning subject, username and groups from the access token.
//
// Env:
//   PORT          listen port (default 4111)
//   MCP_RESOURCE  public canonical URL of this MCP endpoint (default http://localhost:4111/mcp)
//   KC_ISSUER     expected issuer (default http://localhost:4180/realms/spike)
//   KC_JWKS_URL   where to fetch keys (default <KC_ISSUER>/protocol/openid-connect/certs;
//                 set to the local URL when the issuer is a public tunnel URL)
import http from 'node:http';
import { Readable } from 'node:stream';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
    McpServer,
    createMcpHandler,
    requireBearerAuth,
    OAuthError,
    OAuthErrorCode
} from '@modelcontextprotocol/server';

const PORT = Number(process.env.PORT ?? 4111);
const MCP_RESOURCE = process.env.MCP_RESOURCE ?? `http://localhost:${PORT}/mcp`;
const KC_ISSUER = process.env.KC_ISSUER ?? 'http://localhost:4180/realms/spike';
const KC_JWKS_URL = process.env.KC_JWKS_URL ?? `${KC_ISSUER}/protocol/openid-connect/certs`;

const resourceUrl = new URL(MCP_RESOURCE);
const mcpPath = resourceUrl.pathname; // "/mcp"
const metadataPathSuffixed = `/.well-known/oauth-protected-resource${mcpPath === '/' ? '' : mcpPath}`;
const metadataUrl = `${resourceUrl.origin}${metadataPathSuffixed}`;

const protectedResourceMetadata = {
    resource: MCP_RESOURCE,
    authorization_servers: [KC_ISSUER],
    scopes_supported: ['mcp:tools'],
    bearer_methods_supported: ['header'],
    resource_name: 'AI Operations Layer spike 2'
};

const jwks = createRemoteJWKSet(new URL(KC_JWKS_URL));

/** OAuthTokenVerifier for the SDK bearer gate. */
const verifier = {
    async verifyAccessToken(token) {
        try {
            const { payload } = await jwtVerify(token, jwks, {
                issuer: KC_ISSUER,
                audience: MCP_RESOURCE, // AUTH-1: token must be issued for this resource
                algorithms: ['RS256', 'PS256', 'ES256'],
                requiredClaims: ['exp', 'sub'],
                clockTolerance: 0
            });
            return {
                token,
                clientId: String(payload.azp ?? payload.client_id ?? ''),
                scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
                expiresAt: payload.exp,
                resource: new URL(MCP_RESOURCE),
                extra: {
                    sub: payload.sub,
                    preferred_username: payload.preferred_username,
                    groups: Array.isArray(payload.groups) ? payload.groups : [],
                    aud: payload.aud
                }
            };
        } catch (err) {
            throw new OAuthError(OAuthErrorCode.InvalidToken, `token rejected: ${err.code ?? err.message}`);
        }
    }
};

const gate = requireBearerAuth({
    verifier,
    expectedResource: resourceUrl,
    resourceMetadataUrl: metadataUrl
});

function buildServer() {
    const server = new McpServer({ name: 'spike-2-auth-keycloak', version: '0.0.0' });
    server.registerTool(
        'whoami',
        { description: 'Returns the authenticated subject, username and groups from the access token.' },
        async ctx => {
            const extra = ctx?.http?.authInfo?.extra ?? {};
            const result = {
                sub: extra.sub ?? null,
                preferred_username: extra.preferred_username ?? null,
                groups: extra.groups ?? [],
                client_id: ctx?.http?.authInfo?.clientId ?? null
            };
            return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
                structuredContent: result
            };
        }
    );
    return server;
}

const mcpHandler = createMcpHandler(() => buildServer(), {
    onerror: err => console.error('[mcp]', err.message)
});

function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body));
}

async function toWebRequest(req) {
    const url = `http://${req.headers.host ?? `localhost:${PORT}`}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
        else if (v !== undefined) headers.set(k, v);
    }
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        body = Buffer.concat(chunks);
    }
    return new Request(url, { method: req.method, headers, body });
}

async function writeWebResponse(res, response) {
    const headers = {};
    response.headers.forEach((v, k) => {
        headers[k] = v;
    });
    res.writeHead(response.status, headers);
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
}

const httpServer = http.createServer(async (req, res) => {
    try {
        const path = new URL(req.url, 'http://x').pathname;
        if (req.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === metadataPathSuffixed)) {
            return json(res, 200, protectedResourceMetadata);
        }
        if (path === '/healthz') return json(res, 200, { ok: true });
        if (path === mcpPath) {
            const request = await toWebRequest(req);
            const auth = await gate(request);
            if (auth instanceof Response) {
                const who = req.headers.authorization ? 'invalid token' : 'no token';
                console.log(`[auth] ${req.method} ${path} -> ${auth.status} (${who})`);
                return writeWebResponse(res, auth);
            }
            console.log(`[auth] ${req.method} ${path} -> ok sub=${auth.extra?.sub} client=${auth.clientId}`);
            return writeWebResponse(res, await mcpHandler.fetch(request, { authInfo: auth }));
        }
        json(res, 404, { error: 'not_found' });
    } catch (err) {
        console.error('[http]', err);
        if (!res.headersSent) json(res, 500, { error: 'server_error' });
        else res.end();
    }
});

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`resource server on :${PORT} resource=${MCP_RESOURCE} issuer=${KC_ISSUER} metadata=${metadataUrl}`);
});
