import React, { useState, useEffect, useRef } from "react";

const C = {
  void: "var(--sn-void)", panel: "var(--sn-panel)", raised: "var(--sn-raised)",
  rule: "var(--sn-rule)", amber: "var(--sn-amber)", cream: "var(--sn-cream)",
  slate: "var(--sn-slate)", dim: "var(--sn-dim)", green: "var(--sn-green)",
  body: "var(--sn-body)", cta: "var(--sn-cta-text)",
};
const display = '"Poppins", system-ui, sans-serif';
const body = display;
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
        credentials: "same-origin",
        // Sign straight in with a cookie session; no token reaches the page.
        headers: { "Content-Type": "application/json", "X-Session-Mode": "cookie" },
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
