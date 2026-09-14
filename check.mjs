#!/usr/bin/env node
/**
 * Galleria Borghese (tosc.it) availability checker — GitHub Actions runner variant.
 * Runs on a GitHub-hosted runner (hopefully a non-blocked datacenter IP) and writes
 * status.json, which the OpenClaw agent polls over raw.githubusercontent.com.
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
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
      redirect: 'follow',
    });
    const text = await res.text();
    return { status: res.status, text, error: null };
  } catch (e) {
    return { status: 0, text: '', error: String(e && e.message || e) };
  }
}

const prev = (() => { try { return JSON.parse(fs.readFileSync('status.json', 'utf8')); } catch { return null; } })();
const prevAvail = new Set(Object.entries(prev?.availableSlots || {}).filter(([, v]) => v.available).map(([k]) => k));

const status = { updatedAt: new Date().toISOString(), ok: true, notes: [], availableSlots: {}, newAlerts: [] };

for (const page of PAGES) {
  const url = eventUrl(page.eventId);
  const r = await fetchPage(url);
  const blocked = r.status === 403 || /Access Denied|Reference #18\./.test(r.text.slice(0, 4000));
  if (!r.text || blocked || r.status >= 400) {
    status.ok = false;
    status.notes.push(`${page.label}: HTTP ${r.status}${blocked ? ' (akamai/access denied)' : ''}${r.error ? ' ' + r.error : ''}`);
    continue;
  }
  const slots = parseSlots(r.text);
  if (!slots.length) { status.ok = false; status.notes.push(`${page.label}: no slots parsed`); continue; }
  for (const s of slots) {
    const k = `${page.key}|${s.name}`;
    const isPrio = page.priority.includes(s.name);
    status.availableSlots[k] = { page: page.label, slot: s.name, isPriority: isPrio, available: s.available, availableTypes: s.availableTypes };
    if (s.available && !prevAvail.has(k)) {
      status.newAlerts.push({ page: page.label, slot: s.name, isPriority: isPrio, availableTypes: s.availableTypes, url, at: new Date().toISOString() });
    }
  }
}

// Never drop an alert that appeared in the previous committed status within the last 12h
for (const a of (prev?.newAlerts || [])) {
  const age = Date.now() - Date.parse(a.at || 0);
  if (age < 12 * 3600 * 1000 && !status.newAlerts.some(x => x.page === a.page && x.slot === a.slot)) {
    status.newAlerts.push(a);
  }
}

fs.writeFileSync('status.json', JSON.stringify(status, null, 2) + '\n');
console.log(JSON.stringify(status, null, 2));
