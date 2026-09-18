import React from "react";

/**
 * Catches render errors so one broken screen does not white-screen the app.
 *
 * Every page renders inside this, and a thrown error anywhere below it would
 * otherwise unmount the whole tree and leave a blank document with nothing to
 * click. The fallback keeps the user somewhere they can act from.
 *
 * `resetKey` clears a caught error when it changes, so navigating away from a
 * broken screen recovers without a reload.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the stack somewhere a developer can reach it. No reporting
    // endpoint exists yet; when one lands, this is the single call site.
    console.error("[ui:error-boundary]", error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const panel = {
      background: "var(--sn-panel)",
      border: "1px solid var(--sn-rule)",
      borderRadius: 12,
      padding: 28,
      maxWidth: 460,
      width: "100%",
    };

    return (
      <div
        role="alert"
        style={{
          minHeight: "100dvh",
          background: "var(--sn-void)",
          color: "var(--sn-cream)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
          fontFamily: '"Poppins", system-ui, sans-serif',
        }}
      >
        <div style={panel}>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 8px" }}>
            This screen hit an error
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--sn-body)", margin: "0 0 20px" }}>
            The rest of the app is still running. Go back to the dashboard, or
            reload if it keeps happening.
          </p>

          {import.meta.env.DEV && (
            <pre
              style={{
                fontSize: 12,
                lineHeight: 1.5,
                color: "var(--sn-red-ink)",
                background: "var(--sn-raised)",
                border: "1px solid var(--sn-rule)",
                borderRadius: 8,
                padding: 12,
                margin: "0 0 20px",
                overflowX: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {String(error?.stack || error?.message || error)}
            </pre>
          )}

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              style={{
                flex: "1 1 auto",
                minHeight: 44,
                padding: "10px 18px",
                borderRadius: 8,
                border: "none",
                cursor: "pointer",
                fontWeight: 700,
                fontSize: 14,
                background: "var(--sn-amber)",
                color: "var(--sn-cta-text)",
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                flex: "1 1 auto",
                minHeight: 44,
                padding: "10px 18px",
                borderRadius: 8,
                cursor: "pointer",
                fontWeight: 600,
                fontSize: 14,
                background: "var(--sn-raised)",
                border: "1px solid var(--sn-rule)",
                color: "var(--sn-cream)",
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
