#!/usr/bin/env node
// Deliberately plain read-only dashboard: the machine at a glance.
// Helm shows the work; this shows the loops that do it.
import { createServer } from 'node:http';
import { AVATAR_MARKS, ESTATE_AVATARS } from './estate-avatars.generated.js';
import { ESTATE_TOKENS } from './estate-tokens.generated.js';
import { LOCAL_HOSTNAMES, REACH_SCRIPT, reachLink } from './reach.js';
import { readCodexUsage, readUsage, usageLine, worstSeverity } from './usage.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { revHome, loadRoster, stateDir, tokenLogPath } from './config.js';
import { pidAlive, sGet, sHas } from './sentinels.js';

const port = Number(process.env['REV_VIEW_PORT'] ?? 4500);
const host = process.env['REV_VIEW_HOST'] ?? '127.0.0.1';
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

// Poll the parts whose source state changes without reloading the document.
// A focused control belongs to the reader until they leave it, so polling
// pauses instead of replacing a link or scroll region beneath keyboard focus.
const VIEW_REFRESH_SCRIPT = `
let refreshRunning = false;
setInterval(async function () {
  if (refreshRunning || document.hidden || (document.activeElement && document.activeElement !== document.body)) return;
  refreshRunning = true;
  try {
    const response = await fetch(location.pathname, { cache: 'no-store' });
    if (!response.ok) return;
    const next = new DOMParser().parseFromString(await response.text(), 'text/html');
    for (const key of ['title', 'claude', 'codex', 'loops']) {
      const current = document.querySelector('[data-refresh="' + key + '"]');
      const replacement = next.querySelector('[data-refresh="' + key + '"]');
      if (!current || !replacement) continue;
      if (!${JSON.stringify(LOCAL_HOSTNAMES)}.includes(location.hostname))
        replacement.querySelectorAll('a[data-reach]').forEach(function (a) { a.setAttribute('href', a.getAttribute('data-reach')); });
      current.replaceWith(replacement);
    }
  } catch {}
  finally { refreshRunning = false; }
}, 10000);`;

// ---------- actors ----------

const MARKS = new Set<string>(AVATAR_MARKS);

/** Every row on this page is an agent, and that comes from the roster's own
 *  contract rather than from the look of a name: loadRoster refuses a loop
 *  with no `constitution` — the profile the process runs under — and the sole
 *  exception is an all-mock loop, which is a test fixture and not a member.
 *  Rev supervises agent loops; there is no field a human or an orchestrator
 *  could arrive in. If that ever changes, this constant is the one place a
 *  read has to replace it, and test/estate-avatars.test.ts pins both halves:
 *  the refusal it rests on, and the sprite composing this kind at all. */
const LOOP_KIND = 'agent';

/** A seat, drawn: the crew mark for its name in the agent frame, then the name.
 *
 *  THE NAME IS NOT OPTIONAL, and that is the point of having one function.
 *  A crew hue is a retrieval accelerator, never an identifier — the estate
 *  measured its own set and found ten members cannot have ten mutually
 *  distinguishable hues (H-713) — so a mark must never stand alone. Every mark
 *  on this page comes from here, which makes "the name is always beside it" a
 *  property of the code rather than a habit.
 *
 *  A loop the sprite has no mark for renders bare. A new seat is not a defect,
 *  and nothing here invents a mark from a name. */
function actor(name: string): string {
  const glyph = MARKS.has(name)
    ? `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><use href="#crew-${esc(name)}-${LOOP_KIND}"/></svg>`
    : '';
  return `<span class="actor">${glyph}${esc(name)}</span>`;
}

