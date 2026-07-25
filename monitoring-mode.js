'use strict';

function scheduledOpenFollowupsEnabled(env = process.env) {
  return !/^(?:0|false|off|no)$/i.test(
    String(env.SCHEDULED_OPEN_FOLLOWUPS_ENABLED ?? '1').trim()
  );
}

function monitoringMode(env = process.env) {
  return scheduledOpenFollowupsEnabled(env)
    ? 'email_primary_with_scheduled_fallback'
    : 'email_primary';
}

function chooseDetailWork({
  closing = null,
  initial = null,
  open = null,
  scheduledOpenFollowups = true
} = {}) {
  return closing || initial || (scheduledOpenFollowups ? open : null) || null;
}

function preservePendingClosureStatus({
  currentStatus,
  incomingStatus,
  followUpState
} = {}) {
  const closed = value => /\b(?:closed|resolved|cancel(?:led|ed)?)\b/i.test(
    String(value || '')
  );
  return closed(currentStatus)
    && !closed(incomingStatus)
    && String(followUpState || '').trim().toLowerCase() === 'closing';
}

module.exports = {
  chooseDetailWork,
  monitoringMode,
  preservePendingClosureStatus,
  scheduledOpenFollowupsEnabled
};
