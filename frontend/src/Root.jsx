import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import ErrorBoundary from './ErrorBoundary';
import Landing from './Landing';
import { HostingPage, TourPage } from './PublicPages';
import { PrivacyPage, TermsPage } from './Legal';
import { startMeasurement } from './marketing';
import { applyMetadata } from './metadata';
import AccessStatusPage from './AccessFollowThrough';
const App = lazy(() => import('./App'));
const named = (name) => lazy(() => import('./AccessPages').then(module => ({ default: module[name] })));
const VerifyPage = named('VerifyPage');
const AcceptInvitePage = named('AcceptInvitePage');
const ResetPasswordPage = lazy(() => import('./ResetPassword'));

export default function Root({ initialPath = '/' }) {
  const [path, setPath] = useState(initialPath);
  const go = useCallback(next => {
    const url = new URL(next, location.origin);
    if (url.origin !== location.origin) { location.assign(url.href); return; }
    history.pushState({}, '', url.pathname + url.search + url.hash);
    setPath(url.pathname);
    if (url.hash) requestAnimationFrame(() => document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView());
    else window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    const pop = () => setPath(location.pathname);
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => { applyMetadata(path); startMeasurement(path); }, [path]);
  let page;
  if (path === '/') page = <Landing go={go} />;
  else if (path === '/hosting') page = <HostingPage go={go} />;
  else if (path === '/tour') page = <TourPage go={go} />;
  else if (path === '/privacy') page = <PrivacyPage go={go} />;
  else if (path === '/terms') page = <TermsPage go={go} />;
  else if (path === '/verify') page = <VerifyPage go={go} />;
  else if (path === '/accept-invite') page = <AcceptInvitePage go={go} />;
  else if (path === '/access-status') page = <AccessStatusPage go={go} />;
  else if (path === '/reset-password') page = <ResetPasswordPage go={go} />;
  else if (path === '/demo') page = <App go={go} startOnDemo />;
  else if (path === '/login' || path === '/oauth/authorize' || path === '/app' || path.startsWith('/app/')) page = <App go={go} startOnLogin={path === '/login'} />;
  else page = <main className="sn-site sn-status-page"><div className="sn-site-container"><h1>Page not found.</h1><p>Let’s get you back to your next move.</p><a className="sn-site-button" href="/">Back to Sales Nebula</a></div></main>;
  return <ErrorBoundary resetKey={path}><Suspense fallback={<div aria-busy="true" style={{ minHeight: '100vh' }} />}>{page}</Suspense></ErrorBoundary>;
}
