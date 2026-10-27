#!/usr/bin/env node
/**
 * Loads US Census cartographic-boundary counties (cb_<year>_us_county_500k) into
 * `maps.us_counties`, the reference table behind `maps.resolve_jurisdiction()`.
 *
 * Source:  https://www2.census.gov/geo/tiger/GENZ<year>/shp/cb_<year>_us_county_500k.zip
 * (public domain; NAD83 / EPSG:4269, treated as WGS84 - the offset is < 1 m, far below the
 *  1:500k generalisation, which is plenty for county resolution.)
 *
 * Usage (Node >= 20):
 *   # Production / staging: upsert through PostgREST with the service role key.
 *   SUPABASE_URL=https://<project>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/load-tiger-counties.mjs [--year 2023] [--zip ./cb_2023_us_county_500k.zip]
 *
 *   # No API access: emit SQL to pipe into psql.
 *   node scripts/load-tiger-counties.mjs --emit-sql | psql "$DATABASE_URL"
 *
 * The service role key is read from the environment only and is never logged. The load is
 * idempotent (upsert by GEOID) so it is safe to re-run for a new vintage.
 */
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { read as readShapefile } from "shapefile";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const year = option("--year", "2023");
if (!/^\d{4}$/.test(year)) fail("--year must be a 4-digit year");
const base = `cb_${year}_us_county_500k`;
const zipPath = option("--zip", null);
const emitSql = flag("--emit-sql");
const concurrency = Number(option("--concurrency", "6"));

function fail(message) {
  console.error(`load-tiger-counties: ${message}`);
  process.exit(1);
}

async function loadZip() {
  if (zipPath) return new Uint8Array(await readFile(zipPath));
  const url = `https://www2.census.gov/geo/tiger/GENZ${year}/shp/${base}.zip`;
  console.error(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) fail(`download failed with HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** @returns {Promise<{ geoid: string, name: string, state_code: string, geometry: object }[]>} */
async function readCounties() {
  const files = unzipSync(await loadZip());
  const shp = files[`${base}.shp`];
  const dbf = files[`${base}.dbf`];
  if (!shp || !dbf) fail(`archive does not contain ${base}.shp/.dbf`);
  const toBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const collection = await readShapefile(toBuffer(shp), toBuffer(dbf));

  const counties = [];
  for (const feature of collection.features) {
    const { GEOID, NAME, STUSPS } = feature.properties ?? {};
    if (typeof GEOID !== "string" || !/^\d{5}$/.test(GEOID) || !feature.geometry) continue;
    counties.push({
      geoid: GEOID,
      name: String(NAME ?? "").trim(),
      state_code: String(STUSPS ?? "").trim().toUpperCase(),
      geometry: feature.geometry,
    });
  }
  return counties;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function toSql(county) {
  // Dollar-quoted so the GeoJSON needs no escaping.
  return (
    `SELECT maps.upsert_us_county(${sqlLiteral(county.geoid)}, ${sqlLiteral(county.name)}, ` +
    `${sqlLiteral(county.state_code)}, $gj$${JSON.stringify(county.geometry)}$gj$);`
  );
}

async function upsertViaRest(county, { url, key }) {
  const response = await fetch(`${url}/rest/v1/rpc/upsert_us_county`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "Content-Profile": "maps",
    },
    body: JSON.stringify({
      p_geoid: county.geoid,
      p_name: county.name,
      p_state_code: county.state_code,
      p_geojson: JSON.stringify(county.geometry),
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`upsert ${county.geoid} failed: HTTP ${response.status} ${detail}`);
  }
}

async function main() {
  const counties = await readCounties();
  if (counties.length === 0) fail("no counties found in the archive");
  console.error(`Parsed ${counties.length} counties from ${base}`);

  if (emitSql) {
    console.log("BEGIN;");
    for (const county of counties) console.log(toSql(county));
    console.log("COMMIT;");
    return;
  }

  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or pass --emit-sql");

  let next = 0;
  let done = 0;
  const errors = [];
  const worker = async () => {
    while (next < counties.length) {
      const county = counties[next++];
      try {
        await upsertViaRest(county, { url, key });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      done += 1;
      if (done % 250 === 0) console.error(`  ${done}/${counties.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  if (errors.length > 0) {
    console.error(`${errors.length} upserts failed; first: ${errors[0]}`);
    process.exit(1);
  }
  console.error(`Loaded ${counties.length} counties into maps.us_counties`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
