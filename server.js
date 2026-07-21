const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const cheerio = require('cheerio');
const {
  createClosureTracker,
  isClosedStatus,
  statusesMatch
} = require('./closure-tracking');
const {
  assessRecordAvailability,
  currentLifecycleProjection,
  hasText
} = require('./record-availability');
const { buildLiveMapPayload } = require('./live-map-data');
const { buildCatchupStatus, parseState } = require('./catchup-status');
const { reconcileStoredDetails } = require('./detail-queue');
const { createDashboardAuth, dashboardAuthConfig } = require('./dashboard-auth');
const { inspectSqliteHealth } = require('./sqlite-health');
const { originMatchesHost } = require('./request-security');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || null;
const dashboardAuth = dashboardAuthConfig();

app.use(express.json({ limit: '16kb' }));
app.use(createDashboardAuth(dashboardAuth));

// Always revalidate the app shell so mobile browsers pick up versioned assets.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ============================================================
// Portal fetch helpers
// ============================================================

const PORTAL_URL = 'https://portal.311.nyc.gov/entity-pin-fetch-service-requests/';
const PORTAL_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-Explorer/1.0)',
  'Referer': 'https://portal.311.nyc.gov/check-status/',
  'Origin': 'https://portal.311.nyc.gov'
};
const PORTAL_CAP = 100;       // Hard limit per request
const CONCURRENCY = 8;        // Max parallel portal calls
const CACHE_TTL = 10 * 60 * 1000; // 10-minute cache

// Simple in-memory cache: key → { data, timestamp }
const cache = new Map();

function cacheKey(params) {
  return JSON.stringify(params);
}

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.data;
  if (entry) cache.delete(key);
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
  // Evict old entries if cache grows too large
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/**
 * The portal map feed returns a UTC clock in US date format without a timezone.
 * Normalize it to an explicit ISO timestamp before sending it to the browser.
 */
function normalizePortalTimestamp(value) {
  if (!value) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return text;

  const [, month, day, year, rawHour, minute, second, period] = match;
  let hour = Number(rawHour) % 12;
  if (period.toUpperCase() === 'PM') hour += 12;

  return new Date(Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    hour, Number(minute), Number(second)
  )).toISOString();
}

function portalTimestampDay(value) {
  const normalized = normalizePortalTimestamp(value);
  const match = normalized && normalized.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function normalizePortalPin(pin) {
  return {
    id: pin.id || null,
    srnumber: (pin.data && pin.data.srnumber) || null,
    problem: (pin.data && pin.data.problem) || pin.label || null,
    address: (pin.data && pin.data.address) || pin.sublabel || null,
    latitude: parseFloat(pin.latitude) || null,
    longitude: parseFloat(pin.longitude) || null,
    submitteddate: normalizePortalTimestamp(pin.data && pin.data.submitteddate),
    status: (pin.data && pin.data.status) || null,
    portalUrl: pin.id ? `https://portal.311.nyc.gov/sr-details/?id=${pin.id}` : null
  };
}

/**
 * Fetch a single portal window. Returns normalized pins array.
 */
async function fetchPortalWindow(bbox, fromdate, todate) {
  const params = new URLSearchParams();
  if (bbox.minlatitude) params.append('minlatitude', bbox.minlatitude);
  if (bbox.minlongitude) params.append('minlongitude', bbox.minlongitude);
  if (bbox.maxlatitude) params.append('maxlatitude', bbox.maxlatitude);
  if (bbox.maxlongitude) params.append('maxlongitude', bbox.maxlongitude);
  params.append('fromdate', fromdate);
  params.append('todate', todate);

  const url = `${PORTAL_URL}?${params.toString()}`;
  const response = await fetch(url, { headers: PORTAL_HEADERS });
  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      data = JSON.parse(jsonMatch[0]);
    } else {
      return { pins: [], hitCap: false };
    }
  }

  const pins = Array.isArray(data) ? data.map(normalizePortalPin) : [];

  return { pins, hitCap: pins.length >= PORTAL_CAP };
}

/**
 * Run promises with concurrency limit
 */
async function parallelLimit(tasks, limit) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const p = task().then(result => {
      executing.delete(p);
      return result;
    });
    executing.add(p);
    results.push(p);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

/**
 * Generate date pairs: split a range into daily windows.
 * Returns array of { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
 */
