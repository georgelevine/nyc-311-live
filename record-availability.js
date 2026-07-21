const { isClosedStatus } = require('./closure-tracking');

function hasText(value) {
  return value != null && String(value).trim() !== '';
}

function hasMapPin(record) {
  if (!record || record.latitude == null || record.longitude == null) return false;
  if (String(record.latitude).trim() === '' || String(record.longitude).trim() === '') return false;
  return Number.isFinite(Number(record.latitude)) && Number.isFinite(Number(record.longitude));
}

function missingField(key, label, category, important = false) {
  return { key, label, category, important };
}

function currentCycleClosureDate(record) {
  const state = String(record && record.followup_state || '').trim().toLowerCase();
  if (state === 'open' || state === 'closing') return null;
  if (state === 'closed' && Boolean(record && record.closure_cycle_tracking)) {
    return record.current_cycle_date_closed || null;
  }
  return (record && record.date_closed) || null;
}

function currentLifecycleProjection(record) {
  const dateClosed = currentCycleClosureDate(record);
  const state = String(record && record.followup_state || '').trim().toLowerCase();
  const trackedClosure = state === 'closing' || state === 'closed';
  const status = (trackedClosure || (dateClosed && state !== 'open'))
      && !isClosedStatus(record && record.status)
    ? 'Closed'
    : record && record.status || null;
  return { status, date_closed: dateClosed };
}

/**
 * Describe what the NYC311 Portal did and did not publish for a request.
 *
 * This is deliberately derived at read time instead of being stored as a
 * permanent database flag. A later Portal refresh can enrich the same SR and
 * the availability label will then correct itself automatically.
 */
function assessRecordAvailability(record) {
  const detailsLoaded = hasText(record && record.details_fetched_at);
  const mapPin = hasMapPin(record);

  if (!detailsLoaded) {
    return {
      public_details_state: 'pending',
      has_map_pin: mapPin,
      missing_public_fields: null,
      missing_important_fields: null
    };
  }

  const missing = [];
  const status = record && record.status;
  const followupState = String(record && record.followup_state || '').trim().toLowerCase();
  const activelyOpen = followupState === 'open';
  const trackedClosure = followupState === 'closing' || followupState === 'closed';
  const hasClosureDate = hasText(record && record.date_closed);
  const closedEvidence = !activelyOpen && (
    trackedClosure || isClosedStatus(status) || hasClosureDate
  );
  const effectiveStatus = hasText(status)
    ? status
    : closedEvidence && hasClosureDate
      ? 'Closed'
      : status;
  const problem = record && record.problem;
  const reportedTime = record && (record.date_reported || record.submitted_at);

  if (!hasText(effectiveStatus)) {
    missing.push(missingField('status', 'Status', 'core', true));
  }
  if (!hasText(problem)) {
    missing.push(missingField('problem', 'Problem type', 'core', true));
  }
  if (!hasText(record && record.problem_details)) {
    missing.push(missingField('problem_details', 'Problem details', 'submission'));
  }
  if (!hasText(record && record.additional_details)) {
    missing.push(missingField('additional_details', 'Additional details', 'submission'));
  }
  if (!hasText(record && record.address)) {
    missing.push(missingField('address', 'Public address', 'location'));
  }
  if (!hasText(reportedTime)) {
    missing.push(missingField('reported_time', 'Reported time', 'core', true));
  }
  if (!hasText(record && record.updated_on)) {
    missing.push(missingField('updated_on', 'Updated time', 'lifecycle'));
  }

  if (closedEvidence) {
    if (!hasText(record && record.date_closed)) {
      missing.push(missingField('date_closed', 'Closed time', 'lifecycle'));
    }
  } else if (!hasText(record && record.next_update)) {
    missing.push(missingField('next_update', 'Next update', 'lifecycle'));
  }

  const important = missing.filter(field => field.important);

  return {
    public_details_state: 'loaded',
    has_map_pin: mapPin,
    missing_public_fields: missing,
    missing_important_fields: important
  };
}

module.exports = {
  assessRecordAvailability,
  currentCycleClosureDate,
  currentLifecycleProjection,
  hasMapPin,
  hasText
};
