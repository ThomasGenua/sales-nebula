import React, { useEffect, useRef, useState } from "react";
import {
  ArrowRight, ArrowUpRight, BarChart3, Calendar, Check, CheckCircle2,
  ChevronDown, Circle, Clock, CreditCard, FileText, Github, LayoutDashboard,
  ListTodo, Lock, Mail, Menu, Phone, Play, Server, Shield,
  Target, Users, X,
} from "lucide-react";
import { BrandMark, ThemeToggle } from "./theme";
import "./Landing.css";

const REPO = "https://github.com/ThomasGenua/sales-nebula";
const links = [["Product", "product"], ["Workflow", "workflow"], ["Integrations", "integrations"], ["FAQ", "faq"]];

// Normal anchors retain browser history, modifier-click and deep-link behavior.
function PageLink({ go, href, children, ...props }) {
  return <a href={href} {...props} onClick={(event) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go(href);
  }}>{children}</a>;
}

function Header({ go }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef(null);
  const header = useRef(null);
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 961px)");
    const closeOnResize = () => { if (wide.matches) setOpen(false); };
    wide.addEventListener("change", closeOnResize);
    return () => wide.removeEventListener("change", closeOnResize);
  }, []);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") { setOpen(false); toggle.current?.focus(); }
    };
    const closeOutside = (event) => { if (!header.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [open]);

  return <header className="sn-site-header" ref={header}>
    <div className="sn-site-container sn-site-nav">
      <a href="/" className="sn-site-brand" aria-label="Sales Nebula home"><BrandMark size={34} alt="" />Sales Nebula<span className="sn-brand-dot">.</span></a>
      <nav aria-label="Main navigation" className="sn-site-desktop-nav">
        {links.map(([label, id]) => <a key={id} href={`#${id}`}>{label}</a>)}
      </nav>
      <div className="sn-site-nav-actions">
        <ThemeToggle compact />
        <PageLink go={go} href="/login" className="sn-site-sign-in">Log in <ArrowUpRight size={14} aria-hidden="true" /></PageLink>
        <a href="#access" className="sn-site-button sn-site-button-small">Request access <ArrowRight size={16} aria-hidden="true" /></a>
        <button ref={toggle} type="button" className="sn-site-menu-toggle" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} aria-controls="sn-mobile-menu" onClick={() => setOpen(!open)}>
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>
    </div>
    <nav id="sn-mobile-menu" className="sn-site-mobile-nav" aria-label="Mobile navigation" hidden={!open} onBlur={(event) => {
      if (event.relatedTarget && !header.current?.contains(event.relatedTarget)) setOpen(false);
    }}>
      {links.map(([label, id]) => <a key={id} href={`#${id}`} onClick={() => setOpen(false)}>{label}<ArrowUpRight size={16} aria-hidden="true" /></a>)}
      <PageLink go={go} href="/login">Log in <ArrowUpRight size={16} aria-hidden="true" /></PageLink>
      <a href="#access" className="sn-site-button" onClick={() => setOpen(false)}>Request access <ArrowRight size={16} aria-hidden="true" /></a>
    </nav>
  </header>;
}

const stages = [
  { name: "Discovery", total: "$72,000", tone: "blue", deals: [
    { company: "Northstar", name: "Team expansion", value: "$48,000", initials: "JD", next: "Discovery call", icon: Phone },
    { company: "Orbit", name: "Workspace rollout", value: "$24,000", initials: "AL", next: "Send follow-up", icon: Mail },
  ] },
  { name: "Proposal", total: "$108,000", tone: "amber", deals: [
    { company: "Acme", name: "Enterprise plan", value: "$72,000", initials: "MK", next: "Review proposal", icon: FileText },
    { company: "Cedar", name: "Annual agreement", value: "$36,000", initials: "JD", next: "Confirm next steps", icon: Calendar },
  ] },
  { name: "Won", total: "$42,000", tone: "green", deals: [
    { company: "Summit", name: "Platform upgrade", value: "$30,000", initials: "AL", next: "Start onboarding", icon: CheckCircle2 },
    { company: "Helix", name: "New team setup", value: "$12,000", initials: "MK", next: "Welcome call", icon: CheckCircle2 },
  ] },
];
const previewTabs = [
  { id: "pipeline", label: "Pipeline", icon: LayoutDashboard, title: "A little clarity. A lot of momentum.", caption: "See the deal, the owner, and the next move in one place." },
  { id: "day", label: "My day", icon: ListTodo, title: "Your next move, already in view.", caption: "Keep calls, tasks, and cadence follow-ups together." },
  { id: "revenue", label: "Revenue", icon: CreditCard, title: "Keep the handoff moving.", caption: "Carry the customer from proposal to signature to payment." },
];

