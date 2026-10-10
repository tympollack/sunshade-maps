/**
 * Tech-Blueprint design tokens for maps.sunshade.icu.
 * Mirrored as CSS custom properties in `src/app/globals.css` (Tailwind `@theme`).
 * Kept in TS for WebGL/MapLibre paint properties, which cannot read CSS vars.
 */
export const BLUEPRINT = {
  navy: "#0B132B",
  navyDeep: "#070D1F",
  navyRaised: "#13204A",
  cornflower: "#4A90E2",
  cyan: "#00E5FF",
  ink: "#DCE8FA",
  inkMuted: "#7F95B8",
} as const;

export type BlueprintColor = keyof typeof BLUEPRINT;
