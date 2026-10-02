import React from "react";

const FEATURES = {
  campaigns: {
    title: "Campaign email delivery",
    description: "Use campaigns to plan work and record results. Bulk email sending and automatic engagement tracking are unavailable. Individual emails can be sent from contacts, deals or Emails when email delivery is configured.",
  },
  integrations: {
    title: "Third-party synchronization",
    description: "Integration records can store configuration, but connection testing and synchronization are unavailable. Mailbox connections and authorized apps are separate features.",
  },
  sso: {
    title: "Custom SSO providers",
    description: "Sign-in through custom SAML or OpenID Connect (OIDC) providers is unavailable. Use password sign-in, with authenticator-app two-factor authentication if enabled.",
  },
};

export function FeatureAvailability({ features = ["campaigns", "integrations", "sso"] }) {
  return <div className={`grid gap-3 ${features.length > 1 ? "lg:grid-cols-3" : ""}`}>
    {features.map(key => {
      const feature = FEATURES[key];
      return <section key={key} aria-label={feature.title} className="rounded-xl border p-4"
        style={{ background: "var(--sn-panel)", borderColor: "var(--sn-rule)" }}>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h2 className="text-sm font-semibold" style={{ color: "var(--sn-body)" }}>{feature.title}</h2>
          <span className="rounded-md border px-2 py-0.5 text-xs"
            style={{ borderColor: "var(--sn-rule)", color: "var(--sn-slate)" }}>Unavailable</span>
        </div>
        <p className="text-xs leading-relaxed" style={{ color: "var(--sn-slate)" }}>{feature.description}</p>
      </section>;
    })}
  </div>;
}