function PipelinePreview() {
  return <>
    <div className="sn-preview-metrics">
      <div><span>Open pipeline</span><strong>$180,000</strong></div>
      <div><span>In proposal</span><strong>2 <small>deals</small></strong></div>
      <div><span>Closed won</span><strong className="sn-positive">$42,000</strong></div>
    </div>
    <div className="sn-preview-board">
      {stages.map((stage) => <div className="sn-preview-stage" key={stage.name}>
        <div className={`sn-preview-stage-title sn-tone-${stage.tone}`}><span><i />{stage.name}<small>2</small></span><b>{stage.total}</b></div>
        {stage.deals.map(({ company, name, value, initials, next, icon: Icon }) => <article className="sn-preview-deal" key={company}>
          <span className="sn-preview-company">{company}</span><h4>{name}</h4>
          <div className="sn-preview-value"><strong>{value}</strong><span className="sn-preview-avatar">{initials}</span></div>
          <div className="sn-preview-next"><Icon size={12} aria-hidden="true" />{next}</div>
        </article>)}
      </div>)}
    </div>
  </>;
}

function DayPreview() {
  return <div className="sn-day-preview">
    <div className="sn-day-summary"><div><span className="sn-preview-eyebrow">YOUR FOCUS</span><h4>Make room for the right conversations.</h4></div><span className="sn-preview-count">3<span>next actions</span></span></div>
    <ul className="sn-preview-tasks">
      {[
        { icon: Phone, time: "09:30", title: "Discovery call with Northstar", detail: "Team expansion · Jordan Davis", tag: "Call" },
        { icon: Mail, time: "11:00", title: "Follow up on Orbit’s rollout", detail: "Outbound cadence · Step 2", tag: "Email" },
        { icon: FileText, time: "14:00", title: "Review Acme’s proposal", detail: "Enterprise plan · Morgan Kim", tag: "Task" },
      ].map(({ icon: Icon, time, title, detail, tag }) => <li key={title}><span className="sn-task-time">{time}</span><span className="sn-task-icon"><Icon size={18} aria-hidden="true" /></span><div><h4>{title}</h4><p>{detail}</p></div><span className="sn-task-tag">{tag}</span></li>)}
    </ul>
    <p className="sn-preview-note"><CheckCircle2 size={15} aria-hidden="true" />The account context travels with every task.</p>
  </div>;
}

function RevenuePreview() {
  return <div className="sn-revenue-preview">
    <div className="sn-invoice-top"><div><span className="sn-preview-eyebrow">ORBIT · WORKSPACE ROLLOUT</span><h4>One deal. All the way through.</h4></div><FileText size={28} aria-hidden="true" /></div>
    <ol className="sn-revenue-steps">{["Proposal shared", "Signature received", "Payment recorded"].map((step) => <li key={step}><CheckCircle2 size={19} aria-hidden="true" /><span>{step}</span></li>)}</ol>
    <div className="sn-preview-invoice"><div><span>Invoice · INV-1042</span><span className="sn-preview-status">Partially paid</span></div><strong>$24,000 <small>USD</small></strong><div className="sn-payment-track" aria-hidden="true"><span /></div><div><span>Paid <b>$8,000</b></span><span>Remaining <b>$16,000</b></span></div></div>
    <p className="sn-preview-note"><Lock size={14} aria-hidden="true" />Stripe payment links. A clear record of every receipt.</p>
  </div>;
}

