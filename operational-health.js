'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const CONTRACT_VERSION = 1;
const STATUS_VALUES = Object.freeze([
  'healthy',
  'delayed',
  'attention',
  'quiet'
]);
const VALID_STATUSES = new Set(STATUS_VALUES);
const MAX_FUTURE_SKEW_SECONDS = 60;

const DEFAULT_THRESHOLDS = Object.freeze({
  collectorHealthyFloorSeconds: 60,
  collectorAttentionFloorSeconds: 300,
  queueDelayedAfterSeconds: 60,
  queueAttentionAfterSeconds: 15 * 60,
  processingAttentionAfterSeconds: 10 * 60,
  emailQuietAfterSeconds: 6 * 60 * 60
});

function textOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function safeInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function isoTimestamp(value) {
  const timestamp = textOrNull(value);
  const milliseconds = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

function ageSeconds(timestamp, nowMs) {
  const normalized = isoTimestamp(timestamp);
  if (!normalized) return null;
  const timestampMs = Date.parse(normalized);
  if (timestampMs > nowMs + MAX_FUTURE_SKEW_SECONDS * 1000) return null;
  return Math.max(0, Math.round((nowMs - timestampMs) / 1000));
}

function dueDescriptor(row, nowMs) {
  if (!row) return null;
  const dueAt = isoTimestamp(row.next_attempt_at || row.next_check_at);
  const updatedAt = isoTimestamp(row.updated_at);
  const dueDelta = dueAt == null
    ? null
    : Math.round((Date.parse(dueAt) - nowMs) / 1000);
  return {
    state: textOrNull(row.state || row.status),
    due: dueAt == null
      ? 'unscheduled'
      : dueDelta < 0 ? 'overdue' : dueDelta === 0 ? 'due_now' : 'scheduled',
    due_at: dueAt,
    due_in_seconds: dueDelta == null ? null : Math.max(0, dueDelta),
    overdue_seconds: dueDelta == null ? null : Math.max(0, -dueDelta),
    updated_at: updatedAt,
    updated_age_seconds: ageSeconds(updatedAt, nowMs),
    attempts: safeInteger(row.attempts),
    has_error: Boolean(row.has_error)
  };
}

function queueStatus(descriptor, thresholds, {
  processingState = 'processing',
  finalErrorState = 'error'
} = {}) {
  if (!descriptor) return { status: 'quiet', reason: 'queue_empty' };
  if (descriptor.state === finalErrorState) {
    return { status: 'attention', reason: 'work_failed' };
  }
  if (descriptor.state === processingState) {
    const age = descriptor.updated_age_seconds;
    if (age == null || age > thresholds.processingAttentionAfterSeconds) {
      return { status: 'attention', reason: 'work_stalled' };
    }
    return { status: 'healthy', reason: 'work_in_progress' };
  }
  if (descriptor.due === 'unscheduled') {
    return { status: 'attention', reason: 'work_unscheduled' };
  }
  const overdue = descriptor.overdue_seconds || 0;
  if (overdue > thresholds.queueAttentionAfterSeconds) {
    return { status: 'attention', reason: 'work_stalled' };
  }
  if (overdue > thresholds.queueDelayedAfterSeconds) {
    return { status: 'delayed', reason: 'work_overdue' };
  }
  return {
    status: 'healthy',
    reason: descriptor.due === 'scheduled' ? 'work_scheduled' : 'work_due'
  };
}

function queueComponent(rows, nowMs, thresholds, options) {
  const candidates = rows.filter(Boolean).map(row => {
    const next = dueDescriptor(row, nowMs);
    return { ...queueStatus(next, thresholds, options), next };
  });
  if (!candidates.length) {
    return {
      status: 'quiet',
      reason: 'queue_empty',
      available: true,
      next: null
    };
  }
  const severity = { attention: 3, delayed: 2, healthy: 1, quiet: 0 };
  const reasonPriority = {
    work_failed: 4,
    work_stalled: 3,
    work_unscheduled: 2,
    work_overdue: 1
  };
  candidates.sort((left, right) => {
    const statusDifference = severity[right.status] - severity[left.status];
    if (statusDifference) return statusDifference;
    const reasonDifference = (reasonPriority[right.reason] || 0)
      - (reasonPriority[left.reason] || 0);
    if (reasonDifference) return reasonDifference;
    const leftDue = left.next.due_at ? Date.parse(left.next.due_at) : -Infinity;
    const rightDue = right.next.due_at ? Date.parse(right.next.due_at) : -Infinity;
    return leftDue - rightDue;
  });
  return { ...candidates[0], available: true };
}

function readState(database, key) {
  return database.prepare(`
    SELECT value,updated_at
    FROM live_monitor_state
    WHERE key=?
    LIMIT 1
  `).get(key) || null;
}

function readQueueState(database, {
  table,
  stateColumn,
  state,
  dueColumn
}) {
  const sql = `
    SELECT ${stateColumn} AS state,${dueColumn},updated_at,attempts,
      CASE WHEN last_error IS NULL OR TRIM(last_error)='' THEN 0 ELSE 1 END AS has_error
    FROM ${table}
    WHERE ${stateColumn}=?
    ORDER BY ${dueColumn}
    LIMIT 1
  `;
  return database.prepare(sql).get(state) || null;
}

function unavailableComponent(reason = 'database_unavailable') {
  return {
    status: 'attention',
    reason,
    available: false
  };
}

function mapDiscoveryComponent(database, nowMs, thresholds) {
  const lastPollRow = readState(database, 'last_successful_poll_at');
  const intervalRow = readState(database, 'poll_interval_seconds');
  const lastPollAt = isoTimestamp(lastPollRow && lastPollRow.value);
  const pollIntervalSeconds = Math.max(
    5,
    safeInteger(intervalRow && intervalRow.value, 15)
  );
  const pollAgeSeconds = ageSeconds(lastPollAt, nowMs);
  const healthyWindow = Math.max(
    thresholds.collectorHealthyFloorSeconds,
    pollIntervalSeconds * 4
  );
  const attentionWindow = Math.max(
    thresholds.collectorAttentionFloorSeconds,
    pollIntervalSeconds * 20
  );

  if (!lastPollRow || !lastPollAt) {
    return {
      status: 'attention',
      reason: 'poll_missing',
      available: true,
      last_successful_poll_at: null,
      poll_age_seconds: null,
      poll_interval_seconds: pollIntervalSeconds
    };
  }
  if (pollAgeSeconds == null) {
    return {
      status: 'attention',
      reason: 'poll_timestamp_invalid',
      available: true,
      last_successful_poll_at: lastPollAt,
      poll_age_seconds: null,
      poll_interval_seconds: pollIntervalSeconds
    };
  }
  return {
    status: pollAgeSeconds <= healthyWindow
      ? 'healthy'
      : pollAgeSeconds <= attentionWindow ? 'delayed' : 'attention',
    reason: pollAgeSeconds <= healthyWindow
      ? 'poll_fresh'
      : pollAgeSeconds <= attentionWindow ? 'poll_delayed' : 'poll_stale',
    available: true,
    last_successful_poll_at: lastPollAt,
    poll_age_seconds: pollAgeSeconds,
    poll_interval_seconds: pollIntervalSeconds
  };
}

function detailsComponent(database, nowMs, thresholds) {
  return queueComponent(['working', 'pending', 'retry'].map(state =>
    readQueueState(database, {
      table: 'live_detail_queue',
      stateColumn: 'status',
      state,
      dueColumn: 'next_attempt_at'
    })
  ), nowMs, thresholds, {
    processingState: 'working',
    finalErrorState: null
  });
}

function emailIntakeComponent(database, nowMs, thresholds) {
  const row = database.prepare(`
    SELECT id,received_at,created_at,parse_outcome,alias_match_status
    FROM nyc311_email_events
    ORDER BY id DESC
    LIMIT 1
  `).get();
  if (!row) {
    return {
      status: 'quiet',
      reason: 'no_events_yet',
      available: true,
      latest_event: null
    };
  }

  const receivedAt = isoTimestamp(row.received_at || row.created_at);
  const eventAgeSeconds = ageSeconds(receivedAt, nowMs);
  const parseOutcome = textOrNull(row.parse_outcome);
  const aliasMatchStatus = textOrNull(row.alias_match_status);
  const usable = parseOutcome === 'parsed'
    && ['matched', 'attached'].includes(aliasMatchStatus);
  return {
    status: !usable
      ? 'attention'
      : eventAgeSeconds != null && eventAgeSeconds <= thresholds.emailQuietAfterSeconds
        ? 'healthy'
        : 'quiet',
    reason: !usable
      ? 'latest_event_needs_review'
      : eventAgeSeconds != null && eventAgeSeconds <= thresholds.emailQuietAfterSeconds
        ? 'event_recent'
        : 'event_stream_quiet',
    available: true,
    latest_event: {
      id: safeInteger(row.id),
      received_at: receivedAt,
      age_seconds: eventAgeSeconds,
      parse_outcome: parseOutcome,
      alias_match_status: aliasMatchStatus
    }
  };
}

function subscriptionsComponent(database, nowMs, thresholds) {
  return queueComponent(['error', 'processing', 'pending', 'retry'].map(state =>
    readQueueState(database, {
      table: 'nyc311_email_subscription_jobs',
      stateColumn: 'state',
      state,
      dueColumn: 'next_attempt_at'
    })
  ), nowMs, thresholds);
}

function closureVerificationComponent(database, nowMs, thresholds) {
  const row = readQueueState(database, {
    table: 'request_followup_queue',
    stateColumn: 'state',
    state: 'closing',
    dueColumn: 'next_check_at'
  });
  return queueComponent([row], nowMs, thresholds, {
    processingState: null,
    finalErrorState: null
  });
}

function analyticsComponent(input, nowMs) {
  const envelope = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : {};
  const payload = envelope.payload
    && typeof envelope.payload === 'object'
    && !Array.isArray(envelope.payload)
    ? envelope.payload
    : envelope;
  const explicitStatus = VALID_STATUSES.has(payload.status)
    ? payload.status
    : VALID_STATUSES.has(envelope.status) ? envelope.status : null;
  const generatedAt = isoTimestamp(
    payload.metrics_generated_at || payload.generated_at || envelope.generated_at
  );
  const refreshing = Boolean(
    payload.metrics_refreshing == null
      ? payload.refreshing
      : payload.metrics_refreshing
  );
  const stale = Boolean(
    payload.metrics_stale == null ? payload.stale : payload.metrics_stale
  );
  const refreshDisabled = Boolean(
    payload.metrics_refresh_disabled == null
      ? envelope.refreshEnabled === false
      : payload.metrics_refresh_disabled
  );
  const failed = Number(envelope.statusCode) >= 500
    || Boolean(payload.error)
    || Boolean(payload.metrics_refresh_error && !generatedAt);

  let status = explicitStatus;
  let reason = explicitStatus ? 'status_provided' : null;
  if (!status && failed) {
    status = 'attention';
    reason = 'snapshot_unavailable';
  } else if (!status && refreshDisabled && generatedAt) {
    status = 'quiet';
    reason = 'snapshot_saved_refresh_disabled';
  } else if (!status && (stale || (refreshing && generatedAt))) {
    status = 'delayed';
    reason = 'snapshot_refreshing';
  } else if (!status && refreshing) {
    status = 'delayed';
    reason = 'snapshot_building';
  } else if (!status && generatedAt) {
    status = 'healthy';
    reason = 'snapshot_ready';
  } else if (!status) {
    status = 'quiet';
    reason = 'snapshot_not_requested';
  }

  return {
    status,
    reason,
    available: Boolean(generatedAt),
    generated_at: generatedAt,
    age_seconds: ageSeconds(generatedAt, nowMs),
    refreshing,
    stale,
    ...(refreshDisabled ? { refresh_disabled: true } : {})
  };
}

function overallStatus(components) {
  const statuses = Object.values(components).map(component => component.status);
  if (statuses.includes('attention')) return 'attention';
  if (statuses.includes('delayed')) return 'delayed';
  if (statuses.includes('healthy')) return 'healthy';
  return 'quiet';
}

function loadOperationalHealth(databasePath, {
  now = new Date(),
  analyticsSnapshot = null,
  thresholds = {},
  statSync = fs.statSync,
  openDatabase = (filename, options) => new DatabaseSync(filename, options)
} = {}) {
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) throw new TypeError('now must be a valid date');
  const nowMs = current.getTime();
  const generatedAt = current.toISOString();
  const selectedThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const analytics = analyticsComponent(analyticsSnapshot, nowMs);

  let stats;
  try {
    stats = statSync(databasePath);
    if (!stats.isFile()) throw new Error('not a file');
  } catch (_) {
    const components = {
      database: unavailableComponent('database_missing'),
      map_discovery: unavailableComponent(),
      details: unavailableComponent(),
      email_intake: unavailableComponent(),
      subscriptions: unavailableComponent(),
      closure_verification: unavailableComponent(),
      analytics
    };
    return {
      version: CONTRACT_VERSION,
      generated_at: generatedAt,
      status: overallStatus(components),
      components
    };
  }

  let database;
  try {
    database = openDatabase(databasePath, { readOnly: true });
  } catch (_) {
    const components = {
      database: {
        ...unavailableComponent(),
        file_size_bytes: safeInteger(stats.size),
        file_modified_at: isoTimestamp(stats.mtime)
      },
      map_discovery: unavailableComponent(),
      details: unavailableComponent(),
      email_intake: unavailableComponent(),
      subscriptions: unavailableComponent(),
      closure_verification: unavailableComponent(),
      analytics
    };
    return {
      version: CONTRACT_VERSION,
      generated_at: generatedAt,
      status: overallStatus(components),
      components
    };
  }

  const components = {
    database: {
      status: 'healthy',
      reason: 'database_ready',
      available: true,
      file_size_bytes: safeInteger(stats.size),
      file_modified_at: isoTimestamp(stats.mtime)
    }
  };
  const readers = [
    ['map_discovery', () => mapDiscoveryComponent(database, nowMs, selectedThresholds)],
    ['details', () => detailsComponent(database, nowMs, selectedThresholds)],
    ['email_intake', () => emailIntakeComponent(database, nowMs, selectedThresholds)],
    ['subscriptions', () => subscriptionsComponent(database, nowMs, selectedThresholds)],
    [
      'closure_verification',
      () => closureVerificationComponent(database, nowMs, selectedThresholds)
    ]
  ];
  try {
    for (const [name, read] of readers) {
      try {
        components[name] = read();
      } catch (_) {
        components[name] = unavailableComponent('component_unavailable');
      }
    }
  } finally {
    database.close();
  }
  components.analytics = analytics;

  return {
    version: CONTRACT_VERSION,
    generated_at: generatedAt,
    status: overallStatus(components),
    components
  };
}

module.exports = {
  CONTRACT_VERSION,
  DEFAULT_THRESHOLDS,
  MAX_FUTURE_SKEW_SECONDS,
  STATUS_VALUES,
  analyticsComponent,
  dueDescriptor,
  loadOperationalHealth,
  overallStatus,
  queueStatus
};
