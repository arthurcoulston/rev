// The vendored estate reach table (R-11 H-832). Same seam as
// test/estate-tokens.test.ts and test/estate-avatars.test.ts, and the same one
// skip: a clone with no crew checkout beside it has no source to compare
// against, so the verbatim test uses `it.skipIf` and is counted as skipped
// rather than passing quietly.
//
// Everything guarded here fails SILENTLY. A cross-surface href that points at
// localhost from a phone is not an error — the page renders, the link is blue,
// and tapping it lands on nothing. That defect survived two phases of R-11 on
// a machine where it worked perfectly, so the checks below aim at the shapes
// that look fine on this Mac: a link shipped with only one of its two
// addresses, a script placed where it cannot reach the links it rewrites, and
// a table that no longer holds the surface the view names.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { SOURCE, VENDORED, render, table } from '../scripts/vendor-estate-reach.mjs';
import { ESTATE_REACH } from '../src/estate-reach.generated.js';
import { LOCAL_HOSTNAMES, REACH_SCRIPT, reachLink } from '../src/reach.js';

const view = readFileSync(new URL('../src/view.ts', import.meta.url), 'utf8');

/** The surfaces the view actually links to, read out of the view rather than
 *  restated here — a link added to another surface is covered the day it is
 *  written, and one removed stops being checked. */
const linked = [...view.matchAll(/reachLink\('([^']+)'/g)].map((m) => m[1]);

/** Runs the page's script the way a browser would, against a stubbed origin
 *  and a stubbed anchor. `new Function` shadows `location` and `document` with
 *  the parameters, so the script under test is the exact string that ships. */
function runScript(hostname: string, anchors: { href: string; reach: string }[]) {
  const els = anchors.map((a) => ({
    href: a.href,
    getAttribute(name: string) {
      return name === 'data-reach' ? a.reach : this.href;
    },
    setAttribute(name: string, value: string) {
      if (name === 'href') this.href = value;
    },
  }));
  const document = { querySelectorAll: (sel: string) => (sel === 'a[data-reach]' ? els : []) };
  new Function('location', 'document', REACH_SCRIPT)({ hostname }, document);
  return els.map((e) => e.href);
}

describe('vendored estate reach table', () => {
  const haveSource = existsSync(SOURCE);

  it.skipIf(!haveSource)('is the estate registry rendered by the vendor script', () => {
    expect(readFileSync(VENDORED, 'utf8')).toBe(render(readFileSync(SOURCE, 'utf8')));
  });

  it('holds every surface the view links to', () => {
    // The view names a surface by id and the id comes from a file another repo
    // owns. A rename there would leave a link that throws on the next request;
    // this is what makes it a CI failure instead. Reads the vendored copy —
    // what ships is what matters.
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.filter((id) => !ESTATE_REACH[id])).toEqual([]);
  });

  it('ships both addresses on the link, never one', () => {
    // The href is the desk address and `data-reach` is the composed one. A
    // link carrying only the first is today's defect; only the second would
    // break the desk, where the shell is deliberately out of the middle.
    const html = reachLink('helmo-view', 'Helm');
    expect(html).toContain(`href="${ESTATE_REACH['helmo-view']!.url}"`);
    expect(html).toContain(`data-reach="${ESTATE_REACH['helmo-view']!.path}"`);
  });

  it('refuses a surface the table does not hold', () => {
    expect(() => reachLink('no-such-view', 'x')).toThrow(/no estate surface/);
  });

  it('swaps the href for a reader who is not on this Mac', () => {
    expect(runScript('estate.example.invalid', [{ href: 'http://localhost:4400/', reach: '/s/helmo-view/' }])).toEqual([
      '/s/helmo-view/',
    ]);
    expect(runScript('192.168.1.20', [{ href: 'http://localhost:4400/', reach: '/s/helmo-view/' }])).toEqual([
      '/s/helmo-view/',
    ]);
  });

  it('leaves the desk alone', () => {
    // At the desk the products stay standalone on their own ports, with the
    // shell out of the middle — the purity R-11 composes rather than replaces.
    for (const host of LOCAL_HOSTNAMES)
      expect(runScript(host, [{ href: 'http://localhost:4400/', reach: '/s/helmo-view/' }])).toEqual([
        'http://localhost:4400/',
      ]);
  });

  it('puts the script after the links it rewrites', () => {
    // A script above the anchors finds none and rewrites nothing — no error,
    // no warning, and a page that looks exactly like a working one.
    const script = view.indexOf('<script>${REACH_SCRIPT}</script>');
    expect(script).toBeGreaterThan(-1);
    for (const m of view.matchAll(/\$\{reachLink\(/g)) expect(m.index).toBeLessThan(script);
  });

  it('carries nothing that would close its own script tag', () => {
    expect(REACH_SCRIPT).not.toMatch(/<\/script/i);
  });

  it('refuses a registry with no reach prefix', () => {
    // Without the prefix every path would have to be guessed, and a guessed
    // path is a link that resolves to the shell's own document.
    const services = [{ id: 'a-view', nav: 'A', url: 'http://localhost:4400/' }];
    expect(() => table({ services })).toThrow(/reach. prefix/);
    expect(() => table({ reach: 's/', services })).toThrow(/reach. prefix/);
    expect(table({ reach: '/s/', services })['a-view']).toEqual({
      url: 'http://localhost:4400/',
      path: '/s/a-view/',
    });
  });

  it('takes a surface at its own reach when it states one', () => {
    // The shell states `/`: it is the origin the others are reached through.
    const reg = {
      reach: '/s/',
      services: [{ id: 'estate-shell', nav: 'Estate', url: 'http://localhost:4300/', reach: '/' }],
    };
    expect(table(reg)['estate-shell']!.path).toBe('/');
  });

  it('refuses a registry with nothing navigable', () => {
    expect(() => table({ reach: '/s/', services: [{ id: 'x', url: 'http://localhost:1/' }] })).toThrow(
      /no navigable surface/,
    );
  });
});