function ProductPreview() {
  const [active, setActive] = useState(0);
  const tabs = useRef([]);
  const current = previewTabs[active];
  function changeTab(event, index) {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % previewTabs.length;
    if (event.key === "ArrowLeft") next = (index + previewTabs.length - 1) % previewTabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = previewTabs.length - 1;
    if (next === undefined) return;
    event.preventDefault(); setActive(next); tabs.current[next]?.focus();
  }
  return <div className="sn-product-preview" id="product">
    <h2 className="sn-visually-hidden">Explore Sales Nebula</h2>
    <div className="sn-preview-orbit sn-preview-orbit-one" aria-hidden="true" /><div className="sn-preview-orbit sn-preview-orbit-two" aria-hidden="true" />
    <div className="sn-preview-window">
      <div className="sn-preview-titlebar"><div className="sn-window-dots" aria-hidden="true"><i /><i /><i /></div><span>YOUR REVENUE WORKSPACE</span><span className="sn-sample-badge">Sample data</span></div>
      <div className="sn-preview-shell">
        <aside className="sn-preview-rail" aria-hidden="true"><span className="sn-rail-brand">n.</span>{[LayoutDashboard, Users, Target, Mail, BarChart3].map((Icon, index) => <span className={index === active ? "active" : ""} key={index}><Icon size={17} /></span>)}<span className="sn-rail-avatar">JD</span></aside>
        <div className="sn-preview-main">
          <div className="sn-preview-tabs" role="tablist" aria-label="Explore the product preview">{previewTabs.map(({ id, label, icon: Icon }, index) => <button key={id} ref={(el) => { tabs.current[index] = el; }} id={`preview-tab-${id}`} type="button" role="tab" tabIndex={active === index ? 0 : -1} aria-selected={active === index} aria-controls={`preview-panel-${id}`} onClick={() => setActive(index)} onKeyDown={(event) => changeTab(event, index)}><Icon size={15} aria-hidden="true" />{label}</button>)}</div>
          {previewTabs.map(({ id, label }, index) => <div key={id} id={`preview-panel-${id}`} role="tabpanel" aria-labelledby={`preview-tab-${id}`} tabIndex={0} hidden={active !== index} className="sn-preview-panel">
            <h3 className="sn-visually-hidden">{label} preview</h3>
            {id === "pipeline" ? <PipelinePreview /> : id === "day" ? <DayPreview /> : <RevenuePreview />}
          </div>)}
        </div>
      </div>
      <div className="sn-preview-bottom"><span><i />Connected from first touch to follow-through</span><span>Sales Nebula</span></div>
    </div>
    <div className="sn-preview-caption" aria-live="polite"><span className="sn-caption-line" aria-hidden="true" /><div><strong>{current.title}</strong><span>{current.caption}</span></div></div>
  </div>;
}

function Hero({ go }) {
  return <section className="sn-site-hero" aria-labelledby="hero-title">
    <div className="sn-site-container sn-hero-layout">
      <div className="sn-hero-content">
        <a className="sn-release-link" href="#workflow"><span>MEET YOUR NEXT CRM</span><ArrowUpRight size={14} aria-hidden="true" /></a>
        <h1 id="hero-title">Keep your<br /> next win<br /> <span>in sight.</span><svg className="sn-hero-spark" viewBox="0 0 60 60" aria-hidden="true"><path d="M30 4v52M4 30h52M12 12l36 36M12 48l36-36" /></svg></h1>
        <p className="sn-hero-description">A connected home for your pipeline, your people, and everything that happens after “yes.” Meet the CRM that keeps the whole relationship in view.</p>
        <div className="sn-hero-actions"><a href="#access" className="sn-site-button">Request access <ArrowRight size={18} aria-hidden="true" /></a><PageLink go={go} href="/login" className="sn-site-button sn-site-button-outline"><Play size={15} aria-hidden="true" />Explore the demo</PageLink></div>
        <p className="sn-hero-assurance"><Check size={14} aria-hidden="true" />Free browser demo <span>·</span> Sample data. No signup.</p>
      </div>
      <ProductPreview />
    </div>
    <div className="sn-site-container sn-hero-foundation"><p>One workspace.<br /><strong>The whole relationship.</strong></p><ul>{["Leads & contacts", "Pipeline & forecasts", "Quotes & payments", "Customer success"].map((item) => <li key={item}><Check size={16} aria-hidden="true" />{item}</li>)}</ul></div>
  </section>;
}

