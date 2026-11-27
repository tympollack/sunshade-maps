import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const distDir = dirname(require.resolve("maplibre-gl/dist/maplibre-gl.mjs"));
const outDir = join(scriptDir, "..", "public", "maplibre");

mkdirSync(outDir, { recursive: true });

// MapLibre GL v6+ loads a module worker that imports its sibling shared chunk.
// Serving both statically under /maplibre avoids Turbopack import.meta.url breakage.
for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(join(distDir, file), join(outDir, file));
}