function state(name: string): string {
  const pid = pidAlive(name);
  if (sHas(name, 'STOP')) return 'STOP';
  if (sHas(name, 'HOLD')) return 'HOLD';
  if (sHas(name, 'BLOCKED')) return 'BLOCKED';
  if (sHas(name, 'WEDGED')) return 'WEDGED';
  if (!pid && sHas(name, 'BACKOFF')) return 'BACKOFF';
  if (pid && sHas(name, 'LIMIT')) return 'LIMIT';
  if (pid && sHas(name, 'PARKED')) return 'PARKED';
  if (pid && sHas(name, 'SEAT_HELD')) return 'SEAT_HELD';
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
        const reason = st === 'IDLE'
          ? sGet(l.name, 'IDLE')?.split('\n')[1]
          : st === 'SEAT_HELD' ? sGet(l.name, 'SEAT_HELD')?.split('\n')[0]
          : st === 'BLOCKED' || st === 'WEDGED' ? sGet(l.name, st)?.split('\n')[0] : undefined;
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
      const idle = st === 'IDLE' ? `<div class="idlereason">${esc(sGet(l.name, 'IDLE')?.split('\n')[1] ?? 'waiting on the wake cursor')}</div>` : '';
      const seatHeld = st === 'SEAT_HELD' ? `<div class="idlereason">${esc(sGet(l.name, 'SEAT_HELD')?.split('\n')[0] ?? 'another live session holds this seat')}</div>` : '';
      const events = lastEvents(l.name, 5)
        .map((e) => `<div class="ev">${esc(e)}</div>`)
        .join('');
      return `<tr>
        <td class="name">${actor(l.name)}</td>
        <td class="st st-${st}">${st}${blocked}${wedged}${idle}${seatHeld}</td>
        <td>${esc(l.workstream)}</td>
        <td>${esc(l.runtime)}/${esc(l.model)}</td>
        <td>${esc(sGet(l.name, 'PACE')?.trim() ?? '1')}</td>
        <td>${sp.tokens ? `${(sp.tokens / 1000).toFixed(1)}k` : '—'}${sp.cost ? ` $${sp.cost.toFixed(2)}` : ''}</td>
        <td class="trace">${events || '<span class="dim">no trace yet</span>'}</td>
      </tr>`;
    })
    .join('\n');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rev</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
      /* Rev runs one mixed middle step between the estate's foreground and
         muted text, so a look change carries the whole readable ladder. */
      --ink-2: color-mix(in oklab, var(--foreground) 72%, var(--background));
      --ink-3: var(--muted-foreground);
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
    /* ---- actors (R-11 H-713): the mark says who, the frame says what kind ---- */
    /* nowrap is load-bearing, not tidiness: the rule the avatar set ships under
       is that a crew hue never identifies a member on its own, and a mark that
       wrapped away from its name would be doing exactly that. The Loop column
       is the narrowest on the page and the first to wrap on a phone. */
    .actor { white-space: nowrap; }
    /* No colour here — the mark carries its member hue from the sprite and the
       frame is currentColor, so a seat is whatever ink its row gives it. */
    .mark { width: 1.15em; height: 1.15em; vertical-align: -0.22em; margin-right: 4px; }
    .st { font-weight: 600; }
    .st-RUNNING { color: var(--good-text); } .st-IDLE, .st-SEAT_HELD { color: var(--ink-3); } .st-BLOCKED, .st-CRASHED, .st-WEDGED { color: var(--critical); }
    .st-LIMIT, .st-PARKED, .st-BACKOFF { color: var(--warn-text); } .st-STOP, .st-HOLD { color: var(--ink-3); }
    .st-halted { color: var(--ink-3); }
    .trace { font-family: ui-monospace, monospace; font-size: 11px; color: var(--ink-2); }
    .usage { font-family: ui-monospace, monospace; font-size: 12px; color: var(--ink-2); margin: 0 0 12px; }
    .usage.warning { color: var(--warn-text); } .usage.critical { color: var(--critical); font-weight: 600; }
    .blockreason { font-weight: 400; font-size: 12px; color: var(--critical); }
    .idlereason { font-weight: 400; font-size: 12px; color: var(--ink-3); }
    /* Quiet copy still has to read in both themes; --ink-3 is the last
       approved text step in the estate ladder. */
    .dim { color: var(--ink-3); }
    h1 .title-line { min-width: 0; overflow-wrap: anywhere; color: var(--ink-3); font-weight: normal; font-size: 15px; }
  </style></head><body>
  ${ESTATE_AVATARS}
  <h1 data-refresh="title">Rev <span class="title-line">the machine, read-only · supervisor ${pidAlive('supervisor') ? `running (pid ${pidAlive('supervisor')})` : 'down'} · home ${esc(revHome())} · work lives in ${reachLink('helmo-view', 'Helm')}</span></h1>
  <p class="usage ${worstSeverity(readUsage())}" data-refresh="claude">${esc(usageLine(readUsage(), 'Claude'))}</p>
  <p class="usage ${worstSeverity(readCodexUsage())}" data-refresh="codex">${esc(usageLine(readCodexUsage(), 'Codex'))}</p>
  <div class="tablewrap" tabindex="0" role="region" aria-label="Loop status" data-refresh="loops"><table><tr><th>Loop</th><th>State</th><th>Workstream</th><th>Runtime</th><th>Pace</th><th>Spend</th><th>Recent trace</th></tr>
  ${rows || '<tr><td colspan="7">No loops in the roster yet.</td></tr>'}</table></div>
  <!-- Both scripts run after the content they act on. The first rewrites
       cross-surface links for remote readers; the second refreshes live state
       without reloading the document or taking keyboard focus. -->
  <script>${REACH_SCRIPT}</script>
  <script>${VIEW_REFRESH_SCRIPT}</script>
  </body></html>`);
}).listen(port, host, () => console.log(`Rev view (read-only): http://localhost:${port} — home: ${revHome()}`));
