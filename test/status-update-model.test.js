'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildEmailMetricsModel,
  buildStatusUpdateModel,
  currentClosureSnapshot,
  formatMetricDuration,
  portalEvent,
  requestArchiveLabel
} = require('../public/js/status-update-model');

function closedRecord(overrides = {}) {
  return {
    srnumber: '311-28334446',
    status: 'Closed',
    followup_state: 'closed',
    closure_cycle: 1,
    date_closed: '2026-07-23T16:39:18.000Z',
    finalized_at: '2026-07-23T20:01:56.170Z',
    ...overrides
  };
}

function closurePayload(overrides = {}) {
  return {
    history: [
      {
        id: 1,
        previous_status: null,
        status: 'In Progress',
        source: 'migration',
        observed_at: '2026-07-23T15:42:48.000Z'
      },
      {
        id: 2,
        previous_status: 'In Progress',
        status: 'Closed',
        source: 'detail',
        effective_at: '2026-07-23T16:39:18.000Z',
        observed_at: '2026-07-23T20:01:56.170Z'
      }
    ],
    closure_snapshots: [
      {
        id: 4,
        closure_cycle: 1,
        is_final: 1,
        final_state: 'complete',
        fetched_at: '2026-07-23T20:01:56.170Z',
        snapshot: {
          status: 'Closed',
          dateClosed: '2026-07-23T16:39:18.000Z',
          additionalDetails: null
        }
      }
    ],
    followup: { state: 'closed', closure_cycle: 1 },
    ...overrides
  };
}

test('projects a pre-subscription closure from the current Portal cycle', () => {
  const model = buildStatusUpdateModel(closedRecord(), closurePayload(), {
    updates: [],
    total: 0
  });
  assert.equal(model.official_status, 'Closed');
  assert.equal(model.events.length, 1);
  assert.equal(model.events[0].source, 'portal');
  assert.equal(model.events[0].title, 'In Progress → Closed');
  assert.equal(model.events[0].effective_at, '2026-07-23T16:39:18.000Z');
  assert.equal(model.events[0].verification_state, 'verified');
});

test('ignores a retained closure snapshot after a request reopens', () => {
  const record = closedRecord({
    status: 'In Progress',
    followup_state: 'open',
    date_closed: '2026-07-23T16:39:18.000Z'
  });
  const payload = closurePayload({
    history: [
      ...closurePayload().history,
      {
        id: 3,
        previous_status: 'Closed',
        status: 'In Progress',
        source: 'detail',
        effective_at: '2026-07-23T21:00:00.000Z',
        observed_at: '2026-07-23T21:00:05.000Z'
      }
    ],
    followup: { state: 'open', closure_cycle: 1 }
  });
  assert.equal(currentClosureSnapshot(record, payload), null);
  const event = portalEvent(record, payload);
  assert.equal(event.title, 'Closed → In Progress');
  assert.equal(event.effective_at, '2026-07-23T21:00:00.000Z');
  assert.equal(event.verification_state, null);
});

test('labels a provisional closing snapshot as verification in progress', () => {
  const record = closedRecord({ followup_state: 'closing' });
  const payload = closurePayload({
    closure_snapshots: [{
      id: 3,
      closure_cycle: 1,
      is_final: 0,
      final_state: null,
      fetched_at: '2026-07-23T20:00:00.000Z',
      snapshot: { status: 'Closed', dateClosed: '2026-07-23T16:39:18.000Z' }
    }],
    followup: { state: 'closing', closure_cycle: 1 }
  });
  const event = portalEvent(record, payload);
  assert.equal(event.verification_state, 'checking');
  assert.equal(event.verification_label, 'Portal verification in progress');
});

test('does not invent a closure timestamp when the Portal omitted it', () => {
  const record = closedRecord({ date_closed: null });
  const payload = closurePayload({
    history: [{
      id: 2,
      previous_status: 'In Progress',
      status: 'Closed',
      source: 'detail',
      effective_at: null,
      observed_at: '2026-07-23T20:01:56.170Z'
    }],
    closure_snapshots: [{
      id: 4,
      closure_cycle: 1,
      is_final: 1,
      final_state: 'date_missing',
      fetched_at: '2026-07-23T20:01:56.170Z',
      snapshot: { status: 'Closed', dateClosed: null }
    }]
  });
  const event = portalEvent(record, payload);
  assert.equal(event.effective_at, null);
  assert.equal(event.observed_at, '2026-07-23T20:01:56.170Z');
});

test('email narrative is shown without changing the official lifecycle status', () => {
  const record = closedRecord({ status: 'In Progress', followup_state: 'closing' });
  const model = buildStatusUpdateModel(record, { history: [], closure_snapshots: [] }, {
    total: 1,
    updates: [{
      id: 9,
      event_kind: 'Closed',
      agency_name: 'New York City Police Department',
      response_text: 'The agency responded to the complaint.',
      received_at: '2026-07-23T20:05:00.000Z',
      closure_wake_queued: true
    }]
  });
  assert.equal(model.official_status, 'In Progress');
  assert.equal(model.events[0].source, 'email');
  assert.equal(model.events[0].response_text, 'The agency responded to the complaint.');
  assert.equal(model.events[0].verification_state, 'checking');
});