function dailyWindows(fromDate, toDate) {
  const windows = [];
  const start = new Date(fromDate + 'T00:00:00');
  const end = new Date(toDate + 'T00:00:00');

  const cursor = new Date(start);
  while (cursor <= end) {
    const dayStr = cursor.toISOString().split('T')[0];
    windows.push({ from: dayStr, to: dayStr });
    cursor.setDate(cursor.getDate() + 1);
  }
  return windows;
}

/**
 * Split a single day into sub-windows (6-hour chunks).
 * Portal accepts YYYY-MM-DD format, but we can use the same date
 * with different time ranges. Since the portal only takes date (not time),
 * we can't actually split within a day using the portal's fromdate/todate.
 *
 * WORKAROUND: We accept that within a single day, we can only get 100.
 * But we log which days hit the cap so the frontend can display it.
 *
 * ALTERNATIVE: We could try spatial subdivision for capped days.
 */
function spatialSubdivide(bbox, divisions) {
  const latStep = (parseFloat(bbox.maxlatitude) - parseFloat(bbox.minlatitude)) / divisions;
  const lngStep = (parseFloat(bbox.maxlongitude) - parseFloat(bbox.minlongitude)) / divisions;
  const tiles = [];

  for (let i = 0; i < divisions; i++) {
    for (let j = 0; j < divisions; j++) {
      tiles.push({
        minlatitude: (parseFloat(bbox.minlatitude) + latStep * i).toFixed(8),
        maxlatitude: (parseFloat(bbox.minlatitude) + latStep * (i + 1)).toFixed(8),
        minlongitude: (parseFloat(bbox.minlongitude) + lngStep * j).toFixed(8),
        maxlongitude: (parseFloat(bbox.minlongitude) + lngStep * (j + 1)).toFixed(8),
      });
    }
  }
  return tiles;
}

// ============================================================
// Adaptive portal endpoint
// ============================================================

