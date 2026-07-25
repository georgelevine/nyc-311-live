'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { presentEmailMetrics } = require('../email-metrics-presentation');

test('presents internal email metrics in the stable dashboard contract', () => {
  const result = presentEmailMetrics({
    as_of: '2026-07-25T15:00:00.000Z',
    database_available: true,
    deliveries: {
      all_accepted: 100,
      usable: 96,
      detail_complete: 94,
      excluded_non_direct: 1,
      submitted: 10,
      updated: 26,
      closed: 60,
      other_or_unknown: 4,
      issues: 4,
      parser_issues: 3,
      reconciliation_issues: 2,
      authentication_issues: 1,
      detail_issues: 2,
      unrecognized_submitted: 3,
      latest_received_at: '2026-07-25T14:59:50.000Z'
    },
    subscriptions: {
      total: 120,
      confirmed: 117,
      states: { subscribed: 117, pending: 1, retry: 1, processing: 1 },
      lag: { sample_size: 117, median_seconds: 30, p90_seconds: 90 }
    },
    measured_closure_email_coverage: {
      eligible_portal_closures: 50,
      closed_email_observed: 49,
      missing: 1,
      missing_after_grace: 1,
      grace_seconds: 3600,
      observed_coverage_percent: 98
    },
    observed_response_times: {
      definitions: { portal_closure: 'definition' },
      prospective_cohort: { requests: 90 },
      overall: {
        first_updated: { sample_size: 8, median_seconds: 120, p90_seconds: 600 },
        portal_closure: { sample_size: 40, median_seconds: 900, p90_seconds: 3600 },
        closure_notification_delay: {
          sample_size: 40,
          median_seconds: 20,
          p90_seconds: 40
        }
      },
      by_agency: [{
        agency: 'NYPD',
        agency_name: 'New York City Police Department',
        agency_acronym: 'NYPD',
        first_updated: { sample_size: 0, median_seconds: null, p90_seconds: null },
        portal_closure: { sample_size: 20, median_seconds: 600, p90_seconds: 1800 },
        closure_notification_delay: {
          sample_size: 20,
          median_seconds: 18,
          p90_seconds: 30
        }
      }],
      by_complaint_type: [{
        complaint_type: 'Illegal Parking',
        first_updated: { sample_size: 0, median_seconds: null, p90_seconds: null },
        portal_closure: { sample_size: 15, median_seconds: 500, p90_seconds: 1500 },
        closure_notification_delay: {
          sample_size: 15,
          median_seconds: 17,
          p90_seconds: 28
        }
      }]
    },
    data_quality: { invalid_or_negative_response_durations: 0 }
  }, 'email_primary');

  assert.equal(result.monitoring_mode, 'email_primary');
  assert.deepEqual(result.deliveries, {
    total: 100,
    usable: 96,
    detail_complete: 94,
    excluded_non_direct: 1,
    submitted: 10,
    updated: 26,
    closed: 60,
    other_or_unknown: 4,
    issues: 4,
    parser_issues: 3,
    reconciliation_issues: 2,
    authentication_issues: 1,
    detail_issues: 2,
    unrecognized_submitted: 3,
    last_received_at: '2026-07-25T14:59:50.000Z'
  });
  assert.equal(result.subscriptions.subscribed, 117);
  assert.equal(result.verification.coverage_percent, 98);
  assert.equal(result.response_times.overall.update_count, 8);
  assert.equal(result.response_times.overall.closure_median_seconds, 900);
  assert.equal(result.response_times.overall.closure_notification_median_seconds, 20);
  assert.equal(result.response_times.by_agency[0].label, 'NYPD');
  assert.equal(result.response_times.by_agency[0].closure_count, 20);
  assert.equal(result.response_times.by_complaint_type[0].label, 'Illegal Parking');
});

test('presents a safe empty response for an unavailable database', () => {
  const result = presentEmailMetrics({
    database_available: false,
    deliveries: {},
    subscriptions: {},
    measured_closure_email_coverage: {},
    observed_response_times: {}
  });
  assert.equal(result.database_available, false);
  assert.equal(result.deliveries.total, 0);
  assert.equal(result.subscriptions.subscribed, 0);
  assert.equal(result.verification.coverage_percent, null);
  assert.equal(result.response_times.overall.update_median_seconds, null);
  assert.equal(result.response_times.overall.closure_median_seconds, null);
  assert.deepEqual(result.response_times.by_agency, []);
});

test('does not replace an intentionally empty mature coverage cohort with all-age coverage', () => {
  const result = presentEmailMetrics({
    database_available: true,
    measured_closure_email_coverage: {
      eligible_portal_closures: 3,
      closed_email_observed: 3,
      observed_coverage_percent: 100,
      mature_eligible_portal_closures: 0,
      mature_closed_email_observed: 0,
      mature_coverage_percent: null
    }
  });
  assert.equal(result.verification.eligible_portal_closures, 0);
  assert.equal(result.verification.coverage_percent, null);
});
