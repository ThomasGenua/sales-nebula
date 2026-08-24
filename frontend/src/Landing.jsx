import React, { useState, useEffect, useRef } from "react";
import { Menu, X } from "lucide-react";
import { MODULES, TOTALS } from "./moduleManifest";
import { BrandMark, ThemeToggle } from "./theme";

// ── Design tokens ────────────────────────────────────────────────────
// Continuous with the product shell so the CTA does not feel like a
// different company. Display face is a condensed grotesque, data face is
// a terminal mono, which is what the product actually looks like inside.
const C = {
  void: "var(--sn-void)",
  panel: "var(--sn-panel)",
  raised: "var(--sn-raised)",
  rule: "var(--sn-rule)",
  ruleSoft: "var(--sn-rule-soft)",
  amber: "var(--sn-amber)",
  cream: "var(--sn-cream)",
  slate: "var(--sn-slate)",
  dim: "var(--sn-dim)",
  green: "var(--sn-green)",
  blue: "var(--sn-blue)",
  purple: "var(--sn-purple)",
  red: "var(--sn-red)",
};

const display = '"IBM Plex Sans Condensed", "Arial Narrow", sans-serif';
const mono = '"IBM Plex Mono", ui-monospace, monospace';

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Reveal on scroll, once, and skip entirely when motion is reduced
function useReveal() {
  const ref = useRef(null);
  const [shown, setShown] = useState(prefersReducedMotion());
  useEffect(() => {
    if (shown || !ref.current) return;
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setShown(true); io.disconnect(); } },
      { rootMargin: "-40px" }
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [shown]);
  return [ref, shown];
}

// ── Primitives ───────────────────────────────────────────────────────

function Eyebrow({ children, color = C.amber }) {
  return (
    <div style={{
      fontFamily: mono, fontSize: 11, letterSpacing: "0.18em",
      textTransform: "uppercase", color, marginBottom: 14,
    }}>
      {children}
    </div>
  );
}

function Cta({ children, onClick, href, variant = "primary", full }) {
  const base = {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    gap: 8, padding: "13px 24px", borderRadius: 8,
    fontSize: 14, fontWeight: 600, fontFamily: "Inter, sans-serif",
    cursor: "pointer", transition: "all 140ms ease", textDecoration: "none",
    border: "1px solid transparent", width: full ? "100%" : "auto",
  };
  const styles = variant === "primary"
    ? { ...base, background: C.amber, color: "var(--sn-cta-text)" }
    : { ...base, background: "transparent", color: C.cream, borderColor: C.rule };

  const Tag = href ? "a" : "button";
  return (
    <Tag
      href={href} onClick={onClick} style={styles}
      onMouseEnter={e => {
        e.currentTarget.style.transform = "translateY(-1px)";
        if (variant !== "primary") e.currentTarget.style.borderColor = C.amber;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = "translateY(0)";
        if (variant !== "primary") e.currentTarget.style.borderColor = C.rule;
      }}
    >
      {children}
    </Tag>
  );
}

function Section({ children, id, style }) {
  return (
    <section id={id} style={{
      maxWidth: 1180, margin: "0 auto",
      padding: "clamp(64px, 9vw, 120px) clamp(20px, 5vw, 48px)",
      ...style,
    }}>
      {children}
    </section>
  );
}

// ── Header ───────────────────────────────────────────────────────────

