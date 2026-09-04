// VENDORED — do not edit. Source: the crew repo, tools/estate/services.json
// Refresh: node scripts/vendor-estate-reach.mjs
// Drift is a test failure: npm test (skipped, loudly, with no crew checkout)
//
// Where each estate surface is reached: `url` is the product on its own
// port, right at the desk and dead from anywhere else; `path` is the
// same-origin path the estate shell composes it at (R-11). Which one a
// link should use is a property of the reader’s origin, so it is asked
// in the browser — see src/reach.ts.

export const ESTATE_REACH: Record<string, { url: string; path: string }> = {
  "estate-shell": { url: "http://localhost:4300/", path: "/" },
  "helmo-view": { url: "http://localhost:4400/", path: "/s/helmo-view/" },
  "roadmap-view": { url: "http://localhost:4410/", path: "/s/roadmap-view/" },
  "rev-view": { url: "http://localhost:4500/", path: "/s/rev-view/" },
};
