// Runs under Node (not Jest's CommonJS VM) to exercise jose's actual ESM
// implementation and node-saml against generated keys. No network or real IdP.
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { SignedXml } = require('xml-crypto');
const identity = require('../../src/services/enterpriseIdentity');
async function main() {
  const jose = require('jose'), keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', use: 'sig', alg: 'RS256' };
  Object.assign(process.env, { OIDC_ISSUER: 'https://identity.example.test', OIDC_CLIENT_ID: 'fixture-client', OIDC_CLIENT_SECRET: 'fixture-secret', OIDC_TOKEN_URL: 'https://identity.example.test/token', OIDC_JWKS_URL: 'https://identity.example.test/keys', FRONTEND_URL: 'https://crm.example.test' });
  let token;
  global.fetch = async (url, options) => {
    if (String(url) === process.env.OIDC_TOKEN_URL) { assert.equal(new URLSearchParams(options.body).get('code_verifier'), 'fixture-pkce'); return Response.json({ id_token: token }); }
    assert.equal(String(url), process.env.OIDC_JWKS_URL); return Response.json({ keys: [jwk] });
  };
  const sign = async changes => new jose.SignJWT({ nonce: 'fixture-nonce', email: 'alice@example.com', email_verified: true, ...changes }).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).setSubject('alice-subject').setIssuer(changes?.iss || process.env.OIDC_ISSUER).setAudience(changes?.aud || process.env.OIDC_CLIENT_ID).setIssuedAt().setExpirationTime(changes?.exp || '5m').sign(keys.privateKey);
  const row = { nonce: 'fixture-nonce', verifier: 'fixture-pkce' };
  token = await sign(); assert.equal((await identity.oidc(row, 'code')).subject, 'alice-subject');
  for (const changes of [{ nonce: 'wrong' }, { iss: 'https://wrong.example.test' }, { aud: 'other-client' }, { azp: 'other-client' }, { exp: Math.floor(Date.now() / 1000) - 120 }]) {
    token = await sign(changes); await assert.rejects(() => identity.oidc(row, 'code'));
  }
  token = await sign(); const parts = token.split('.'); parts[1] = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url'); token = parts.join('.'); await assert.rejects(() => identity.oidc(row, 'code'));

  Object.assign(process.env, { ENTERPRISE_SSO_ENABLED: 'true', ENTERPRISE_EMAIL_DOMAINS: 'example.com', SAML_IDP_ISSUER: 'https://saml.example.test', SAML_ENTRY_POINT: 'https://saml.example.test/login', SAML_IDP_CERT: keys.publicKey.export({ format: 'pem', type: 'spki' }), SAML_SP_ENTITY_ID: 'https://crm.example.test/entity' });
  const attempts = new Map(), cacheRows = new Map();
  const db = { enterpriseLoginAttempt: {
    deleteMany: async () => ({ count: 0 }), create: async ({ data }) => { attempts.set(data.stateHash, data); return data; }, findUnique: async ({ where }) => attempts.get(where.stateHash),
    updateMany: async ({ where, data }) => { const row = attempts.get(where.stateHash); if (!row || row.ticketHash) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
  }, samlRequest: {
    create: async ({ data }) => { if (cacheRows.has(data.id)) throw Object.assign(new Error('duplicate'), { code: 'P2002' }); cacheRows.set(data.id, data); return data; },
    findUnique: async ({ where }) => cacheRows.get(where.id), deleteMany: async ({ where }) => ({ count: where.id && cacheRows.delete(where.id) ? 1 : 0 }),
  }, $transaction: async fn => fn(db) };
  const res = { cookie() {}, set() { return this; }, redirect(code, url) { this.location = url; assert.equal(code, 303); } };
  const req = { params: { provider: 'saml' }, get: () => null };
  const start = async () => { const { authorizationUrl } = await identity.start(db, req, res), state = new URL(authorizationUrl).searchParams.get('RelayState'); return { state, row: attempts.get(crypto.createHash('sha256').update(state).digest('hex')) }; };
  const signature = (xml, name) => {
    const sig = new SignedXml({ privateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#', signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256' });
    sig.addReference({ xpath: `//*[local-name(.)='${name}']`, transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
    sig.computeSignature(xml, { location: { reference: `//*[local-name(.)='${name}']/*[local-name(.)='Issuer']`, action: 'after' } }); return sig.getSignedXml();
  };
  const response = (attempt, audience = process.env.SAML_SP_ENTITY_ID) => {
    const now = new Date().toISOString(), until = new Date(Date.now() + 300000).toISOString(), before = new Date(Date.now() - 60000).toISOString(), requestId = '_' + attempt.row.nonce;
    let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${crypto.randomUUID()}" Version="2.0" IssueInstant="${now}" Destination="https://crm.example.test/api/enterprise/saml/acs" InResponseTo="${requestId}"><saml:Issuer>${process.env.SAML_IDP_ISSUER}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="_${crypto.randomUUID()}" Version="2.0" IssueInstant="${now}"><saml:Issuer>${process.env.SAML_IDP_ISSUER}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">alice-subject</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" NotOnOrAfter="${until}" Recipient="https://crm.example.test/api/enterprise/saml/acs"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${before}" NotOnOrAfter="${until}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${now}" SessionIndex="fixture-session"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>alice@example.com</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;
    xml = signature(xml, 'Assertion'); return signature(xml, 'Response');
  };
  const acs = (attempt, xml) => identity.samlAcs(db, { body: { RelayState: attempt.state, SAMLResponse: Buffer.from(xml).toString('base64') } }, res);
  const valid = await start(), validXml = response(valid); await acs(valid, validXml); assert.match(res.location, /enterprise=saml/); assert.equal(valid.row.identity.subject, 'alice-subject'); await assert.rejects(() => acs(valid, validXml));
  const tampered = await start(); await assert.rejects(() => acs(tampered, response(tampered).replace('alice@example.com', 'attacker@example.com')));
  const audience = await start(); await assert.rejects(() => acs(audience, response(audience, 'https://wrong.example.test')));
  const requestA = await start(), requestB = await start(); await assert.rejects(() => acs(requestB, response(requestA)));
  console.log('OIDC and SAML signed identity fixtures passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