function Header({ go }) {
  const [solid, setSolid] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [menuOpen]);

  const links = [["Modules", "#modules"], ["How it runs", "#deploy"], ["Access", "#access"]];
  const closeMenu = () => setMenuOpen(false);

  return (
    <header style={{
      position: "sticky", top: 0, zIndex: 50,
      background: solid || menuOpen ? "var(--sn-header-bg)" : "transparent",
      backdropFilter: solid || menuOpen ? "blur(12px)" : "none",
      borderBottom: `1px solid ${solid || menuOpen ? C.rule : "transparent"}`,
      transition: "background 200ms ease, border-color 200ms ease",
    }}>
      <div style={{
        maxWidth: 1180, margin: "0 auto",
        padding: "12px clamp(16px, 4vw, 48px)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12,
      }}>
        <a href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", minWidth: 0 }}>
          <BrandMark size={32} />
          <span style={{
            fontFamily: display, fontSize: "clamp(15px, 3vw, 19px)", fontWeight: 700,
            letterSpacing: "0.01em", color: C.cream, whiteSpace: "nowrap",
          }}>SALES NEBULA</span>
        </a>

        <nav className="sn-desktop-only" style={{ display: "flex", alignItems: "center", gap: 22 }}>
          {links.map(([label, href]) => (
            <a key={href} href={href} className="nav-link" style={{
              fontSize: 13, color: C.slate, textDecoration: "none",
              fontFamily: "Inter, sans-serif", transition: "color 140ms",
            }}>{label}</a>
          ))}
          <ThemeToggle compact />
          <button onClick={() => go("/login")} style={{
            fontSize: 13, fontWeight: 600, color: C.cream, background: "transparent",
            border: `1px solid ${C.rule}`, borderRadius: 7, padding: "8px 16px",
            cursor: "pointer", fontFamily: "Inter, sans-serif",
          }}>Sign in</button>
        </nav>

        <div className="sn-mobile-only" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ThemeToggle compact />
          <button
            type="button"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(open => !open)}
            style={{
              width: 40, height: 40, borderRadius: 8, border: `1px solid ${C.rule}`,
              background: C.raised, color: C.cream, display: "inline-flex",
              alignItems: "center", justifyContent: "center", cursor: "pointer",
            }}
          >
            {menuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="sn-mobile-only" style={{
          borderTop: `1px solid ${C.rule}`,
          padding: "12px clamp(16px, 4vw, 48px) 20px",
          background: "var(--sn-header-bg)",
        }}>
          <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {links.map(([label, href]) => (
              <a key={href} href={href} onClick={closeMenu} style={{
                fontSize: 16, color: C.cream, textDecoration: "none",
                fontFamily: "Inter, sans-serif", padding: "12px 4px",
              }}>{label}</a>
            ))}
            <button onClick={() => { closeMenu(); go("/login"); }} style={{
              marginTop: 8, fontSize: 15, fontWeight: 600, color: "var(--sn-cta-text)",
              background: C.amber, border: "none", borderRadius: 8, padding: "12px 16px",
              cursor: "pointer", fontFamily: "Inter, sans-serif",
            }}>Sign in</button>
          </nav>
        </div>
      )}
    </header>
  );
}

// ── Hero ─────────────────────────────────────────────────────────────

function Hero({ go }) {
  return (
    <Section style={{ paddingTop: "clamp(48px, 7vw, 88px)", paddingBottom: "clamp(40px, 5vw, 64px)" }}>
      {/* Ticker strip: the product's actual dimensions, stated up front */}
      <div style={{
        display: "flex", flexWrap: "wrap", gap: 0,
        border: `1px solid ${C.rule}`, borderRadius: 8,
        overflow: "hidden", marginBottom: 44,
      }}>
        {[
          [TOTALS.endpoints.toLocaleString(), "API endpoints"],
          [TOTALS.modules, "modules"],
          [TOTALS.models, "data models"],
          ["0", "per-seat fees"],
        ].map(([value, label], i) => (
          <div key={label} style={{
            flex: "1 1 140px", padding: "14px 18px",
            borderLeft: i === 0 ? "none" : `1px solid ${C.rule}`,
            background: C.panel,
          }}>
            <div style={{
              fontFamily: mono, fontSize: 21, fontWeight: 600,
              color: i === 3 ? C.green : C.amber, lineHeight: 1.1,
            }}>{value}</div>
            <div style={{
              fontFamily: mono, fontSize: 10, letterSpacing: "0.14em",
              textTransform: "uppercase", color: C.dim, marginTop: 4,
            }}>{label}</div>
          </div>
        ))}
      </div>

      <h1 style={{
        fontFamily: display, fontWeight: 700,
        fontSize: "clamp(34px, 8vw, 104px)", lineHeight: 0.94,
        letterSpacing: "-0.02em", color: C.cream, margin: 0,
        textTransform: "uppercase",
      }}>
        Manage every<br />customer.<br />
        <span style={{ color: C.amber }}>Close more deals.</span>
      </h1>

      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
        gap: 40, marginTop: 40, alignItems: "start",
      }}>
        <div>
          <p style={{
            fontSize: 17, lineHeight: 1.65, color: C.slate,
            fontFamily: "Inter, sans-serif", margin: "0 0 28px",
          }}>
            Bring leads, contacts, accounts, deals, quotes, service, and
            reporting into one CRM. Give your team a clear view of every
            customer and every opportunity from first contact to closed deal.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <Cta onClick={() => document.getElementById("access")?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" })}>
              Request access
            </Cta>
            <Cta variant="ghost" onClick={() => document.getElementById("modules")?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" })}>
              See every module
            </Cta>
          </div>
        </div>

        {/* A real request against the real API, not a stock screenshot */}
        <div style={{
          border: `1px solid ${C.rule}`, borderRadius: 10,
          background: C.panel, overflow: "hidden",
        }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 7,
            padding: "9px 14px", borderBottom: `1px solid ${C.rule}`,
          }}>
            {[C.red, C.amber, C.green].map(c => (
              <span key={c} style={{ width: 9, height: 9, borderRadius: "50%", background: c, opacity: 0.65 }} />
            ))}
            <span style={{ fontFamily: mono, fontSize: 10, color: C.dim, marginLeft: 6 }}>
              GET /api/projects/:id/gantt
            </span>
          </div>
          <pre style={{
            margin: 0, padding: "14px 16px", fontFamily: mono,
            fontSize: 11.5, lineHeight: 1.75, color: C.slate,
            overflowX: "auto",
          }}>
{`{
  `}<span style={{ color: C.blue }}>"criticalPath"</span>{`: [`}<span style={{ color: C.green }}>"discovery"</span>{`, `}<span style={{ color: C.green }}>"build"</span>{`],
  `}<span style={{ color: C.blue }}>"projectDuration"</span>{`: `}<span style={{ color: C.amber }}>9</span>{`,
  `}<span style={{ color: C.blue }}>"rows"</span>{`: [
    {
      `}<span style={{ color: C.blue }}>"wbs"</span>{`: `}<span style={{ color: C.green }}>"1.2"</span>{`,
      `}<span style={{ color: C.blue }}>"totalFloat"</span>{`: `}<span style={{ color: C.amber }}>0</span>{`,
      `}<span style={{ color: C.blue }}>"isCritical"</span>{`: `}<span style={{ color: C.purple }}>true</span>{`
    }
  ]
}`}
          </pre>
        </div>
      </div>
    </Section>
  );
}