test('does not render email-sourced status history as a second Portal event', () => {
  const record = closedRecord({ followup_state: 'closing' });
  const model = buildStatusUpdateModel(record, {
    history: [{
      id: 12,
      previous_status: 'In Progress',
      status: 'Closed',
      source: 'email',
      observed_at: '2026-07-23T20:05:00.000Z'
    }],
    closure_snapshots: [],
    followup: { state: 'closing', closure_cycle: 1 }
  }, {
    total: 1,
    updates: [{
      id: 9,
      event_kind: 'Closed',
      received_at: '2026-07-23T20:05:00.000Z',
      closure_wake_queued: true
    }]
  });
  assert.deepEqual(model.events.map(event => event.source), ['email']);
  assert.equal(model.total, 1);
});

test('never labels a detail-unconfirmed closure as Portal verified', () => {
  const record = closedRecord({ current_cycle_final_state: 'detail_unconfirmed' });
  const payload = closurePayload({
    history: [{
      id: 12,
      previous_status: 'In Progress',
      status: 'Closed',
      source: 'email',
      observed_at: '2026-07-23T20:05:00.000Z'
    }],
    closure_snapshots: [{
      id: 13,
      closure_cycle: 1,
      is_final: 1,
      final_state: 'detail_unconfirmed',
      fetched_at: '2026-07-23T21:05:00.000Z',
      snapshot: { status: 'In Progress', dateClosed: null }
    }]
  });
  const model = buildStatusUpdateModel(record, payload, {
    total: 1,
    updates: [{
      id: 9,
      event_kind: 'Closed',
      received_at: '2026-07-23T20:05:00.000Z'
    }]
  });
  assert.equal(model.events.length, 1);
  assert.equal(model.events[0].verification_state, 'unconfirmed');
  assert.equal(model.events[0].verification_label, 'Portal detail did not confirm closure');
  assert.equal(model.events[0].portal_evidence.verification_state, 'unconfirmed');
});

test('merges a Portal closure and its agency email into one status update', () => {
  const model = buildStatusUpdateModel(closedRecord(), closurePayload(), {
    total: 2,
    updates: [
      { id: 1, event_kind: 'Updated', received_at: '2026-07-23T19:00:00.000Z' },
      { id: 2, event_kind: 'Closed', received_at: '2026-07-23T20:05:00.000Z' }
    ]
  });
  assert.deepEqual(model.events.map(event => event.id), [
    'email-2',
    'email-1'
  ]);
  assert.equal(model.events[0].portal_evidence.verification_state, 'verified');
  assert.equal(model.events[0].portal_evidence.effective_at, '2026-07-23T16:39:18.000Z');
  assert.equal(model.total, 2);
});

test('normalizes email monitoring totals, coverage, and response-time samples', () => {
  const model = buildEmailMetricsModel({
    as_of: '2026-07-25T14:10:00.000Z',
    monitoring_mode: 'subscription_only',
    deliveries: {
      total: 4500,
      usable: 4400,
      submitted: 76,
      updated: 425,
      closed: 3975,
      issues: { total: 24 },
      unrecognized_submitted: 20,
      authentication_issues: 1,
      detail_issues: 2,
      detail_complete: 4378,
      excluded_non_direct: 1,
      last_received_at: '2026-07-25T14:09:58.000Z'
    },
    subscriptions: {
      subscribed: 7800,
      pending: 2,
      retry: 1,
      processing: 1
    },
    verification: {
      eligible_portal_closures: 4000,
      closed_emails_received: 3910,
      coverage_percent: 97.75,
      missing: 90,
      missing_after_grace: 90,
      awaiting_within_grace: 4,
      all_known_portal_closures: 4004,
      all_closed_emails_received: 3910,
      grace_seconds: 3600,
      limitation: 'Only independently known Portal closures enter the denominator'
    },
    response_times: {
      cohort: {
        requests: 7800,
        started_at: '2026-07-23T14:00:00.000Z',
        early_subscription_seconds: 900,
        right_censored_without_first_updated: 7375,
        right_censored_without_observed_portal_closure: 3890
      },
      overall: {
        update_median_seconds: 1800,
        update_p90_seconds: 7200,
        update_count: 425,
        closure_median_seconds: 3600,
        closure_p90_seconds: 86400,
        closure_count: 3910,
        closure_notification_median_seconds: 18,
        closure_notification_p90_seconds: 29,
        closure_notification_count: 3910
      },
      by_agency: [{
        agency_name: 'Department of Transportation',
        update_median_seconds: 600,
        update_p90_seconds: 3600,
        update_count: 20,
        closure_median_seconds: 7200,
        closure_p90_seconds: 14400,
        closure_count: 90
      }, {}],
      by_complaint_type: [{
        complaint_type: 'Illegal Parking',
        update_median_seconds: null,
        update_p90_seconds: null,
        update_count: 0,
        closure_median_seconds: 900,
        closure_p90_seconds: 1800,
        closure_count: 500
      }]
    }
  });

  assert.equal(model.available, true);
  assert.deepEqual(model.monitoring_mode, {
    key: 'subscription_only',
    label: 'Email subscriptions'
  });
  assert.equal(model.deliveries.usable_percent, 4400 / 45);
  assert.equal(model.deliveries.issues, 24);
  assert.equal(model.deliveries.unrecognized_submitted, 20);
  assert.equal(model.deliveries.authentication_issues, 1);
  assert.equal(model.deliveries.detail_issues, 2);
  assert.equal(model.deliveries.excluded_non_direct, 1);
  assert.equal(model.subscriptions.subscribed, 7800);
  assert.equal(model.verification.coverage_percent, 97.75);
  assert.equal(model.verification.awaiting_within_grace, 4);
  assert.equal(model.verification.grace_seconds, 3600);
  assert.match(model.verification.limitation, /independently known Portal closures/);
  assert.equal(model.response_times.cohort.requests, 7800);
  assert.equal(model.response_times.cohort.started_at, '2026-07-23T14:00:00.000Z');
  assert.equal(model.response_times.cohort.right_censored_without_first_updated, 7375);
  assert.equal(model.response_times.overall.closure_notification_median_seconds, 18);
  assert.equal(model.response_times.by_agency.length, 1);
  assert.equal(model.response_times.by_agency[0].label, 'Department of Transportation');
  assert.equal(model.response_times.by_complaint_type[0].label, 'Illegal Parking');
  assert.equal(model.response_times.by_complaint_type[0].update_median_seconds, null);
});

