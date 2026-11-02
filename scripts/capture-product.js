// Capture actual application screens with the browser-only sample workspace.
// No CRM database or live integration is connected to this process.
const { chromium } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, 'preview-public.js')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PUBLIC_PREVIEW_PORT: '7549' } });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.stdout.on('data', data => { if (String(data).includes('preview ready')) resolve(); }); server.on('error', reject); server.on('exit', code => reject(new Error(`Preview exited: ${code}`))); setTimeout(() => reject(new Error('Preview timed out')), 15000).unref(); });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: 1, extraHTTPHeaders: { DNT: '1' } });
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await page.addInitScript(() => localStorage.setItem('sn_measurement_opt_out', 'true'));
    await page.goto('http://127.0.0.1:7549/demo');
    await page.getByRole('button', { name: 'Explore on my own', exact: true }).click();
    await fs.mkdir(path.resolve(__dirname, '../frontend/public/product'), { recursive: true });
    for (const [key, route, title] of [['lead', 'leads/demo-lead-1', 'Anna'], ['deal', 'deals/demo-deal-1', 'TechStart team rollout'], ['quote', 'quotes/demo-quote-1', 'TechStart rollout proposal']]) {
      await page.goto(`http://127.0.0.1:7549/app/${route}`);
      await page.getByRole('heading', { name: title, exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState('networkidle');
      await page.getByRole('heading', { name: title, exact: true }).waitFor();
      await page.screenshot({ path: path.resolve(__dirname, `../frontend/public/product/${key}.jpg`), type: 'jpeg', quality: 82 });
      await fs.mkdir(path.resolve(__dirname, '../frontend/dist/product'), { recursive: true });
      await fs.copyFile(path.resolve(__dirname, `../frontend/public/product/${key}.jpg`), path.resolve(__dirname, `../frontend/dist/product/${key}.jpg`));
      console.log(`Captured ${key}`);
    }
  } finally { if (browser) await browser.close(); server.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
