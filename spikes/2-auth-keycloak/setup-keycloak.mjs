// Spike 2: realm settings that cannot be expressed cleanly in realm.json, applied through
// the Keycloak Admin REST API after the realm import.
//
//  1. Anonymous Dynamic Client Registration: the default "Trusted Hosts" policy rejects
//     every anonymous registration (no trusted hosts configured). We switch it from
//     "trust the sending host" to "trust redirect-URI hosts": any sender may register,
//     but only with redirect URIs on DCR_TRUSTED_HOSTS. The other default anonymous
//     policies (Consent Required, Full Scope Disabled, Max Clients 200, Allowed Client
//     Scopes = realm defaults, Allowed Protocol Mapper Types) stay as Keycloak ships them.
//  2. Client ID Metadata Documents: a client profile with the `client-id-metadata-document`
//     executor and a client policy with the `client-id-uri` condition (Keycloak MCP guide).
//
// Usable standalone: `node setup-keycloak.mjs` (env as below), or imported by check.mjs.
//
// Env:
//   KC_URL            Keycloak base URL for admin calls (default http://localhost:4180)
//   MCP_RESOURCE      MCP resource URL for the CIMD resource-indicator allow list
//   DCR_TRUSTED_HOSTS comma list (default localhost,127.0.0.1,claude.ai,chatgpt.com)
//   CIMD_CLIENT_DOMAINS  comma list of hosts allowed as CIMD client_id hosts
//                        (default host.docker.internal,claude.ai)
//   CIMD_EXTRA_DOMAINS   comma list of hosts additionally allowed in metadata URLs
//                        (default localhost,127.0.0.1,chatgpt.com — redirect URI hosts; Keycloak checks
//                        every redirect_uris entry against the trusted domains)

const KC_URL = process.env.KC_URL ?? 'http://localhost:4180';
const REALM = 'spike';
const list = (v, d) => (v ?? d).split(',').map(s => s.trim()).filter(Boolean);

export async function adminToken() {
    const res = await fetch(`${KC_URL}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'admin' })
    });
    if (!res.ok) throw new Error(`admin token: ${res.status} ${await res.text()}`);
    return (await res.json()).access_token;
}

async function admin(token, method, path, body) {
    const res = await fetch(`${KC_URL}/admin/realms/${REALM}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
}

export async function configureDcr(token, trustedHosts) {
    const comps = await admin(token, 'GET', '/components?type=org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy');
    const th = comps.find(c => c.providerId === 'trusted-hosts' && c.subType === 'anonymous');
    if (!th) throw new Error('anonymous Trusted Hosts policy not found');
    th.config = {
        ...th.config,
        'trusted-hosts': trustedHosts,
        'host-sending-registration-request-must-match': ['false'],
        'client-uris-must-match': ['true']
    };
    await admin(token, 'PUT', `/components/${th.id}`, th);
    return comps.filter(c => c.subType === 'anonymous').map(c => `${c.name}${c.id === th.id ? ' (updated)' : ''}`);
}

export async function configureCimd(token, { resource, clientDomains, extraDomains }) {
    await admin(token, 'PUT', '/client-policies/profiles', {
        profiles: [
            {
                name: 'cimd-profile',
                description: 'Accept OAuth Client ID Metadata Documents from trusted domains',
                executors: [
                    {
                        executor: 'client-id-metadata-document',
                        configuration: {
                            'cimd-allow-http-scheme': false,
                            'cimd-allow-permitted-domains': [...clientDomains, ...extraDomains],
                            // OFF: loopback redirect URIs (Claude Code) are not on the client_id domain
                            'cimd-restrict-same-domain': false,
                            'only-allow-confidential-client': false,
                            // ON: Claude Desktop's metadata lists the jwt-bearer grant (Keycloak MCP guide)
                            'accept-public-client-with-confidential-client-only-grant': true,
                            'cimd-resource-indicator-allow-list': [resource]
                        }
                    }
                ]
            }
        ]
    });
    await admin(token, 'PUT', '/client-policies/policies', {
        policies: [
            {
                name: 'cimd-policy',
                description: 'URL-formatted client_id on a trusted domain -> cimd-profile',
                enabled: true,
                conditions: [
                    {
                        condition: 'client-id-uri',
                        configuration: { 'client-id-uri-scheme': ['https'], 'client-id-uri-allow-permitted-domains': clientDomains }
                    }
                ],
                profiles: ['cimd-profile']
            }
        ]
    });
}

export async function setup() {
    const token = await adminToken();
    const dcr = await configureDcr(token, list(process.env.DCR_TRUSTED_HOSTS, 'localhost,127.0.0.1,claude.ai,chatgpt.com'));
    await configureCimd(token, {
        resource: process.env.MCP_RESOURCE ?? 'http://localhost:4111/mcp',
        clientDomains: list(process.env.CIMD_CLIENT_DOMAINS, 'host.docker.internal,claude.ai'),
        extraDomains: list(process.env.CIMD_EXTRA_DOMAINS, 'localhost,127.0.0.1,chatgpt.com')
    });
    return { anonymousDcrPolicies: dcr };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    setup()
        .then(r => console.log('keycloak setup done:', JSON.stringify(r)))
        .catch(e => {
            console.error(e);
            process.exit(1);
        });
}
