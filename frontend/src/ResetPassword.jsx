import React, { useState } from "react";
import { BrandMark, ThemeToggle } from "./theme";

const body = '"Poppins", system-ui, sans-serif';

export default function ResetPasswordPage({ go }) {
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [state, setState] = useState(token ? "ready" : "invalid");
  const [message, setMessage] = useState(token ? "" : "That reset link is missing its token.");

  const submit = async (e) => {
    e.preventDefault();
    if (password !== confirm) {
      setMessage("Passwords do not match.");
      return;
    }
    setState("working");
    setMessage("");
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setState("ready");
        setMessage(data.error || "Could not reset password.");
        return;
      }
      setState("done");
      setMessage(data.message || "Password updated.");
    } catch {
      setState("ready");
      setMessage("Could not reach the server.");
    }
  };

  const field = {
    width: "100%",
    padding: "12px 14px",
    borderRadius: 8,
    background: "var(--sn-raised)",
    border: "1px solid var(--sn-rule)",
    color: "var(--sn-cream)",
    fontFamily: body,
    fontSize: 14,
    outline: "none",
  };

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "var(--sn-void)",
        color: "var(--sn-cream)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        fontFamily: body,
      }}
    >
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
          <ThemeToggle compact />
        </div>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
            <BrandMark size={48} />
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Reset password</h1>
          <p style={{ fontSize: 13, color: "var(--sn-dim)", margin: "8px 0 0" }}>Sales Nebula</p>
        </div>

        {state === "done" ? (
          <div
            style={{
              background: "var(--sn-panel)",
              border: "1px solid var(--sn-rule)",
              borderRadius: 12,
              padding: 24,
              textAlign: "center",
            }}
          >
            <p style={{ margin: "0 0 16px", color: "var(--sn-body)" }}>{message}</p>
            <button
              type="button"
              onClick={() => go("/login")}
              style={{
                fontFamily: body,
                fontWeight: 700,
                border: "none",
                borderRadius: 8,
                padding: "12px 18px",
                background: "var(--sn-amber)",
                color: "var(--sn-cta-text)",
                cursor: "pointer",
              }}
            >
              Sign in
            </button>
          </div>
        ) : state === "invalid" ? (
          <div
            style={{
              background: "var(--sn-panel)",
              border: "1px solid var(--sn-rule)",
              borderRadius: 12,
              padding: 24,
              textAlign: "center",
            }}
          >
            <p style={{ margin: "0 0 16px", color: "var(--sn-red-ink)" }}>{message}</p>
            <button
              type="button"
              onClick={() => go("/login")}
              style={{
                fontFamily: body,
                fontWeight: 600,
                border: "1px solid var(--sn-rule)",
                borderRadius: 8,
                padding: "12px 18px",
                background: "transparent",
                color: "var(--sn-cream)",
                cursor: "pointer",
              }}
            >
              Back to sign in
            </button>
          </div>
        ) : (
          <form
            onSubmit={submit}
            style={{
              background: "var(--sn-panel)",
              border: "1px solid var(--sn-rule)",
              borderRadius: 12,
              padding: 24,
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            {message && (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "rgba(248,113,113,0.1)",
                  border: "1px solid rgba(248,113,113,0.25)",
                  color: "var(--sn-red-ink)",
                  fontSize: 13,
                }}
              >
                {message}
              </div>
            )}
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--sn-dim)" }}>
              New password
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ ...field, marginTop: 6 }}
              />
            </label>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--sn-dim)" }}>
              Confirm password
              <input
                type="password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                style={{ ...field, marginTop: 6 }}
              />
            </label>
            <button
              type="submit"
              disabled={state === "working"}
              style={{
                marginTop: 4,
                fontFamily: body,
                fontWeight: 700,
                border: "none",
                borderRadius: 8,
                padding: "13px",
                background: "var(--sn-amber)",
                color: "var(--sn-cta-text)",
                cursor: "pointer",
                opacity: state === "working" ? 0.7 : 1,
              }}
            >
              {state === "working" ? "Updating…" : "Update password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
