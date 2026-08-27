#!/usr/bin/env node
// Deliberately plain read-only dashboard: the machine at a glance.
// Helm shows the work; this shows the loops that do it.
import { createServer } from 'node:http';
import { readUsage, usageLine, worstSeverity } from './usage.js';
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

createServer((_req, res) => {
  const { loops } = loadRoster();
  const rows = Object.values(loops)
    .map((l) => {
      const st = state(l.name);
      const sp = spend(l.name);
      const blocked = st === 'BLOCKED' ? `<div class="blockreason">${esc(sGet(l.name, 'BLOCKED')?.split('\n')[0])} — see the Helm awaiting-you queue</div>` : '';
      const events = lastEvents(l.name, 5)
        .map((e) => `<div class="ev">${esc(e)}</div>`)
        .join('');
      return `<tr>
        <td class="name">${esc(l.name)}</td>
        <td class="st st-${st}">${st}${blocked}</td>
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
  <meta http-equiv="refresh" content="10">
  <style>
    body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; max-width: 1250px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #ddd; vertical-align: top; }
    th { font-size: 12px; text-transform: uppercase; color: #666; }
    .name { font-family: ui-monospace, monospace; }
    .st { font-weight: 600; }
    .st-RUNNING { color: #167c2e; } .st-IDLE { color: #666; } .st-BLOCKED, .st-CRASHED { color: #b00; }
    .st-LIMIT, .st-PARKED, .st-BACKOFF { color: #b60; } .st-STOP, .st-HOLD, .st-halted { color: #999; }
    .trace { font-family: ui-monospace, monospace; font-size: 11px; color: #555; }
    .usage { font-family: ui-monospace, monospace; font-size: 12px; color: #555; margin: 0 0 12px; }
    .usage.warning { color: #a60; } .usage.critical { color: #b00; font-weight: 600; }
    .blockreason { font-weight: 400; font-size: 12px; color: #b00; }
    .dim { color: #bbb; }
    h1 span { color: #999; font-weight: normal; font-size: 15px; }
  </style>
  <h1>Rev <span>the machine, read-only · supervisor ${pidAlive('supervisor') ? `running (pid ${pidAlive('supervisor')})` : 'down'} · home ${esc(revHome())} · work lives in <a href="http://localhost:4400">Helm</a></span></h1>
  <p class="usage ${worstSeverity(readUsage())}">${esc(usageLine(readUsage()))}</p>
  <table><tr><th>Loop</th><th>State</th><th>Workstream</th><th>Runtime</th><th>Pace</th><th>Spend</th><th>Recent trace</th></tr>
  ${rows || '<tr><td colspan="7">No loops in the roster yet.</td></tr>'}</table>`);
}).listen(port, host, () => console.log(`Rev view (read-only): http://localhost:${port} — home: ${revHome()}`));
