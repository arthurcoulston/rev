// VENDORED — do not edit. Source: the estate repo, tokens/estate-tokens.css
// Refresh: node scripts/vendor-estate-tokens.mjs
// Drift is a test failure: npm test (skipped, loudly, with no estate checkout)
//
// The estate shell is the source of the visual system every estate surface
// shares (R-11); rev consumes it as a copy so it stays publishable alone.

export const ESTATE_TOKENS = `
/* GENERATED — do not edit. Source: src/index.css (shadcn radix-nova, neutral) + MARK_HUE and STATUS in tools/generate.mjs
   Regenerate: npm run generate
   Drift is a build failure: npm run check */


:root, .light {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --chart-1: oklch(0.87 0 0);
  --chart-2: oklch(0.556 0 0);
  --chart-3: oklch(0.439 0 0);
  --chart-4: oklch(0.371 0 0);
  --chart-5: oklch(0.269 0 0);
  --radius: 0.625rem;
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-primary: oklch(0.205 0 0);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.97 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.708 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
  --chart-1: oklch(0.87 0 0);
  --chart-2: oklch(0.556 0 0);
  --chart-3: oklch(0.439 0 0);
  --chart-4: oklch(0.371 0 0);
  --chart-5: oklch(0.269 0 0);
  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.269 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.556 0 0);
}

@media (prefers-color-scheme: dark) {
  :root:not(.light) {
    --background: oklch(0.145 0 0);
    --foreground: oklch(0.985 0 0);
    --card: oklch(0.205 0 0);
    --card-foreground: oklch(0.985 0 0);
    --popover: oklch(0.205 0 0);
    --popover-foreground: oklch(0.985 0 0);
    --primary: oklch(0.922 0 0);
    --primary-foreground: oklch(0.205 0 0);
    --secondary: oklch(0.269 0 0);
    --secondary-foreground: oklch(0.985 0 0);
    --muted: oklch(0.269 0 0);
    --muted-foreground: oklch(0.708 0 0);
    --accent: oklch(0.269 0 0);
    --accent-foreground: oklch(0.985 0 0);
    --destructive: oklch(0.704 0.191 22.216);
    --border: oklch(1 0 0 / 10%);
    --input: oklch(1 0 0 / 15%);
    --ring: oklch(0.556 0 0);
    --chart-1: oklch(0.87 0 0);
    --chart-2: oklch(0.556 0 0);
    --chart-3: oklch(0.439 0 0);
    --chart-4: oklch(0.371 0 0);
    --chart-5: oklch(0.269 0 0);
    --sidebar: oklch(0.205 0 0);
    --sidebar-foreground: oklch(0.985 0 0);
    --sidebar-primary: oklch(0.488 0.243 264.376);
    --sidebar-primary-foreground: oklch(0.985 0 0);
    --sidebar-accent: oklch(0.269 0 0);
    --sidebar-accent-foreground: oklch(0.985 0 0);
    --sidebar-border: oklch(1 0 0 / 10%);
    --sidebar-ring: oklch(0.556 0 0);
  }
}

/* Crew marks, one hue per member (H-713). Applied to the mark only —
   the frame keeps the context colour, so shape says kind and colour says who.
   Values are Tailwind v4 ramp steps; percent-form L is theirs, kept verbatim
   so the provenance check in tools/palette.test.mjs is a string compare. */
:root, .light {
  --crew-bosun: oklch(64.8% 0.2 131.684); /* lime */
  --crew-gauge: oklch(59.2% 0.249 0.584); /* pink */
  --crew-herald: oklch(55.3% 0.195 38.402); /* orange */
  --crew-kron: oklch(60% 0.118 184.704); /* teal */
  --crew-mason: oklch(50.8% 0.118 165.612); /* emerald */
  --crew-moxie: oklch(59.1% 0.293 322.896); /* fuchsia */
  --crew-page: oklch(50% 0.134 242.749); /* sky */
  --crew-proof: oklch(45.7% 0.24 277.023); /* indigo */
  --crew-rolo: oklch(60.9% 0.126 221.723); /* cyan */
  --crew-ward: oklch(62.3% 0.214 259.815); /* blue */
}

.dark {
  --crew-bosun: oklch(64.8% 0.2 131.684); /* lime */
  --crew-gauge: oklch(59.2% 0.249 0.584); /* pink */
  --crew-herald: oklch(55.3% 0.195 38.402); /* orange */
  --crew-kron: oklch(60% 0.118 184.704); /* teal */
  --crew-mason: oklch(50.8% 0.118 165.612); /* emerald */
  --crew-moxie: oklch(59.1% 0.293 322.896); /* fuchsia */
  --crew-page: oklch(50% 0.134 242.749); /* sky */
  --crew-proof: oklch(67.3% 0.182 276.935); /* indigo */
  --crew-rolo: oklch(60.9% 0.126 221.723); /* cyan */
  --crew-ward: oklch(54.6% 0.245 262.881); /* blue */
}

@media (prefers-color-scheme: dark) {
  :root:not(.light) {
    --crew-bosun: oklch(64.8% 0.2 131.684); /* lime */
    --crew-gauge: oklch(59.2% 0.249 0.584); /* pink */
    --crew-herald: oklch(55.3% 0.195 38.402); /* orange */
    --crew-kron: oklch(60% 0.118 184.704); /* teal */
    --crew-mason: oklch(50.8% 0.118 165.612); /* emerald */
    --crew-moxie: oklch(59.1% 0.293 322.896); /* fuchsia */
    --crew-page: oklch(50% 0.134 242.749); /* sky */
    --crew-proof: oklch(67.3% 0.182 276.935); /* indigo */
    --crew-rolo: oklch(60.9% 0.126 221.723); /* cyan */
    --crew-ward: oklch(54.6% 0.245 262.881); /* blue */
  }
}

/* Status ramp and interactive colour (H-771). Base hues are the dataviz
   reference palette; the -ink and -wash steps are the estate's own, derived
   for text use and measured in tools/status.test.mjs. Named --interactive and
   --status-* rather than --link and the views' own names, so that an alias
   seam can never come out as --link: var(--link), which CSS drops silently.
   Colour never identifies alone — always beside a text label (H-713). */
:root, .light {
  --status-good: #006300;
  --status-good-ink: #006300;
  --status-good-wash: rgba(12,163,12,0.12);
  --status-warn: #a60;
  --status-warn-ink: #8a5c00;
  --status-warn-wash: rgba(250,178,25,0.16);
  --status-serious: #ac491f;
  --status-serious-ink: #ac491f;
  --status-serious-wash: rgba(236,131,90,0.14);
  --status-bad: #d03b3b;
  --status-bad-ink: #a51f1f;
  --status-bad-wash: rgba(208,59,59,0.12);
  --interactive: #256abf;
  --interactive-foreground: #ffffff;
}

.dark {
  --status-good: #0ca30c;
  --status-good-ink: #0ca30c;
  --status-good-wash: rgba(12,163,12,0.14);
  --status-warn: #fab219;
  --status-warn-ink: #fab219;
  --status-warn-wash: rgba(250,178,25,0.14);
  --status-serious: #ec835a;
  --status-serious-ink: #ec835a;
  --status-serious-wash: rgba(236,131,90,0.14);
  --status-bad: #ef6f6c;
  --status-bad-ink: #ef6f6c;
  --status-bad-wash: rgba(208,59,59,0.16);
  --interactive: #3987e5;
  --interactive-foreground: oklch(0.145 0 0);
}

@media (prefers-color-scheme: dark) {
  :root:not(.light) {
    --status-good: #0ca30c;
    --status-good-ink: #0ca30c;
    --status-good-wash: rgba(12,163,12,0.14);
    --status-warn: #fab219;
    --status-warn-ink: #fab219;
    --status-warn-wash: rgba(250,178,25,0.14);
    --status-serious: #ec835a;
    --status-serious-ink: #ec835a;
    --status-serious-wash: rgba(236,131,90,0.14);
    --status-bad: #ef6f6c;
    --status-bad-ink: #ef6f6c;
    --status-bad-wash: rgba(208,59,59,0.16);
    --interactive: #3987e5;
    --interactive-foreground: oklch(0.145 0 0);
  }
}
`;
