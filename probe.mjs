#!/usr/bin/env node
/**
 * One-off probe: can a GitHub runner fetch tosc.it at all?
 *   - curl timing breakdown (does TCP/TLS connect? does the response stall?)
 *   - undici fetch (node)
 *   - real Chromium via Playwright
 * Writes probe.json (committed) so results can be read over raw.githubusercontent.com.
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const URLS = [
  'https://www.tosc.it/en/event/galleria-borghese-galleria-borghese-21975271/',
  'https://www.tosc.it/en/event/galleria-borghese-galleria-borghese-21975270/',
];
const out = { at: new Date().toISOString(), results: [] };

for (const url of URLS) {
  const rec = { url };

  // 1) curl
  try {
    rec.curl = execSync(
      `curl -sS -o /tmp/c.html -w 'code=%{http_code} tcp=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} bytes=%{size_download}' --max-time 30 -A "${UA}" "${url}" 2>&1 || echo "  (curl non-zero exit)"`,
      { encoding: 'utf8', shell: '/bin/bash', timeout: 60000 }
    ).trim();
  } catch (e) { rec.curl = 'ERROR ' + e.message; }

  // 2) undici fetch
  try {
    const t0 = Date.now();
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
    const txt = await res.text();
    rec.fetch = { status: res.status, ms: Date.now() - t0, bytes: txt.length, hasSlots: txt.includes('pc-list-number'), snippet: txt.replace(/\s+/g, ' ').slice(0, 120) };
  } catch (e) {
    rec.fetch = { error: String(e.message), cause: e.cause ? (e.cause.code || e.cause.message) : '' };
  }

  // 3) Playwright Chromium
  try {
    const t0 = Date.now();
    const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    let resp = null, err = null;
    try {
      resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(6000);
    } catch (e) { err = String(e.message).split('\n')[0]; }
    const html = await page.content().catch(() => '');
    rec.playwright = {
      ms: Date.now() - t0,
      httpStatus: resp ? resp.status() : null,
      bytes: html.length,
      hasSlots: html.includes('pc-list-number'),
      title: (await page.title().catch(() => '')).slice(0, 120),
      snippet: html.replace(/\s+/g, ' ').slice(0, 160),
      error: err,
    };
    await browser.close();
  } catch (e) {
    rec.playwright = { error: String(e.message).split('\n')[0] };
  }

  out.results.push(rec);
}

fs.writeFileSync('probe.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
