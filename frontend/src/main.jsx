import React, { useState, useEffect, useCallback, lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
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

// Each surface loads only its own code. Everything used to ship as one
// 418 KB bundle, so a visitor to the landing page downloaded the whole CRM.
const named = (load, name) => lazy(() => load().then(m => ({ default: m[name] })));
const loadLanding = () => import("./Landing");
const loadLegal = () => import("./Legal");
const App = lazy(() => import("./App"));
const Landing = lazy(loadLanding);
const VerifyPage = named(loadLanding, "VerifyPage");
const AcceptInvitePage = named(loadLanding, "AcceptInvitePage");
const PrivacyPage = named(loadLegal, "PrivacyPage");
const TermsPage = named(loadLegal, "TermsPage");
const ResetPasswordPage = lazy(() => import("./ResetPassword"));

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

  // Keyed on the path so navigating away from a broken screen clears the error.
  // While a page's code loads, the body's own background shows.
  return (
    <ErrorBoundary resetKey={path}>
      <Suspense fallback={<div aria-busy="true" style={{ minHeight: "100vh" }} />}>
        {renderPage(path, go)}
      </Suspense>
    </ErrorBoundary>
  );
}

/** Path -> page. Split out so ErrorBoundary can wrap whatever it returns. */
function renderPage(path, go) {
  if (path === "/verify") return <VerifyPage go={go} />;
  if (path === "/accept-invite") return <AcceptInvitePage go={go} />;
  if (path === "/privacy") return <PrivacyPage go={go} />;
  if (path === "/terms") return <TermsPage go={go} />;
  if (path === "/reset-password") return <ResetPasswordPage go={go} />;
  // A connected app asking for access: sign in if need be, then consent.
  if (path === "/oauth/authorize") return <App go={go} />;
  if (path === "/app" || path.startsWith("/app/") || path === "/login") return <App go={go} startOnLogin={path === "/login"} />;
  if (path === "/") return <Landing go={go} />;

  // Unknown path: send signed-in users to the product, everyone else home.
  // The session cookies are unreadable by design; the CSRF cookie beside
  // them is the sign that one exists.
  const signedIn = /(?:^|;\s*)sn_csrf=/.test(document.cookie);
  return signedIn ? <App go={go} /> : <Landing go={go} />;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  </React.StrictMode>
);