const workflows = [
  { number: "01", icon: Users, title: "Start with the full picture.", copy: "Bring accounts, contacts, and conversations together. Walk into the next meeting knowing who you’re talking to and where things stand.", tags: ["Account 360", "Lead conversion", "Email & calendar"], visual: "account" },
  { number: "02", icon: Target, title: "Give every deal a next step.", copy: "Move from a promising conversation to a repeatable process. Keep follow-ups visible, guide your team with cadences, and see the pipeline take shape.", tags: ["Pipeline board", "Multichannel cadences", "Forecasts & reports"], visual: "cadence" },
  { number: "03", icon: CreditCard, title: "Make “yes” the beginning.", copy: "Turn a proposal into a shared plan. Keep quotes, signatures, invoices, and onboarding connected to the customer you worked so hard to win.", tags: ["Deal rooms", "Stripe & DocuSign", "Success playbooks"], visual: "success" },
];

function WorkflowVisual({ kind }) {
  if (kind === "account") return <div className="sn-account-visual">
    <div className="sn-mini-account"><span className="sn-company-monogram">N</span><div><strong>Northstar</strong><span>Account overview</span></div><span className="sn-mini-tag">Customer</span></div>
    <div className="sn-account-facts"><div><span>Account owner</span><strong>Jordan Davis</strong></div><div><span>Open opportunity</span><strong>Team expansion</strong></div></div>
    <div className="sn-account-event"><span><Mail size={16} aria-hidden="true" /></span><div><strong>A conversation worth picking up.</strong><p>Re: Plans for the next quarter</p></div><span className="sn-event-time">Today</span></div>
    <div className="sn-connected-note"><span className="sn-overlap-avatar">JD</span><span className="sn-overlap-avatar">AL</span><span>People, history, and next steps. Together.</span></div>
  </div>;
  if (kind === "cadence") return <div className="sn-cadence-visual"><div className="sn-mini-header"><span>New relationship cadence</span><span className="sn-mini-tag">Active</span></div><ol>{[
    { icon: Mail, title: "A thoughtful introduction", subtitle: "Day 1 · Email", done: true },
    { icon: Phone, title: "Make the connection", subtitle: "Day 3 · Call", done: false },
    { icon: ListTodo, title: "Follow through", subtitle: "Day 5 · Task", done: false },
  ].map(({ icon: Icon, title, subtitle, done }) => <li key={title} className={done ? "complete" : ""}><span className="sn-cadence-node"><Icon size={17} aria-hidden="true" /></span><div><strong>{title}</strong><span>{subtitle}</span></div>{done ? <CheckCircle2 size={16} aria-label="Complete" /> : <Clock size={16} aria-label="Upcoming" />}</li>)}</ol></div>;
  return <div className="sn-success-visual"><div className="sn-mini-header"><span>Orbit · Customer launch</span><span className="sn-mini-tag">In progress</span></div><div className="sn-success-summary"><strong>A strong start.</strong><span>2 of 3 milestones complete</span></div><div className="sn-success-track" aria-hidden="true"><span /></div><ul>{["Agreement signed", "Kickoff completed", "First team training"].map((text, i) => <li key={text}>{i < 2 ? <CheckCircle2 size={17} aria-hidden="true" /> : <Circle size={17} aria-hidden="true" />}<span>{text}</span>{i === 2 && <small>Up next</small>}</li>)}</ul></div>;
}