// ── Signature: the module matrix ─────────────────────────────────────

const MODULE_NOTES = {
  calendar: "RFC 5545 recurrence, resource booking, iCal feeds",
  projects: "Critical path method, WBS, Gantt, time tracking",
  securityGroups: "Row-level access under the RBAC layer",
  studio: "Add fields at runtime without a migration",
  sla: "Business-hours clocks that skip nights and holidays",
  maps: "Territory polygons, proximity search, route ordering",
  searchIndex: "Inverted index with BM25, not a table scan",
  inboundEmail: "IMAP ingest, reply threading, auto-reply filtering",
  pdfTemplates: "Merge fields, loops, conditionals",
  prospects: "Pre-lead records, scoring, target lists",
  cpq: "Configure, price, quote",
  advancedCpq: "Tiered pricing, bundles, approval thresholds",
  forecasts: "Pipeline roll-up by period and owner",
  territories: "Assignment rules and hierarchy",
  workflows: "Trigger, condition, action",
  flowBuilder: "Visual automation without code",
  omnichannel: "Routing across chat, email, and voice",
  fieldService: "Work orders and dispatch",
  knowledge: "Article authoring and versioning",
  bugs: "Defect tracking with release notes",
  subscriptions: "Recurring billing schedules",
  revenueRecognition: "Schedules and deferred revenue",
  entitlements: "Support contracts and coverage",
  partners: "Channel accounts and deal registration",
  cdp: "Unified customer profiles",
  aiAgents: "Task-scoped assistants over your own data",
};

function ModuleMatrix() {
  const [ref, shown] = useReveal();
  const [active, setActive] = useState(null);
  const max = MODULES[0][1];

  return (
    <Section id="modules" style={{ paddingTop: 40 }}>
      <div style={{ marginBottom: 32 }}>
        <Eyebrow>The whole surface</Eyebrow>
        <h2 style={{
          fontFamily: display, fontWeight: 700, textTransform: "uppercase",
          fontSize: "clamp(30px, 5vw, 54px)", lineHeight: 1, letterSpacing: "-0.015em",
          color: C.cream, margin: "0 0 16px", maxWidth: 760,
        }}>
          Every module, with its real endpoint count
        </h2>
        <p style={{
          fontSize: 15.5, lineHeight: 1.65, color: C.slate,
          fontFamily: "Inter, sans-serif", maxWidth: 640, margin: 0,
        }}>
          Not a roadmap. This grid is generated from the route table at build
          time, so what you see is what ships. Hover a cell to read what it does.
        </p>
      </div>

      <div ref={ref} style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 110px), 1fr))",
        gap: 1, background: C.ruleSoft,
        border: `1px solid ${C.rule}`, borderRadius: 10, overflow: "hidden",
      }}>
        {MODULES.map(([name, count], i) => {
          const weight = count / max;
          return (
            <div
              key={name}
              onMouseEnter={() => setActive(name)}
              onMouseLeave={() => setActive(null)}
              style={{
                background: C.panel, padding: "11px 12px 10px",
                position: "relative", cursor: "default",
                opacity: shown ? 1 : 0,
                transform: shown ? "none" : "translateY(6px)",
                transition: prefersReducedMotion()
                  ? "none"
                  : `opacity 320ms ease ${Math.min(i * 7, 700)}ms, transform 320ms ease ${Math.min(i * 7, 700)}ms, background 120ms`,
              }}
              onFocus={() => setActive(name)}
              tabIndex={0}
            >
              {/* Weight bar encodes endpoint count, so the grid reads as data */}
              <div style={{
                position: "absolute", left: 0, top: 0, bottom: 0,
                width: 2, background: C.amber, opacity: 0.18 + weight * 0.82,
              }} />
              <div style={{
                fontFamily: mono, fontSize: 11, color: C.cream,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>{name}</div>
              <div style={{
                fontFamily: mono, fontSize: 10, color: C.dim, marginTop: 3,
              }}>{count} ep</div>
            </div>
          );
        })}
      </div>

      <div style={{
        marginTop: 14, minHeight: 22,
        fontFamily: mono, fontSize: 12, color: active ? C.amber : C.dim,
        transition: "color 140ms",
      }}>
        {active
          ? `${active} — ${MODULE_NOTES[active] || "Full CRUD, search, and reporting"}`
          : `${TOTALS.modules} modules · ${TOTALS.endpoints.toLocaleString()} endpoints · counted at build time`}
      </div>
    </Section>
  );
}

