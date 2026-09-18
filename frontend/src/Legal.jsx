import React from "react";
import { BrandMark } from "./theme";

const display = '"Poppins", system-ui, sans-serif';
const body = '"Poppins", system-ui, sans-serif';

const shell = {
  minHeight: "100vh",
  background: "var(--sn-void)",
  color: "var(--sn-cream)",
};

const wrap = {
  maxWidth: 720,
  margin: "0 auto",
  padding: "48px 20px 80px",
};

function LegalShell({ go, title, children }) {
  return (
    <div style={shell}>
      <header
        style={{
          borderBottom: "1px solid var(--sn-rule)",
          padding: "14px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <a href="/" onClick={(e) => { e.preventDefault(); go("/"); }} style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "var(--sn-cream)" }}>
          <BrandMark size={32} />
          <span style={{ fontFamily: display, fontWeight: 700, fontSize: 16 }}>Sales Nebula</span>
        </a>
        <button
          type="button"
          onClick={() => go("/")}
          style={{
            fontFamily: body,
            fontSize: 13,
            fontWeight: 600,
            color: "var(--sn-amber-ink)",
            background: "none",
            border: "none",
            cursor: "pointer",
          }}
        >
          Back to home
        </button>
      </header>
      <article style={wrap}>
        <h1 style={{ fontFamily: display, fontSize: 32, fontWeight: 700, letterSpacing: "-0.03em", margin: "0 0 8px" }}>
          {title}
        </h1>
        <p style={{ fontFamily: body, fontSize: 13, color: "var(--sn-dim)", margin: "0 0 32px" }}>
          Last updated: 24 August 2026
        </p>
        <div style={{ fontFamily: body, fontSize: 15, lineHeight: 1.7, color: "var(--sn-body)" }}>
          {children}
        </div>
      </article>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ fontFamily: display, fontSize: 18, fontWeight: 700, color: "var(--sn-cream)", margin: "0 0 10px" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function PrivacyPage({ go }) {
  return (
    <LegalShell go={go} title="Privacy Policy">
      <Section title="Who we are">
        <p style={{ margin: "0 0 12px" }}>
          Sales Nebula (“we”, “us”) provides a sales CRM platform. This policy explains what information we collect when you use our website, request access, or use a Sales Nebula workspace.
        </p>
      </Section>
      <Section title="Information we collect">
        <p style={{ margin: "0 0 12px" }}>We may collect:</p>
        <ul style={{ margin: "0 0 12px", paddingLeft: 20 }}>
          <li>Account details such as name, email, company, and role</li>
          <li>CRM records you or your organization enter (contacts, deals, notes, files, and related activity)</li>
          <li>Technical data such as IP address, browser type, and approximate usage logs needed to operate and secure the service</li>
          <li>Communications you send to us, including access requests and support messages</li>
        </ul>
      </Section>
      <Section title="How we use information">
        <p style={{ margin: "0 0 12px" }}>
          We use information to provide and improve Sales Nebula, authenticate users, send transactional email (verification, invites, password resets, and product notices), prevent abuse, and comply with legal obligations.
        </p>
      </Section>
      <Section title="Self-hosted deployments">
        <p style={{ margin: "0 0 12px" }}>
          If you run Sales Nebula on your own infrastructure, customer CRM data stays under your control in your environment. Our marketing site and access-request process may still collect contact details you submit to us.
        </p>
      </Section>
      <Section title="Sharing">
        <p style={{ margin: "0 0 12px" }}>
          We do not sell personal information. We may share data with subprocessors that help us operate email delivery, hosting, or security — only as needed to run the service — or when required by law.
        </p>
      </Section>
      <Section title="Retention and security">
        <p style={{ margin: "0 0 12px" }}>
          We retain information for as long as needed for the purposes above, including account administration and security. We use industry-standard safeguards such as encrypted transport and hashed passwords. No method of transmission or storage is perfectly secure.
        </p>
      </Section>
      <Section title="Your choices">
        <p style={{ margin: "0 0 12px" }}>
          You may request access, correction, or deletion of personal information we hold about you by contacting us. Workspace administrators control user access inside their Sales Nebula instance.
        </p>
      </Section>
      <Section title="Contact">
        <p style={{ margin: 0 }}>
          Questions about privacy: <a href="mailto:privacy@salesnebula.com" style={{ color: "var(--sn-amber-ink)" }}>privacy@salesnebula.com</a>
        </p>
      </Section>
    </LegalShell>
  );
}

export function TermsPage({ go }) {
  return (
    <LegalShell go={go} title="Terms of Service">
      <Section title="Agreement">
        <p style={{ margin: "0 0 12px" }}>
          By accessing Sales Nebula websites, requesting an account, or using the product, you agree to these Terms. If you use Sales Nebula on behalf of an organization, you represent that you have authority to bind that organization.
        </p>
      </Section>
      <Section title="The service">
        <p style={{ margin: "0 0 12px" }}>
          Sales Nebula is a CRM platform for managing leads, accounts, deals, quoting, and related revenue workflows. Features may change as we improve the product. Demo environments are provided for evaluation and may be reset or limited.
        </p>
      </Section>
      <Section title="Accounts and access">
        <p style={{ margin: "0 0 12px" }}>
          Access is granted by invitation or administrator approval. You are responsible for safeguarding credentials and for activity under your account. Notify us promptly of unauthorized use.
        </p>
      </Section>
      <Section title="Acceptable use">
        <p style={{ margin: "0 0 12px" }}>
          You may not misuse the service, attempt unauthorized access, interfere with other customers, upload unlawful content, or use Sales Nebula to spam or harass. We may suspend access for abuse or security risk.
        </p>
      </Section>
      <Section title="Customer data">
        <p style={{ margin: "0 0 12px" }}>
          You retain ownership of CRM data you submit. You grant us a limited license to process that data solely to provide the service. For self-hosted deployments, you are responsible for backups, security, and compliance in your environment.
        </p>
      </Section>
      <Section title="Intellectual property">
        <p style={{ margin: "0 0 12px" }}>
          Sales Nebula software, branding, and documentation remain our property (or our licensors’). These Terms do not transfer ownership of our IP to you.
        </p>
      </Section>
      <Section title="Disclaimer and liability">
        <p style={{ margin: "0 0 12px" }}>
          The service is provided “as is” to the fullest extent permitted by law. We disclaim warranties of merchantability, fitness for a particular purpose, and non-infringement. Our aggregate liability arising from the service is limited to the fees you paid us for the service in the three months before the claim (or zero if you use a free evaluation).
        </p>
      </Section>
      <Section title="Changes">
        <p style={{ margin: "0 0 12px" }}>
          We may update these Terms. Continued use after changes become effective constitutes acceptance of the updated Terms.
        </p>
      </Section>
      <Section title="Contact">
        <p style={{ margin: 0 }}>
          Legal questions: <a href="mailto:legal@salesnebula.com" style={{ color: "var(--sn-amber-ink)" }}>legal@salesnebula.com</a>
        </p>
      </Section>
    </LegalShell>
  );
}
