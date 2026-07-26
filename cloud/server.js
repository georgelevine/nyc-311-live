const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { query, transaction, close } = require('./db');
const { fetchDetailById } = require('./portal');
const { isClosedStatus, statusesMatch } = require('../closure-tracking');
const { getFollowUp, observeStatus, scheduleAfterDetail } = require('./closure-tracking');
const {
  assessRecordAvailability,
  currentLifecycleProjection,
  hasText
} = require('../record-availability');
const { buildLiveMapPayload } = require('../live-map-data');
const { storedPortalDetailFromRow } = require('../stored-portal-detail');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || '0.0.0.0';
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || 'admin';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
const immutableVendorAssets = {
  immutable: true,
  maxAge: '1y'
};
app.use(
  '/vendor/leaflet',
  express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist'), immutableVendorAssets)
);
app.use(
  '/vendor/leaflet-markercluster',
  express.static(
    path.join(__dirname, '..', 'node_modules', 'leaflet.markercluster', 'dist'),
    immutableVendorAssets
  )
);

app.get('/api/health/live', (_req, res) => {
  res.json({ status: 'ok', process: 'running', timestamp: new Date().toISOString() });
});

async function readiness(_req, res) {
  try {
    const result = await query(`
      SELECT
        (SELECT value FROM live_monitor_state WHERE key='last_successful_poll_at') AS last_successful_poll_at,
        (SELECT MAX(version) FROM schema_migrations) AS schema_version
    `);
    const lastPoll = result.rows[0].last_successful_poll_at;
    const ageSeconds = lastPoll ? Math.round((Date.now() - new Date(lastPoll).getTime()) / 1000) : null;
    res.json({
      status: 'ok', database: 'connected',
      collector: ageSeconds !== null && ageSeconds <= 120 ? 'current' : 'waiting',
      last_successful_poll_at: lastPoll,
      schema_version: result.rows[0].schema_version,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({ status: 'error', database: 'unavailable', timestamp: new Date().toISOString() });
  }
}

app.get('/api/health', readiness);
app.get('/api/health/ready', readiness);

function safeEqual(first, second) {
  const a = Buffer.from(String(first));
  const b = Buffer.from(String(second));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireDashboardLogin(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next();
  const authorization = String(req.headers.authorization || '');
  if (authorization.startsWith('Basic ')) {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const username = separator >= 0 ? decoded.slice(0, separator) : '';
    const password = separator >= 0 ? decoded.slice(separator + 1) : '';
    if (safeEqual(username, DASHBOARD_USERNAME) && safeEqual(password, DASHBOARD_PASSWORD)) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="NYC 311 Live", charset="UTF-8"');
  return res.status(401).send('Sign in to NYC 311 Live');
}

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'live.html')));
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  }
}));

