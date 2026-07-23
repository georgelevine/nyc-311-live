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
    const transition = meaningfulTransitions(payload)[0] || null;
    const closureSnapshot = currentClosureSnapshot(record, payload);
    const followupState = normalizedStatus(
      (record && record.followup_state) || (payload && payload.followup && payload.followup.state)
    );
    const currentStatus = textOrNull(record && record.status);
    if (!transition && followupState !== 'closed' && followupState !== 'closing') return null;

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
      verification_state: followupState === 'closed'
        ? 'verified'
        : followupState === 'closing' ? 'checking' : null,
      verification_label: followupState === 'closed'
        ? 'Confirmed from NYC311 Portal'
        : followupState === 'closing' ? 'Portal verification in progress' : null,
      sort_at: observedAt || effectiveAt
    };
  }

  function emailEvents(record, payload) {
    const updates = Array.isArray(payload && payload.updates) ? payload.updates : [];
    const followupState = normalizedStatus(record && record.followup_state);
    return updates.map(update => {
      const eventKind = textOrNull(update && update.event_kind) || 'Updated';
      const closed = isClosedStatus(eventKind);
      let verificationState = null;
      let verificationLabel = null;
      if (closed && followupState === 'closed') {
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
    const events = emailEvents(record, emailPayload);
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
    buildStatusUpdateModel,
    currentClosureSnapshot,
    isClosedStatus,
    meaningfulTransitions,
    portalEvent
  };
}));
