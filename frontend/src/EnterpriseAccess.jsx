import React, { useEffect, useState } from 'react';
import { useAuth } from './contexts';
import { Button } from './Controls';
import { panel, Problem } from './SalesWorkspace';
export function EnterpriseAccess() {
  const { apiFetch } = useAuth(); const [data, setData] = useState(null), [error, setError] = useState('');
  const load = () => { setError(''); return apiFetch('/enterprise/status').then(setData).catch(e => setError(e.message)); };
  useEffect(() => { load(); }, [apiFetch]);
  return <section className={`${panel} space-y-3`}><div className="flex justify-between flex-wrap gap-2"><h3 className="font-bold">Enterprise sign-in and provisioning</h3><Button variant="secondary" onClick={load}>Refresh access setup</Button></div><Problem message={error} />
    {data && <><p>OIDC: {data.providers.oidc.enabled ? 'Configured' : 'Needs setup'} · SAML: {data.providers.saml.enabled ? 'Configured' : 'Needs setup'} · SCIM: {data.scimConfigured ? 'Configured' : 'Needs setup'}</p><p>{data.required ? 'Enterprise sign-in is required for staff, except configured recovery accounts.' : 'Enterprise sign-in is optional. Existing sign-in methods remain available.'}</p><p>Provisioned users: {data.provisionedUsers} · New-user role: {data.defaultRole || 'Not configured'}</p><p>Allowed email domains: {data.domains.join(', ') || 'Not configured'}</p>
      <dl className="grid gap-2 break-all text-sm">{[['OIDC redirect URI', data.oidcCallback], ['SAML reply / ACS URL', data.samlAcs], ['SAML metadata URL', data.samlMetadata], ['SCIM tenant URL', data.scimBase]].map(([label, value]) => <div key={label}><dt className="font-semibold">{label}</dt><dd className="select-all text-slate-400">{value}</dd></div>)}</dl>
      <details><summary className="cursor-pointer">Connect Entra or Okta</summary><ol className="list-decimal pl-5 space-y-2 mt-3"><li>Create an OIDC web application or SAML application in your identity provider, using the matching URLs above.</li><li>Configure the issuer, client credentials or signing certificate, and allowed email domains in the deployment. SAML requires a persistent NameID, an email attribute, and signatures on both the assertion and response.</li><li>For provisioning, configure a strong SCIM bearer token and a default role without administrative privileges. Enable user creation, updates and deactivation. Group and role provisioning are not supported.</li><li>Test an existing active account before requiring enterprise sign-in. Keep a designated recovery account and verify its access.</li></ol><p className="mt-3">SCIM deactivation revokes sessions, API keys, connected-app tokens and mailbox access. Reactivation requires fresh sign-in and mailbox consent. Use active=false to suspend users reversibly; SCIM DELETE removes them from the directory while retaining their CRM history.</p></details>
    </>}
  </section>;
}