app.get('/api/portal-pins-adaptive', async (req, res) => {
  const { minlatitude, minlongitude, maxlatitude, maxlongitude, fromdate, todate, refresh } = req.query;

  if (!fromdate || !todate) {
    return res.status(400).json({ error: 'fromdate and todate required' });
  }

  const bbox = { minlatitude, minlongitude, maxlatitude, maxlongitude };

  // Check cache — skip entirely if the client requested a fresh pull
  const ck = cacheKey({ bbox, fromdate, todate, endpoint: 'adaptive' });
  if (!refresh) {
    const cached = getCached(ck);
    if (cached) return res.json(cached);
  } else {
    cache.delete(ck);
  }

  try {
    // Phase 1: Daily windows
    const days = dailyWindows(fromdate, todate);
    console.log(`[adaptive] Phase 1: ${days.length} daily windows for ${fromdate} to ${todate}`);

    const dayTasks = days.map(day => () => fetchPortalWindow(bbox, day.from, day.to));
    const dayResults = await parallelLimit(dayTasks, CONCURRENCY);

    // Collect results and identify capped days
    let allPins = [];
    const cappedDays = [];

    for (let i = 0; i < dayResults.length; i++) {
      const { pins, hitCap } = dayResults[i];
      allPins = allPins.concat(pins);
      if (hitCap) {
        cappedDays.push(days[i]);
      }
    }

    const phase1Count = allPins.length;
    const phase1Calls = days.length;

    // Phase 2: For capped days, retry with spatial subdivision (2x2 grid = 4 tiles)
    let phase2Calls = 0;
    if (cappedDays.length > 0) {
      console.log(`[adaptive] Phase 2: ${cappedDays.length} capped days, subdividing spatially (2x2)`);

      const tileTasks = [];
      for (const day of cappedDays) {
        const tiles = spatialSubdivide(bbox, 2); // 2x2 = 4 tiles
        for (const tile of tiles) {
          tileTasks.push(() => fetchPortalWindow(tile, day.from, day.to));
        }
      }

      const tileResults = await parallelLimit(tileTasks, CONCURRENCY);
      phase2Calls = tileTasks.length;

      // Remove the capped-day pins (we're replacing them with tile results)
      const cappedDateSet = new Set(cappedDays.map(d => d.from));
      allPins = allPins.filter(pin => {
        // Keep pin if its date is NOT in a capped day
        if (!pin.submitteddate) return true;
        const dayStr = portalTimestampDay(pin.submitteddate);
        if (!dayStr) return true;
        return !cappedDateSet.has(dayStr);
      });

      // Add tile results
      for (const { pins } of tileResults) {
        allPins = allPins.concat(pins);
      }
    }

    // Phase 3: Deduplicate by srnumber (tiles may overlap at edges)
    const seen = new Set();
    const deduped = [];
    for (const pin of allPins) {
      const key = pin.srnumber || pin.id || `${pin.latitude}-${pin.longitude}-${pin.submitteddate}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(pin);
      }
    }

    const result = {
      pins: deduped,
      count: deduped.length,
      stats: {
        phase1_days: days.length,
        phase1_calls: phase1Calls,
        phase1_pins: phase1Count,
        phase2_capped_days: cappedDays.length,
        phase2_calls: phase2Calls,
        phase2_pins_after_dedup: deduped.length - (phase1Count - cappedDays.length * PORTAL_CAP),
        total_calls: phase1Calls + phase2Calls,
        total_pins: deduped.length,
        capped_days: cappedDays.map(d => d.from)
      }
    };

    // Cache the result
    setCache(ck, result);

    console.log(`[adaptive] Done: ${deduped.length} pins from ${phase1Calls + phase2Calls} calls (${cappedDays.length} days re-split)`);
    res.json(result);

  } catch (err) {
    console.error('Adaptive portal error:', err.message);
    res.status(500).json({ error: err.message, pins: [], stats: {} });
  }
});

// ============================================================
// Original simple portal endpoint (kept for backward compat)
// ============================================================

app.get('/api/portal-pins', async (req, res) => {
  try {
    const params = new URLSearchParams();
    if (req.query.borough) params.append('borough', req.query.borough);
    if (req.query.fromdate) params.append('fromdate', req.query.fromdate);
    if (req.query.todate) params.append('todate', req.query.todate);
    if (req.query.minlatitude) params.append('minlatitude', req.query.minlatitude);
    if (req.query.minlongitude) params.append('minlongitude', req.query.minlongitude);
    if (req.query.maxlatitude) params.append('maxlatitude', req.query.maxlatitude);
    if (req.query.maxlongitude) params.append('maxlongitude', req.query.maxlongitude);
    if (req.query.problemarea) params.append('problemarea', req.query.problemarea);
    if (req.query.problem) params.append('problem', req.query.problem);

    const url = `https://portal.311.nyc.gov/entity-pin-fetch-service-requests/?${params.toString()}`;
    const response = await fetch(url, { headers: PORTAL_HEADERS });
    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[0]);
      } else {
        return res.json({ error: 'Could not parse portal response', pins: [] });
      }
    }

    const pins = Array.isArray(data) ? data.map(normalizePortalPin) : [];

    res.json({ pins, count: pins.length, raw_count: Array.isArray(data) ? data.length : 0 });
  } catch (err) {
    console.error('Portal proxy error:', err.message);
    res.status(500).json({ error: err.message, pins: [] });
  }
});

