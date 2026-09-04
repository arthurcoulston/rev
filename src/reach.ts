/* Where a cross-surface link points, decided by the reader's origin (H-832).

   Rev's one link out of this page — "work lives in Helm" — was
   `http://localhost:4400`, which is right at the desk and dead everywhere
   else. It matters now because the estate shell composes this view at
   `/s/rev-view/` on its own origin, so the page is read from a phone, and a
   localhost href there goes nowhere.

   The addresses come from the estate registry, vendored
   (src/estate-reach.generated.ts): a surface has two, and rev hand-keeps
   neither. WHICH of the two is right is not a property of the surface, it is a
   property of the origin the reader is on — so it cannot be baked into the
   markup this server renders. Nor can it be read from the request: the shell's
   proxy fetches this page itself, so the Host header rev sees is always its
   own port, whoever is really looking. The browser is the only place that
   knows, which is why this page gains its first script.

   Same rule as estate/src/lib/reach.ts and crew/tools/estate/registry.mjs's
   `reachFrom`; three implementations because three runtimes, one registry
   deciding the addresses.

   With scripting off the href stays the localhost address — the behaviour of
   every rev build before this one. */

import { ESTATE_REACH } from './estate-reach.generated.js';

/** Hostnames that mean "this machine", where the product's own port is right.
    `[::1]` is how a browser spells the IPv6 literal in location.hostname. */
export const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]', '::1'];

/* Rewrites in place rather than choosing at render, so the served HTML is the
   same bytes for every reader and stays cacheable and inspectable. It runs
   once per load; this page reloads itself on a meta refresh, so there is
   nothing to re-run on. `data-reach` names the elements rather than a class:
   the attribute IS the second address, so an anchor without one is not a
   cross-surface link and is left alone. */
export const REACH_SCRIPT = `if (!${JSON.stringify(LOCAL_HOSTNAMES)}.includes(location.hostname))
  document.querySelectorAll("a[data-reach]").forEach(function (a) { a.setAttribute("href", a.getAttribute("data-reach")); });`;

/** An anchor to another estate surface, carrying both of its addresses.
 *
 *  Unknown ids throw rather than rendering a link to nothing: the failure this
 *  whole file exists to end is a href that looks fine and goes nowhere, and a
 *  surface renamed in the registry must not come back as another one of those.
 *  test/estate-reach.test.ts fires the same check over the ids this view uses,
 *  so a rename goes red in CI rather than on Arthur's phone. */
export function reachLink(id: string, label: string): string {
  const target = ESTATE_REACH[id];
  if (!target)
    throw new Error(
      `no estate surface "${id}" in the vendored reach table — it was renamed or dropped from ` +
        `the registry; run node scripts/vendor-estate-reach.mjs and fix the link`,
    );
  return `<a href="${target.url}" data-reach="${target.path}">${label}</a>`;
}
