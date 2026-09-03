#!/usr/bin/env node
// Deliberately plain read-only dashboard: the machine at a glance.
// Helm shows the work; this shows the loops that do it.
import { createServer } from 'node:http';
import { ESTATE_TOKENS } from './estate-tokens.generated.js';
import { readCodexUsage, readUsage, usageLine, worstSeverity } from './usage.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { revHome, loadRoster, stateDir, tokenLogPath } from './config.js';
import { pidAlive, sGet, sHas } from './sentinels.js';

const port = Number(process.env['REV_VIEW_PORT'] ?? 4500);
const host = process.env['REV_VIEW_HOST'] ?? '127.0.0.1';
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

function state(name: string): string {
  const pid = pidAlive(name);
  if (sHas(name, 'STOP')) return 'STOP';
  if (sHas(name, 'HOLD')) return 'HOLD';
  if (sHas(name, 'BLOCKED')) return 'BLOCKED';
  if (sHas(name, 'WEDGED')) return 'WEDGED';
  if (!pid && sHas(name, 'BACKOFF')) return 'BACKOFF';
  if (pid && sHas(name, 'LIMIT')) return 'LIMIT';
  if (pid && sHas(name, 'PARKED')) return 'PARKED';
  if (pid && sHas(name, 'IDLE')) return 'IDLE';
  if (pid) return 'RUNNING';
  if (sHas(name, 'RUNNING')) return 'CRASHED';
  return 'halted';
}

function lastEvents(name: string, n: number): string[] {
  const p = join(stateDir(name), 'events.log');
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  return lines.slice(-n);
}

function spend(name: string): { tokens: number; cost: number } {
  const p = tokenLogPath();
  let tokens = 0, cost = 0;
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.includes(`loop=${name} `)) continue;
      const t = /tokens=(\d+)/.exec(line);
      const c = /cost_usd=([\d.]+)/.exec(line);
      if (t) tokens += Number(t[1]);
      if (c) cost += Number(c[1]);
    }
  }
  return { tokens, cost };
}

createServer((req, res) => {
  // Machine-readable snapshot for aggregators (the estate health page, H-627).
  // Rev owns loop-state truth — sentinel precedence and pid identity (H-154)
  // — so consumers read this instead of re-deriving it from the markers.
  if (req.url === '/health.json') {
    const { loops } = loadRoster();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      supervisor: pidAlive('supervisor') || null,
      loops: Object.values(loops).map((l) => {
        const st = state(l.name);
        const reason = st === 'BLOCKED' || st === 'WEDGED' ? sGet(l.name, st)?.split('\n')[0] : undefined;
        return { name: l.name, state: st, workstream: l.workstream, ...(reason ? { reason } : {}) };
      }),
      usage: { claude: readUsage(), codex: readCodexUsage() },
    }));
    return;
  }
  const { loops } = loadRoster();
  const rows = Object.values(loops)
    .map((l) => {
      const st = state(l.name);
      const sp = spend(l.name);
      const blocked = st === 'BLOCKED' ? `<div class="blockreason">${esc(sGet(l.name, 'BLOCKED')?.split('\n')[0])} — see the Helm awaiting-you queue</div>` : '';
      // A wedged loop cannot file a ticket about being wedged — Helm is what it
      // cannot reach — so this row is the record (H-448).
      const wedged = st === 'WEDGED' ? `<div class="blockreason">${esc(sGet(l.name, 'WEDGED')?.split('\n')[0])}</div>` : '';
      const events = lastEvents(l.name, 5)
        .map((e) => `<div class="ev">${esc(e)}</div>`)
        .join('');
      return `<tr>
        <td class="name">${esc(l.name)}</td>
        <td class="st st-${st}">${st}${blocked}${wedged}</td>
        <td>${esc(l.workstream)}</td>
        <td>${esc(l.runtime)}/${esc(l.model)}</td>
        <td>${esc(sGet(l.name, 'PACE')?.trim() ?? '1')}</td>
        <td>${sp.tokens ? `${(sp.tokens / 1000).toFixed(1)}k` : '—'}${sp.cost ? ` $${sp.cost.toFixed(2)}` : ''}</td>
        <td class="trace">${events || '<span class="dim">no trace yet</span>'}</td>
      </tr>`;
    })
    .join('\n');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Rev</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="10">
  <style>
