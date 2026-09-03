// VENDORED — do not edit. Source: the estate repo, avatars/crew-avatars.svg
// Refresh: node scripts/vendor-estate-avatars.mjs
// Drift is a test failure: npm test (skipped, loudly, with no estate checkout)
//
// The estate shell is the source of the visual system every estate surface
// shares (R-11); rev consumes it as a copy so it stays publishable alone.
// Hues come from the vendored token file — a mark is currentColor
// over var(--crew-<name>), so nothing here carries a colour of its own.

export const ESTATE_AVATARS = `
<!-- GENERATED — do not edit. Source: avatars/{mark,frame}-*.svg
     Regenerate: npm run generate
     Drift is a build failure: npm run check -->
<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
  <symbol id="crew-frame-agent" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M5.5 1h13A4.5 4.5 0 0 1 23 5.5v13a4.5 4.5 0 0 1-4.5 4.5h-13A4.5 4.5 0 0 1 1 18.5v-13A4.5 4.5 0 0 1 5.5 1Z" opacity=".18"/>
  </symbol>
  <symbol id="crew-frame-human" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M12 1a11 11 0 1 1 0 22 11 11 0 0 1 0-22Z" opacity=".18"/>
  </symbol>
  <symbol id="crew-bosun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8.5 11.75h7l1.75 8.5H6.75Z" fill="currentColor" opacity=".35" stroke="none"/>
    <path d="M8.5 11.75h7l1.75 8.5H6.75Z"/>
    <path d="M8.25 9.25h7.5v2.5H8.25Z"/>
    <path d="M12 3v6.25"/>
  </symbol>
  <symbol id="crew-gauge" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3.25 17.5a8.75 8.75 0 0 1 17.5 0Z" fill="currentColor" opacity=".35" stroke="none"/>
    <path d="M3.25 17.5a8.75 8.75 0 0 1 17.5 0Z"/>
    <path d="M12 17.5 16 10.5"/>
  </symbol>
  <symbol id="crew-herald" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4.75 20.25C4 11.75 9.75 5.25 19.5 4.75l.5 6.25c-6.25.5-10 4.75-9.5 9.25Z" fill="currentColor" opacity=".35" stroke="none"/>
    <path d="M4.75 20.25C4 11.75 9.75 5.25 19.5 4.75l.5 6.25c-6.25.5-10 4.75-9.5 9.25Z"/>
  </symbol>
  <symbol id="crew-kron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3.25a8.75 8.75 0 1 1 0 17.5 8.75 8.75 0 0 1 0-17.5Z" fill="currentColor" opacity=".35" stroke="none"/>
    <path d="M12 3.25a8.75 8.75 0 1 1 0 17.5 8.75 8.75 0 0 1 0-17.5Z"/>
    <path d="M12 7.25V12l3.5 2.25"/>
  </symbol>
  <symbol id="crew-mason" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3.25 20.75 9.75 8.25 16.25 14.75Z" fill="currentColor" opacity=".35" stroke="none"/>
    <path d="M3.25 20.75 9.75 8.25 16.25 14.75Z"/>
    <path d="m14.5 10.75 3.25-3.25"/>
    <path d="M16.25 4.75 20.5 9"/>
  </symbol>
  <symbol id="crew-moxie" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M7.75 4.25h8.5v6.5L12 20.5 7.75 10.75Z" fill="currentColor" opacity=".35" stroke="none"/>
    <path d="M7.75 4.25h8.5v6.5L12 20.5 7.75 10.75Z"/>
    <path d="M7.75 8.25h8.5"/>
    <path d="M12 12.5v4.75"/>
  </symbol>
  <symbol id="crew-page" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4.75 5.5h14.5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4.75a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z" fill="currentColor" opacity=".35" stroke="none"/>
    <path d="M4.75 5.5h14.5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4.75a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z"/>
    <path d="m3.25 7 8.75 5.75L20.75 7"/>
  </symbol>
  <symbol id="crew-person" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" fill="currentColor" opacity=".35" stroke="none"/>
    <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0Z" fill="currentColor" opacity=".35" stroke="none"/>
    <path d="M12 3.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/>
    <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>
  </symbol>
  <symbol id="crew-proof" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10.75 7h2.5v6.25h5.5v4H5.25v-4h5.5Z" fill="currentColor" opacity=".35" stroke="none"/>
    <path d="M10.75 7h2.5v6.25h5.5v4H5.25v-4h5.5Z"/>
    <path d="M10 3.25h4a1.5 1.5 0 0 1 1.5 1.5v.75a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 8.5 5.5v-.75A1.5 1.5 0 0 1 10 3.25Z"/>
    <path d="M4 20.75h16"/>
  </symbol>
  <symbol id="crew-rolo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3.5 8.5h13.75a1.75 1.75 0 0 1 1.75 1.75v8.5a1.75 1.75 0 0 1-1.75 1.75H3.5a1.75 1.75 0 0 1-1.75-1.75v-8.5A1.75 1.75 0 0 1 3.5 8.5Z" fill="currentColor" opacity=".35" stroke="none"/>
    <path d="M3.5 8.5h13.75a1.75 1.75 0 0 1 1.75 1.75v8.5a1.75 1.75 0 0 1-1.75 1.75H3.5a1.75 1.75 0 0 1-1.75-1.75v-8.5A1.75 1.75 0 0 1 3.5 8.5Z"/>
    <path d="M5.5 5.75h13a1.75 1.75 0 0 1 1.75 1.75v9.25"/>
    <path d="M5 12.75h9M5 16.25h5.5"/>
  </symbol>
  <symbol id="crew-ward" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 2.5 20 5.75v6.1c0 4.6-3.3 8.7-8 9.9-4.7-1.2-8-5.3-8-9.9V5.75Z" fill="currentColor" opacity=".35" stroke="none"/>
    <path d="M12 2.5 20 5.75v6.1c0 4.6-3.3 8.7-8 9.9-4.7-1.2-8-5.3-8-9.9V5.75Z"/>
    <path d="m8.75 12 2.25 2.25 4.25-4.5"/>
  </symbol>
  <symbol id="crew-bosun-agent" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-bosun" x="4" y="4" width="16" height="16" color="var(--crew-bosun, currentColor)"/>
  </symbol>
  <symbol id="crew-bosun-orchestrator" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-bosun" x="4" y="4" width="16" height="16" color="var(--crew-bosun, currentColor)"/>
  </symbol>
  <symbol id="crew-bosun-human" viewBox="0 0 24 24">
    <use href="#crew-frame-human" width="24" height="24"/>
    <use href="#crew-bosun" x="4" y="4" width="16" height="16" color="var(--crew-bosun, currentColor)"/>
  </symbol>
  <symbol id="crew-gauge-agent" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-gauge" x="4" y="4" width="16" height="16" color="var(--crew-gauge, currentColor)"/>
  </symbol>
  <symbol id="crew-gauge-orchestrator" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-gauge" x="4" y="4" width="16" height="16" color="var(--crew-gauge, currentColor)"/>
  </symbol>
  <symbol id="crew-gauge-human" viewBox="0 0 24 24">
    <use href="#crew-frame-human" width="24" height="24"/>
    <use href="#crew-gauge" x="4" y="4" width="16" height="16" color="var(--crew-gauge, currentColor)"/>
  </symbol>
  <symbol id="crew-herald-agent" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-herald" x="4" y="4" width="16" height="16" color="var(--crew-herald, currentColor)"/>
  </symbol>
  <symbol id="crew-herald-orchestrator" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-herald" x="4" y="4" width="16" height="16" color="var(--crew-herald, currentColor)"/>
  </symbol>
  <symbol id="crew-herald-human" viewBox="0 0 24 24">
    <use href="#crew-frame-human" width="24" height="24"/>
    <use href="#crew-herald" x="4" y="4" width="16" height="16" color="var(--crew-herald, currentColor)"/>
  </symbol>
  <symbol id="crew-kron-agent" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-kron" x="4" y="4" width="16" height="16" color="var(--crew-kron, currentColor)"/>
  </symbol>
  <symbol id="crew-kron-orchestrator" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-kron" x="4" y="4" width="16" height="16" color="var(--crew-kron, currentColor)"/>
  </symbol>
  <symbol id="crew-kron-human" viewBox="0 0 24 24">
    <use href="#crew-frame-human" width="24" height="24"/>
    <use href="#crew-kron" x="4" y="4" width="16" height="16" color="var(--crew-kron, currentColor)"/>
  </symbol>
  <symbol id="crew-mason-agent" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-mason" x="4" y="4" width="16" height="16" color="var(--crew-mason, currentColor)"/>
  </symbol>
  <symbol id="crew-mason-orchestrator" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-mason" x="4" y="4" width="16" height="16" color="var(--crew-mason, currentColor)"/>
  </symbol>
  <symbol id="crew-mason-human" viewBox="0 0 24 24">
    <use href="#crew-frame-human" width="24" height="24"/>
    <use href="#crew-mason" x="4" y="4" width="16" height="16" color="var(--crew-mason, currentColor)"/>
  </symbol>
  <symbol id="crew-moxie-agent" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-moxie" x="4" y="4" width="16" height="16" color="var(--crew-moxie, currentColor)"/>
  </symbol>
  <symbol id="crew-moxie-orchestrator" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-moxie" x="4" y="4" width="16" height="16" color="var(--crew-moxie, currentColor)"/>
  </symbol>
  <symbol id="crew-moxie-human" viewBox="0 0 24 24">
    <use href="#crew-frame-human" width="24" height="24"/>
    <use href="#crew-moxie" x="4" y="4" width="16" height="16" color="var(--crew-moxie, currentColor)"/>
  </symbol>
  <symbol id="crew-page-agent" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-page" x="4" y="4" width="16" height="16" color="var(--crew-page, currentColor)"/>
  </symbol>
  <symbol id="crew-page-orchestrator" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-page" x="4" y="4" width="16" height="16" color="var(--crew-page, currentColor)"/>
  </symbol>
  <symbol id="crew-page-human" viewBox="0 0 24 24">
    <use href="#crew-frame-human" width="24" height="24"/>
    <use href="#crew-page" x="4" y="4" width="16" height="16" color="var(--crew-page, currentColor)"/>
  </symbol>
  <symbol id="crew-person-agent" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-person" x="4" y="4" width="16" height="16"/>
  </symbol>
  <symbol id="crew-person-orchestrator" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-person" x="4" y="4" width="16" height="16"/>
  </symbol>
  <symbol id="crew-person-human" viewBox="0 0 24 24">
    <use href="#crew-frame-human" width="24" height="24"/>
    <use href="#crew-person" x="4" y="4" width="16" height="16"/>
  </symbol>
  <symbol id="crew-proof-agent" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-proof" x="4" y="4" width="16" height="16" color="var(--crew-proof, currentColor)"/>
  </symbol>
  <symbol id="crew-proof-orchestrator" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-proof" x="4" y="4" width="16" height="16" color="var(--crew-proof, currentColor)"/>
  </symbol>
  <symbol id="crew-proof-human" viewBox="0 0 24 24">
    <use href="#crew-frame-human" width="24" height="24"/>
    <use href="#crew-proof" x="4" y="4" width="16" height="16" color="var(--crew-proof, currentColor)"/>
  </symbol>
  <symbol id="crew-rolo-agent" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-rolo" x="4" y="4" width="16" height="16" color="var(--crew-rolo, currentColor)"/>
  </symbol>
  <symbol id="crew-rolo-orchestrator" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-rolo" x="4" y="4" width="16" height="16" color="var(--crew-rolo, currentColor)"/>
  </symbol>
  <symbol id="crew-rolo-human" viewBox="0 0 24 24">
    <use href="#crew-frame-human" width="24" height="24"/>
    <use href="#crew-rolo" x="4" y="4" width="16" height="16" color="var(--crew-rolo, currentColor)"/>
  </symbol>
  <symbol id="crew-ward-agent" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-ward" x="4" y="4" width="16" height="16" color="var(--crew-ward, currentColor)"/>
  </symbol>
  <symbol id="crew-ward-orchestrator" viewBox="0 0 24 24">
    <use href="#crew-frame-agent" width="24" height="24"/>
    <use href="#crew-ward" x="4" y="4" width="16" height="16" color="var(--crew-ward, currentColor)"/>
  </symbol>
  <symbol id="crew-ward-human" viewBox="0 0 24 24">
    <use href="#crew-frame-human" width="24" height="24"/>
    <use href="#crew-ward" x="4" y="4" width="16" height="16" color="var(--crew-ward, currentColor)"/>
  </symbol>
</svg>
`;

/** Marks the sprite carries. Read out of the sprite, never hand-listed. */
export const AVATAR_MARKS = ["bosun", "gauge", "herald", "kron", "mason", "moxie", "page", "person", "proof", "rolo", "ward"] as const;

/** Actor kinds the sprite composes a symbol for. */
export const AVATAR_KINDS = ["agent", "human", "orchestrator"] as const;
