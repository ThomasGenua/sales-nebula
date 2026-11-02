import React from 'react';
import { ArrowRight, Check, Server, Users } from 'lucide-react';
import { Header, Footer, PageLink } from './Landing';
import './Landing.css';

function Shell({ go, children }) {
  return <div className="sn-site"><a className="sn-site-skip" href="#main-content">Skip to content</a><Header go={go} /><main id="main-content" tabIndex={-1}>{children}</main><Footer go={go} /></div>;
}

export function HostingPage({ go }) {
  const rows = [
    ['Where it runs', 'Infrastructure you choose and control.', 'Deployment arrangements confirmed during review.'],
    ['Setup & upgrades', 'Your team installs, configures, and updates the application.', 'Agree on setup, upgrades, and ongoing ownership before starting.'],
    ['Backups & recovery', 'Your team schedules backups and tests restoration.', 'Confirm retention, restoration, and recovery expectations in the hosting agreement.'],
    ['Support', 'Repository documentation and the project issue tracker. No response-time commitment.', 'Support scope and response expectations are agreed separately.'],
    ['Connected providers', 'Bring your own email, payment, signature, and other provider accounts.', 'Provider accounts, credentials, consent, and fees still need to be arranged.'],
    ['Cost', 'Budget for infrastructure, operations, and any paid providers.', 'Request a scope and quote. No published managed plan or instant purchase.'],
  ];
  return <Shell go={go}><section className="sn-site-section sn-public-intro"><div className="sn-site-container"><p className="sn-eyebrow">A HOME FOR YOUR TEAM’S WORK</p><h1>Choose how<br />you run <span>your Nebula.</span></h1><p>Take the project into your own infrastructure, or tell us what you need from a hosted workspace. Make the responsibilities clear before you begin.</p></div></section>
    <section className="sn-site-container sn-plan-grid" aria-label="Hosting options">
      <article className="sn-plan-card"><Server size={28} aria-hidden="true" /><p className="sn-eyebrow">SELF-HOSTED</p><h2>Your infrastructure.<br />Your operating plan.</h2><p>For teams with someone ready to own deployment, maintenance, and recovery.</p><ul>{['A dedicated installation for your company', 'Control over your deployment and data location', 'Source code and setup documentation'].map(x => <li key={x}><Check size={17} aria-hidden="true" />{x}</li>)}</ul><a className="sn-site-button" href="https://github.com/ThomasGenua/sales-nebula#readme" target="_blank" rel="noopener noreferrer">Read the setup guide <ArrowRight size={16} aria-hidden="true" /></a><PageLink go={go} href="/?hosting=self-hosted#access" className="sn-text-link">Discuss a self-hosted rollout →</PageLink></article>
      <article className="sn-plan-card"><Users size={28} aria-hidden="true" /><p className="sn-eyebrow">HOSTING BY ARRANGEMENT</p><h2>A conversation<br />before a commitment.</h2><p>For teams that want to discuss help running Sales Nebula. Availability and scope are reviewed with your request.</p><ul>{['Share team size and the workflows you need', 'Confirm hosting, migration, and support scope', 'Agree on pricing before provisioning'].map(x => <li key={x}><Check size={17} aria-hidden="true" />{x}</li>)}</ul><PageLink go={go} href="/?hosting=cloud#access" className="sn-site-button">Discuss hosting <ArrowRight size={16} aria-hidden="true" /></PageLink><p className="sn-small-note">A request starts a review. It does not activate a plan or create a charge.</p></article>
    </section>
    <section className="sn-site-section"><div className="sn-site-container"><p className="sn-eyebrow">KNOW WHO OWNS WHAT</p><h2>A clear starting point.</h2><div className="sn-comparison" role="region" aria-label="Hosting responsibilities" tabIndex={0}><table><caption>Responsibilities and costs by deployment option</caption><thead><tr><th scope="col">Consideration</th><th scope="col">Self-hosted</th><th scope="col">Hosting by arrangement</th></tr></thead><tbody>{rows.map(([label, self, managed]) => <tr key={label}><th scope="row">{label}</th><td>{self}</td><td>{managed}</td></tr>)}</tbody></table></div></div></section>
  </Shell>;
}

export const WALKTHROUGH = [
  { key: 'lead', title: 'Know who you’re talking to.', copy: 'Bring the source, company, qualification, and contact details into one lead record. Start with enough context to make the next conversation useful.', alt: 'Sales Nebula lead record for fictional Anna Martinez at TechStart, with contact and qualification details.' },
  { key: 'deal', title: 'Give the opportunity a direction.', copy: 'Keep the stage, value, expected close date, and related account together. Everyone can see what the opportunity is and where it stands.', alt: 'Sales Nebula opportunity record for the fictional TechStart team rollout, in the negotiation stage.' },
  { key: 'quote', title: 'Make the proposal concrete.', copy: 'Review the offer with product lines, quantities, terms, and totals. Follow the linked deal without rebuilding its context.', alt: 'Sales Nebula sample TechStart quote showing product lines and a fictional total of 32,000 dollars.' },
];
export function WalkthroughPreview({ go }) {
  return <section className="sn-site-section sn-real-preview"><div className="sn-site-container sn-walkthrough-teaser"><div><p className="sn-eyebrow">INSIDE THE WORKSPACE</p><h2>Less guessing.<br />Take a closer look.</h2><p>See the actual application with fictional records, then follow a lead through a deal and a quote yourself.</p><PageLink go={go} href="/tour" className="sn-text-link">Take the product walkthrough <ArrowRight size={18} aria-hidden="true" /></PageLink></div><a href="/tour" aria-label="View the product walkthrough"><img src="/product/deal.jpg" width="1280" height="960" loading="lazy" decoding="async" alt={WALKTHROUGH[1].alt} /></a></div></section>;
}
export function TourPage({ go }) {
  return <Shell go={go}><section className="sn-site-section sn-public-intro"><div className="sn-site-container"><p className="sn-eyebrow">FROM FIRST INTEREST TO A CLEAR OFFER</p><h1>Three steps.<br /><span>One connected story.</span></h1><p>A look inside the actual Sales Nebula workspace. Every record and amount shown here is fictional sample data.</p><PageLink go={go} href="/demo" className="sn-site-button">Start the interactive tour <ArrowRight size={18} aria-hidden="true" /></PageLink><p className="sn-small-note">No account, payment details, or setup needed. Read-only sample workspace.</p></div></section>
    <div className="sn-site-container">{WALKTHROUGH.map((step, i) => <section className="sn-walkthrough-step" key={step.key} aria-labelledby={`walk-${step.key}`}><div><p className="sn-eyebrow">0{i + 1} / {step.key.toUpperCase()}</p><h2 id={`walk-${step.key}`}>{step.title}</h2><p>{step.copy}</p></div><figure><a href={`/product/${step.key}.jpg`} target="_blank" rel="noopener noreferrer" aria-label={`Open full-size ${step.key} screenshot`}><img src={`/product/${step.key}.jpg`} width="1280" height="960" loading="lazy" decoding="async" alt={step.alt} /></a><figcaption>Actual application · Fictional sample records · Open image for full-size view</figcaption></figure></section>)}</div>
    <section className="sn-site-section"><div className="sn-site-container sn-tour-end"><h2>See how it feels to work here.</h2><p>The interactive demo lets you explore without changing records. Live email, signatures, and payment collection need a configured installation.</p><PageLink go={go} href="/demo" className="sn-site-button">Explore the demo <ArrowRight size={18} aria-hidden="true" /></PageLink><PageLink go={go} href="/hosting" className="sn-text-link">Compare hosting options →</PageLink></div></section>
  </Shell>;
}