${ESTATE_TOKENS}
    /* Chrome, ink and shape come from the estate's design tokens, vendored
       (R-11 H-714): one visual system across Helmo, the roadmap, rev, the
       health page and the estate shell. The aliases are the whole seam — rev
       keeps its own names and every rule below is written against them, so a
       look ratified upstream restyles this page without it being touched.
       ESTATE_TOKENS goes first: the aliases read from it, and it brings the
       dark values under prefers-color-scheme, which is what a page with no
       theme switch needs. Rev had no dark half at all before this. */
    :root {
      color-scheme: light dark;
      --page: var(--background); --ink: var(--foreground);
      /* Rev runs a four-step grey ladder where shadcn has two; the steps in
         between are mixed rather than picked, so a look change carries them. */
      --ink-2: color-mix(in oklab, var(--foreground) 72%, var(--background));
      --ink-3: var(--muted-foreground);
      --ink-4: color-mix(in oklab, var(--muted-foreground) 62%, var(--background));
      --hairline: var(--border);
      /* No radius ramp: nothing on this page is rounded. */

      /* Status and link were the one part of this page shadcn had nothing for,
         so they were held back as literals until the estate grew a ramp of its
         own (H-771). Now they alias like everything else, and rev's dark
         overrides for them are gone because the ramp is themed.
         --warn-text moves one step: rev carried #b60, which is 4.19:1 on white
         and rev uses amber AS body text. The estate's light amber is #a60 at
         4.56:1 — the value the health page measured and this file's own note
         reported upstream. Colour always rides with a text label (H-713). */
      --good-text: var(--status-good); --critical: var(--status-bad);
      --warn-text: var(--status-warn); --link: var(--interactive);
    }
    body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; max-width: 1250px;
      background: var(--page); color: var(--ink); }
    a { color: var(--link); }
    /* Seven columns of machine detail do not fit a phone and should not try to.
       The wrapper is what keeps the page from being dragged sideways with them:
       the table scrolls, the heading and usage lines stay put. */
    .tablewrap { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; min-width: 700px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--hairline); vertical-align: top; }
    th { font-size: 12px; text-transform: uppercase; color: var(--ink-3); }
    .name { font-family: ui-monospace, monospace; }
    .st { font-weight: 600; }
    .st-RUNNING { color: var(--good-text); } .st-IDLE { color: var(--ink-3); } .st-BLOCKED, .st-CRASHED, .st-WEDGED { color: var(--critical); }
    .st-LIMIT, .st-PARKED, .st-BACKOFF { color: var(--warn-text); } .st-STOP, .st-HOLD, .st-halted { color: var(--ink-4); }
    .trace { font-family: ui-monospace, monospace; font-size: 11px; color: var(--ink-2); }
    .usage { font-family: ui-monospace, monospace; font-size: 12px; color: var(--ink-2); margin: 0 0 12px; }
    .usage.warning { color: var(--warn-text); } .usage.critical { color: var(--critical); font-weight: 600; }
    .blockreason { font-weight: 400; font-size: 12px; color: var(--critical); }
    /* Was #bbb against .st-halted's #999 — two greys two percent apart, which
       is not a distinction anyone reads. One faint step now serves both. */
    .dim { color: var(--ink-4); }
    h1 span { color: var(--ink-4); font-weight: normal; font-size: 15px; }
  </style>
  <h1>Rev <span>the machine, read-only · supervisor ${pidAlive('supervisor') ? `running (pid ${pidAlive('supervisor')})` : 'down'} · home ${esc(revHome())} · work lives in <a href="http://localhost:4400">Helm</a></span></h1>
  <p class="usage ${worstSeverity(readUsage())}">${esc(usageLine(readUsage(), 'Claude'))}</p>
  <p class="usage ${worstSeverity(readCodexUsage())}">${esc(usageLine(readCodexUsage(), 'Codex'))}</p>
  <div class="tablewrap"><table><tr><th>Loop</th><th>State</th><th>Workstream</th><th>Runtime</th><th>Pace</th><th>Spend</th><th>Recent trace</th></tr>
  ${rows || '<tr><td colspan="7">No loops in the roster yet.</td></tr>'}</table></div>`);
}).listen(port, host, () => console.log(`Rev view (read-only): http://localhost:${port} — home: ${revHome()}`));
