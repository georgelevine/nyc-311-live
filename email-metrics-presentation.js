'use strict';

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function responseTimes(statistics) {
  const update = statistics && statistics.first_updated || {};
  const closure = statistics && statistics.portal_closure || {};
  const notification = statistics && statistics.closure_notification_delay || {};
  return {
    update_median_seconds: numberOrNull(update.median_seconds),
    update_p90_seconds: numberOrNull(update.p90_seconds),
    update_count: count(update.sample_size),
    closure_median_seconds: numberOrNull(closure.median_seconds),
    closure_p90_seconds: numberOrNull(closure.p90_seconds),
    closure_count: count(closure.sample_size),
    closure_notification_median_seconds: numberOrNull(notification.median_seconds),
    closure_notification_p90_seconds: numberOrNull(notification.p90_seconds),
    closure_notification_count: count(notification.sample_size)
  };
}

function responseGroup(row, dimension) {
  return {
    ...(dimension === 'agency'
      ? {
          label: row.agency || row.agency_acronym || row.agency_name || 'Unknown agency',
          agency_name: row.agency_name || null,
          agency_acronym: row.agency_acronym || null
        }
      : {
          label: row.complaint_type || 'Unknown complaint type',
          complaint_type: row.complaint_type || null
        }),
    ...responseTimes(row)
  };
}

function presentEmailMetrics(metrics, monitoringMode = 'unknown') {
  const deliveries = metrics && metrics.deliveries || {};
  const subscriptions = metrics && metrics.subscriptions || {};
  const subscriptionStates = subscriptions.states || {};
  const coverage = metrics && metrics.measured_closure_email_coverage || {};
  const hasMatureCoverage = Object.prototype.hasOwnProperty.call(
    coverage,
    'mature_coverage_percent'
  );
  const observed = metrics && metrics.observed_response_times || {};
  const prospectiveCohort = observed.prospective_cohort || {};
  return {
    as_of: metrics && metrics.as_of || new Date().toISOString(),
    database_available: Boolean(metrics && metrics.database_available),
    monitoring_mode: monitoringMode || 'unknown',
    deliveries: {
      total: count(deliveries.all_accepted),
      usable: count(deliveries.usable),
      detail_complete: count(deliveries.detail_complete),
      excluded_non_direct: count(deliveries.excluded_non_direct),
      submitted: count(deliveries.submitted),
      updated: count(deliveries.updated),
      closed: count(deliveries.closed),
      other_or_unknown: count(deliveries.other_or_unknown),
      issues: count(deliveries.issues),
      parser_issues: count(deliveries.parser_issues),
      reconciliation_issues: count(deliveries.reconciliation_issues),
      authentication_issues: count(deliveries.authentication_issues),
      detail_issues: count(deliveries.detail_issues),
      unrecognized_submitted: count(deliveries.unrecognized_submitted),
      last_received_at: deliveries.latest_received_at || null
    },
    subscriptions: {
      total: count(subscriptions.total),
      subscribed: count(subscriptions.confirmed ?? subscriptionStates.subscribed),
      pending: count(subscriptionStates.pending),
      retry: count(subscriptionStates.retry),
      processing: count(subscriptionStates.processing),
      lag: subscriptions.lag || null
    },
    verification: {
      eligible_portal_closures: count(
        coverage.mature_eligible_portal_closures ?? coverage.eligible_portal_closures
      ),
      closed_emails_received: count(
        coverage.mature_closed_email_observed ?? coverage.closed_email_observed
      ),
      coverage_percent: numberOrNull(
        hasMatureCoverage
          ? coverage.mature_coverage_percent
          : coverage.observed_coverage_percent
      ),
      missing: count(coverage.missing_after_grace ?? coverage.missing),
      missing_after_grace: count(coverage.missing_after_grace),
      awaiting_within_grace: count(coverage.awaiting_within_grace),
      all_known_portal_closures: count(coverage.eligible_portal_closures),
      all_closed_emails_received: count(coverage.closed_email_observed),
      grace_seconds: count(coverage.grace_seconds),
      limitation: coverage.limitation || null
    },
    response_times: {
      definitions: observed.definitions || {},
      cohort: {
        ...prospectiveCohort,
        started_at: prospectiveCohort.started_at || null
      },
      overall: responseTimes(observed.overall),
      by_agency: (observed.by_agency || []).map(row => responseGroup(row, 'agency')),
      by_complaint_type: (observed.by_complaint_type || [])
        .map(row => responseGroup(row, 'complaint'))
    },
    data_quality: metrics && metrics.data_quality || {}
  };
}

module.exports = {
  presentEmailMetrics,
  responseTimes
};