// ── Claims a skeptic would test ──────────────────────────────────────

const CLAIMS = [
  {
    label: "Ownership",
    head: "The database is yours",
    body: "Postgres, a readable Prisma schema, and a documented REST API. Point any BI tool at it. Fork it. There is no proprietary storage layer and no export queue to wait in.",
    proof: "286 models · Swagger at /api/docs",
  },
  {
    label: "Scope",
    head: "The awkward parts are already built",
    body: "Business-hours SLA clocks, critical-path scheduling, row-level security groups, recurrence that survives daylight saving. These are the pieces that turn a CRM pilot into a two-year project.",
    proof: "Verified by 231 tests",
  },
  {
    label: "Cost",
    head: "Adding a person costs nothing",
    body: "Seat pricing charges you for growth and quietly punishes you for giving read access to the people who need it. Self-host and the marginal user is free. Give the whole company a login.",
    proof: "Self-host: no licence fee",
  },
];

function Claims() {
  return (
    <Section>
      <Eyebrow color={C.blue}>Why teams move</Eyebrow>
      <div style={{
        display: "grid", gap: 1, background: C.ruleSoft,
        border: `1px solid ${C.rule}`, borderRadius: 10, overflow: "hidden",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
      }}>
        {CLAIMS.map(c => (
          <div key={c.label} style={{ background: C.panel, padding: "28px 26px 26px" }}>
            <div style={{
              fontFamily: mono, fontSize: 10, letterSpacing: "0.16em",
              textTransform: "uppercase", color: C.dim, marginBottom: 14,
            }}>{c.label}</div>
            <h3 style={{
              fontFamily: display, fontWeight: 700, fontSize: 26, lineHeight: 1.1,
              color: C.cream, margin: "0 0 12px", letterSpacing: "-0.01em",
            }}>{c.head}</h3>
            <p style={{
              fontSize: 14.5, lineHeight: 1.65, color: C.slate,
              fontFamily: "Inter, sans-serif", margin: "0 0 18px",
            }}>{c.body}</p>
            <div style={{
              fontFamily: mono, fontSize: 11, color: C.amber,
              paddingTop: 14, borderTop: `1px solid ${C.rule}`,
            }}>{c.proof}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ── Deployment ───────────────────────────────────────────────────────

function Deploy() {
  const options = [
    {
      name: "Self-hosted",
      price: "No licence fee",
      sub: "You run it",
      points: [
        "Docker Compose, Postgres, and Redis",
        "Unlimited users and records",
        "Full source, modify anything",
        "Your backups, your retention policy",
      ],
      cta: "Request the repo",
      featured: true,
    },
    {
      name: "Managed",
      price: "Talk to us",
      sub: "We run it",
      points: [
        "Hosting, backups, and upgrades handled",
        "Priority support with an SLA",
        "Migration from your current CRM",
        "Same codebase, same data access",
      ],
      cta: "Request access",
      featured: false,
    },
  ];

  return (
    <Section id="deploy">
      <Eyebrow color={C.purple}>How it runs</Eyebrow>
      <h2 style={{
        fontFamily: display, fontWeight: 700, textTransform: "uppercase",
        fontSize: "clamp(30px, 5vw, 54px)", lineHeight: 1,
        letterSpacing: "-0.015em", color: C.cream, margin: "0 0 32px",
      }}>
        Two ways in
      </h2>

      <div style={{
        display: "grid", gap: 16,
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
      }}>
        {options.map(o => (
          <div key={o.name} style={{
            background: C.panel,
            border: `1px solid ${o.featured ? "rgba(245,166,35,0.35)" : C.rule}`,
            borderRadius: 10, padding: "28px 26px",
            display: "flex", flexDirection: "column",
          }}>
            <div style={{
              fontFamily: mono, fontSize: 10, letterSpacing: "0.16em",
              textTransform: "uppercase", color: o.featured ? C.amber : C.dim,
              marginBottom: 12,
            }}>{o.sub}</div>
            <h3 style={{
              fontFamily: display, fontWeight: 700, fontSize: 30,
              color: C.cream, margin: "0 0 6px", textTransform: "uppercase",
            }}>{o.name}</h3>
            <div style={{
              fontFamily: mono, fontSize: 15, color: o.featured ? C.green : C.slate,
              marginBottom: 22,
            }}>{o.price}</div>

            <ul style={{ listStyle: "none", padding: 0, margin: "0 0 26px", flex: 1 }}>
              {o.points.map(p => (
                <li key={p} style={{
                  display: "flex", gap: 10, alignItems: "flex-start",
                  fontSize: 14, lineHeight: 1.55, color: C.slate,
                  fontFamily: "Inter, sans-serif", marginBottom: 10,
                }}>
                  <span style={{ color: C.amber, fontFamily: mono, fontSize: 12, marginTop: 2 }}>/</span>
                  {p}
                </li>
              ))}
            </ul>

            <Cta
              full
              variant={o.featured ? "primary" : "ghost"}
              onClick={() => document.getElementById("access")?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" })}
            >{o.cta}</Cta>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ── Access request ───────────────────────────────────────────────────

function AccessForm() {
  const [form, setForm] = useState({ email: "", firstName: "", lastName: "", company: "", companySize: "", useCase: "", interestedIn: "cloud" });
  const [state, setState] = useState("idle"); // idle | sending | sent | error
  const [message, setMessage] = useState("");
  const [devLink, setDevLink] = useState(null);

  const set = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.email.trim()) { setState("error"); setMessage("Enter your email address."); return; }
    setState("sending"); setMessage("");
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, source: "landing" }),
      });
      const data = await res.json();
      if (!res.ok) { setState("error"); setMessage(data.error || "Something went wrong. Try again."); return; }
      setState("sent");
      setMessage(data.message);
      if (data.devVerifyUrl) setDevLink(data.devVerifyUrl);
    } catch {
      setState("error");
      setMessage("Could not reach the server. Check your connection and try again.");
    }
  };

  const field = {
    width: "100%", padding: "11px 13px", borderRadius: 7,
    background: C.raised, border: `1px solid ${C.rule}`,
    color: C.cream, fontSize: 14, fontFamily: "Inter, sans-serif",
    outline: "none", transition: "border-color 140ms",
  };
  const label = {
    display: "block", fontFamily: mono, fontSize: 10,
    letterSpacing: "0.14em", textTransform: "uppercase",
    color: C.dim, marginBottom: 6,
  };

  if (state === "sent") {
    return (
      <Section id="access">
        <div style={{
          background: C.panel, border: `1px solid rgba(52,211,153,0.30)`,
          borderRadius: 12, padding: "44px 32px", textAlign: "center",
          maxWidth: 560, margin: "0 auto",
        }}>
          <div style={{
            width: 44, height: 44, borderRadius: 11, margin: "0 auto 20px",
            background: "rgba(52,211,153,0.10)", border: `1px solid rgba(52,211,153,0.30)`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: mono, fontSize: 20, color: C.green,
          }}>OK</div>
          <h3 style={{
            fontFamily: display, fontWeight: 700, fontSize: 28,
            color: C.cream, margin: "0 0 12px", textTransform: "uppercase",
          }}>Check your inbox</h3>
          <p style={{
            fontSize: 15, lineHeight: 1.6, color: C.slate,
            fontFamily: "Inter, sans-serif", margin: 0,
          }}>{message}</p>
          {devLink && (
            <a href={devLink} style={{
              display: "inline-block", marginTop: 20, fontFamily: mono,
              fontSize: 11, color: C.amber, wordBreak: "break-all",
            }}>Development link: verify now</a>
          )}
        </div>
      </Section>
    );
  }

  return (
    <Section id="access">
      <div style={{
        display: "grid", gap: 44,
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
        alignItems: "start",
      }}>
        <div>
          <Eyebrow color={C.green}>Access</Eyebrow>
          <h2 style={{
            fontFamily: display, fontWeight: 700, textTransform: "uppercase",
            fontSize: "clamp(30px, 5vw, 54px)", lineHeight: 1,
            letterSpacing: "-0.015em", color: C.cream, margin: "0 0 18px",
          }}>
            Tell us what you<br />are replacing
          </h2>
          <p style={{
            fontSize: 15.5, lineHeight: 1.65, color: C.slate,
            fontFamily: "Inter, sans-serif", margin: "0 0 22px",
          }}>
            Access is granted by invitation. You will get a verification email
            first, then an invite once we have looked at your request. We read
            every one.
          </p>
          <div style={{
            fontFamily: mono, fontSize: 11.5, lineHeight: 1.9,
            color: C.dim, paddingTop: 18, borderTop: `1px solid ${C.rule}`,
          }}>
            <div>1. Submit this form</div>
            <div>2. Confirm your email</div>
            <div>3. Receive an invite and set a password</div>
          </div>
        </div>

        <form onSubmit={submit} style={{
          background: C.panel, border: `1px solid ${C.rule}`,
          borderRadius: 12, padding: "26px 24px",
        }}>
          {state === "error" && (
            <div style={{
              background: "rgba(248,113,113,0.10)", border: `1px solid rgba(248,113,113,0.25)`,
              borderRadius: 7, padding: "10px 13px", marginBottom: 16,
              fontSize: 13.5, color: C.red, fontFamily: "Inter, sans-serif",
            }}>{message}</div>
          )}

          <div className="sn-form-2col" style={{ marginBottom: 14 }}>
            <div>
              <label style={label} htmlFor="fn">First name</label>
              <input id="fn" style={field} value={form.firstName} onChange={set("firstName")}
                onFocus={e => e.target.style.borderColor = C.amber}
                onBlur={e => e.target.style.borderColor = C.rule} />
            </div>
            <div>
              <label style={label} htmlFor="ln">Last name</label>
              <input id="ln" style={field} value={form.lastName} onChange={set("lastName")}
                onFocus={e => e.target.style.borderColor = C.amber}
                onBlur={e => e.target.style.borderColor = C.rule} />
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={label} htmlFor="em">Work email</label>
            <input id="em" type="email" required style={field} value={form.email} onChange={set("email")}
              placeholder="you@company.com"
              onFocus={e => e.target.style.borderColor = C.amber}
              onBlur={e => e.target.style.borderColor = C.rule} />
          </div>

          <div className="sn-form-2col" style={{ marginBottom: 14 }}>
            <div>
              <label style={label} htmlFor="co">Company</label>
              <input id="co" style={field} value={form.company} onChange={set("company")}
                onFocus={e => e.target.style.borderColor = C.amber}
                onBlur={e => e.target.style.borderColor = C.rule} />
            </div>
            <div>
              <label style={label} htmlFor="sz">Team size</label>
              <select id="sz" style={field} value={form.companySize} onChange={set("companySize")}>
                <option value="">Select</option>
                {["1-10", "11-50", "51-200", "201-1000", "1000+"].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={label} htmlFor="in">Interested in</label>
            <select id="in" style={field} value={form.interestedIn} onChange={set("interestedIn")}>
              <option value="cloud">Managed hosting</option>
              <option value="self-hosted">Self-hosting</option>
              <option value="both">Still deciding</option>
            </select>
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={label} htmlFor="uc">What are you replacing</label>
            <textarea id="uc" rows={3} style={{ ...field, resize: "vertical" }}
              value={form.useCase} onChange={set("useCase")}
              placeholder="Salesforce, a stack of spreadsheets, nothing yet"
              onFocus={e => e.target.style.borderColor = C.amber}
              onBlur={e => e.target.style.borderColor = C.rule} />
          </div>

          <Cta full onClick={submit}>
            {state === "sending" ? "Sending" : "Request access"}
          </Cta>

          <p style={{
            fontFamily: mono, fontSize: 10.5, color: C.dim,
            textAlign: "center", margin: "14px 0 0", lineHeight: 1.6,
          }}>
            No newsletter. We use this to reply to you.
          </p>
        </form>
      </div>
    </Section>
  );
}

// ── Footer ───────────────────────────────────────────────────────────

function Footer({ go }) {
  return (
    <footer style={{ borderTop: `1px solid ${C.rule}`, marginTop: 40 }}>
      <div style={{
        maxWidth: 1180, margin: "0 auto",
        padding: "32px clamp(20px, 5vw, 48px)",
        display: "flex", flexWrap: "wrap", gap: 20,
        alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ fontFamily: mono, fontSize: 11, color: C.dim }}>
          Sales Nebula · {new Date().getFullYear()}
        </div>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
          <a href="#modules" className="nav-link" style={{ fontFamily: mono, fontSize: 11, color: C.dim, textDecoration: "none" }}>Modules</a>
          <a href="#deploy" className="nav-link" style={{ fontFamily: mono, fontSize: 11, color: C.dim, textDecoration: "none" }}>Deployment</a>
          <button onClick={() => go("/login")} style={{
            fontFamily: mono, fontSize: 11, color: C.dim, background: "none",
            border: "none", cursor: "pointer", padding: 0,
          }}>Sign in</button>
        </div>
      </div>
    </footer>
  );
}

// ── Page ─────────────────────────────────────────────────────────────

export default function Landing({ go }) {
  return (
    <div style={{ background: C.void, minHeight: "100vh", color: C.cream, overflow: "visible" }}>
      <style>{`
        .nav-link:hover { color: var(--sn-amber) !important; }
        @media (prefers-reduced-motion: reduce) {
          html { scroll-behavior: auto; }
          * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
        }
        select option { background: var(--sn-raised); color: var(--sn-cream); }
      `}</style>
      <Header go={go} />
      <Hero go={go} />
      <ModuleMatrix />
      <Claims />
      <Deploy />
      <AccessForm />
      <Footer go={go} />
    </div>
  );
}

// ── Email verification screen ────────────────────────────────────────

export function VerifyPage({ go }) {
  const [state, setState] = useState("working");
  const [message, setMessage] = useState("Confirming your email address");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) { setState("error"); setMessage("That link is missing its verification token."); return; }

    fetch("/api/signup/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async r => {
        const data = await r.json();
        if (!r.ok) { setState("error"); setMessage(data.error || "That verification link is not valid."); return; }
        setState("done");
        setMessage(data.message);
      })
      .catch(() => { setState("error"); setMessage("Could not reach the server. Try the link again shortly."); });
  }, []);

  const accent = state === "error" ? C.red : state === "done" ? C.green : C.amber;

  return (
    <CenteredCard
      badge={state === "working" ? "..." : state === "done" ? "OK" : "!"}
      accent={accent}
      title={state === "done" ? "Email confirmed" : state === "error" ? "Link not valid" : "One moment"}
      body={message}
      action={state !== "working" ? { label: state === "done" ? "Back to home" : "Request access again", onClick: () => go("/") } : null}
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
    if (!token.current) { setState("invalid"); setError("That link is missing its invite token."); return; }
    fetch(`/api/signup/invites/lookup/${encodeURIComponent(token.current)}`)
      .then(async r => {
        const data = await r.json();
        if (!r.ok) { setState("invalid"); setError(data.error || "That invite link is not valid."); return; }
        setInvite(data);
        setForm(p => ({ ...p, firstName: data.firstName || "", lastName: data.lastName || "" }));
        setState("ready");
      })
      .catch(() => { setState("invalid"); setError("Could not reach the server."); });
  }, []);

  const rules = [
    ["At least 8 characters", form.password.length >= 8],
    ["An uppercase letter", /[A-Z]/.test(form.password)],
    ["A lowercase letter", /[a-z]/.test(form.password)],
    ["A number", /[0-9]/.test(form.password)],
    ["A symbol", /[^A-Za-z0-9]/.test(form.password)],
  ];
  const ready = rules.every(r => r[1]) && form.password === form.confirm && form.firstName && form.lastName;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    setState("submitting"); setError("");
    try {
      const res = await fetch("/api/signup/invites/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.current, password: form.password, firstName: form.firstName, lastName: form.lastName }),
      });
      const data = await res.json();
      if (!res.ok) {
        setState("ready");
        setError(data.details?.join(". ") || data.error || "Could not create your account.");
        return;
      }
      // Matches the key AuthProvider reads on boot
      localStorage.setItem("sn_token", data.token);
      window.location.href = "/app";
    } catch {
      setState("ready");
      setError("Could not reach the server. Try again.");
    }
  };

  if (state === "loading") {
    return <CenteredCard badge="..." accent={C.amber} title="Checking your invite" body="One moment." />;
  }
  if (state === "invalid") {
    return (
      <CenteredCard badge="!" accent={C.red} title="Invite not valid" body={error}
        action={{ label: "Request access", onClick: () => go("/") }} />
    );
  }

  const field = {
    width: "100%", padding: "11px 13px", borderRadius: 7,
    background: C.raised, border: `1px solid ${C.rule}`,
    color: C.cream, fontSize: 14, fontFamily: "Inter, sans-serif", outline: "none",
  };
  const label = {
    display: "block", fontFamily: mono, fontSize: 10, letterSpacing: "0.14em",
    textTransform: "uppercase", color: C.dim, marginBottom: 6,
  };

  return (
    <div style={{
      background: C.void, minHeight: "100vh", display: "flex",
      alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: 26 }}>
          <h1 style={{
            fontFamily: display, fontWeight: 700, fontSize: 32,
            color: C.cream, margin: "0 0 6px", textTransform: "uppercase",
          }}>Set your password</h1>
          <p style={{ fontFamily: mono, fontSize: 12, color: C.dim, margin: 0 }}>{invite.email}</p>
        </div>

        <form onSubmit={submit} style={{
          background: C.panel, border: `1px solid ${C.rule}`,
          borderRadius: 12, padding: "24px 22px",
        }}>
          {invite.message && (
            <div style={{
              background: C.raised, borderRadius: 7, padding: "11px 13px",
              marginBottom: 16, fontSize: 13.5, color: C.slate,
              fontFamily: "Inter, sans-serif", lineHeight: 1.55,
            }}>{invite.message}</div>
          )}
          {error && (
            <div style={{
              background: "rgba(248,113,113,0.10)", border: `1px solid rgba(248,113,113,0.25)`,
              borderRadius: 7, padding: "10px 13px", marginBottom: 16,
              fontSize: 13.5, color: C.red, fontFamily: "Inter, sans-serif",
            }}>{error}</div>
          )}

          <div className="sn-form-2col" style={{ marginBottom: 14 }}>
            <div>
              <label style={label} htmlFor="ifn">First name</label>
              <input id="ifn" style={field} value={form.firstName}
                onChange={e => setForm(p => ({ ...p, firstName: e.target.value }))} required />
            </div>
            <div>
              <label style={label} htmlFor="iln">Last name</label>
              <input id="iln" style={field} value={form.lastName}
                onChange={e => setForm(p => ({ ...p, lastName: e.target.value }))} required />
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={label} htmlFor="ipw">Password</label>
            <input id="ipw" type="password" style={field} value={form.password}
              onChange={e => setForm(p => ({ ...p, password: e.target.value }))} required />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={label} htmlFor="ipc">Confirm password</label>
            <input id="ipc" type="password" style={field} value={form.confirm}
              onChange={e => setForm(p => ({ ...p, confirm: e.target.value }))} required />
            {form.confirm && form.password !== form.confirm && (
              <div style={{ fontFamily: mono, fontSize: 11, color: C.red, marginTop: 6 }}>
                Passwords do not match
              </div>
            )}
          </div>

          <div style={{ marginBottom: 18 }}>
            {rules.map(([text, met]) => (
              <div key={text} style={{
                display: "flex", gap: 8, alignItems: "center",
                fontFamily: mono, fontSize: 11,
                color: met ? C.green : C.dim, marginBottom: 4,
              }}>
                <span style={{ width: 10 }}>{met ? "+" : "-"}</span>{text}
              </div>
            ))}
          </div>

          <button type="submit" disabled={!ready || state === "submitting"} style={{
            width: "100%", padding: "13px", borderRadius: 8, border: "none",
            background: ready ? C.amber : C.rule,
            color: ready ? C.void : C.dim,
            fontSize: 14, fontWeight: 600, fontFamily: "Inter, sans-serif",
            cursor: ready ? "pointer" : "not-allowed", transition: "all 140ms",
          }}>
            {state === "submitting" ? "Creating your account" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Shared status card ───────────────────────────────────────────────

function CenteredCard({ badge, accent, title, body, action }) {
  return (
    <div style={{
      background: C.void, minHeight: "100vh", display: "flex",
      alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{
        background: C.panel, border: `1px solid ${C.rule}`, borderRadius: 12,
        padding: "40px 32px", textAlign: "center", maxWidth: 440, width: "100%",
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 11, margin: "0 auto 20px",
          background: `${accent}1A`, border: `1px solid ${accent}4D`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: mono, fontSize: 18, color: accent,
        }}>{badge}</div>
        <h1 style={{
          fontFamily: display, fontWeight: 700, fontSize: 27,
          color: C.cream, margin: "0 0 12px", textTransform: "uppercase",
        }}>{title}</h1>
        <p style={{
          fontSize: 14.5, lineHeight: 1.6, color: C.slate,
          fontFamily: "Inter, sans-serif", margin: 0,
        }}>{body}</p>
        {action && (
          <div style={{ marginTop: 24 }}>
            <Cta variant="ghost" onClick={action.onClick}>{action.label}</Cta>
          </div>
        )}
      </div>
    </div>
  );
}