// Complete marker contract. Keep this unbounded endpoint lightweight at the
// current archive size; a future viewport/cluster API should be additive and use
// PostGIS rather than silently changing or truncating `/api/live-map`.
app.get('/api/live-map', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const rawPageLimit = req.query && req.query.limit;
    const rawBeforeSuffix = req.query && req.query.before_suffix;
    let pageLimit = null;
    let beforeSuffix = null;
    if (rawPageLimit != null && String(rawPageLimit).trim() !== '') {
      pageLimit = Number(rawPageLimit);
      if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 5000) {
        return res.status(400).json({ error: 'limit must be an integer from 1 through 5000' });
      }
    }
    if (rawBeforeSuffix != null && String(rawBeforeSuffix).trim() !== '') {
      beforeSuffix = Number(rawBeforeSuffix);
      if (!Number.isSafeInteger(beforeSuffix) || beforeSuffix < 1) {
        return res.status(400).json({ error: 'before_suffix must be a positive request suffix' });
      }
    }
    const parameters = [];
    const predicates = [
      'live.latitude BETWEEN -90 AND 90',
      'live.longitude BETWEEN -180 AND 180'
    ];
    if (beforeSuffix != null) {
      parameters.push(beforeSuffix);
      predicates.push(`live.suffix < $${parameters.length}`);
    }
    let pageClause = '';
    if (pageLimit != null) {
      parameters.push(pageLimit);
      pageClause = `LIMIT $${parameters.length}`;
    }
    const [result, totalResult] = await Promise.all([
      query(`
      SELECT live.srnumber,live.suffix,live.portal_id,live.problem,live.address,
             live.borough,live.incident_zip,
             live.latitude,live.longitude,live.submitted_at,live.status,
             live.portal_url,live.first_seen_at,live.last_seen_at,
             details.portal_id AS detail_portal_id,
             details.problem AS detail_problem,
             details.address AS detail_address,
             details.status AS detail_status,
             details.portal_url AS detail_portal_url,
             details.date_reported AS detail_date_reported,
             details.date_closed AS detail_date_closed,
             followup.state AS followup_state,
             followup.next_check_at AS next_check_at,
             followup.finalized_at AS finalized_at,
             current_final.date_closed AS current_cycle_date_closed,
             TRUE AS closure_cycle_tracking
      FROM live_portal_requests AS live
      LEFT JOIN portal_requests AS details ON details.srnumber=live.srnumber
      LEFT JOIN request_followup_queue AS followup ON followup.srnumber=live.srnumber
      LEFT JOIN request_closure_snapshots AS current_final
        ON current_final.srnumber=followup.srnumber
       AND current_final.closure_cycle=followup.closure_cycle
       AND current_final.is_final=TRUE
      WHERE ${predicates.join(' AND ')}
      ORDER BY live.suffix DESC
      ${pageClause}
    `, parameters),
      query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (
            WHERE latitude BETWEEN -90 AND 90
              AND longitude BETWEEN -180 AND 180
          ) AS mapped_total
        FROM live_portal_requests
      `)
    ]);
    const total = Number(totalResult.rows[0] && totalResult.rows[0].total || 0);
    const mappedTotal = Number(totalResult.rows[0] && totalResult.rows[0].mapped_total || 0);
    const payload = buildLiveMapPayload(result.rows, {
      total,
      mapped_total: mappedTotal,
      unmapped_total: Math.max(0, total - mappedTotal)
    });
    if (pageLimit != null) {
      const lastRecord = payload.records[payload.records.length - 1];
      payload.page = {
        limit: pageLimit,
        returned: payload.records.length,
        has_more: payload.records.length === pageLimit,
        next_before_suffix: lastRecord ? lastRecord.suffix : null
      };
    }
    return res.json(payload);
  } catch (error) {
    console.error(JSON.stringify({ live_map_error: error.message }));
    return res.status(503).json(buildLiveMapPayload([]));
  }
});

app.get('/api/live-dashboard', async (req, res) => {
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 750)));
  try {
    const [recordsResult, statsResult, summaryResult] = await Promise.all([
      query(`
        SELECT live.srnumber, live.suffix, live.portal_id, live.problem, live.address,
               live.borough,live.incident_zip,
               live.latitude, live.longitude, live.submitted_at, live.status,
               live.portal_url, live.source, live.first_seen_at, live.last_seen_at,
               details.portal_id AS detail_portal_id,details.status AS detail_status,
               details.problem AS detail_problem,details.address AS detail_address,
               details.portal_url AS detail_portal_url,
               details.problem_details, details.additional_details, details.next_update,
               details.date_reported, details.updated_on, details.date_closed,
               details.archived_at AS details_fetched_at,
               followup.state AS followup_state,followup.next_check_at,
               followup.closure_cycle,followup.finalized_at,
               current_final.date_closed AS current_cycle_date_closed,
               current_final.final_state AS current_cycle_final_state,
               TRUE AS closure_cycle_tracking
        FROM live_portal_requests AS live
        LEFT JOIN portal_requests AS details ON details.srnumber = live.srnumber
        LEFT JOIN request_followup_queue AS followup ON followup.srnumber=live.srnumber
        LEFT JOIN LATERAL (
          SELECT snapshot.date_closed,snapshot.final_state
          FROM request_closure_snapshots snapshot
          WHERE snapshot.srnumber=followup.srnumber
            AND snapshot.closure_cycle=followup.closure_cycle
            AND snapshot.is_final=TRUE
          ORDER BY snapshot.id DESC LIMIT 1
        ) AS current_final ON TRUE
        ORDER BY live.suffix DESC
        LIMIT $1
      `, [limit]),
      query(`
        SELECT
          (SELECT COUNT(*) FROM live_portal_requests) AS total,
          (SELECT COUNT(*) FROM live_portal_requests
            WHERE latitude IS NULL OR longitude IS NULL) AS unmapped_total,
          (SELECT COUNT(*) FROM live_number_queue WHERE audit_outcome IN ('pending','working')) AS pending,
          COALESCE(
            (SELECT MAX(suffix) FROM live_number_queue),
            (SELECT value::bigint FROM live_monitor_state WHERE key='live_frontier'),
            (SELECT MAX(suffix) FROM live_portal_requests)
          ) AS frontier,
          (SELECT MAX(last_seen_at) FROM live_portal_requests) AS last_seen_at,
          COALESCE((SELECT value::integer FROM live_monitor_state WHERE key='poll_interval_seconds'),15) AS poll_interval_seconds,
          (SELECT COUNT(*) FROM portal_requests stored JOIN live_portal_requests captured USING (srnumber)) AS details_loaded,
          (SELECT COUNT(*) FROM live_portal_requests captured
            LEFT JOIN portal_requests stored USING (srnumber)
            WHERE stored.srnumber IS NULL) AS details_pending,
          (SELECT COUNT(*) FROM request_followup_queue WHERE state='closing') AS closure_refreshes_pending,
          (SELECT COUNT(*) FROM request_followup_queue WHERE state='open') AS open_followups_scheduled,
          (SELECT COUNT(*) FROM request_followup_queue WHERE state='closed') AS closures_finalized
      `),
      query(`
        SELECT id, window_started_at, window_ended_at, request_count, summary, model, created_at
        FROM ai_summaries ORDER BY created_at DESC LIMIT 1
      `)
    ]);
    const records = recordsResult.rows.map(stored => {
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
      record.submitted_at = hasText(record.submitted_at) ? record.submitted_at : record.date_reported;
      record.closure_cycle_tracking = Boolean(record.closure_cycle_tracking);
      Object.assign(record, currentLifecycleProjection(record));
      record.portal_url = hasText(record.portal_url)
        ? record.portal_url
        : detailPortalUrl || (record.portal_id
          ? `https://portal.311.nyc.gov/sr-details/?id=${record.portal_id}`
          : null);
      return { ...record, ...assessRecordAvailability(record) };
    });
    res.json({
      records,
      stats: statsResult.rows[0],
      latest_summary: summaryResult.rows[0] || null
    });
  } catch (error) {
    console.error(JSON.stringify({ live_dashboard_error: error.message }));
    res.status(503).json({ error: 'The cloud database is temporarily unavailable', records: [], stats: {} });
  }
});

