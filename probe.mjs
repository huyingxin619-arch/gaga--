#!/usr/bin/env node
/**
 * One-off probe: can a GitHub runner fetch tosc.it at all?
 * Resilient: writes probe.json continuously, never throws, no hard deps at load time.
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const URLS = [
  'https://www.tosc.it/en/event/galleria-borghese-galleria-borghese-21975271/',
  'https://www.tosc.it/en/event/galleria-borghese-galleria-borghese-21975270/',
];

const out = { at: new Date().toISOString(), env: {}, results: [] };
const flush = () => fs.writeFileSync('probe.json', JSON.stringify(out, null, 2) + '\n');

function sh(cmd, timeout = 60000) {
  try { return execSync(cmd, { encoding: 'utf8', shell: '/bin/bash', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { return `ERR(${e.status ?? 'x'}): ${String(e.message).split('\n')[0]}`; }
}

out.env = {
  node: process.version,
  chrome: sh('(which google-chrome || which chromium || which chromium-browser || echo none) 2>&1'),
  playwrightInstalled: fs.existsSync('node_modules/playwright') || fs.existsSync('node_modules/playwright-core'),
};
flush();

for (const url of URLS) {
  const rec = { url };

  rec.curl = sh(`curl -sS -o /tmp/c.html -w 'code=%{http_code} tcp=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} bytes=%{size_download}' --max-time 25 -A "${UA}" "${url}" 2>&1; echo " exit=$?"`, 60000);
  rec.curlBodySnippet = sh('head -c 150 /tmp/c.html 2>/dev/null | tr -s "[:space:]" " "', 10000);
  flush();

  try {
    const t0 = Date.now();
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(40000) });
    const txt = await res.text();
    rec.fetch = { status: res.status, ms: Date.now() - t0, bytes: txt.length, hasSlots: txt.includes('pc-list-number'), snippet: txt.replace(/\s+/g, ' ').slice(0, 140) };
  } catch (e) {
    rec.fetch = { error: String(e.message), cause: e.cause ? (e.cause.code || e.cause.message) : '' };
  }
  flush();

  // Chromium via playwright/playwright-core (system chrome channel as fallback)
  let chromium = null, loadedFrom = null;
  for (const mod of ['playwright', 'playwright-core']) {
    try { const m = await import(mod); chromium = m.chromium; loadedFrom = mod; break; } catch {}
  }
  rec.playwrightModule = loadedFrom;
  if (chromium) {
    for (const launchOpts of [{ args: ['--no-sandbox', '--disable-dev-shm-usage'] }, { channel: 'chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] }]) {
      try {
        const t0 = Date.now();
        const browser = await chromium.launch(launchOpts);
        const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1366, height: 900 } });
        const page = await ctx.newPage();
        let resp = null, err = null;
        try {
          resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(6000);
        } catch (e) { err = String(e.message).split('\n')[0]; }
        const html = await page.content().catch(() => '');
        rec.playwright = {
          mode: launchOpts.channel ? 'system-chrome' : 'bundled-chromium',
          ms: Date.now() - t0,
          httpStatus: resp ? resp.status() : null,
          bytes: html.length,
          hasSlots: html.includes('pc-list-number'),
          title: (await page.title().catch(() => '')).slice(0, 120),
          snippet: html.replace(/\s+/g, ' ').slice(0, 160),
          error: err,
        };
        await browser.close();
        break;
      } catch (e) {
        rec.playwright = { mode: launchOpts.channel ? 'system-chrome' : 'bundled-chromium', error: String(e.message).split('\n')[0] };
      }
      flush();
    }
  } else {
    rec.playwright = { error: 'playwright module not available' };
  }

  out.results.push(rec);
  flush();
}

flush();
console.log(JSON.stringify(out, null, 2));
