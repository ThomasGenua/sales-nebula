import React, { useState, useEffect, useCallback } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Landing, { VerifyPage, AcceptInvitePage } from "./Landing";
import { ThemeProvider } from "./theme";
import "./index.css";

/**
 * Path router.
 *
 * The public site and the authenticated product are separate surfaces:
 * "/" must render marketing to a stranger, and "/app" must never render
 * anything before a session exists. Hand-rolled rather than pulling in a
 * router dependency, since there are only four routes.
 */
function Root() {
  const [path, setPath] = useState(window.location.pathname);

  const go = useCallback((next) => {
    if (next === window.location.pathname) return;
    window.history.pushState({}, "", next);
    setPath(next);
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (path === "/verify") return <VerifyPage go={go} />;
  if (path === "/accept-invite") return <AcceptInvitePage go={go} />;
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
