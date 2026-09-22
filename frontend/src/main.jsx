import React, { useState, useEffect, useCallback } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Landing, { VerifyPage, AcceptInvitePage } from "./Landing";
import { PrivacyPage, TermsPage } from "./Legal";
import ResetPasswordPage from "./ResetPassword";
import ErrorBoundary from "./ErrorBoundary";
import { ThemeProvider } from "./theme";
// Served from this app rather than Google Fonts, so no visitor's IP address
// goes to a third party just to render text.
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "@fontsource/poppins/800.css";
import "./index.css";

/**
 * Path router.
 *
 * The public site and the authenticated product are separate surfaces:
 * "/" must render marketing to a stranger, and "/app" must never render
 * anything before a session exists. Hand-rolled rather than pulling in a
 * router dependency.
 */
function Root() {
  const [path, setPath] = useState(window.location.pathname);

  const go = useCallback((next) => {
    const url = new URL(next, window.location.origin);
    const nextPath = url.pathname + url.search;
    if (nextPath === window.location.pathname + window.location.search) return;
    window.history.pushState({}, "", nextPath);
    setPath(url.pathname);
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Keyed on the path so navigating away from a broken screen clears the error
  return <ErrorBoundary resetKey={path}>{renderPage(path, go)}</ErrorBoundary>;
}

/** Path -> page. Split out so ErrorBoundary can wrap whatever it returns. */
function renderPage(path, go) {
  if (path === "/verify") return <VerifyPage go={go} />;
  if (path === "/accept-invite") return <AcceptInvitePage go={go} />;
  if (path === "/privacy") return <PrivacyPage go={go} />;
  if (path === "/terms") return <TermsPage go={go} />;
  if (path === "/reset-password") return <ResetPasswordPage go={go} />;
  if (path === "/app" || path.startsWith("/app/") || path === "/login") return <App go={go} startOnLogin={path === "/login"} />;
  if (path === "/") return <Landing go={go} />;

  // Unknown path: send signed-in users to the product, everyone else home
  const signedIn = !!localStorage.getItem("sn_token");
  return signedIn ? <App go={go} /> : <Landing go={go} />;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  </React.StrictMode>
);