test('email metric model labels email-primary monitoring modes clearly', () => {
  assert.deepEqual(buildEmailMetricsModel({
    monitoring_mode: 'email_primary'
  }).monitoring_mode, {
    key: 'email_primary',
    label: 'Email subscriptions active'
  });
  assert.deepEqual(buildEmailMetricsModel({
    monitoring_mode: 'email_primary_with_scheduled_fallback'
  }).monitoring_mode, {
    key: 'email_primary_with_scheduled_fallback',
    label: 'Email + Portal fallback'
  });
});

test('email metric model handles absent data and formats compact durations', () => {
  const missing = buildEmailMetricsModel(null);
  assert.equal(missing.available, false);
  assert.equal(missing.deliveries.total, 0);
  assert.equal(missing.verification.coverage_percent, null);
  assert.deepEqual(missing.response_times.by_agency, []);

  assert.equal(formatMetricDuration(null), '—');
  assert.equal(formatMetricDuration(-1), '—');
  assert.equal(formatMetricDuration(42), '42s');
  assert.equal(formatMetricDuration(90), '1m 30s');
  assert.equal(formatMetricDuration(3600), '1h');
  assert.equal(formatMetricDuration(9000), '2h 30m');
  assert.equal(formatMetricDuration(90000), '1d 1h');
});

test('tracking label uses per-request email evidence and ignores inactive dates in email-primary mode', () => {
  const record = {
    followup_state: 'open',
    next_check_at: '2026-07-26T12:00:00.000Z'
  };
  assert.equal(requestArchiveLabel(record, {
    monitoringModeKey: 'email_primary',
    subscription: { state: 'active' },
    emailLookupComplete: true
  }), 'Email monitoring active');
  assert.equal(requestArchiveLabel(record, {
    monitoringModeKey: 'email_primary',
    subscription: null,
    emailLookupComplete: true
  }), 'Not email-subscribed · scheduled checks off');
  assert.equal(requestArchiveLabel(record, {
    monitoringModeKey: 'email_primary',
    subscription: null,
    emailLookupComplete: false
  }), 'Checking email subscription');
  assert.equal(requestArchiveLabel(record, {
    monitoringModeKey: 'email_primary',
    subscription: { state: 'created' },
    emailLookupComplete: true
  }), 'Subscription pending');
  assert.equal(requestArchiveLabel(record, {
    monitoringModeKey: 'email_primary',
    subscription: { state: 'paused' },
    emailLookupComplete: true
  }), 'Monitoring paused');
});

test('tracking label only presents a next check when scheduled fallback is active', () => {
  const record = {
    followup_state: 'open',
    next_check_at: '2026-07-26T12:00:00.000Z'
  };
  assert.equal(requestArchiveLabel(record, {
    monitoringModeKey: 'email_primary_with_scheduled_fallback',
    subscription: { state: 'active' },
    emailLookupComplete: true,
    formatTime: value => `TIME(${value})`
  }), 'Email monitoring active · Portal fallback TIME(2026-07-26T12:00:00.000Z)');
  assert.equal(requestArchiveLabel(record, {
    monitoringModeKey: 'portal_only',
    subscription: null,
    emailLookupComplete: true,
    formatTime: value => `TIME(${value})`
  }), 'Portal monitoring · next TIME(2026-07-26T12:00:00.000Z)');
});
