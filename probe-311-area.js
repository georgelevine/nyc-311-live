const fetch = require('node-fetch');

const PORTAL_URL = 'https://portal.311.nyc.gov/entity-pin-fetch-service-requests/';
const NYC = { west: -74.2591, south: 40.4774, east: -73.7002, north: 40.9176 };
const TIMEOUT_MS = Math.max(1000, Number(process.env.PROBE_TIMEOUT_MS || 30000));
const DELAY_MS = Math.max(0, Number(process.env.QUERY_DELAY_MS || 2000));

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function centeredBox(scale) {
  const centerLongitude = (NYC.west + NYC.east) / 2;
  const centerLatitude = (NYC.south + NYC.north) / 2;
  const halfWidth = ((NYC.east - NYC.west) * scale) / 2;
  const halfHeight = ((NYC.north - NYC.south) * scale) / 2;
  return {
    west: centerLongitude - halfWidth,
    south: centerLatitude - halfHeight,
    east: centerLongitude + halfWidth,
    north: centerLatitude + halfHeight
  };
}

async function probe(scale) {
  const box = centeredBox(scale);
  const params = new URLSearchParams({
    minlatitude: String(box.south),
    minlongitude: String(box.west),
    maxlatitude: String(box.north),
    maxlongitude: String(box.east)
  });
  const started = Date.now();
  const response = await fetch(`${PORTAL_URL}?${params}`, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-Explorer/1.0)',
      Referer: 'https://portal.311.nyc.gov/check-status/',
      Origin: 'https://portal.311.nyc.gov'
    },
    timeout: TIMEOUT_MS
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const records = await response.json();
  if (!Array.isArray(records)) throw new Error('response was not a record list');
  return { box, count: records.length, elapsedMs: Date.now() - started };
}

async function main() {
  const scales = [1 / 256, 1 / 128, 1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1];
  console.log(`Portal timeout: ${TIMEOUT_MS / 1000}s; delay between requests: ${DELAY_MS / 1000}s`);
  for (let index = 0; index < scales.length; index += 1) {
    if (index > 0) await sleep(DELAY_MS);
    const scale = scales[index];
    const grid = Math.round(1 / scale);
    try {
      const result = await probe(scale);
      console.log(JSON.stringify({
        scale: `1/${grid}`,
        equivalentGrid: `${grid}x${grid}`,
        records: result.count,
        hitCap: result.count >= 100,
        seconds: Number((result.elapsedMs / 1000).toFixed(2)),
        bbox: result.box
      }));
    } catch (error) {
      console.error(JSON.stringify({
        scale: `1/${grid}`,
        equivalentGrid: `${grid}x${grid}`,
        timeoutSeconds: TIMEOUT_MS / 1000,
        error: error.message
      }));
      break;
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
