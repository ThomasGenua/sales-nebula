const express = require('express');
const path = require('path');
const fs = require('fs');
const publicPaths = new Set(['/', '/hosting', '/tour', '/privacy', '/terms']);
const privatePaths = new Set(['/demo', '/login', '/verify', '/accept-invite', '/access-status', '/reset-password', '/oauth/authorize']);

module.exports = function publicSite(spaDir) {
  const router = express.Router();
  router.use(express.static(spaDir, { index: false, redirect: false, setHeaders: (res, file) => {
    res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    // Only clean public URLs belong in search results, not duplicate HTML files.
    if (file.endsWith('.html')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  } }));
  router.get(/^\/(?!api(?:\/|$)|uploads(?:\/|$)).*/, (req, res) => {
    const route = req.path.replace(/\/$/, '') || '/';
    res.setHeader('Cache-Control', 'no-cache');
    if (publicPaths.has(route)) {
      const file = path.join(spaDir, route === '/' ? '' : route.slice(1), 'index.html');
      if (fs.existsSync(file)) return res.sendFile(file);
    }
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!privatePaths.has(route) && route !== '/app' && !route.startsWith('/app/')) res.status(404);
    const appShell = path.join(spaDir, 'app.html');
    res.sendFile(fs.existsSync(appShell) ? appShell : path.join(spaDir, 'index.html'));
  });
  return router;
};