function Workflow() {
  return <section id="workflow" className="sn-site-section sn-workflow-section" aria-labelledby="workflow-title"><div className="sn-site-container">
    <div className="sn-section-heading"><p className="sn-eyebrow">LESS HANDOFF. MORE FOLLOW-THROUGH.</p><h2 id="workflow-title">Good relationships<br />deserve a better system.</h2><p>From the first conversation to the next renewal, keep the context that makes your team better.</p></div>
    <div className="sn-workflow-list">{workflows.map(({ number, title, copy, tags, visual }) => <article className="sn-workflow-row" key={number}><div className="sn-workflow-copy"><span className="sn-step-number">{number}<span /></span><h3>{title}</h3><p>{copy}</p><ul>{tags.map((tag) => <li key={tag}><Check size={14} aria-hidden="true" />{tag}</li>)}</ul></div><div className={`sn-workflow-visual sn-workflow-${visual}`}><WorkflowVisual kind={visual} /><span className="sn-visual-label">ILLUSTRATIVE WORKFLOW</span></div></article>)}</div>
  </div></section>;
}

function Integrations() {
  const integrations = [
    { name: "Google Workspace", badge: "G", className: "google", detail: "Gmail conversations & Calendar events", icon: Mail },
    { name: "Microsoft Outlook", badge: "O", className: "outlook", detail: "Your mailbox & calendar, connected", icon: Calendar },
    { name: "Stripe", badge: "S", className: "stripe", detail: "Payment links & recorded receipts", icon: CreditCard },
    { name: "DocuSign", badge: "D", className: "docusign", detail: "Quote signatures & envelope status", icon: FileText },
  ];
  return <section id="integrations" className="sn-site-section sn-integration-section" aria-labelledby="integrations-title"><div className="sn-site-container"><div className="sn-section-heading sn-heading-split"><div><p className="sn-eyebrow">FAMILIAR TOOLS. SHARED CONTEXT.</p><h2 id="integrations-title">Fits into your day.<br />Brings it all together.</h2></div><p>Connect the tools your team already uses, so conversations and commercial details stay close to the customer.</p></div><div className="sn-integrations">{integrations.map(({ name, badge, className, detail }) => <div className="sn-integration" key={name}><span className={`sn-integration-monogram sn-provider-${className}`} aria-hidden="true">{badge}</span><h3>{name}</h3><p>{detail}</p></div>)}</div><p className="sn-integration-footnote"><Lock size={14} aria-hidden="true" />Provider accounts and administrator setup required. <a href={`${REPO}/blob/main/docs/REVENUE_WORKFLOWS.md`} target="_blank" rel="noopener noreferrer">Explore setup & scope <ArrowUpRight size={13} aria-hidden="true" /></a></p></div></section>;
}

function Ownership() {
  return <section className="sn-site-section sn-ownership-section" aria-labelledby="ownership-title"><div className="sn-site-container sn-ownership-layout"><div><p className="sn-eyebrow">A WORKSPACE YOU CAN MAKE YOURS</p><h2 id="ownership-title">Your process.<br />Your data.<br /><span>Your Nebula.</span></h2><p>Self-host Sales Nebula on your own infrastructure. Shape the workspace around the way your team sells, supports, and grows.</p><a className="sn-text-link" href={REPO} target="_blank" rel="noopener noreferrer"><Github size={19} aria-hidden="true" />Explore the project <ArrowUpRight size={16} aria-hidden="true" /></a></div><div className="sn-ownership-features">{[
    { icon: Server, title: "Choose where your data lives", copy: "Run a dedicated installation for your company, with deployment and backups under your control." },
    { icon: Shield, title: "Give the right people the right access", copy: "Use roles, record sharing, and field permissions to support the way your team works." },
    { icon: BarChart3, title: "Make the workspace fit the work", copy: "Build reports, add custom fields and formulas, and guide repeatable processes with automation." },
  ].map(({ icon: Icon, title, copy }) => <article key={title}><span><Icon size={22} aria-hidden="true" /></span><div><h3>{title}</h3><p>{copy}</p></div></article>)}</div></div></section>;
}

