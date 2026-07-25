'use strict';

(function exposeStatusUpdateModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NYC311StatusUpdateModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function textOrNull(value) {
    if (value == null) return null;
    const text = String(value).replace(/\s+/g, ' ').trim();
    return text || null;
  }

  function normalizedStatus(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function isClosedStatus(value) {
    return /\b(?:closed|resolved|cancel(?:led|ed)?)\b/i.test(String(value || ''));
  }

  function timestampValue(value) {
    const timestamp = Date.parse(value || '');
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function finiteMetric(value) {
    if (value == null || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  }

  function metricCount(value) {
    const numeric = finiteMetric(value);
    return numeric == null ? 0 : Math.round(numeric);
  }

  function responseTimeRow(row, dimension) {
    if (!row || typeof row !== 'object') return null;
    const dimensionLabel = dimension === 'agency'
      ? row.agency || row.agency_name || row.agency_acronym
      : row.complaint_type || row.request_type || row.problem;
    const label = textOrNull(
      row.name
      || row.label
      || dimensionLabel
    );
    if (!label) return null;
    return {
      label,
      update_median_seconds: finiteMetric(row.update_median_seconds),
      update_p90_seconds: finiteMetric(row.update_p90_seconds),
      update_count: metricCount(row.update_count),
      closure_median_seconds: finiteMetric(row.closure_median_seconds),
      closure_p90_seconds: finiteMetric(row.closure_p90_seconds),
      closure_count: metricCount(row.closure_count),
      closure_notification_median_seconds: finiteMetric(
        row.closure_notification_median_seconds
      ),
      closure_notification_p90_seconds: finiteMetric(
        row.closure_notification_p90_seconds
      ),
      closure_notification_count: metricCount(row.closure_notification_count)
    };
  }

  function responseTimeMetric(row) {
    const value = row && typeof row === 'object' ? row : {};
    return {
      update_median_seconds: finiteMetric(value.update_median_seconds),
      update_p90_seconds: finiteMetric(value.update_p90_seconds),
      update_count: metricCount(value.update_count),
      closure_median_seconds: finiteMetric(value.closure_median_seconds),
      closure_p90_seconds: finiteMetric(value.closure_p90_seconds),
      closure_count: metricCount(value.closure_count),
      closure_notification_median_seconds: finiteMetric(
        value.closure_notification_median_seconds
      ),
      closure_notification_p90_seconds: finiteMetric(
        value.closure_notification_p90_seconds
      ),
      closure_notification_count: metricCount(value.closure_notification_count)
    };
  }

  function monitoringMode(value) {
    const key = textOrNull(value)?.toLowerCase().replace(/[\s-]+/g, '_') || 'unknown';
    const labels = {
      email_primary: 'Email subscriptions active',
      email_primary_with_scheduled_fallback: 'Email + Portal fallback',
      subscription_only: 'Email subscriptions',
      subscriptions_only: 'Email subscriptions',
      email_only: 'Email subscriptions',
      hybrid: 'Email + Portal checks',
      portal_and_email: 'Email + Portal checks',
      scheduled: 'Scheduled Portal checks',
      portal_only: 'Scheduled Portal checks',
      paused: 'Monitoring paused',
      unknown: 'Monitoring mode unavailable'
    };
    return { key, label: labels[key] || textOrNull(value) || labels.unknown };
  }

  function requestArchiveLabel(record, {
    monitoringModeKey = 'unknown',
    subscription = null,
    emailLookupComplete = false,
    formatTime = value => value
  } = {}) {
    if (!record || typeof record !== 'object') return '';
    if (record.followup_state === 'closing') return 'Verifying final details';
    if (record.followup_state === 'closed') {
      return record.finalized_at
        ? `Final snapshot saved ${formatTime(record.finalized_at)}`
        : 'Final snapshot saved';
    }
    if (record.followup_state !== 'open') return '';

    const modeKey = textOrNull(monitoringModeKey)?.toLowerCase() || 'unknown';
    const subscriptionState = textOrNull(subscription && subscription.state)?.toLowerCase() || '';
    const activeSubscription = ['active', 'subscribed'].includes(subscriptionState);
    const scheduledFallback = new Set([
      'email_primary_with_scheduled_fallback',
      'hybrid',
      'portal_and_email'
    ]).has(modeKey);
    const scheduledPrimary = new Set(['scheduled', 'portal_only']).has(modeKey);
    const emailPrimary = new Set([
      'email_primary',
      'subscription_only',
      'subscriptions_only',
      'email_only'
    ]).has(modeKey);

    if (scheduledFallback) {
      const fallback = record.next_check_at
        ? `Portal fallback ${formatTime(record.next_check_at)}`
        : 'Portal fallback active';
      return activeSubscription ? `Email monitoring active · ${fallback}` : fallback;
    }
    if (scheduledPrimary) {
      return record.next_check_at
        ? `Portal monitoring · next ${formatTime(record.next_check_at)}`
        : 'Portal monitoring active';
    }
    if (activeSubscription) return 'Email monitoring active';
    if (emailPrimary) {
      if (!emailLookupComplete) return 'Checking email subscription';
      const stateLabels = {
        created: 'Subscription pending',
        paused: 'Monitoring paused',
        retired: 'Monitoring retired',
        error: 'Subscription error'
      };
      if (stateLabels[subscriptionState]) return stateLabels[subscriptionState];
      return 'Not email-subscribed · scheduled checks off';
    }
    return emailLookupComplete && subscriptionState
      ? `Email subscription ${subscriptionState}`
      : 'Archived';
  }

  function buildEmailMetricsModel(payload) {
    const available = Boolean(payload && typeof payload === 'object' && !Array.isArray(payload));
    const source = available ? payload : {};
    const deliverySource = source.deliveries && typeof source.deliveries === 'object'
      ? source.deliveries
      : {};
    const subscriptionSource = source.subscriptions && typeof source.subscriptions === 'object'
      ? source.subscriptions
      : {};
    const verificationSource = source.verification && typeof source.verification === 'object'
      ? source.verification
      : {};
    const responseSource = source.response_times && typeof source.response_times === 'object'
      ? source.response_times
      : {};
    const cohortSource = responseSource.cohort && typeof responseSource.cohort === 'object'
      ? responseSource.cohort
      : {};
    const issueSource = deliverySource.issues && typeof deliverySource.issues === 'object'
      ? deliverySource.issues.total
      : deliverySource.issues;
    const total = metricCount(deliverySource.total);
    const usable = metricCount(deliverySource.usable);
    const coverage = finiteMetric(verificationSource.coverage_percent);
    return {
      available,
      as_of: textOrNull(source.as_of),
      monitoring_mode: monitoringMode(source.monitoring_mode),
      deliveries: {
        total,
        usable,
        usable_percent: total > 0 ? Math.max(0, Math.min(100, (usable / total) * 100)) : null,
        detail_complete: metricCount(deliverySource.detail_complete),
        detail_issues: metricCount(deliverySource.detail_issues),
        authentication_issues: metricCount(deliverySource.authentication_issues),
        excluded_non_direct: metricCount(deliverySource.excluded_non_direct),
        submitted: metricCount(deliverySource.submitted),
        updated: metricCount(deliverySource.updated),
        closed: metricCount(deliverySource.closed),
        issues: metricCount(issueSource),
        unrecognized_submitted: metricCount(deliverySource.unrecognized_submitted),
        last_received_at: textOrNull(deliverySource.last_received_at)
      },
      subscriptions: {
        subscribed: metricCount(subscriptionSource.subscribed),
        pending: metricCount(subscriptionSource.pending),
        retry: metricCount(subscriptionSource.retry),
        processing: metricCount(subscriptionSource.processing)
      },
      verification: {
        eligible_portal_closures: metricCount(verificationSource.eligible_portal_closures),
        closed_emails_received: metricCount(verificationSource.closed_emails_received),
        coverage_percent: coverage == null ? null : Math.max(0, Math.min(100, coverage)),
        missing: metricCount(verificationSource.missing),
        missing_after_grace: metricCount(verificationSource.missing_after_grace),
        awaiting_within_grace: metricCount(verificationSource.awaiting_within_grace),
        all_known_portal_closures: metricCount(
          verificationSource.all_known_portal_closures
        ),
        all_closed_emails_received: metricCount(
          verificationSource.all_closed_emails_received
        ),
        grace_seconds: finiteMetric(verificationSource.grace_seconds),
        limitation: textOrNull(verificationSource.limitation)
      },
      response_times: {
        definitions: responseSource.definitions && typeof responseSource.definitions === 'object'
          ? { ...responseSource.definitions }
          : {},
        cohort: {
          requests: metricCount(cohortSource.requests),
          started_at: textOrNull(cohortSource.started_at),
          early_subscription_seconds: finiteMetric(cohortSource.early_subscription_seconds),
          right_censored_without_first_updated: metricCount(
            cohortSource.right_censored_without_first_updated
          ),
          right_censored_without_observed_portal_closure: metricCount(
            cohortSource.right_censored_without_observed_portal_closure
          )
        },
        overall: responseTimeMetric(responseSource.overall),
        by_agency: (Array.isArray(responseSource.by_agency) ? responseSource.by_agency : [])
          .map(row => responseTimeRow(row, 'agency'))
          .filter(Boolean),
        by_complaint_type: (
          Array.isArray(responseSource.by_complaint_type)
            ? responseSource.by_complaint_type
            : []
        ).map(row => responseTimeRow(row, 'complaint')).filter(Boolean)
      }
    };
  }

  function formatMetricDuration(value) {
    const seconds = finiteMetric(value);
    if (seconds == null) return '—';
    const rounded = Math.round(seconds);
    if (rounded < 60) return `${rounded}s`;
    const minutes = Math.floor(rounded / 60);
    if (minutes < 60) {
      const remainingSeconds = rounded % 60;
      return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      const remainingMinutes = minutes % 60;
      return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
  }

  function parsedSnapshot(value) {
    if (!value) return null;
    if (value && typeof value === 'object') return value;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function meaningfulTransitions(payload) {
    const history = Array.isArray(payload && payload.history) ? payload.history : [];
    return history.filter(row => {
      const previous = textOrNull(row && row.previous_status);
      const status = textOrNull(row && row.status);
      return previous && status && normalizedStatus(previous) !== normalizedStatus(status);
    }).sort((left, right) => {
      const leftTime = timestampValue(left.observed_at || left.effective_at);
      const rightTime = timestampValue(right.observed_at || right.effective_at);
      return rightTime - leftTime || Number(right.id || 0) - Number(left.id || 0);
    });
  }

  function currentClosureSnapshot(record, payload) {
    const state = normalizedStatus(
      (record && record.followup_state) || (payload && payload.followup && payload.followup.state)
    );
    if (state !== 'closed' && state !== 'closing') return null;
    const cycleValue = Number(
      (record && record.closure_cycle)
      ?? (payload && payload.followup && payload.followup.closure_cycle)
    );
    const hasCycle = Number.isFinite(cycleValue) && cycleValue > 0;
    const snapshots = (Array.isArray(payload && payload.closure_snapshots)
      ? payload.closure_snapshots
      : []).filter(snapshot => (
      !hasCycle || Number(snapshot && snapshot.closure_cycle) === cycleValue
    )).sort((left, right) => (
      Number(right && right.is_final || 0) - Number(left && left.is_final || 0)
      || Number(right && right.id || 0) - Number(left && left.id || 0)
      || timestampValue(right && right.fetched_at) - timestampValue(left && left.fetched_at)
    ));
    if (state === 'closed') {
      return snapshots.find(snapshot => Number(snapshot && snapshot.is_final) === 1) || null;
    }
    return snapshots[0] || null;
  }

  function snapshotNarrative(snapshot) {
    const detail = parsedSnapshot(snapshot && snapshot.snapshot);
    return textOrNull(detail && detail.additionalDetails);
  }

  function portalEvent(record, payload) {
    const transition = meaningfulTransitions(payload).find(row => (
      normalizedStatus(row && row.source) !== 'email'
    )) || null;
    const closureSnapshot = currentClosureSnapshot(record, payload);
    const followupState = normalizedStatus(
      (record && record.followup_state) || (payload && payload.followup && payload.followup.state)
    );
    const currentStatus = textOrNull(record && record.status);
    // An email-sourced history row is the same evidence already represented by
    // the email event. Only add a Portal event when a separate Portal
    // transition or detail snapshot actually exists.
    if (!transition && !closureSnapshot) return null;

    const previousStatus = textOrNull(transition && transition.previous_status);
    const status = textOrNull(transition && transition.status) || currentStatus || 'Status updated';
    const snapshotDetail = parsedSnapshot(closureSnapshot && closureSnapshot.snapshot);
    const isCurrentClosure = isClosedStatus(status)
      && (followupState === 'closed' || followupState === 'closing');
    const effectiveAt = textOrNull(
      transition && transition.effective_at
      || (isCurrentClosure && snapshotDetail && snapshotDetail.dateClosed)
      || (isCurrentClosure && record && record.date_closed)
    );
    const observedAt = textOrNull(
      transition && transition.observed_at
      || closureSnapshot && closureSnapshot.fetched_at
      || record && record.finalized_at
    );
    const title = previousStatus
      ? `${previousStatus} → ${status}`
      : (followupState === 'closing' ? `Verifying ${status}` : status);
    const finalState = normalizedStatus(closureSnapshot && closureSnapshot.final_state);
    const detailUnconfirmed = finalState === 'detail_unconfirmed';
    const verificationState = detailUnconfirmed
      ? 'unconfirmed'
      : followupState === 'closed'
        ? 'verified'
        : followupState === 'closing' ? 'checking' : null;
    const verificationLabel = detailUnconfirmed
      ? 'Portal detail did not confirm closure'
      : followupState === 'closed'
        ? 'Confirmed from NYC311 Portal'
        : followupState === 'closing' ? 'Portal verification in progress' : null;
    return {
      id: `portal-${transition && transition.id || closureSnapshot && closureSnapshot.id || status}`,
      source: 'portal',
      source_label: 'NYC311 Portal',
      event_kind: isClosedStatus(status) ? 'Closed' : 'Updated',
      title,
      previous_status: previousStatus,
      status,
      effective_at: effectiveAt,
      observed_at: observedAt,
      response_text: snapshotNarrative(closureSnapshot)
        || textOrNull(parsedSnapshot(transition && transition.snapshot_json)?.additionalDetails),
      final_state: textOrNull(closureSnapshot && closureSnapshot.final_state),
      verification_state: verificationState,
      verification_label: verificationLabel,
      sort_at: observedAt || effectiveAt
    };
  }

  function emailEvents(record, payload, statusPayload) {
    const updates = Array.isArray(payload && payload.updates) ? payload.updates : [];
    const followupState = normalizedStatus(record && record.followup_state);
    const closureSnapshot = currentClosureSnapshot(record, statusPayload);
    const finalState = normalizedStatus(
      (record && record.current_cycle_final_state)
      || (closureSnapshot && closureSnapshot.final_state)
    );
    return updates.map(update => {
      const eventKind = textOrNull(update && update.event_kind) || 'Updated';
      const closed = isClosedStatus(eventKind);
      let verificationState = null;
      let verificationLabel = null;
      if (closed && finalState === 'detail_unconfirmed') {
        verificationState = 'unconfirmed';
        verificationLabel = 'Portal detail did not confirm closure';
      } else if (closed && followupState === 'closed') {
        verificationState = 'verified';
        verificationLabel = 'Confirmed from NYC311 Portal';
      } else if (closed && followupState === 'closing') {
        verificationState = 'checking';
        verificationLabel = 'Portal verification in progress';
      } else if (closed && update && update.closure_wake_queued) {
        verificationState = 'queued';
        verificationLabel = 'Portal verification queued';
      } else if (closed) {
        verificationState = 'waiting';
        verificationLabel = 'Awaiting Portal verification';
      }
      return {
        ...update,
        id: `email-${update && update.id || update && update.received_at || eventKind}`,
        source: 'email',
        source_label: 'NYC311 email',
        title: eventKind,
        verification_state: verificationState,
        verification_label: verificationLabel,
        sort_at: textOrNull(update && update.received_at)
      };
    });
  }

  function buildStatusUpdateModel(record, statusPayload, emailPayload) {
    const events = emailEvents(record, emailPayload, statusPayload);
    const portal = portalEvent(record, statusPayload);
    if (portal) events.push(portal);
    events.sort((left, right) => (
      timestampValue(right.sort_at) - timestampValue(left.sort_at)
      || String(right.id || '').localeCompare(String(left.id || ''))
    ));
    const emailTotal = Number(emailPayload && emailPayload.total);
    return {
      official_status: textOrNull(record && record.status),
      events,
      total: (Number.isFinite(emailTotal) && emailTotal >= 0 ? emailTotal : 0)
        + (portal ? 1 : 0)
    };
  }

  return {
    buildEmailMetricsModel,
    buildStatusUpdateModel,
    currentClosureSnapshot,
    formatMetricDuration,
    isClosedStatus,
    meaningfulTransitions,
    portalEvent,
    requestArchiveLabel
  };
}));
