import React, { useState, useEffect, useRef } from "react";
import { Menu, X } from "lucide-react";
import { BrandMark, ThemeToggle } from "./theme";

/* ── Sales Nebula marketing surface ───────────────────────────────────
   Product-first CRM. Poppins throughout. Hero leads with a short phrase,
   not the full product name. */

const C = {
  void: "var(--sn-void)",
  panel: "var(--sn-panel)",
  raised: "var(--sn-raised)",
  rule: "var(--sn-rule)",
  amber: "var(--sn-amber)",
  cream: "var(--sn-cream)",
  slate: "var(--sn-slate)",
  dim: "var(--sn-dim)",
  green: "var(--sn-green)",
  body: "var(--sn-body)",
  cta: "var(--sn-cta-text)",
};

const display = '"Poppins", system-ui, sans-serif';
const body = '"Poppins", system-ui, sans-serif';

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function useReveal(offset = "-12%") {
  const ref = useRef(null);
  const [shown, setShown] = useState(prefersReducedMotion());
  useEffect(() => {
    if (shown || !ref.current) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: offset }
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [shown, offset]);
  return [ref, shown];
}

function scrollTo(id) {
  document.getElementById(id)?.scrollIntoView({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "start",
  });
}

// ── Header ───────────────────────────────────────────────────────────

function Header({ go }) {
  const [solid, setSolid] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  const links = [
    ["Product", "#product"],
    ["Workflow", "#workflow"],
    ["Access", "#access"],
  ];

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: solid || menuOpen ? "var(--sn-header-bg)" : "transparent",
        backdropFilter: solid || menuOpen ? "blur(12px)" : "none",
        borderBottom: `1px solid ${solid || menuOpen ? "var(--sn-rule)" : "transparent"}`,
        transition: "background 200ms ease, border-color 200ms ease",
      }}
    >
      <div
        style={{
          maxWidth: 1180,
          margin: "0 auto",
          padding: "14px clamp(18px, 4vw, 40px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <a href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
          <BrandMark size={34} />
          <span
            style={{
              fontFamily: display,
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: C.cream,
            }}
          >
            Sales Nebula
          </span>
        </a>

        <nav className="sn-desktop-only" style={{ display: "flex", alignItems: "center", gap: 28 }}>
          {links.map(([label, href]) => (
            <a
              key={href}
              href={href}
              onClick={(e) => {
                e.preventDefault();
                scrollTo(href.slice(1));
              }}
              style={{
                fontFamily: body,
                fontSize: 14,
                fontWeight: 500,
                color: C.slate,
                textDecoration: "none",
              }}
            >
              {label}
            </a>
          ))}
          <ThemeToggle compact />
          <button
            type="button"
            onClick={() => go("/login")}
            style={{
              fontFamily: body,
              fontSize: 14,
              fontWeight: 600,
              color: C.cream,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "8px 4px",
            }}
          >
            Log in
          </button>
          <button
            type="button"
            onClick={() => scrollTo("access")}
            style={{
              fontFamily: body,
              fontSize: 14,
              fontWeight: 700,
              color: C.cta,
              background: C.amber,
              border: "none",
              borderRadius: 8,
              padding: "10px 16px",
              cursor: "pointer",
            }}
          >
            Request access
          </button>
        </nav>

        <div className="sn-mobile-only" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ThemeToggle compact />
          <button
            type="button"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((o) => !o)}
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              border: `1px solid ${C.rule}`,
              background: C.raised,
              color: C.cream,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            {menuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div
          className="sn-mobile-only"
          style={{
            borderTop: `1px solid ${C.rule}`,
            padding: "12px 20px 20px",
            background: "var(--sn-header-bg)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {links.map(([label, href]) => (
            <a
              key={href}
              href={href}
              onClick={(e) => {
                e.preventDefault();
                setMenuOpen(false);
                scrollTo(href.slice(1));
              }}
              style={{
                fontFamily: body,
                fontSize: 16,
                color: C.cream,
                textDecoration: "none",
                padding: "12px 4px",
              }}
            >
              {label}
            </a>
          ))}
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              go("/login");
            }}
            style={{
              marginTop: 8,
              fontFamily: body,
              fontSize: 15,
              fontWeight: 600,
              color: C.cta,
              background: C.amber,
              border: "none",
              borderRadius: 8,
              padding: "12px 16px",
              cursor: "pointer",
            }}
          >
            Log in
          </button>
        </div>
      )}
    </header>
  );
}

// ── Sales Nebula portal snapshot ─────────────────────────────────────