const questions = [
  ["Can I try it before requesting access?", "Yes. Choose Explore the demo, then Use demo access on the sign-in page and sign in. The read-only demo runs in your browser with sample records. You do not need to create an account or enter payment details."],
  ["What happens after I request access?", "You’ll receive an email to verify your address. After verification, your request goes to an administrator for review. If approved, you’ll receive an invitation to create your account. Submitting a request does not immediately grant access."],
  ["Can we run Sales Nebula ourselves?", "Yes. Sales Nebula supports self-hosting with Docker or a Node.js and PostgreSQL deployment. Each installation serves one company. Your team manages hosting, backups, upgrades, and any connected provider accounts."],
  ["Can we bring our existing CRM data?", "You can import CSV files with field mapping, a row preview, and duplicate review. Start with a small sample to check your mapping before importing the rest. Spreadsheet files should be exported to CSV first."],
  ["Are the integrations ready to use?", "The integrations are built in, but your administrator needs to configure the provider credentials and connections. Google and Microsoft require account consent, Stripe needs payment and webhook configuration, and DocuSign needs a configured account. Provider fees may apply."],
  ["Is everything shown available in the browser demo?", "The demo gives you a read-only view of the core CRM with sample data. Live email, payment collection, signature requests, and other connected workflows require a configured installation. The previews on this page are illustrative, not live customer data."],
];

function FAQ() {
  return <section id="faq" className="sn-site-section" aria-labelledby="faq-title"><div className="sn-site-container sn-faq-layout"><div><p className="sn-eyebrow">A FEW THINGS TO KNOW</p><h2 id="faq-title">Good questions.<br />Clear answers.</h2><p className="sn-faq-intro">A closer look before you make<br className="sn-desktop-break" /> your next move.</p></div><div className="sn-faq-list">{questions.map(([question, answer]) => <details key={question}><summary>{question}<ChevronDown size={19} aria-hidden="true" /></summary><p>{answer}</p></details>)}</div></div></section>;
}

