'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_EARLY_SUBSCRIPTION_SECONDS = 15 * 60;
const DEFAULT_CLOSURE_GRACE_SECONDS = 60 * 60;
const DEFAULT_MAX_GROUPS = 50;
const MAX_GROUPS_LIMIT = 250;
const ZONED_TIMESTAMP_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function finiteNonnegativeInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(maximum, Math.floor(parsed));
}

function isoTimestamp(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const text = String(value || '').trim();
  if (!text || !ZONED_TIMESTAMP_PATTERN.test(text)) return null;
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function instantMilliseconds(value) {
  const timestamp = isoTimestamp(value);
  return timestamp ? Date.parse(timestamp) : null;
}

function elapsedSeconds(start, end) {
  const startMilliseconds = instantMilliseconds(start);
  const endMilliseconds = instantMilliseconds(end);
  if (startMilliseconds == null || endMilliseconds == null) return null;
  const seconds = (endMilliseconds - startMilliseconds) / 1000;
  return Number.isFinite(seconds) ? seconds : null;
}

function roundedSeconds(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

function durationStatistics(values) {
  const sorted = values
    .filter(value => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  const sampleSize = sorted.length;
  if (!sampleSize) {
    return {
      sample_size: 0,
      median_seconds: null,
      p90_seconds: null
    };
  }
  const middle = Math.floor(sampleSize / 2);
  const median = sampleSize % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  const p90Index = Math.max(0, Math.ceil(sampleSize * 0.9) - 1);
  return {
    sample_size: sampleSize,
    median_seconds: roundedSeconds(median),
    p90_seconds: roundedSeconds(sorted[p90Index])
  };
}

function emptyDurationStatistics() {
  return durationStatistics([]);
}

function emptyMetrics(now = new Date(), databaseAvailable = true) {
  const asOf = isoTimestamp(now) || new Date().toISOString();
  return {
    as_of: asOf,
    database_available: databaseAvailable,
    deliveries: {
      all_accepted: 0,
      usable: 0,
      detail_complete: 0,
      excluded_non_direct: 0,
      submitted: 0,
      updated: 0,
      closed: 0,
      other_or_unknown: 0,
      issues: 0,
      parser_issues: 0,
      reconciliation_issues: 0,
      authentication_issues: 0,
      detail_issues: 0,
      unrecognized_submitted: 0,
      latest_received_at: null
    },
    subscriptions: {
      total: 0,
      states: {},
      confirmed: 0,
      lag: {
        ...emptyDurationStatistics(),
        within_early_window: 0,
        early_window_seconds: DEFAULT_EARLY_SUBSCRIPTION_SECONDS
      }
    },
    measured_closure_email_coverage: {
      eligible_portal_closures: 0,
      closed_email_observed: 0,
      missing: 0,
      missing_after_grace: 0,
      mature_eligible_portal_closures: 0,
      mature_closed_email_observed: 0,
      awaiting_within_grace: 0,
      grace_seconds: DEFAULT_CLOSURE_GRACE_SECONDS,
      observed_coverage_percent: null,
      mature_coverage_percent: null,
      limitation: 'Only closures independently present in stored Portal detail can enter this denominator'
    },
    observed_response_times: {
      definitions: {
        first_updated: 'Canonical Portal submission to first usable Updated email received',
        portal_closure: 'Canonical Portal submission to Portal-published closure time, attributed by the first usable Closed email',
        closure_notification_delay: 'Portal-published closure time to first usable Closed email received',
        breakdown_scope: 'Agency and complaint breakdowns contain observed event-attributed requests only; right-censored requests remain in prospective_cohort counts'
      },
      prospective_cohort: {
        requests: 0,
        started_at: null,
        early_subscription_seconds: DEFAULT_EARLY_SUBSCRIPTION_SECONDS,
        right_censored_without_first_updated: 0,
        right_censored_without_observed_portal_closure: 0
      },
      overall: {
        first_updated: emptyDurationStatistics(),
        portal_closure: emptyDurationStatistics(),
        closure_notification_delay: emptyDurationStatistics()
      },
      by_agency: [],
      by_complaint_type: []
    },
    data_quality: {
      subscription_rows_missing_submitted_time: 0,
      subscription_rows_invalid_submitted_time: 0,
      subscription_rows_invalid_subscribed_time: 0,
      negative_subscription_lag: 0,
      late_subscriptions_excluded_from_response_times: 0,
      response_rows_missing_portal_closure_time: 0,
      invalid_or_negative_response_durations: 0
    }
  };
}

function tableNames(database) {
  return new Set(database.prepare(`
    SELECT name FROM sqlite_master WHERE type='table'
  `).all().map(row => row.name));
}

function collectorBidOnly(database, tables) {
  if (!tables.has('live_monitor_state')) return false;
  const row = database.prepare(`
    SELECT value FROM live_monitor_state WHERE key='collector_scope' LIMIT 1
  `).get();
  return String(row && row.value || '').trim().toLowerCase() === 'bid_only';
}

function activeBidMembershipWhere(srnumberSql) {
  return `EXISTS (
    SELECT 1
    FROM live_request_bid_memberships AS metric_membership
    JOIN business_improvement_district_boundary_versions AS metric_boundary
      ON metric_boundary.version=metric_membership.boundary_version
     AND metric_boundary.active=1
    WHERE metric_membership.srnumber=${srnumberSql}
  )`;
}

function canonicalSubmittedSql(hasPortalRequests) {
  return hasPortalRequests
    ? `COALESCE(
         NULLIF(TRIM(portal.date_reported),''),
         NULLIF(TRIM(live.submitted_at),'')
       )`
    : `NULLIF(TRIM(live.submitted_at),'')`;
}

function portalJoinSql(hasPortalRequests) {
  return hasPortalRequests
    ? 'LEFT JOIN portal_requests AS portal ON portal.srnumber=live.srnumber'
    : '';
}

function portalClosedSql(hasPortalRequests) {
  return hasPortalRequests ? 'portal.date_closed' : 'NULL';
}

function matchedEmailWhere(alias = 'email') {
  return `${alias}.parse_outcome='parsed'
    AND ${alias}.srnumber_mismatch=0
    AND ${alias}.alias_match_status IN ('matched','attached')
    AND ${alias}.reconciled_srnumber IS NOT NULL
    AND TRIM(${alias}.reconciled_srnumber)<>''`;
}

function senderAuthenticationPassedWhere(alias = 'email') {
  return `UPPER(TRIM(COALESCE(${alias}.spam_verdict,'')))='PASS'
    AND UPPER(TRIM(COALESCE(${alias}.virus_verdict,'')))='PASS'
    AND UPPER(TRIM(COALESCE(${alias}.dmarc_verdict,'')))='PASS'
    AND (
      UPPER(TRIM(COALESCE(${alias}.spf_verdict,'')))='PASS'
      OR UPPER(TRIM(COALESCE(${alias}.dkim_verdict,'')))='PASS'
    )`;
}

function matchedAuthenticatedEmailWhere(alias = 'email') {
  return `${matchedEmailWhere(alias)}
    AND ${senderAuthenticationPassedWhere(alias)}`;
}

function usableEmailWhere(alias = 'email') {
  return `${matchedAuthenticatedEmailWhere(alias)}
    AND json_extract(${alias}.parsed_json,'$.deliveryMode')='direct'`;
}

function expectedDetailIssueWhere(alias = 'email') {
  return `(${usableEmailWhere(alias)})
    AND LOWER(TRIM(COALESCE(${alias}.event_kind,'')))
      IN ('submitted','updated','closed')
    AND (
      NULLIF(TRIM(COALESCE(${alias}.agency_name,'')),'') IS NULL
      OR NULLIF(TRIM(COALESCE(${alias}.request_type,'')),'') IS NULL
      OR (
        LOWER(TRIM(COALESCE(${alias}.event_kind,''))) IN ('updated','closed')
        AND NULLIF(TRIM(COALESCE(${alias}.response_text,'')),'') IS NULL
      )
    )`;
}

function loadDeliveryMetrics(database, bidOnly = false) {
  const row = database.prepare(`
    SELECT
      COUNT(*) AS all_accepted,
      SUM(CASE WHEN ${usableEmailWhere()} THEN 1 ELSE 0 END) AS usable,
      SUM(CASE WHEN ${usableEmailWhere()}
        AND NOT (${expectedDetailIssueWhere()})
        THEN 1 ELSE 0 END) AS detail_complete,
      SUM(CASE WHEN ${matchedAuthenticatedEmailWhere()}
        AND COALESCE(json_extract(email.parsed_json,'$.deliveryMode'),'')<>'direct'
        THEN 1 ELSE 0 END) AS excluded_non_direct,
      SUM(CASE
        WHEN LOWER(TRIM(COALESCE(email.event_kind,'')))='submitted'
          OR (TRIM(COALESCE(email.event_kind,''))=''
            AND LOWER(TRIM(COALESCE(email.subject,''))) LIKE 'sr submitted #%')
        THEN 1 ELSE 0 END) AS submitted,
      SUM(CASE
        WHEN LOWER(TRIM(COALESCE(email.event_kind,'')))='updated'
          OR (TRIM(COALESCE(email.event_kind,''))=''
            AND LOWER(TRIM(COALESCE(email.subject,''))) LIKE 'sr updated #%')
        THEN 1 ELSE 0 END) AS updated,
      SUM(CASE
        WHEN LOWER(TRIM(COALESCE(email.event_kind,'')))='closed'
          OR (TRIM(COALESCE(email.event_kind,''))=''
            AND LOWER(TRIM(COALESCE(email.subject,''))) LIKE 'sr closed #%')
        THEN 1 ELSE 0 END) AS closed,
      SUM(CASE WHEN email.parse_outcome<>'parsed' THEN 1 ELSE 0 END) AS parser_issues,
      SUM(CASE
        WHEN email.parse_outcome<>'parsed'
          AND LOWER(TRIM(COALESCE(email.subject,''))) LIKE 'sr submitted #%'
        THEN 1 ELSE 0 END) AS unrecognized_submitted,
      SUM(CASE WHEN email.srnumber_mismatch<>0
        OR email.alias_match_status NOT IN ('matched','attached')
        OR email.reconciled_srnumber IS NULL
        OR TRIM(email.reconciled_srnumber)=''
        THEN 1 ELSE 0 END) AS reconciliation_issues,
      SUM(CASE WHEN ${matchedEmailWhere()}
        AND NOT (${senderAuthenticationPassedWhere()})
        THEN 1 ELSE 0 END) AS authentication_issues,
      SUM(CASE WHEN ${expectedDetailIssueWhere()} THEN 1 ELSE 0 END)
        AS detail_issues,
      SUM(CASE WHEN email.parse_outcome<>'parsed'
        OR email.srnumber_mismatch<>0
        OR email.alias_match_status NOT IN ('matched','attached')
        OR email.reconciled_srnumber IS NULL
        OR TRIM(email.reconciled_srnumber)=''
        OR (${matchedEmailWhere()}
          AND NOT (${senderAuthenticationPassedWhere()}))
        OR (${expectedDetailIssueWhere()})
        THEN 1 ELSE 0 END) AS issues,
      MAX(email.received_at) AS latest_received_at
    FROM nyc311_email_events AS email
    ${bidOnly ? `WHERE ${activeBidMembershipWhere('email.reconciled_srnumber')}` : ''}
  `).get();
  const submitted = Number(row.submitted || 0);
  const updated = Number(row.updated || 0);
  const closed = Number(row.closed || 0);
  const accepted = Number(row.all_accepted || 0);
  return {
    all_accepted: accepted,
    usable: Number(row.usable || 0),
    detail_complete: Number(row.detail_complete || 0),
    excluded_non_direct: Number(row.excluded_non_direct || 0),
    submitted,
    updated,
    closed,
    other_or_unknown: Math.max(0, accepted - submitted - updated - closed),
    issues: Number(row.issues || 0),
    parser_issues: Number(row.parser_issues || 0),
    reconciliation_issues: Number(row.reconciliation_issues || 0),
    authentication_issues: Number(row.authentication_issues || 0),
    detail_issues: Number(row.detail_issues || 0),
    unrecognized_submitted: Number(row.unrecognized_submitted || 0),
    latest_received_at: isoTimestamp(row.latest_received_at)
  };
}

function loadSubscriptionMetrics(
  database,
  tables,
  earlySubscriptionSeconds,
  dataQuality,
  bidOnly = false
) {
  if (!tables.has('nyc311_email_subscription_jobs')) {
    return {
      total: 0,
      states: {},
      confirmed: 0,
      lag: {
        ...emptyDurationStatistics(),
        within_early_window: 0,
        early_window_seconds: earlySubscriptionSeconds
      },
      prospectiveRequestNumbers: new Set(),
      prospectiveStartedAt: null
    };
  }

  const stateRows = database.prepare(`
    SELECT state,COUNT(*) AS count
    FROM nyc311_email_subscription_jobs
    ${bidOnly ? `WHERE ${activeBidMembershipWhere('nyc311_email_subscription_jobs.srnumber')}` : ''}
    GROUP BY state
    ORDER BY state
  `).all();
  const states = {};
  let total = 0;
  for (const row of stateRows) {
    const state = String(row.state || 'unknown').trim() || 'unknown';
    const count = Number(row.count || 0);
    states[state] = count;
    total += count;
  }
  const confirmed = Number(states.subscribed || 0);

  if (!tables.has('live_portal_requests')) {
    return {
      total,
      states,
      confirmed,
      lag: {
        ...emptyDurationStatistics(),
        within_early_window: 0,
        early_window_seconds: earlySubscriptionSeconds
      },
      prospectiveRequestNumbers: new Set(),
      prospectiveStartedAt: null
    };
  }

  const hasPortalRequests = tables.has('portal_requests');
  const rows = database.prepare(`
    SELECT jobs.srnumber,jobs.subscribed_at,
      ${canonicalSubmittedSql(hasPortalRequests)} AS canonical_submitted_at
    FROM nyc311_email_subscription_jobs AS jobs
    JOIN live_portal_requests AS live ON live.srnumber=jobs.srnumber
    ${portalJoinSql(hasPortalRequests)}
    WHERE jobs.state='subscribed'
      ${bidOnly ? `AND ${activeBidMembershipWhere('jobs.srnumber')}` : ''}
  `).all();

  const lagValues = [];
  const prospectiveRequestNumbers = new Set();
  let prospectiveStartedAt = null;
  let withinEarlyWindow = 0;
  for (const row of rows) {
    if (row.canonical_submitted_at == null || String(row.canonical_submitted_at).trim() === '') {
      dataQuality.subscription_rows_missing_submitted_time += 1;
      continue;
    }
    if (instantMilliseconds(row.canonical_submitted_at) == null) {
      dataQuality.subscription_rows_invalid_submitted_time += 1;
      continue;
    }
    if (instantMilliseconds(row.subscribed_at) == null) {
      dataQuality.subscription_rows_invalid_subscribed_time += 1;
      continue;
    }
    const lag = elapsedSeconds(row.canonical_submitted_at, row.subscribed_at);
    if (lag == null) {
      dataQuality.subscription_rows_invalid_subscribed_time += 1;
      continue;
    }
    if (lag < 0) {
      dataQuality.negative_subscription_lag += 1;
      continue;
    }
    lagValues.push(lag);
    if (lag <= earlySubscriptionSeconds) {
      withinEarlyWindow += 1;
      prospectiveRequestNumbers.add(String(row.srnumber));
      const submittedAt = isoTimestamp(row.canonical_submitted_at);
      if (submittedAt && (!prospectiveStartedAt || submittedAt < prospectiveStartedAt)) {
        prospectiveStartedAt = submittedAt;
      }
    } else {
      dataQuality.late_subscriptions_excluded_from_response_times += 1;
    }
  }

  return {
    total,
    states,
    confirmed,
    lag: {
      ...durationStatistics(lagValues),
      within_early_window: withinEarlyWindow,
      early_window_seconds: earlySubscriptionSeconds
    },
    prospectiveRequestNumbers,
    prospectiveStartedAt
  };
}

function loadClosureCoverage(database, tables, now, graceSeconds, bidOnly = false) {
  if (!tables.has('nyc311_email_subscription_jobs')
      || !tables.has('portal_requests')
      || !tables.has('nyc311_email_events')) {
    return {
      eligible_portal_closures: 0,
      closed_email_observed: 0,
      missing: 0,
      missing_after_grace: 0,
      mature_eligible_portal_closures: 0,
      mature_closed_email_observed: 0,
      awaiting_within_grace: 0,
      grace_seconds: graceSeconds,
      observed_coverage_percent: null,
      mature_coverage_percent: null,
      limitation: 'Only closures independently present in stored Portal detail can enter this denominator'
    };
  }
  const row = database.prepare(`
    WITH eligible AS (
      SELECT jobs.srnumber,portal.date_closed,jobs.subscribed_at,
        MIN(CASE
          WHEN ${usableEmailWhere()}
            AND LOWER(TRIM(COALESCE(email.event_kind,'')))='closed'
            AND julianday(email.received_at)>=julianday(jobs.subscribed_at)
            AND julianday(email.received_at)>=julianday(portal.date_closed)
          THEN email.received_at
          ELSE NULL
        END) AS closed_email_received_at
      FROM nyc311_email_subscription_jobs AS jobs
      JOIN portal_requests AS portal ON portal.srnumber=jobs.srnumber
      LEFT JOIN nyc311_email_events AS email
        ON email.reconciled_srnumber=jobs.srnumber
      WHERE jobs.state='subscribed'
        ${bidOnly ? `AND ${activeBidMembershipWhere('jobs.srnumber')}` : ''}
        AND jobs.subscribed_at IS NOT NULL
        AND portal.date_closed IS NOT NULL
        AND julianday(portal.date_closed)>=julianday(jobs.subscribed_at)
      GROUP BY jobs.srnumber,portal.date_closed,jobs.subscribed_at
    )
    SELECT
      COUNT(*) AS eligible_portal_closures,
      SUM(CASE WHEN closed_email_received_at IS NOT NULL THEN 1 ELSE 0 END)
        AS closed_email_observed,
      SUM(CASE WHEN closed_email_received_at IS NULL THEN 1 ELSE 0 END) AS missing,
      SUM(CASE WHEN closed_email_received_at IS NULL
        AND (julianday(@now)-julianday(date_closed))*86400>=@grace
        THEN 1 ELSE 0 END) AS missing_after_grace,
      SUM(CASE
        WHEN (julianday(@now)-julianday(date_closed))*86400>=@grace
        THEN 1 ELSE 0 END) AS mature_eligible_portal_closures,
      SUM(CASE
        WHEN closed_email_received_at IS NOT NULL
          AND (julianday(@now)-julianday(date_closed))*86400>=@grace
        THEN 1 ELSE 0 END) AS mature_closed_email_observed,
      SUM(CASE
        WHEN closed_email_received_at IS NULL
          AND (julianday(@now)-julianday(date_closed))*86400<@grace
        THEN 1 ELSE 0 END) AS awaiting_within_grace
    FROM eligible
  `).get({ now, grace: graceSeconds });
  const eligible = Number(row.eligible_portal_closures || 0);
  const observed = Number(row.closed_email_observed || 0);
  const matureEligible = Number(row.mature_eligible_portal_closures || 0);
  const matureObserved = Number(row.mature_closed_email_observed || 0);
  return {
    eligible_portal_closures: eligible,
    closed_email_observed: observed,
    missing: Number(row.missing || 0),
    missing_after_grace: Number(row.missing_after_grace || 0),
    mature_eligible_portal_closures: matureEligible,
    mature_closed_email_observed: matureObserved,
    awaiting_within_grace: Number(row.awaiting_within_grace || 0),
    grace_seconds: graceSeconds,
    observed_coverage_percent: eligible
      ? Math.round((observed / eligible) * 1000) / 10
      : null,
    mature_coverage_percent: matureEligible
      ? Math.round((matureObserved / matureEligible) * 1000) / 10
      : null,
    limitation: 'Only closures independently present in stored Portal detail can enter this denominator'
  };
}

function normalizedLabel(value, fallback) {
  const label = String(value || '').replace(/\s+/g, ' ').trim();
  return label || fallback;
}

function agencyIdentity(row) {
  const acronym = normalizedLabel(row.agency_acronym, null);
  const name = normalizedLabel(row.agency_name, null);
  const label = acronym || name || 'Unknown agency';
  return {
    key: (acronym || name || 'unknown agency').toLocaleLowerCase('en-US'),
    label,
    acronym,
    name
  };
}

function getGroup(map, identity) {
  if (!map.has(identity.key)) {
    map.set(identity.key, {
      ...identity,
      firstUpdated: [],
      portalClosure: [],
      closureDelay: []
    });
  }
  const group = map.get(identity.key);
  if (!group.name && identity.name) group.name = identity.name;
  if (!group.acronym && identity.acronym) group.acronym = identity.acronym;
  if (group.label === 'Unknown agency' && identity.label) group.label = identity.label;
  return group;
}

function responseGroupRows(groups, minimumSample, maxGroups, includeAgencyFields) {
  return [...groups.values()].map(group => {
    const firstUpdated = durationStatistics(group.firstUpdated);
    const portalClosure = durationStatistics(group.portalClosure);
    const closureDelay = durationStatistics(group.closureDelay);
    const totalSample = firstUpdated.sample_size + portalClosure.sample_size;
    return {
      ...(includeAgencyFields ? {
        agency: group.label,
        agency_name: group.name,
        agency_acronym: group.acronym
      } : {
        complaint_type: group.label
      }),
      first_updated: firstUpdated,
      portal_closure: portalClosure,
      closure_notification_delay: closureDelay,
      total_observed_sample: totalSample
    };
  }).filter(row => row.total_observed_sample >= minimumSample)
    .sort((left, right) => (
      right.total_observed_sample - left.total_observed_sample
      || String(left.agency || left.complaint_type).localeCompare(
        String(right.agency || right.complaint_type)
      )
    ))
    .slice(0, maxGroups);
}

function loadResponseMetrics(
  database,
  tables,
  prospectiveRequestNumbers,
  prospectiveStartedAt,
  earlySubscriptionSeconds,
  minimumGroupSample,
  maxGroups,
  dataQuality,
  bidOnly = false
) {
  const empty = {
    definitions: {
      first_updated: 'Canonical Portal submission to first usable Updated email received',
      portal_closure: 'Canonical Portal submission to Portal-published closure time, attributed by the first usable Closed email',
      closure_notification_delay: 'Portal-published closure time to first usable Closed email received',
      breakdown_scope: 'Agency and complaint breakdowns contain observed event-attributed requests only; right-censored requests remain in prospective_cohort counts'
    },
    prospective_cohort: {
      requests: prospectiveRequestNumbers.size,
      started_at: prospectiveStartedAt,
      early_subscription_seconds: earlySubscriptionSeconds,
      right_censored_without_first_updated: prospectiveRequestNumbers.size,
      right_censored_without_observed_portal_closure: prospectiveRequestNumbers.size
    },
    overall: {
      first_updated: emptyDurationStatistics(),
      portal_closure: emptyDurationStatistics(),
      closure_notification_delay: emptyDurationStatistics()
    },
    by_agency: [],
    by_complaint_type: []
  };
  if (!prospectiveRequestNumbers.size
      || !tables.has('nyc311_email_events')
      || !tables.has('nyc311_email_subscription_jobs')
      || !tables.has('live_portal_requests')) return empty;

  const hasPortalRequests = tables.has('portal_requests');
  const rows = database.prepare(`
    WITH candidates AS (
      SELECT email.id,email.reconciled_srnumber AS srnumber,email.event_kind,
        email.received_at,email.agency_name,email.agency_acronym,
        email.request_type,email.request_subtype,jobs.subscribed_at,
        ${canonicalSubmittedSql(hasPortalRequests)} AS canonical_submitted_at,
        ${portalClosedSql(hasPortalRequests)} AS portal_closed_at
      FROM nyc311_email_events AS email
      JOIN nyc311_email_subscription_jobs AS jobs
        ON jobs.srnumber=email.reconciled_srnumber
      JOIN live_portal_requests AS live
        ON live.srnumber=email.reconciled_srnumber
      ${portalJoinSql(hasPortalRequests)}
      WHERE ${usableEmailWhere()}
        ${bidOnly ? `AND ${activeBidMembershipWhere('email.reconciled_srnumber')}` : ''}
        AND LOWER(TRIM(COALESCE(email.event_kind,''))) IN ('updated','closed')
        AND jobs.state='subscribed'
    ),
    ranked AS (
      SELECT candidates.*,
        ROW_NUMBER() OVER (
          PARTITION BY srnumber,LOWER(TRIM(event_kind))
          ORDER BY received_at,id
        ) AS event_rank
      FROM candidates
      WHERE canonical_submitted_at IS NOT NULL
        AND subscribed_at IS NOT NULL
        AND julianday(subscribed_at)-julianday(canonical_submitted_at)
          BETWEEN 0 AND (@early_seconds / 86400.0)
        AND julianday(received_at)>=julianday(subscribed_at)
        AND (
          LOWER(TRIM(event_kind))<>'closed'
          OR (
            portal_closed_at IS NOT NULL
            AND julianday(received_at)>=julianday(portal_closed_at)
          )
        )
    )
    SELECT * FROM ranked WHERE event_rank=1
    ORDER BY srnumber,event_kind
  `).all({ early_seconds: earlySubscriptionSeconds });

  const firstUpdatedValues = [];
  const portalClosureValues = [];
  const closureDelayValues = [];
  const agencyGroups = new Map();
  const complaintGroups = new Map();
  const firstKinds = new Set();
  const updatedRequests = new Set();
  const closedRequests = new Set();

  for (const row of rows) {
    const srnumber = String(row.srnumber || '');
    if (!prospectiveRequestNumbers.has(srnumber)) continue;
    const kind = String(row.event_kind || '').trim().toLowerCase();
    const uniqueKind = `${srnumber}\0${kind}`;
    if (firstKinds.has(uniqueKind)) continue;

    const eventAfterSubscription = elapsedSeconds(row.subscribed_at, row.received_at);
    if (eventAfterSubscription == null || eventAfterSubscription < 0) continue;
    firstKinds.add(uniqueKind);

    const agency = agencyIdentity(row);
    const complaintLabel = normalizedLabel(row.request_type, 'Unknown complaint type');
    const complaint = {
      key: complaintLabel.toLocaleLowerCase('en-US'),
      label: complaintLabel
    };
    const agencyGroup = getGroup(agencyGroups, agency);
    const complaintGroup = getGroup(complaintGroups, complaint);

    if (kind === 'updated') {
      const duration = elapsedSeconds(row.canonical_submitted_at, row.received_at);
      if (duration == null || duration < 0) {
        dataQuality.invalid_or_negative_response_durations += 1;
        continue;
      }
      firstUpdatedValues.push(duration);
      agencyGroup.firstUpdated.push(duration);
      complaintGroup.firstUpdated.push(duration);
      updatedRequests.add(srnumber);
      continue;
    }

    if (row.portal_closed_at == null || String(row.portal_closed_at).trim() === '') {
      dataQuality.response_rows_missing_portal_closure_time += 1;
      continue;
    }
    const closureDuration = elapsedSeconds(row.canonical_submitted_at, row.portal_closed_at);
    const notificationDelay = elapsedSeconds(row.portal_closed_at, row.received_at);
    if (closureDuration == null || closureDuration < 0
        || notificationDelay == null || notificationDelay < 0) {
      dataQuality.invalid_or_negative_response_durations += 1;
      continue;
    }
    portalClosureValues.push(closureDuration);
    closureDelayValues.push(notificationDelay);
    agencyGroup.portalClosure.push(closureDuration);
    agencyGroup.closureDelay.push(notificationDelay);
    complaintGroup.portalClosure.push(closureDuration);
    complaintGroup.closureDelay.push(notificationDelay);
    closedRequests.add(srnumber);
  }

  return {
    ...empty,
    prospective_cohort: {
      requests: prospectiveRequestNumbers.size,
      started_at: prospectiveStartedAt,
      early_subscription_seconds: earlySubscriptionSeconds,
      right_censored_without_first_updated: Math.max(
        0,
        prospectiveRequestNumbers.size - updatedRequests.size
      ),
      right_censored_without_observed_portal_closure: Math.max(
        0,
        prospectiveRequestNumbers.size - closedRequests.size
      )
    },
    overall: {
      first_updated: durationStatistics(firstUpdatedValues),
      portal_closure: durationStatistics(portalClosureValues),
      closure_notification_delay: durationStatistics(closureDelayValues)
    },
    by_agency: responseGroupRows(
      agencyGroups,
      minimumGroupSample,
      maxGroups,
      true
    ),
    by_complaint_type: responseGroupRows(
      complaintGroups,
      minimumGroupSample,
      maxGroups,
      false
    )
  };
}

function computeSqliteEmailMetrics(database, {
  now = new Date(),
  earlySubscriptionSeconds = DEFAULT_EARLY_SUBSCRIPTION_SECONDS,
  closureGraceSeconds = DEFAULT_CLOSURE_GRACE_SECONDS,
  minimumGroupSample = 1,
  maxGroups = DEFAULT_MAX_GROUPS
} = {}) {
  const normalizedNow = isoTimestamp(now);
  if (!normalizedNow) throw new TypeError('now must be a valid zoned timestamp or Date');
  const earlySeconds = finiteNonnegativeInteger(
    earlySubscriptionSeconds,
    DEFAULT_EARLY_SUBSCRIPTION_SECONDS
  );
  const graceSeconds = finiteNonnegativeInteger(
    closureGraceSeconds,
    DEFAULT_CLOSURE_GRACE_SECONDS
  );
  const minimumSample = Math.max(1, finiteNonnegativeInteger(minimumGroupSample, 1));
  const groupLimit = Math.max(
    1,
    finiteNonnegativeInteger(maxGroups, DEFAULT_MAX_GROUPS, MAX_GROUPS_LIMIT)
  );
  const result = emptyMetrics(new Date(normalizedNow), true);
  result.subscriptions.lag.early_window_seconds = earlySeconds;
  result.measured_closure_email_coverage.grace_seconds = graceSeconds;
  result.observed_response_times.prospective_cohort.early_subscription_seconds = earlySeconds;
  const tables = tableNames(database);
  const bidOnly = collectorBidOnly(database, tables);
  const bidScopeReady = !bidOnly || (
    tables.has('live_request_bid_memberships')
    && tables.has('business_improvement_district_boundary_versions')
  );

  // A BID-only dashboard must never fall back to citywide analytics when its
  // membership tables are unavailable. Returning the empty contract is safer
  // than publishing misleading SES/email totals.
  if (!bidScopeReady) return result;

  if (tables.has('nyc311_email_events')) {
    result.deliveries = loadDeliveryMetrics(database, bidOnly);
  }
  const subscriptionMetrics = loadSubscriptionMetrics(
    database,
    tables,
    earlySeconds,
    result.data_quality,
    bidOnly
  );
  const {
    prospectiveRequestNumbers,
    prospectiveStartedAt,
    ...publicSubscriptionMetrics
  } = subscriptionMetrics;
  result.subscriptions = publicSubscriptionMetrics;
  result.measured_closure_email_coverage = loadClosureCoverage(
    database,
    tables,
    normalizedNow,
    graceSeconds,
    bidOnly
  );
  result.observed_response_times = loadResponseMetrics(
    database,
    tables,
    prospectiveRequestNumbers,
    prospectiveStartedAt,
    earlySeconds,
    minimumSample,
    groupLimit,
    result.data_quality,
    bidOnly
  );
  return result;
}

function loadSqliteEmailMetrics(databaseOrPath, options = {}) {
  if (databaseOrPath && typeof databaseOrPath.prepare === 'function') {
    return computeSqliteEmailMetrics(databaseOrPath, options);
  }
  const databasePath = String(databaseOrPath || '').trim();
  if (!databasePath || !fs.existsSync(databasePath)) {
    return emptyMetrics(options.now || new Date(), false);
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout=3000');
    return computeSqliteEmailMetrics(database, options);
  } finally {
    database.close();
  }
}

module.exports = {
  DEFAULT_CLOSURE_GRACE_SECONDS,
  DEFAULT_EARLY_SUBSCRIPTION_SECONDS,
  computeSqliteEmailMetrics,
  durationStatistics,
  loadSqliteEmailMetrics
};
