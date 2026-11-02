// Render the editable vector source to the PNG expected by social crawlers.
// Uses the existing browser-test dependency, with no network requests.
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('@playwright/test');

async function main() {
  const publicDir = path.resolve(__dirname, '../frontend/public');
  const svg = await fs.readFile(path.join(publicDir, 'og.svg'), 'utf8');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.route('**/*', route => route.abort());
    await page.setContent(`<style>html,body{margin:0;padding:0}svg{display:block}</style>${svg}`);
    await page.screenshot({ path: path.join(publicDir, 'og.png'), type: 'png' });
    console.log('Rendered frontend/public/og.png (1200 × 630).');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