function PortalSnapshot() {
  const stages = [
    {
      name: "Qualify",
      cards: [
        { title: "Acme CRM rollout", meta: "Acme Corp", val: "$48k" },
        { title: "Helix expansion", meta: "Helix Retail", val: "$22k" },
      ],
    },
    {
      name: "Discovery",
      cards: [
        { title: "Orbit fleet ops", meta: "Orbit Logistics", val: "$120k", hot: true },
        { title: "Cedar clinics", meta: "Cedar Health", val: "$67k" },
      ],
    },
    {
      name: "Proposal",
      cards: [{ title: "Summit banking", meta: "Summit Bank", val: "$210k", hot: true }],
    },
    {
      name: "Negotiate",
      cards: [{ title: "Atlas renewal", meta: "Atlas Energy", val: "$385k", hot: true }],
    },
  ];

  return (
    <div className="sn-hero-shot" aria-hidden="true">
      <div className="sn-float sn-float-report">
        <div className="sn-float-label">Sales Nebula · Win rate</div>
        <div className="sn-bars">
          {[42, 58, 51, 74, 63, 86].map((h, i) => (
            <span key={i} style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>

      <div className="sn-laptop">
        <div className="sn-laptop-bezel">
          <div className="sn-portal">
            <aside className="sn-portal-side">
              <div className="sn-side-brand">SN</div>
              {["Home", "CRM", "Deals", "Mail", "AI", "More"].map((label, i) => (
                <span key={label} className={i === 2 ? "active" : ""} title={label}>
                  {["⌂", "◎", "◈", "✉", "✦", "⋯"][i]}
                </span>
              ))}
            </aside>
            <div className="sn-portal-main">
              <div className="sn-portal-top">
                <strong>Deals</strong>
                <span className="sn-pill">Sales Nebula</span>
              </div>
              <div className="sn-kanban">
                {stages.map((s) => (
                  <div key={s.name} className="sn-col">
                    <div className="sn-col-h">{s.name}</div>
                    {s.cards.map((c) => (
                      <div key={c.title} className={`sn-card${c.hot ? " hot" : ""}`}>
                        <div className="sn-card-t">{c.title}</div>
                        <div className="sn-card-m">
                          <span>{c.meta}</span>
                          <b>{c.val}</b>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="sn-laptop-base" />
      </div>

      <div className="sn-phone">
        <div className="sn-phone-notch" />
        <div className="sn-phone-body">
          <div className="sn-phone-h">Sales Nebula</div>
          <div className="sn-phone-title">Atlas renewal</div>
          <div className="sn-phone-val">$385,000</div>
          <div className="sn-phone-row">Stage · Negotiate</div>
          <div className="sn-phone-row">Owner · Demo Visitor</div>
          <div className="sn-phone-btn">Log activity</div>
        </div>
      </div>

      <div className="sn-float sn-float-ai">
        <div className="sn-float-label">AI Copilot</div>
        <div className="sn-ai-line">Draft follow-up for Atlas</div>
        <div className="sn-ai-bar"><i /></div>
      </div>
    </div>
  );
}

// ── Hero ─────────────────────────────────────────────────────────────

function Hero({ go }) {
  const points = [
    "Leads, accounts, and deals in one Sales Nebula workspace",
    "Quotes, forecasts, and service without leaving the deal",
    "Self-host on your servers — or start with a managed invite",
    "Open the live demo anytime — no card required",
  ];

  return (
    <section className="sn-hero-plain">
      <div className="sn-hero-grid">
        <div className="sn-hero-copy">
          <h1>Deals that move. Customers that stay.</h1>
          <p>
            Sales Nebula is the CRM built for revenue teams — capture the lead,
            drive the opportunity, and keep the account after you win.
          </p>
          <ul>
            {points.map((t) => (
              <li key={t}>
                <span className="sn-check" aria-hidden="true">✓</span>
                {t}
              </li>
            ))}
          </ul>
          <div className="sn-hero-ctas">
            <button type="button" className="sn-btn-primary" onClick={() => scrollTo("access")}>
              Request access
            </button>
            <button type="button" className="sn-btn-secondary" onClick={() => go("/login")}>
              Try the demo
            </button>
          </div>
          <p className="sn-hero-micro">
            Full Sales Nebula demo. Your data stays yours when you go live.
          </p>
        </div>
        <div className="sn-hero-visual">
          <PortalSnapshot />
        </div>
      </div>
    </section>
  );
}

// ── Product ──────────────────────────────────────────────────────────

function Product() {
  const [ref, shown] = useReveal();
  const pillars = [
    {
      title: "Know every account",
      copy: "Contacts, companies, and history stay linked so your team never starts a call cold.",
    },
    {
      title: "Drive the pipeline",
      copy: "Stages, forecasts, and next actions make it obvious what closes this week — and what is stuck.",
    },
    {
      title: "Quote and deliver",
      copy: "Move from opportunity to quote to invoice without bouncing between five tools.",
    },
  ];

  return (
    <section
      id="product"
      ref={ref}
      style={{
        maxWidth: 1120,
        margin: "0 auto",
        padding: "clamp(72px, 10vw, 120px) clamp(18px, 4vw, 40px)",
        opacity: shown ? 1 : 0,
        transform: shown ? "none" : "translateY(18px)",
        transition: "opacity 600ms ease, transform 600ms ease",
      }}
    >
      <h2
        style={{
          fontFamily: display,
          fontSize: "clamp(28px, 4vw, 42px)",
          fontWeight: 700,
          letterSpacing: "-0.03em",
          color: C.cream,
          margin: "0 0 14px",
          maxWidth: 560,
        }}
      >
        Built for revenue teams, not dashboards nobody opens.
      </h2>
      <p
        style={{
          fontFamily: body,
          fontSize: 17,
          lineHeight: 1.6,
          color: C.slate,
          margin: "0 0 48px",
          maxWidth: 520,
        }}
      >
        Sales Nebula is a full CRM workspace: lead capture through closed-won, then service that protects the renewal.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
          gap: "clamp(28px, 4vw, 48px)",
          borderTop: `1px solid ${C.rule}`,
          paddingTop: 36,
        }}
      >
        {pillars.map((p, i) => (
          <div key={p.title}>
            <div
              style={{
                fontFamily: display,
                fontSize: 13,
                fontWeight: 700,
                color: C.amber,
                letterSpacing: "0.08em",
                marginBottom: 10,
              }}
            >
              {String(i + 1).padStart(2, "0")}
            </div>
            <h3
              style={{
                fontFamily: display,
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: "-0.02em",
                color: C.cream,
                margin: "0 0 10px",
              }}
            >
              {p.title}
            </h3>
            <p style={{ fontFamily: body, fontSize: 15, lineHeight: 1.6, color: C.slate, margin: 0 }}>
              {p.copy}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Workflow ─────────────────────────────────────────────────────────

function Workflow() {
  const [ref, shown] = useReveal();
  const steps = [
    { label: "Capture", detail: "Inbound leads land with source, score, and owner." },
    { label: "Qualify", detail: "Reps work a clear path — not a spreadsheet of hope." },
    { label: "Close", detail: "Quotes, approvals, and forecasts stay on the same deal." },
    { label: "Retain", detail: "Cases and entitlements keep customers after the sale." },
  ];

  return (
    <section
      id="workflow"
      ref={ref}
      style={{
        borderTop: `1px solid ${C.rule}`,
        borderBottom: `1px solid ${C.rule}`,
        background: `linear-gradient(90deg, color-mix(in srgb, var(--sn-raised) 80%, transparent), transparent 40%, color-mix(in srgb, var(--sn-raised) 80%, transparent))`,
        opacity: shown ? 1 : 0,
        transform: shown ? "none" : "translateY(18px)",
        transition: "opacity 600ms ease, transform 600ms ease",
      }}
    >
      <div
        style={{
          maxWidth: 1120,
          margin: "0 auto",
          padding: "clamp(72px, 10vw, 112px) clamp(18px, 4vw, 40px)",
        }}
      >
        <h2
          style={{
            fontFamily: display,
            fontSize: "clamp(28px, 4vw, 42px)",
            fontWeight: 700,
            letterSpacing: "-0.03em",
            color: C.cream,
            margin: "0 0 12px",
          }}
        >
          One motion from first touch to renewal.
        </h2>
        <p
          style={{
            fontFamily: body,
            fontSize: 17,
            lineHeight: 1.55,
            color: C.slate,
            margin: "0 0 40px",
            maxWidth: 480,
          }}
        >
          Stop stitching together point tools. Sales Nebula carries the account across the full revenue cycle.
        </p>

        <ol
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
            gap: 0,
          }}
        >
          {steps.map((s, i) => (
            <li
              key={s.label}
              style={{
                padding: "24px 20px 24px 0",
                borderTop: `1px solid ${C.rule}`,
                position: "relative",
              }}
            >
              <div
                style={{
                  fontFamily: display,
                  fontSize: 28,
                  fontWeight: 800,
                  color: C.amber,
                  letterSpacing: "-0.03em",
                  marginBottom: 8,
                }}
              >
                {s.label}
              </div>
              <p style={{ fontFamily: body, fontSize: 14.5, lineHeight: 1.55, color: C.slate, margin: 0 }}>
                {s.detail}
              </p>
              {i < steps.length - 1 && (
                <span
                  className="sn-desktop-only"
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    right: 8,
                    top: 28,
                    color: C.dim,
                    fontFamily: display,
                    fontSize: 20,
                  }}
                >
                  →
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ── Ownership (self-host — no API inventory) ─────────────────────────

function Ownership() {
  const [ref, shown] = useReveal();
  return (
    <section
      ref={ref}
      style={{
        maxWidth: 1120,
        margin: "0 auto",
        padding: "clamp(72px, 10vw, 120px) clamp(18px, 4vw, 40px)",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
        gap: 40,
        alignItems: "end",
        opacity: shown ? 1 : 0,
        transform: shown ? "none" : "translateY(18px)",
        transition: "opacity 600ms ease, transform 600ms ease",
      }}
    >
      <div>
        <h2
          style={{
            fontFamily: display,
            fontSize: "clamp(28px, 4vw, 40px)",
            fontWeight: 700,
            letterSpacing: "-0.03em",
            color: C.cream,
            margin: "0 0 14px",
          }}
        >
          Your CRM. Your servers. Your rules.
        </h2>
        <p style={{ fontFamily: body, fontSize: 16.5, lineHeight: 1.6, color: C.slate, margin: 0 }}>
          Run Sales Nebula where your data already lives. No per-seat tax for growing the team that closes.
        </p>
      </div>
      <p
        style={{
          fontFamily: body,
          fontSize: 15,
          lineHeight: 1.65,
          color: C.dim,
          margin: 0,
          maxWidth: 360,
        }}
      >
        Demo the product in the browser, then request access when you are ready to bring your own pipeline online.
      </p>
    </section>
  );
}

// ── Access form ──────────────────────────────────────────────────────

function AccessForm() {
  const [form, setForm] = useState({
    email: "",
    firstName: "",
    lastName: "",
    company: "",
    companySize: "",
    useCase: "",
    interestedIn: "cloud",
  });
  const [state, setState] = useState("idle");
  const [message, setMessage] = useState("");
  const [devLink, setDevLink] = useState(null);

  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.email.trim()) {
      setState("error");
      setMessage("Enter your work email.");
      return;
    }
    setState("sending");
    setMessage("");
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, source: "landing" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setState("error");
        setMessage(data.error || "Something went wrong. Try again.");
        return;
      }
      setState("sent");
      setMessage(data.message);
      if (data.devVerifyUrl) setDevLink(data.devVerifyUrl);
    } catch {
      setState("error");
      setMessage("Could not reach the server. Check your connection and try again.");
    }
  };

  const field = {
    width: "100%",
    padding: "12px 14px",
    borderRadius: 8,
    background: C.raised,
    border: `1px solid ${C.rule}`,
    color: C.cream,
    fontSize: 15,
    fontFamily: body,
    outline: "none",
  };
  const label = {
    display: "block",
    fontFamily: body,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: C.dim,
    marginBottom: 6,
  };

  if (state === "sent") {
    return (
      <section id="access" style={{ maxWidth: 560, margin: "0 auto", padding: "clamp(64px, 9vw, 100px) 20px" }}>
        <div
          style={{
            textAlign: "center",
            padding: "48px 28px",
            borderTop: `1px solid color-mix(in srgb, var(--sn-green) 40%, var(--sn-rule))`,
          }}
        >
          <h3
            style={{
              fontFamily: display,
              fontWeight: 700,
              fontSize: 32,
              letterSpacing: "-0.03em",
              color: C.cream,
              margin: "0 0 12px",
            }}
          >
            Check your inbox
          </h3>
          <p style={{ fontFamily: body, fontSize: 16, lineHeight: 1.6, color: C.slate, margin: 0 }}>
            {message}
          </p>
          {devLink && (
            <a
              href={devLink}
              style={{
                display: "inline-block",
                marginTop: 20,
                fontFamily: body,
                fontSize: 13,
                color: C.amber,
                wordBreak: "break-all",
              }}
            >
              Development link: verify now
            </a>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      id="access"
      style={{
        maxWidth: 1120,
        margin: "0 auto",
        padding: "clamp(64px, 9vw, 110px) clamp(18px, 4vw, 40px)",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
        gap: 48,
        alignItems: "start",
      }}
    >
      <div>
        <h2
          style={{
            fontFamily: display,
            fontWeight: 700,
            fontSize: "clamp(28px, 4vw, 40px)",
            letterSpacing: "-0.03em",
            color: C.cream,
            margin: "0 0 14px",
          }}
        >
          Request access
        </h2>
        <p style={{ fontFamily: body, fontSize: 16, lineHeight: 1.6, color: C.slate, margin: "0 0 20px" }}>
          Tell us what you sell and what you are replacing. We review every request and send an invite when you are approved.
        </p>
        <p style={{ fontFamily: body, fontSize: 14, lineHeight: 1.55, color: C.dim, margin: 0 }}>
          Prefer to look around first?{" "}
          <a href="/login" style={{ color: C.amber, fontWeight: 600 }}>
            Open the demo
          </a>{" "}
          with the credentials on the sign-in page.
        </p>
      </div>

      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {state === "error" && (
          <div
            style={{
              padding: "12px 14px",
              borderRadius: 8,
              background: "rgba(248,113,113,0.1)",
              border: "1px solid rgba(248,113,113,0.25)",
              color: "var(--sn-red-ink)",
              fontFamily: body,
              fontSize: 14,
            }}
          >
            {message}
          </div>
        )}
        <div className="sn-form-2col">
          <div>
            <label style={label} htmlFor="fn">
              First name
            </label>
            <input id="fn" style={field} value={form.firstName} onChange={set("firstName")} />
          </div>
          <div>
            <label style={label} htmlFor="ln">
              Last name
            </label>
            <input id="ln" style={field} value={form.lastName} onChange={set("lastName")} />
          </div>
        </div>
        <div>
          <label style={label} htmlFor="em">
            Work email
          </label>
          <input id="em" type="email" required style={field} value={form.email} onChange={set("email")} />
        </div>
        <div>
          <label style={label} htmlFor="co">
            Company
          </label>
          <input id="co" style={field} value={form.company} onChange={set("company")} />
        </div>
        <div className="sn-form-2col">
          <div>
            <label style={label} htmlFor="sz">
              Company size
            </label>
            <select id="sz" style={field} value={form.companySize} onChange={set("companySize")}>
              <option value="">Select</option>
              <option value="1-10">1–10</option>
              <option value="11-50">11–50</option>
              <option value="51-200">51–200</option>
              <option value="201-1000">201–1,000</option>
              <option value="1000+">1,000+</option>
            </select>
          </div>
          <div>
            <label style={label} htmlFor="dep">
              Deploy preference
            </label>
            <select id="dep" style={field} value={form.interestedIn} onChange={set("interestedIn")}>
              <option value="cloud">Hosted for us</option>
              <option value="self-host">Self-hosted</option>
              <option value="either">Either</option>
            </select>
          </div>
        </div>
        <div>
          <label style={label} htmlFor="uc">
            What are you replacing?
          </label>
          <textarea
            id="uc"
            rows={3}
            style={{ ...field, resize: "vertical" }}
            value={form.useCase}
            onChange={set("useCase")}
            placeholder="Salesforce, HubSpot, spreadsheets…"
          />
        </div>
        <button
          type="submit"
          disabled={state === "sending"}
          style={{
            marginTop: 6,
            fontFamily: body,
            fontSize: 15,
            fontWeight: 700,
            padding: "14px 20px",
            borderRadius: 8,
            border: "none",
            background: C.amber,
            color: C.cta,
            cursor: state === "sending" ? "wait" : "pointer",
            opacity: state === "sending" ? 0.7 : 1,
          }}
        >
          {state === "sending" ? "Sending…" : "Submit request"}
        </button>
      </form>
    </section>
  );
}

// ── Footer ───────────────────────────────────────────────────────────

function Footer({ go }) {
  return (
    <footer
      style={{
        borderTop: `1px solid ${C.rule}`,
        padding: "28px clamp(18px, 4vw, 40px)",
      }}
    >
      <div
        style={{
          maxWidth: 1120,
          margin: "0 auto",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <BrandMark size={28} />
          <span style={{ fontFamily: display, fontWeight: 700, fontSize: 15, color: C.cream }}>
            Sales Nebula
          </span>
        </div>
        <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => go("/privacy")}
            style={{
              fontFamily: body,
              fontSize: 13,
              fontWeight: 600,
              color: C.slate,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            Privacy
          </button>
          <button
            type="button"
            onClick={() => go("/terms")}
            style={{
              fontFamily: body,
              fontSize: 13,
              fontWeight: 600,
              color: C.slate,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            Terms
          </button>
          <button
            type="button"
            onClick={() => go("/login")}
            style={{
              fontFamily: body,
              fontSize: 13,
              fontWeight: 600,
              color: C.slate,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            Sign in
          </button>
          <a
            href="#access"
            onClick={(e) => {
              e.preventDefault();
              scrollTo("access");
            }}
            style={{ fontFamily: body, fontSize: 13, fontWeight: 600, color: C.amber, textDecoration: "none" }}
          >
            Request access
          </a>
        </div>
      </div>
    </footer>
  );
}

// ── Page ─────────────────────────────────────────────────────────────

export default function Landing({ go }) {
  useEffect(() => {
    const scrollToAccess = () => {
      if (window.location.hash !== "#access") return;
      window.setTimeout(() => scrollTo("access"), 80);
    };
    scrollToAccess();
    window.addEventListener("hashchange", scrollToAccess);
    return () => window.removeEventListener("hashchange", scrollToAccess);
  }, []);

  return (
    <div style={{ background: C.void, minHeight: "100vh", color: C.cream, overflow: "visible" }}>
      <style>{`
        .sn-hero-plain {
          background: var(--sn-void);
          color: var(--sn-cream);
          padding: clamp(28px, 5vw, 56px) clamp(18px, 4vw, 40px) clamp(48px, 7vw, 80px);
          overflow: hidden;
        }
        .sn-hero-grid {
          max-width: 1180px;
          margin: 0 auto;
          display: grid;
          grid-template-columns: minmax(0, 1.05fr) minmax(0, 1.15fr);
          gap: clamp(28px, 4vw, 48px);
          align-items: center;
        }
        .sn-hero-copy h1 {
          font-family: "Poppins", system-ui, sans-serif;
          font-size: clamp(32px, 4.4vw, 48px);
          font-weight: 700;
          letter-spacing: -0.03em;
          line-height: 1.12;
          color: var(--sn-cream);
          margin: 0 0 16px;
          max-width: 14ch;
        }
        .sn-hero-copy > p {
          font-family: "Poppins", system-ui, sans-serif;
          font-size: 16px;
          line-height: 1.6;
          color: var(--sn-slate);
          margin: 0 0 22px;
          max-width: 44ch;
        }
        .sn-hero-copy ul {
          list-style: none;
          margin: 0 0 26px;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .sn-hero-copy li {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          font-family: "Poppins", system-ui, sans-serif;
          font-size: 14.5px;
          font-weight: 500;
          color: var(--sn-body);
          line-height: 1.4;
        }
        .sn-check {
          flex-shrink: 0;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: var(--sn-amber);
          color: var(--sn-cta-text);
          font-size: 11px;
          font-weight: 700;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          margin-top: 1px;
        }
        .sn-hero-ctas {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-bottom: 12px;
        }
        .sn-btn-primary {
          font-family: "Poppins", system-ui, sans-serif;
          font-size: 15px;
          font-weight: 700;
          padding: 14px 22px;
          border-radius: 10px;
          border: none;
          background: var(--sn-amber);
          color: var(--sn-cta-text);
          cursor: pointer;
        }
        .sn-btn-secondary {
          font-family: "Poppins", system-ui, sans-serif;
          font-size: 15px;
          font-weight: 700;
          padding: 14px 22px;
          border-radius: 10px;
          border: 1px solid var(--sn-rule);
          background: var(--sn-raised);
          color: var(--sn-cream);
          cursor: pointer;
        }
        .sn-hero-micro {
          font-family: "Poppins", system-ui, sans-serif;
          font-size: 12.5px;
          color: var(--sn-dim);
          margin: 0;
        }
        .sn-hero-visual { position: relative; min-height: 360px; }
        .sn-hero-shot { position: relative; width: 100%; min-height: 380px; }
        .sn-laptop {
          position: relative;
          margin-left: 8%;
          width: 92%;
          z-index: 1;
        }
        .sn-laptop-bezel {
          background: #0A1224;
          border: 1px solid var(--sn-rule);
          border-radius: 12px 12px 6px 6px;
          padding: 10px 10px 0;
          box-shadow: 0 24px 48px rgba(0, 0, 0, 0.35);
        }
        .sn-portal {
          display: flex;
          background: var(--sn-void);
          border-radius: 8px 8px 0 0;
          overflow: hidden;
          min-height: 268px;
        }
        .sn-portal-side {
          width: 48px;
          background: var(--sn-panel);
          border-right: 1px solid var(--sn-rule);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          padding: 12px 0;
          color: var(--sn-dim);
          font-size: 12px;
        }
        .sn-side-brand {
          width: 28px;
          height: 28px;
          border-radius: 7px;
          background: linear-gradient(135deg, #F5A623, #E8961A);
          color: #060B1A;
          font-family: "Poppins", system-ui, sans-serif;
          font-size: 9px;
          font-weight: 800;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 4px;
        }
        .sn-portal-side span.active {
          color: var(--sn-amber);
        }
        .sn-portal-main { flex: 1; min-width: 0; padding: 12px 12px 16px; background: var(--sn-void); }
        .sn-portal-top {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
          font-family: "Poppins", system-ui, sans-serif;
          color: var(--sn-cream);
        }
        .sn-portal-top strong { font-size: 14px; font-weight: 700; }
        .sn-pill {
          font-size: 10px;
          font-weight: 600;
          background: rgba(245, 166, 35, 0.12);
          color: var(--sn-amber);
          border: 1px solid rgba(245, 166, 35, 0.28);
          padding: 3px 8px;
          border-radius: 999px;
        }
        .sn-kanban {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 8px;
        }
        .sn-col-h {
          font-family: "Poppins", system-ui, sans-serif;
          font-size: 10px;
          font-weight: 600;
          color: var(--sn-dim);
          margin-bottom: 8px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .sn-card {
          background: var(--sn-panel);
          border: 1px solid var(--sn-rule);
          border-radius: 8px;
          padding: 8px;
          margin-bottom: 8px;
        }
        .sn-card.hot { border-color: rgba(245, 166, 35, 0.45); }
        .sn-card-t {
          font-family: "Poppins", system-ui, sans-serif;
          font-size: 11px;
          font-weight: 600;
          color: var(--sn-cream);
          margin-bottom: 6px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .sn-card-m {
          display: flex;
          justify-content: space-between;
          font-family: "Poppins", system-ui, sans-serif;
          font-size: 10px;
          color: var(--sn-slate);
        }
        .sn-card-m b { color: var(--sn-amber); font-weight: 700; }
        .sn-laptop-base {
          height: 10px;
          width: 104%;
          margin-left: -2%;
          background: linear-gradient(180deg, #142038, #0A1224);
          border-radius: 0 0 10px 10px;
          border: 1px solid var(--sn-rule);
          border-top: none;
        }
        .sn-phone {
          position: absolute;
          left: 0;
          bottom: 18px;
          width: 118px;
          background: #0A1224;
          border: 1px solid var(--sn-rule);
          border-radius: 18px;
          padding: 8px;
          box-shadow: 0 18px 36px rgba(0, 0, 0, 0.4);
          z-index: 3;
        }
        .sn-phone-notch {
          width: 42px;
          height: 5px;
          border-radius: 999px;
          background: var(--sn-rule);
          margin: 2px auto 8px;
        }
        .sn-phone-body {
          background: var(--sn-panel);
          border: 1px solid var(--sn-rule);
          border-radius: 12px;
          padding: 10px;
          min-height: 170px;
        }
        .sn-phone-h { font-family: "Poppins", system-ui, sans-serif; font-size: 10px; color: var(--sn-amber); font-weight: 600; margin-bottom: 4px; }
        .sn-phone-title { font-family: "Poppins", system-ui, sans-serif; font-size: 13px; font-weight: 700; color: var(--sn-cream); }
        .sn-phone-val { font-family: "Poppins", system-ui, sans-serif; font-size: 16px; font-weight: 700; color: var(--sn-amber); margin: 6px 0 10px; }
        .sn-phone-row { font-family: "Poppins", system-ui, sans-serif; font-size: 10px; color: var(--sn-slate); margin-bottom: 4px; }
        .sn-phone-btn {
          margin-top: 12px;
          background: var(--sn-amber);
          color: var(--sn-cta-text);
          font-family: "Poppins", system-ui, sans-serif;
          font-size: 10px;
          font-weight: 700;
          text-align: center;
          padding: 8px;
          border-radius: 8px;
        }
        .sn-float {
          position: absolute;
          background: var(--sn-panel);
          border: 1px solid var(--sn-rule);
          border-radius: 12px;
          box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
          padding: 12px 14px;
          z-index: 4;
          font-family: "Poppins", system-ui, sans-serif;
        }
        .sn-float-report { top: 0; right: 4%; width: 158px; }
        .sn-float-ai { right: 2%; bottom: 28px; width: 176px; }
        .sn-float-label { font-size: 11px; font-weight: 700; color: var(--sn-cream); margin-bottom: 8px; }
        .sn-bars { display: flex; align-items: flex-end; gap: 5px; height: 54px; }
        .sn-bars span {
          flex: 1;
          background: linear-gradient(180deg, var(--sn-amber), color-mix(in srgb, var(--sn-amber) 35%, transparent));
          border-radius: 3px 3px 1px 1px;
          display: block;
        }
        .sn-ai-line { font-size: 12px; color: var(--sn-slate); margin-bottom: 8px; }
        .sn-ai-bar { height: 6px; border-radius: 999px; background: var(--sn-raised); overflow: hidden; }
        .sn-ai-bar i { display: block; width: 68%; height: 100%; background: var(--sn-amber); border-radius: 999px; }
        @media (max-width: 900px) {
          .sn-hero-grid { grid-template-columns: 1fr; }
          .sn-hero-copy h1 { max-width: none; }
          .sn-hero-visual { min-height: 320px; }
          .sn-laptop { margin-left: 14%; width: 86%; }
          .sn-phone { width: 100px; }
          .sn-kanban { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 560px) {
          .sn-float-report, .sn-float-ai, .sn-phone { display: none; }
          .sn-laptop { margin-left: 0; width: 100%; }
        }
        select option { background: var(--sn-raised); color: var(--sn-cream); }
      `}</style>
      <Header go={go} />
      <Hero go={go} />
      <Product />
      <Workflow />
      <Ownership />
      <AccessForm />
      <Footer go={go} />
    </div>
  );
}

// ── Email verification ───────────────────────────────────────────────

export function VerifyPage({ go }) {
  const [state, setState] = useState("working");
  const [message, setMessage] = useState("Confirming your email address");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setState("error");
      setMessage("That link is missing its verification token.");
      return;
    }

    fetch("/api/signup/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) {
          setState("error");
          setMessage(data.error || "That verification link is not valid.");
          return;
        }
        setState("done");
        setMessage(data.message);
      })
      .catch(() => {
        setState("error");
        setMessage("Could not reach the server. Try the link again shortly.");
      });
  }, []);

  const accent = state === "error" ? "var(--sn-red)" : state === "done" ? C.green : C.amber;

  return (
    <CenteredCard
      badge={state === "working" ? "…" : state === "done" ? "OK" : "!"}
      accent={accent}
      title={state === "done" ? "Email confirmed" : state === "error" ? "Link not valid" : "One moment"}
      body={message}
      action={
        state !== "working"
          ? {
              label: state === "done" ? "Back to home" : "Request access again",
              onClick: () => go("/"),
            }
          : null
      }
    />
  );
}

// ── Invite acceptance ────────────────────────────────────────────────

export function AcceptInvitePage({ go }) {
  const [invite, setInvite] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [form, setForm] = useState({ firstName: "", lastName: "", password: "", confirm: "" });
  const token = useRef(new URLSearchParams(window.location.search).get("token"));

  useEffect(() => {
    if (!token.current) {
      setState("invalid");
      setError("That link is missing its invite token.");
      return;
    }
    fetch(`/api/signup/invites/lookup/${encodeURIComponent(token.current)}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) {
          setState("invalid");
          setError(data.error || "That invite link is not valid.");
          return;
        }
        setInvite(data);
        setForm((p) => ({ ...p, firstName: data.firstName || "", lastName: data.lastName || "" }));
        setState("ready");
      })
      .catch(() => {
        setState("invalid");
        setError("Could not reach the server.");
      });
  }, []);

  const rules = [
    ["At least 8 characters", form.password.length >= 8],
    ["An uppercase letter", /[A-Z]/.test(form.password)],
    ["A lowercase letter", /[a-z]/.test(form.password)],
    ["A number", /[0-9]/.test(form.password)],
    ["A symbol", /[^A-Za-z0-9]/.test(form.password)],
  ];
  const ready =
    rules.every((r) => r[1]) && form.password === form.confirm && form.firstName && form.lastName;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    setState("submitting");
    setError("");
    try {
      const res = await fetch("/api/signup/invites/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token.current,
          password: form.password,
          firstName: form.firstName,
          lastName: form.lastName,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setState("ready");
        setError(data.details?.join(". ") || data.error || "Could not create your account.");
        return;
      }
      localStorage.setItem("sn_token", data.token);
      window.location.href = "/app";
    } catch {
      setState("ready");
      setError("Could not reach the server. Try again.");
    }
  };

  const field = {
    width: "100%",
    padding: "11px 13px",
    borderRadius: 8,
    background: C.raised,
    border: `1px solid ${C.rule}`,
    color: C.cream,
    fontSize: 14,
    fontFamily: body,
    outline: "none",
  };
  const label = {
    display: "block",
    fontFamily: body,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: C.dim,
    marginBottom: 6,
  };

  if (state === "loading") {
    return <CenteredCard badge="…" accent={C.amber} title="Checking your invite" body="One moment." />;
  }
  if (state === "invalid") {
    return (
      <CenteredCard
        badge="!"
        accent="var(--sn-red)"
        title="Invite not valid"
        body={error}
        action={{ label: "Request access", onClick: () => go("/") }}
      />
    );
  }

  return (
    <div
      style={{
        background: C.void,
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: 26 }}>
          <h1
            style={{
              fontFamily: display,
              fontWeight: 700,
              fontSize: 28,
              letterSpacing: "-0.03em",
              color: C.cream,
              margin: "0 0 6px",
            }}
          >
            Set your password
          </h1>
          <p style={{ fontFamily: body, fontSize: 13, color: C.dim, margin: 0 }}>{invite.email}</p>
        </div>

        <form
          onSubmit={submit}
          style={{
            background: C.panel,
            border: `1px solid ${C.rule}`,
            borderRadius: 12,
            padding: "24px 22px",
          }}
        >
          {invite.message && (
            <div
              style={{
                background: C.raised,
                borderRadius: 8,
                padding: "11px 13px",
                marginBottom: 16,
                fontSize: 14,
                color: C.slate,
                fontFamily: body,
                lineHeight: 1.55,
              }}
            >
              {invite.message}
            </div>
          )}
          {error && (
            <div
              style={{
                background: "rgba(248,113,113,0.10)",
                border: "1px solid rgba(248,113,113,0.25)",
                borderRadius: 8,
                padding: "10px 13px",
                marginBottom: 16,
                fontSize: 14,
                color: "var(--sn-red-ink)",
                fontFamily: body,
              }}
            >
              {error}
            </div>
          )}

          <div className="sn-form-2col" style={{ marginBottom: 14 }}>
            <div>
              <label style={label} htmlFor="ifn">
                First name
              </label>
              <input
                id="ifn"
                style={field}
                value={form.firstName}
                onChange={(e) => setForm((p) => ({ ...p, firstName: e.target.value }))}
                required
              />
            </div>
            <div>
              <label style={label} htmlFor="iln">
                Last name
              </label>
              <input
                id="iln"
                style={field}
                value={form.lastName}
                onChange={(e) => setForm((p) => ({ ...p, lastName: e.target.value }))}
                required
              />
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={label} htmlFor="ipw">
              Password
            </label>
            <input
              id="ipw"
              type="password"
              style={field}
              value={form.password}
              onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
              required
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={label} htmlFor="ipc">
              Confirm password
            </label>
            <input
              id="ipc"
              type="password"
              style={field}
              value={form.confirm}
              onChange={(e) => setForm((p) => ({ ...p, confirm: e.target.value }))}
              required
            />
          </div>

          <div style={{ marginBottom: 18 }}>
            {rules.map(([text, met]) => (
              <div
                key={text}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  fontFamily: body,
                  fontSize: 12,
                  color: met ? C.green : C.dim,
                  marginBottom: 4,
                }}
              >
                <span style={{ width: 10 }}>{met ? "+" : "–"}</span>
                {text}
              </div>
            ))}
          </div>

          <button
            type="submit"
            disabled={!ready || state === "submitting"}
            style={{
              width: "100%",
              padding: "13px",
              borderRadius: 8,
              border: "none",
              background: ready ? C.amber : C.rule,
              color: ready ? C.cta : C.dim,
              fontSize: 14,
              fontWeight: 700,
              fontFamily: body,
              cursor: ready ? "pointer" : "not-allowed",
            }}
          >
            {state === "submitting" ? "Creating your account" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}

function CenteredCard({ badge, accent, title, body, action }) {
  return (
    <div
      style={{
        background: C.void,
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        style={{
          background: C.panel,
          border: `1px solid ${C.rule}`,
          borderRadius: 12,
          padding: "40px 32px",
          textAlign: "center",
          maxWidth: 440,
          width: "100%",
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            margin: "0 auto 20px",
            background: `color-mix(in srgb, ${accent} 12%, transparent)`,
            border: `1px solid color-mix(in srgb, ${accent} 35%, transparent)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: display,
            fontSize: 16,
            fontWeight: 700,
            color: accent,
          }}
        >
          {badge}
        </div>
        <h1
          style={{
            fontFamily: display,
            fontWeight: 700,
            fontSize: 26,
            letterSpacing: "-0.03em",
            color: C.cream,
            margin: "0 0 12px",
          }}
        >
          {title}
        </h1>
        <p style={{ fontSize: 15, lineHeight: 1.6, color: C.slate, fontFamily: body, margin: 0 }}>
          {body}
        </p>
        {action && (
          <div style={{ marginTop: 24 }}>
            <button
              type="button"
              onClick={action.onClick}
              style={{
                fontFamily: body,
                fontSize: 14,
                fontWeight: 600,
                padding: "12px 20px",
                borderRadius: 8,
                border: `1px solid ${C.rule}`,
                background: "transparent",
                color: C.cream,
                cursor: "pointer",
              }}
            >
              {action.label}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