app.get('/api/portal-detail', async (req, res) => {
  const portalId = String(req.query.id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(portalId)) return res.status(400).json({ error: 'valid id parameter required' });
  try {
    const requestResult = await query(
      `SELECT live.srnumber, live.suffix, details.status, details.problem,
              details.problem_details, details.additional_details, details.address,
              details.next_update, details.date_reported, details.updated_on,
              details.date_closed, details.fields_json, details.archived_at
       FROM live_portal_requests AS live
       LEFT JOIN portal_requests AS details ON details.srnumber=live.srnumber
       WHERE live.portal_id=$1`,
      [portalId]
    );
    if (!requestResult.rowCount) return res.status(404).json({ error: 'request is not in the cloud archive' });
    const row = requestResult.rows[0];
    if (req.query.preferArchive === '1') {
      if (!row.archived_at) {
        return res.status(404).json({ error: 'Submitted details are still being saved' });
      }
      res.setHeader('X-Detail-Source', 'archive');
      return res.json(storedPortalDetailFromRow(row));
    }
    const parsed = await fetchDetailById(row.srnumber, portalId);
    if (parsed.outcome !== 'found') throw new Error(parsed.error || 'Portal detail was not found');
    const detail = parsed.record.dateClosed && !isClosedStatus(parsed.record.status)
      ? { ...parsed.record, status: 'Closed' }
      : parsed.record;
    const now = new Date();
    await transaction(async client => {
      const currentResult = await client.query(
        'SELECT status FROM live_portal_requests WHERE srnumber=$1 FOR UPDATE',
        [row.srnumber]
      );
      const current = currentResult.rows[0] || { status: null };
      const followup = await getFollowUp(client, row.srnumber, true);
      const preserveMapClosure = isClosedStatus(current.status)
        && !isClosedStatus(detail.status)
        && followup
        && followup.state === 'closing';
      const effectiveStatus = preserveMapClosure
        ? current.status
        : (detail.status || current.status || null);
      if (detail.status && !preserveMapClosure && !statusesMatch(current.status, detail.status)) {
        await observeStatus(client, {
          srnumber: row.srnumber,
          previousStatus: current.status,
          status: detail.status,
          source: 'detail',
          effectiveAt: isClosedStatus(detail.status)
            ? (detail.dateClosed || detail.updatedOn)
            : detail.updatedOn,
          observedAt: now,
          snapshot: detail
        });
        await client.query(
          'UPDATE live_portal_requests SET status=$2 WHERE srnumber=$1',
          [row.srnumber, detail.status]
        );
      }
      await client.query(`
        INSERT INTO portal_requests (
          srnumber,suffix,portal_id,status,problem,problem_details,additional_details,
          address,next_update,date_reported,updated_on,date_closed,fields_json,portal_url,archived_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
        ON CONFLICT (srnumber) DO UPDATE SET
          portal_id=COALESCE(EXCLUDED.portal_id,portal_requests.portal_id),
          status=CASE WHEN portal_requests.date_closed IS NOT NULL AND EXCLUDED.date_closed IS NULL
            THEN portal_requests.status ELSE COALESCE(EXCLUDED.status,portal_requests.status) END,
          problem=COALESCE(EXCLUDED.problem,portal_requests.problem),
          problem_details=COALESCE(EXCLUDED.problem_details,portal_requests.problem_details),
          additional_details=COALESCE(EXCLUDED.additional_details,portal_requests.additional_details),
          address=COALESCE(EXCLUDED.address,portal_requests.address),
          next_update=COALESCE(EXCLUDED.next_update,portal_requests.next_update),
          date_reported=COALESCE(EXCLUDED.date_reported,portal_requests.date_reported),
          updated_on=COALESCE(EXCLUDED.updated_on,portal_requests.updated_on),
          date_closed=COALESCE(EXCLUDED.date_closed,portal_requests.date_closed),
          fields_json=portal_requests.fields_json || EXCLUDED.fields_json,
          portal_url=COALESCE(EXCLUDED.portal_url,portal_requests.portal_url),
          archived_at=EXCLUDED.archived_at
      `, [
        detail.srnumber, row.suffix, portalId, detail.status, detail.problem, detail.problemDetails,
        detail.additionalDetails, detail.address, detail.nextUpdate, detail.dateReported,
        detail.updatedOn, detail.dateClosed, JSON.stringify(detail.fields),
        `https://portal.311.nyc.gov/sr-details/?id=${portalId}`, now
      ]);
      await client.query(`
        UPDATE live_detail_queue
        SET status='found', attempts=attempts+1, last_error=NULL, updated_at=$2
        WHERE srnumber=$1
      `, [row.srnumber, now]);
      await scheduleAfterDetail(client, {
        srnumber: row.srnumber,
        portalId,
        effectiveStatus,
        detail,
        source: 'detail',
        checkedAt: now
      });
    });
    res.json({
      srnumber: detail.srnumber,
      status: detail.status,
      problem: detail.problem,
      problemDetails: detail.problemDetails,
      additionalDetails: detail.additionalDetails,
      address: detail.address,
      nextUpdate: detail.nextUpdate,
      dateReported: detail.dateReported,
      updatedOn: detail.updatedOn,
      dateClosed: detail.dateClosed,
      fields: detail.fields
    });
  } catch (error) {
    console.error(JSON.stringify({ portal_detail_error: error.message }));
    res.status(502).json({ error: 'Case details are temporarily unavailable' });
  }
});

