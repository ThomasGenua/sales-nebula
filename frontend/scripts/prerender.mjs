import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

await build({ build: { ssr: 'src/prerender.jsx', outDir: '.prerender', rollupOptions: { output: { manualChunks: undefined, entryFileNames: 'render.mjs' } } } });
const { render, metadata, PUBLIC_META, siteOrigin } = await import(pathToFileURL(path.resolve('.prerender/render.mjs')));
const template = await fs.readFile('dist/index.html', 'utf8');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function head(html, route) {
  const meta = metadata(route);
  html = html.replace(/<title>.*?<\/title>/, `<title>${escape(meta.title)}</title>`);
  for (const [attribute, name, value] of [['name', 'description', meta.description], ['name', 'robots', meta.robots], ['property', 'og:title', meta.title], ['property', 'og:description', meta.description], ['property', 'og:url', meta.canonical], ['property', 'og:image', `${siteOrigin}/og.png`], ['name', 'twitter:title', meta.title], ['name', 'twitter:description', meta.description], ['name', 'twitter:image', `${siteOrigin}/og.png`]]) {
    html = html.replace(new RegExp(`<meta ${attribute}="${name}" content="[^"]*"\\s*/?>`), `<meta ${attribute}="${name}" content="${escape(value)}" />`);
  }
  return html.replace(/<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${escape(meta.canonical)}" />`);
}
await fs.writeFile('dist/app.html', head(template, '/app'));
for (const route of Object.keys(PUBLIC_META)) {
  const file = path.join('dist', route === '/' ? '' : route.slice(1), 'index.html');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const html = head(template, route).replace('<div id="root"></div>', `<div id="root" data-prerender="${route}">${render(route)}</div>`);
  await fs.writeFile(file, html);
}
await fs.writeFile('dist/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Object.keys(PUBLIC_META).map(route => `<url><loc>${escape(siteOrigin + route)}</loc></url>`).join('')}</urlset>`);
await fs.writeFile('dist/robots.txt', `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /app\nDisallow: /demo\nDisallow: /verify\nDisallow: /accept-invite\nDisallow: /access-status\nDisallow: /reset-password\nDisallow: /login\nDisallow: /oauth/\nSitemap: ${siteOrigin}/sitemap.xml\n`);
console.log(`Prerendered ${Object.keys(PUBLIC_META).length} public pages for ${siteOrigin}`);