// Proxy: 311 Portal SR number lookup
app.get('/api/portal-sr', async (req, res) => {
  try {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: 'number parameter required' });

    const url = `https://portal.311.nyc.gov/check-status/?number=${encodeURIComponent(number)}`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (compatible; NYC-BID-311-Explorer/1.0)',
        'Referer': 'https://portal.311.nyc.gov/check-status/'
      }
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[0]);
      } else {
        return res.json({ error: 'Could not parse SR lookup response' });
      }
    }

    res.json(data);
  } catch (err) {
    console.error('SR lookup proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function parsePortalDetail(html) {
  const $ = cheerio.load(html);
  const fields = {};

  $('.info label').each((_, label) => {
    const name = $(label).text().replace(/\s+/g, ' ').trim();
    const field = $(label).closest('[class*="col-"]');
    const value = field.find('.control span').first().text()
      .replace(/\s+/g, ' ').trim();
    if (name && value && value !== '-') fields[name] = value;
  });

  const scripts = $('script').map((_, script) => $(script).html() || '').get().join('\n');
  const scriptDate = (id) => {
    const pattern = new RegExp(`\\$\\(["']#${id}["']\\)\\.text\\(getESTDate\\(["']([^"']+)["']\\)\\)`);
    const match = scripts.match(pattern);
    return match ? match[1] : null;
  };

  return {
    srnumber: fields['SR Number'] || null,
    status: fields['SR Status'] || null,
    problem: fields.Problem || null,
    problemDetails: fields['Problem Details'] || null,
    additionalDetails: fields['Additional Details'] || null,
    address: fields['SR Address'] || null,
    nextUpdate: fields['Time To Next Update'] || null,
    dateReported: scriptDate('srdatereported'),
    updatedOn: scriptDate('srupdatedon'),
    dateClosed: scriptDate('srdateclosed'),
    fields
  };
}

function persistLivePortalDetail(portalId, detail) {
  if (!detail || !detail.srnumber) return;
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  if (!require('fs').existsSync(databasePath)) return;
  const suffixMatch = String(detail.srnumber).match(/^311-(\d{8})$/);
  if (!suffixMatch) return;

  let database;
  try {
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA busy_timeout = 500;
      CREATE TABLE IF NOT EXISTS portal_requests (
        srnumber TEXT PRIMARY KEY,
        suffix INTEGER NOT NULL UNIQUE,
        portal_id TEXT UNIQUE,
        status TEXT,
        problem TEXT,
        problem_details TEXT,
        additional_details TEXT,
        address TEXT,
        next_update TEXT,
        date_reported TEXT,
        updated_on TEXT,
        date_closed TEXT,
        fields_json TEXT NOT NULL,
        portal_url TEXT NOT NULL,
        archived_at TEXT NOT NULL
      );
    `);
    const closureTracker = createClosureTracker(database);
    const hasDetailQueue = database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'live_detail_queue'
    `).get();
    const now = new Date().toISOString();
    const archivalStatus = detail.dateClosed && !isClosedStatus(detail.status)
      ? 'Closed'
      : detail.status;
    database.exec('BEGIN');
    try {
      database.prepare(`
        INSERT INTO portal_requests (
          srnumber, suffix, portal_id, status, problem, problem_details,
          additional_details, address, next_update, date_reported, updated_on,
          date_closed, fields_json, portal_url, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(srnumber) DO UPDATE SET
          portal_id = COALESCE(excluded.portal_id, portal_requests.portal_id),
          status = CASE
            WHEN portal_requests.date_closed IS NOT NULL AND excluded.date_closed IS NULL
              THEN portal_requests.status
            ELSE COALESCE(excluded.status, portal_requests.status)
          END,
          problem = COALESCE(excluded.problem, portal_requests.problem),
          problem_details = COALESCE(excluded.problem_details, portal_requests.problem_details),
          additional_details = COALESCE(excluded.additional_details, portal_requests.additional_details),
          address = COALESCE(excluded.address, portal_requests.address),
          next_update = COALESCE(excluded.next_update, portal_requests.next_update),
          date_reported = COALESCE(excluded.date_reported, portal_requests.date_reported),
          updated_on = COALESCE(excluded.updated_on, portal_requests.updated_on),
          date_closed = COALESCE(excluded.date_closed, portal_requests.date_closed),
          fields_json = json_patch(
            COALESCE(portal_requests.fields_json, '{}'),
            COALESCE(excluded.fields_json, '{}')
          ),
          portal_url = COALESCE(excluded.portal_url, portal_requests.portal_url),
          archived_at = excluded.archived_at
      `).run(
        detail.srnumber,
        Number(suffixMatch[1]),
        portalId,
        archivalStatus,
        detail.problem,
        detail.problemDetails,
        detail.additionalDetails,
        detail.address,
        detail.nextUpdate,
        detail.dateReported,
        detail.updatedOn,
        detail.dateClosed,
        JSON.stringify(detail.fields || {}),
        `https://portal.311.nyc.gov/sr-details/?id=${portalId}`,
        now
      );

      if (hasDetailQueue) {
        reconcileStoredDetails(database, {
          srnumber: detail.srnumber,
          updatedAt: now
        });
      }

      // A fresh UI fetch may notice a closure before the next map poll. Record
      // that transition and wake the monitor, but leave retries/finalization to
      // the background collector. Cached UI reads never enter this function.
      const current = database.prepare(`
        SELECT status, portal_id FROM live_portal_requests WHERE srnumber = ?
      `).get(detail.srnumber);
      if (current && archivalStatus && isClosedStatus(archivalStatus)
          && !statusesMatch(current.status, archivalStatus)) {
        closureTracker.observeStatus({
          srnumber: detail.srnumber,
          previousStatus: current.status,
          status: archivalStatus,
          source: 'manual_detail',
          effectiveAt: detail.dateClosed || detail.updatedOn,
          observedAt: now,
          snapshot: detail
        });
        database.prepare(`
          UPDATE live_portal_requests SET status = ? WHERE srnumber = ?
        `).run(archivalStatus, detail.srnumber);
        closureTracker.queueMapStatusChange({
          srnumber: detail.srnumber,
          portalId: portalId || current.portal_id,
          previousStatus: current.status,
          status: archivalStatus,
          observedAt: now
        });
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.warn('Could not persist Portal detail:', error.message);
  } finally {
    if (database) database.close();
  }
}

// Enrich a map pin only when its popup is opened.
app.get('/api/portal-detail', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'valid id parameter required' });
  }

  const ck = cacheKey({ endpoint: 'portal-detail', id });
  const cached = getCached(ck);
  if (cached) return res.json(cached);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(`https://portal.311.nyc.gov/sr-details/?id=${encodeURIComponent(id)}`, {
      headers: { ...PORTAL_HEADERS, Accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Portal detail fetch failed: ${response.status}`);

    const detail = parsePortalDetail(await response.text());
    setCache(ck, detail);
    persistLivePortalDetail(id, detail);
    res.json(detail);
  } catch (err) {
    console.error('Portal detail proxy error:', err.message);
    res.status(502).json({ error: 'Case details are temporarily unavailable' });
  } finally {
    clearTimeout(timeout);
  }
});

// Complete, lightweight marker dataset. This is intentionally separate from the
// bounded dashboard feed so the map does not lose older coordinate-bearing rows.
app.get('/api/live-map', (req, res) => {
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  let database;
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!require('fs').existsSync(databasePath)) return res.json(buildLiveMapPayload([]));
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    const tables = new Set(database.prepare(`
      SELECT name FROM sqlite_master WHERE type='table'
    `).all().map(row => row.name));
    if (!tables.has('live_portal_requests')) return res.json(buildLiveMapPayload([]));

    const hasDetails = tables.has('portal_requests');
    const hasFollowUps = tables.has('request_followup_queue');
    const hasClosureSnapshots = tables.has('request_closure_snapshots');
    const detailColumns = hasDetails
      ? `details.portal_id AS detail_portal_id,
         details.problem AS detail_problem,
         details.address AS detail_address,
         details.status AS detail_status,
         details.portal_url AS detail_portal_url,
         details.date_reported AS detail_date_reported,
         details.date_closed AS detail_date_closed`
      : `NULL AS detail_portal_id,
         NULL AS detail_problem,
         NULL AS detail_address,
         NULL AS detail_status,
         NULL AS detail_portal_url,
         NULL AS detail_date_reported,
         NULL AS detail_date_closed`;
    const detailJoin = hasDetails
      ? 'LEFT JOIN portal_requests AS details ON details.srnumber=live.srnumber'
      : '';
    const followUpColumns = hasFollowUps
      ? `followup.state AS followup_state,
         followup.next_check_at AS next_check_at,
         followup.finalized_at AS finalized_at`
      : `NULL AS followup_state,
         NULL AS next_check_at,
         NULL AS finalized_at`;
    const followUpJoin = hasFollowUps
      ? 'LEFT JOIN request_followup_queue AS followup ON followup.srnumber=live.srnumber'
      : '';
    const currentClosureColumns = hasFollowUps && hasClosureSnapshots
      ? `current_final.date_closed AS current_cycle_date_closed,
         1 AS closure_cycle_tracking`
      : `NULL AS current_cycle_date_closed,
         0 AS closure_cycle_tracking`;
    const currentClosureJoin = hasFollowUps && hasClosureSnapshots
      ? `LEFT JOIN request_closure_snapshots AS current_final
           ON current_final.id=(
             SELECT MAX(snapshot.id)
             FROM request_closure_snapshots AS snapshot
             WHERE snapshot.srnumber=followup.srnumber
               AND snapshot.closure_cycle=followup.closure_cycle
               AND snapshot.is_final=1
           )`
      : '';
    const rows = database.prepare(`
      SELECT live.srnumber,live.suffix,live.portal_id,live.problem,live.address,
             live.latitude,live.longitude,live.submitted_at,live.status,
             live.portal_url,live.first_seen_at,live.last_seen_at,
             ${detailColumns},${followUpColumns},${currentClosureColumns}
      FROM live_portal_requests AS live
      ${detailJoin}
      ${followUpJoin}
      ${currentClosureJoin}
    `).all();
    return res.json(buildLiveMapPayload(rows));
  } catch (error) {
    console.error('Live map data error:', error.message);
    return res.status(503).json(buildLiveMapPayload([]));
  } finally {
    if (database) database.close();
  }
});

// Read-only feed for the macOS live monitor dashboard. The SQLite module is
// loaded lazily so the existing web deployment remains compatible with older
// Node runtimes that do not include node:sqlite.
app.get('/api/live-dashboard', (req, res) => {
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 500)));
  let database;
  try {
    if (!require('fs').existsSync(databasePath)) {
      return res.json({ records: [], stats: { total: 0, pending: 0, frontier: null, last_seen_at: null } });
    }
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    const hasDetails = database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'portal_requests'
    `).get();
    const hasFollowUps = database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'request_followup_queue'
    `).get();
    const hasClosureSnapshots = database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'request_closure_snapshots'
    `).get();
    const detailColumns = hasDetails
      ? `details.portal_id AS detail_portal_id, details.status AS detail_status,
         details.problem AS detail_problem, details.address AS detail_address,
         details.portal_url AS detail_portal_url,
         details.problem_details, details.additional_details, details.next_update,
         details.date_reported, details.updated_on, details.date_closed,
         details.archived_at AS details_fetched_at`
      : `NULL AS detail_portal_id, NULL AS detail_status,
         NULL AS detail_problem, NULL AS detail_address, NULL AS detail_portal_url,
         NULL AS problem_details, NULL AS additional_details, NULL AS next_update,
         NULL AS date_reported, NULL AS updated_on, NULL AS date_closed,
         NULL AS details_fetched_at`;
    const detailJoin = hasDetails
      ? 'LEFT JOIN portal_requests AS details ON details.srnumber = live.srnumber'
      : '';
    const followUpColumns = hasFollowUps
      ? `followup.state AS followup_state, followup.next_check_at,
         followup.closure_cycle, followup.finalized_at`
      : `NULL AS followup_state, NULL AS next_check_at,
         0 AS closure_cycle, NULL AS finalized_at`;
    const followUpJoin = hasFollowUps
      ? 'LEFT JOIN request_followup_queue AS followup ON followup.srnumber = live.srnumber'
      : '';
    const currentClosureColumns = hasFollowUps && hasClosureSnapshots
      ? `current_final.date_closed AS current_cycle_date_closed,
         current_final.final_state AS current_cycle_final_state,
         1 AS closure_cycle_tracking`
      : `NULL AS current_cycle_date_closed,
         NULL AS current_cycle_final_state,
         0 AS closure_cycle_tracking`;
    const currentClosureJoin = hasFollowUps && hasClosureSnapshots
      ? `LEFT JOIN request_closure_snapshots AS current_final
           ON current_final.id = (
             SELECT MAX(snapshot.id)
             FROM request_closure_snapshots AS snapshot
             WHERE snapshot.srnumber = followup.srnumber
               AND snapshot.closure_cycle = followup.closure_cycle
               AND snapshot.is_final = 1
           )`
      : '';
    const storedRecords = database.prepare(`
      SELECT live.srnumber, live.suffix, live.portal_id, live.problem, live.address,
             live.latitude, live.longitude, live.submitted_at, live.status,
             live.portal_url, live.first_seen_at, live.last_seen_at,
             ${detailColumns}, ${followUpColumns}, ${currentClosureColumns}
      FROM live_portal_requests AS live
      ${detailJoin}
      ${followUpJoin}
      ${currentClosureJoin}
      ORDER BY live.suffix DESC
      LIMIT ?
    `).all(limit);
    const records = storedRecords.map(stored => {
      const {
        detail_portal_id: detailPortalId,
        detail_status: detailStatus,
        detail_problem: detailProblem,
        detail_address: detailAddress,
        detail_portal_url: detailPortalUrl,
        ...record
      } = stored;
      record.portal_id = hasText(record.portal_id) ? record.portal_id : detailPortalId;
      record.status = hasText(record.status) ? record.status : detailStatus;
      record.problem = hasText(record.problem) ? record.problem : detailProblem;
      record.address = hasText(record.address) ? record.address : detailAddress;
      record.submitted_at = hasText(record.submitted_at)
        ? record.submitted_at
        : record.date_reported;
      // Detail rows intentionally retain an older closure date for history.
      // Do not present that date as the current cycle after a reopen, or while
      // a newly observed closure is still being verified.
      record.closure_cycle_tracking = Boolean(record.closure_cycle_tracking);
      Object.assign(record, currentLifecycleProjection(record));
      record.portal_url = hasText(record.portal_url)
        ? record.portal_url
        : detailPortalUrl || (record.portal_id
          ? `https://portal.311.nyc.gov/sr-details/?id=${record.portal_id}`
          : null);
      return { ...record, ...assessRecordAvailability(record) };
    });
    const detailStats = hasDetails
      ? `(SELECT COUNT(*) FROM portal_requests AS stored
          JOIN live_portal_requests AS captured ON captured.srnumber = stored.srnumber) AS details_loaded,
         (SELECT COUNT(*) FROM live_portal_requests AS captured
          LEFT JOIN portal_requests AS stored ON stored.srnumber = captured.srnumber
          WHERE stored.srnumber IS NULL) AS details_pending`
      : `0 AS details_loaded,
         (SELECT COUNT(*) FROM live_portal_requests) AS details_pending`;
    const closureStats = hasFollowUps
      ? `(SELECT COUNT(*) FROM request_followup_queue WHERE state = 'closing') AS closure_refreshes_pending,
         (SELECT COUNT(*) FROM request_followup_queue WHERE state = 'open') AS open_followups_scheduled,
         (SELECT COUNT(*) FROM request_followup_queue WHERE state = 'closed') AS closures_finalized`
      : `0 AS closure_refreshes_pending,
         0 AS open_followups_scheduled,
         0 AS closures_finalized`;
    const totals = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM live_portal_requests) AS total,
        (SELECT COUNT(*) FROM live_portal_requests
          WHERE latitude IS NULL OR longitude IS NULL) AS unmapped_total,
        (SELECT COUNT(*) FROM live_number_queue WHERE audit_outcome = 'pending') AS pending,
        (SELECT MAX(suffix) FROM live_number_queue) AS frontier,
        (SELECT MAX(last_seen_at) FROM live_portal_requests) AS last_seen_at,
        COALESCE(
          (SELECT CAST(value AS INTEGER) FROM live_monitor_state WHERE key = 'poll_interval_seconds'),
          15
        ) AS poll_interval_seconds,
        ${detailStats},
        ${closureStats}
    `).get();
    const catchupWindowRow = database.prepare(`
      SELECT value FROM live_monitor_state WHERE key = 'catchup_window'
    `).get();
    const auditRunRow = database.prepare(`
      SELECT value FROM live_monitor_state WHERE key = 'audit_run'
    `).get();
    const catchupWindow = parseState(catchupWindowRow && catchupWindowRow.value);
    if (catchupWindow && Number.isInteger(Number(catchupWindow.low_suffix)) &&
        Number.isInteger(Number(catchupWindow.high_suffix))) {
      const low = Number(catchupWindow.low_suffix);
      const high = Number(catchupWindow.high_suffix);
      const coverage = database.prepare(`
        SELECT
          SUM(CASE WHEN outcome IN ('found', 'not_found') THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN outcome = 'found' THEN 1 ELSE 0 END) AS found,
          SUM(CASE WHEN outcome = 'not_found' THEN 1 ELSE 0 END) AS not_found,
          SUM(CASE WHEN outcome = 'retry' THEN 1 ELSE 0 END) AS retry
        FROM number_ledger
        WHERE suffix BETWEEN ? AND ?
      `).get(low, high);
      const current = database.prepare(`
        SELECT MAX(queue.suffix) AS suffix
        FROM live_number_queue AS queue
        LEFT JOIN number_ledger AS ledger ON ledger.suffix = queue.suffix
        WHERE queue.suffix BETWEEN ? AND ?
          AND (ledger.suffix IS NULL OR ledger.outcome = 'retry')
      `).get(low, high);
      totals.catchup = buildCatchupStatus({
        windowState: catchupWindow,
        runState: auditRunRow && auditRunRow.value,
        coverage,
        currentSuffix: current && current.suffix
      });
    } else {
      totals.catchup = null;
    }
    res.json({ records, stats: totals });
  } catch (error) {
    res.status(503).json({ error: error.message, records: [], stats: {} });
  } finally {
    if (database) database.close();
  }
});

app.get('/api/status-history/:srnumber', (req, res) => {
  const srnumber = String(req.params.srnumber || '').trim();
  if (!/^311-\d{8}$/.test(srnumber)) {
    return res.status(400).json({ error: 'valid 311 request number required' });
  }
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  let database;
  try {
    if (!require('fs').existsSync(databasePath)) {
      return res.json({ srnumber, history: [], closure_snapshots: [], followup: null });
    }
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    const tableNames = new Set(database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map(row => row.name));
    const history = tableNames.has('request_status_history')
      ? database.prepare(`
          SELECT id, previous_status, status, source, effective_at, observed_at
          FROM request_status_history
          WHERE srnumber = ? ORDER BY id
        `).all(srnumber)
      : [];
    const closureSnapshots = tableNames.has('request_closure_snapshots')
      ? database.prepare(`
          SELECT id, closure_cycle, status, date_closed, source, fetched_at,
                 is_final, final_state, content_hash, snapshot_json
          FROM request_closure_snapshots
          WHERE srnumber = ? ORDER BY id
        `).all(srnumber).map(row => {
          try {
            return { ...row, snapshot: JSON.parse(row.snapshot_json), snapshot_json: undefined };
          } catch (_) {
            return row;
          }
        })
      : [];
    const followup = tableNames.has('request_followup_queue')
      ? database.prepare(`
          SELECT state, next_check_at, attempts, closing_attempts, closure_cycle,
                 last_checked_at, last_error, finalized_at, updated_at
          FROM request_followup_queue WHERE srnumber = ?
        `).get(srnumber) || null
      : null;
    res.json({ srnumber, history, closure_snapshots: closureSnapshots, followup });
  } catch (error) {
    res.status(503).json({ error: error.message });
  } finally {
    if (database) database.close();
  }
});

app.post('/api/live-settings', (req, res) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'application/json is required' });
  }
  const requestProtocol = req.get('x-forwarded-proto') || req.protocol;
  if (!originMatchesHost(req.get('origin'), req.get('host'), requestProtocol)) {
    return res.status(403).json({ error: 'cross-origin settings changes are not allowed' });
  }
  const interval = Number(req.body && req.body.poll_interval_seconds);
  if (![5, 10, 15, 30, 60].includes(interval)) {
    return res.status(400).json({ error: 'poll_interval_seconds must be 5, 10, 15, 30, or 60' });
  }
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  let database;
  try {
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath);
    database.exec('PRAGMA busy_timeout = 1000');
    database.prepare(`
      INSERT INTO live_monitor_state (key, value, updated_at)
      VALUES ('poll_interval_seconds', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(interval), new Date().toISOString());
    res.json({ poll_interval_seconds: interval });
  } catch (error) {
    res.status(503).json({ error: error.message });
  } finally {
    if (database) database.close();
  }
});

function currentHealth() {
  const now = new Date();
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'portal-archive.sqlite');
  const health = inspectSqliteHealth(databasePath, { now });
  if (health.error) console.error('Health check failed:', health.error);
  const { error: _privateError, ...publicHealth } = health;
  return { now, health, publicHealth };
}

// Web/database liveness stays available during a Portal outage so the archive
// remains readable. Collector readiness is a separate monitored endpoint.
app.get('/api/health', (req, res) => {
  const { now, health, publicHealth } = currentHealth();
  res.status(health.ok ? 200 : 503).json({
    ...publicHealth,
    timestamp: now.toISOString()
  });
});

app.get('/api/health/collector', (req, res) => {
  const { now, health, publicHealth } = currentHealth();
  const ready = health.ok && health.collector === 'fresh';
  res.status(ready ? 200 : 503).json({
    ...publicHealth,
    ready,
    timestamp: now.toISOString()
  });
});

const onListen = () => {
  console.log(`NYC BID 311 Explorer running at http://localhost:${PORT}`);
};

if (HOST) app.listen(PORT, HOST, onListen);
else app.listen(PORT, onListen);
