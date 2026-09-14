#!/usr/bin/env node
/**
 * Galleria Borghese (tosc.it) availability checker — GitHub Actions runner variant.
 * Writes status.json (committed by the workflow). Includes self-diagnostics when a
 * fetch fails, so the result can be inspected over raw.githubusercontent.com.
 */
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const PAGES = [
  {
    key: 'sep30', label: '9/30', eventId: '21975271',
    priority: ['IN 9 am-OUT 11 am', '9:10 am ITALIAN GUIDED TOUR', '9:10 am ENGLISH GUIDED TOUR',
               '11:10 am ITALIAN GUIDED TOUR', '11:10 am ENGLISH GUIDED TOUR'],
  },
  {
    key: 'sep29', label: '9/29', eventId: '21975270',
    priority: ['IN 18:00-OUT 20:00'],
  },
];
const eventUrl = (id) => `https://www.tosc.it/en/event/galleria-borghese-galleria-borghese-${id}/`;

function parseSlots(html) {
  const out = [];
  const marks = [...html.matchAll(/data-qa="pc-list-number-([^"]+)"/g)];
  for (let i = 0; i < marks.length; i++) {
    const name = marks[i][1];
    const block = html.slice(marks[i].index, i + 1 < marks.length ? marks[i + 1].index : html.length);
    const tps = [...block.matchAll(/data-tt-name="([^"]+)"/g)];
    const types = [];
    for (let k = 0; k < tps.length; k++) {
      const s = tps[k].index;
      const e = k + 1 < tps.length ? tps[k + 1].index : block.length;
      types.push({ name: tps[k][1], available: !block.slice(s, e).includes('ticket-type-availability-hint') });
    }
    out.push({ name, available: types.some(t => t.available), availableTypes: types.filter(t => t.available).map(t => t.name) });
  }
  return out;
}

async function fetchPage(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
      redirect: 'follow',
    });
    const text = await res.text();
    return { status: res.status, text, ms: Date.now() - t0, error: null };
  } catch (e) {
    const cause = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : '';
    return { status: 0, text: '', ms: Date.now() - t0, error: `${String(e && e.message || e)}${cause ? ' [' + cause + ']' : ''}` };
  }
}

async function quickProbe(url) {
  const r = await fetchPage(url);
  return { url, status: r.status, error: r.error, ms: r.ms, snippet: r.text ? r.text.replace(/\s+/g, ' ').slice(0, 180) : '' };
}

const prev = (() => { try { return JSON.parse(fs.readFileSync('status.json', 'utf8')); } catch { return null; } })();
const prevAvail = new Set(Object.entries(prev?.availableSlots || {}).filter(([, v]) => v.available).map(([k]) => k));

const status = { updatedAt: new Date().toISOString(), ok: true, notes: [], availableSlots: {}, newAlerts: [] };
const failures = [];

for (const page of PAGES) {
  const url = eventUrl(page.eventId);
  const r = await fetchPage(url);
  const blocked = r.status === 403 || /Access Denied|Reference #18\./.test(r.text.slice(0, 4000));
  if (!r.text || blocked || r.status >= 400) {
    status.ok = false;
    status.notes.push(`${page.label}: HTTP ${r.status}${blocked ? ' (akamai/access denied)' : ''}${r.error ? ' ' + r.error : ''} (${r.ms}ms)`);
    failures.push({ page: page.label, url, status: r.status, error: r.error, ms: r.ms, blocked, snippet: r.text.replace(/\s+/g, ' ').slice(0, 200) });
    continue;
  }
  const slots = parseSlots(r.text);
  if (!slots.length) { status.ok = false; status.notes.push(`${page.label}: no slots parsed (${r.ms}ms)`); failures.push({ page: page.label, url, status: r.status, ms: r.ms, error: 'no slots parsed', snippet: r.text.replace(/\s+/g, ' ').slice(0, 200) }); continue; }
  for (const s of slots) {
    const k = `${page.key}|${s.name}`;
    const isPrio = page.priority.includes(s.name);
    status.availableSlots[k] = { page: page.label, slot: s.name, isPriority: isPrio, available: s.available, availableTypes: s.availableTypes };
    if (s.available && !prevAvail.has(k)) {
      status.newAlerts.push({ page: page.label, slot: s.name, isPriority: isPrio, availableTypes: s.availableTypes, url, at: new Date().toISOString() });
    }
  }
}

// keep prior alerts alive for 12h so a slow poller can't miss them
for (const a of (prev?.newAlerts || [])) {
  const age = Date.now() - Date.parse(a.at || 0);
  if (age < 12 * 3600 * 1000 && !status.newAlerts.some(x => x.page === a.page && x.slot === a.slot)) status.newAlerts.push(a);
}

if (!status.ok) {
  status.diag = {
    egress: await quickProbe('https://api.ipify.org'),
    control: await quickProbe('https://example.com'),
    failures,
  };
}

fs.writeFileSync('status.json', JSON.stringify(status, null, 2) + '\n');
console.log(JSON.stringify(status, null, 2));