function AccessForm({ go }) {
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", company: "", companySize: "", interestedIn: "cloud", useCase: "" });
  const [state, setState] = useState("idle");
  const [message, setMessage] = useState("");
  const [devLink, setDevLink] = useState(null);
  const feedback = useRef(null);
  const pending = useRef(false);
  const abort = useRef(null);
  const set = (key) => (event) => setForm((value) => ({ ...value, [key]: event.target.value }));
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { if (state === "sent" || state === "error") feedback.current?.focus(); }, [state]);

  async function submit(event) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setState("sending"); setMessage("");
    const controller = new AbortController(); abort.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch("/api/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, email: form.email.trim(), source: "landing" }), signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || (response.status === 429 ? "Too many requests. Please wait a few minutes before trying again." : "We couldn’t submit your request. Please try again."));
      if (!data.accepted) throw new Error("The server returned an unexpected response. Please try again.");
      setMessage(data.message || "We’ve sent a verification link. Please check your inbox and spam folder.");
      if (import.meta.env.DEV && data.devVerifyUrl) {
        const url = new URL(data.devVerifyUrl, window.location.origin);
        if (url.origin === window.location.origin) setDevLink(url.href);
      }
      setState("sent");
    } catch (error) {
      setMessage(error.name === "AbortError" ? "The request took too long. Please try again." : error instanceof TypeError ? "Could not reach the server. Check your connection and try again." : error.message);
      setState("error");
    } finally {
      window.clearTimeout(timeout); pending.current = false; abort.current = null;
    }
  }

  return <section id="access" className="sn-site-section sn-access-section" aria-labelledby="access-title"><div className="sn-site-container sn-access-layout"><div className="sn-access-copy"><p className="sn-eyebrow">YOUR NEXT CHAPTER STARTS HERE</p><h2 id="access-title">Bring your<br />next win<br /><span>a little closer.</span></h2><p>Tell us a little about your team. We’ll review your request and help you take the next step.</p><ol className="sn-access-steps"><li><span>01</span>Request access</li><li><span>02</span>Verify your email</li><li><span>03</span>Receive an invite after approval</li></ol><p className="sn-access-demo">Just looking around? <PageLink go={go} href="/login">Explore the demo <ArrowUpRight size={14} aria-hidden="true" /></PageLink></p></div>
      <div className="sn-access-card">{state === "sent" ? <div className="sn-form-success" ref={feedback} tabIndex={-1} role="status"><span className="sn-success-icon"><Mail size={28} aria-hidden="true" /></span><h3>Check your inbox.</h3><p>{message}</p><p>Once your email is verified, an administrator will review your request.</p>{devLink && <a href={devLink}>Development link: verify now</a>}<PageLink go={go} href="/login" className="sn-site-button sn-site-button-outline">Explore the demo <ArrowRight size={17} aria-hidden="true" /></PageLink></div> : <form onSubmit={submit} aria-label="Request access" aria-busy={state === "sending"}>
        <h3>Let’s meet your team.</h3><p className="sn-form-help">Only your work email is required.</p>
        {state === "error" && <div className="sn-form-error" role="alert" tabIndex={-1} ref={feedback}>{message}</div>}
        <fieldset disabled={state === "sending"}>
          <div className="sn-field-row"><label htmlFor="fn">First name<input id="fn" name="firstName" autoComplete="given-name" maxLength={100} value={form.firstName} onChange={set("firstName")} /></label><label htmlFor="ln">Last name<input id="ln" name="lastName" autoComplete="family-name" maxLength={100} value={form.lastName} onChange={set("lastName")} /></label></div>
          <label htmlFor="em">Work email <span aria-hidden="true">*</span><input id="em" name="email" type="email" required autoComplete="email" maxLength={254} placeholder="you@company.com" value={form.email} onChange={set("email")} /></label>
          <label htmlFor="co">Company<input id="co" name="company" autoComplete="organization" maxLength={200} value={form.company} onChange={set("company")} /></label>
          <div className="sn-field-row"><label htmlFor="sz">Company size<select id="sz" name="companySize" value={form.companySize} onChange={set("companySize")}><option value="">Select size</option>{["1-10", "11-50", "51-200", "201-1000", "1000+"].map((value) => <option key={value} value={value}>{value.replace("-", "–")}</option>)}</select></label><label htmlFor="dep">Deploy preference<select id="dep" name="interestedIn" value={form.interestedIn} onChange={set("interestedIn")}><option value="cloud">Hosted for us</option><option value="self-hosted">Self-hosted</option><option value="both">Help me decide</option></select></label></div>
          <details className="sn-form-optional"><summary>Add a little context <span>Optional</span><ChevronDown size={15} aria-hidden="true" /></summary><label htmlFor="uc">What are you replacing?<textarea id="uc" name="useCase" rows={3} maxLength={2000} value={form.useCase} onChange={set("useCase")} placeholder="Your current CRM, spreadsheets, or the workflow you’d like to improve…" /></label></details>
          <button className="sn-site-button sn-submit-button" type="submit" disabled={state === "sending"}>{state === "sending" ? "Sending…" : "Submit request"}<ArrowRight size={17} aria-hidden="true" /></button>
        </fieldset><p className="sn-form-privacy"><Lock size={13} aria-hidden="true" /><span>We’ll use these details to review and respond to your request. <PageLink go={go} href="/privacy">Privacy policy</PageLink></span></p>
      </form>}</div>
    </div></section>;
}

function Footer({ go }) {
  return <footer className="sn-site-footer"><div className="sn-site-container"><div className="sn-footer-main"><div><a href="/" className="sn-site-brand"><BrandMark size={30} alt="" />Sales Nebula<span className="sn-brand-dot">.</span></a><p>A clearer view. A stronger relationship.</p></div><nav aria-label="Footer navigation"><a href="#product">Product</a><a href="#integrations">Integrations</a><a href={REPO} target="_blank" rel="noopener noreferrer">GitHub <ArrowUpRight size={13} aria-hidden="true" /></a><PageLink go={go} href="/login">Log in</PageLink></nav></div><div className="sn-footer-bottom"><span>© {new Date().getFullYear()} Sales Nebula</span><span>Built for the whole relationship.</span><div><PageLink go={go} href="/privacy">Privacy</PageLink><PageLink go={go} href="/terms">Terms</PageLink></div></div></div></footer>;
}

export default function Landing({ go }) {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    const frame = window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "instant", block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return <div className="sn-site"><a className="sn-site-skip" href="#main-content">Skip to content</a><Header go={go} /><main id="main-content" tabIndex={-1}><Hero go={go} /><Workflow /><Integrations /><Ownership /><FAQ /><AccessForm go={go} /></main><Footer go={go} /></div>;
}