app.post('/api/live-settings', requireDashboardLogin, async (req, res) => {
  const interval = Number((req.body && req.body.poll_interval_seconds) ?? req.query.poll_interval_seconds);
  if (![5, 10, 15, 30, 60].includes(interval)) {
    return res.status(400).json({ error: 'poll_interval_seconds must be 5, 10, 15, 30, or 60' });
  }
  try {
    await query(`
      INSERT INTO live_monitor_state (key,value,updated_at)
      VALUES ('poll_interval_seconds',$1,NOW())
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at
    `, [String(interval)]);
    res.json({ poll_interval_seconds: interval });
  } catch (error) {
    res.status(503).json({ error: 'Could not update cloud monitor settings' });
  }
});

app.get('/api/status-history/:srnumber', async (req, res) => {
  if (!/^311-\d{8}$/.test(req.params.srnumber)) return res.status(400).json({ error: 'invalid request number' });
  const [history, snapshots, followup] = await Promise.all([
    query(`
      SELECT id,previous_status,status,source,effective_at,observed_at
      FROM request_status_history WHERE srnumber=$1 ORDER BY id
    `, [req.params.srnumber]),
    query(`
      SELECT id,closure_cycle,status,date_closed,source,fetched_at,is_final,
             final_state,content_hash,snapshot_json AS snapshot
      FROM request_closure_snapshots WHERE srnumber=$1 ORDER BY id
    `, [req.params.srnumber]),
    query(`
      SELECT state,next_check_at,attempts,closing_attempts,closure_cycle,
             last_checked_at,last_success_at,last_error,finalized_at,updated_at
      FROM request_followup_queue WHERE srnumber=$1
    `, [req.params.srnumber])
  ]);
  res.json({
    srnumber: req.params.srnumber,
    history: history.rows,
    closure_snapshots: snapshots.rows,
    followup: followup.rows[0] || null
  });
});

let server;
async function start() {
  const schema = await query("SELECT to_regclass('public.request_followup_queue') IS NOT NULL AS ready");
  if (!schema.rows[0].ready) {
    throw new Error('Database schema is not ready; run npm run cloud:migrate before starting the web service');
  }
  if (process.env.NODE_ENV === 'production' && !DASHBOARD_PASSWORD) {
    throw new Error('DASHBOARD_PASSWORD is required in production');
  } else if (!DASHBOARD_PASSWORD) {
    console.warn('DASHBOARD_PASSWORD is not set; the cloud dashboard is publicly readable and settings are writable.');
  }
  server = app.listen(PORT, HOST, () => {
    console.log(`NYC 311 cloud dashboard listening on ${HOST}:${PORT}`);
  });
}

async function shutdown() {
  if (server) await new Promise(resolve => server.close(resolve));
  await close();
}
process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));
process.on('SIGINT', () => shutdown().finally(() => process.exit(0)));

start().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
