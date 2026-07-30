'use strict';

(function exposeLiveDashboardModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NYC311LiveDashboardModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function normalizedText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function isClosed(status) {
    return /\b(?:closed|resolved|cancel(?:led|ed)?)\b/i.test(normalizedText(status));
  }

  function exactSrnumberQuery(value) {
    const normalized = normalizedText(value).toUpperCase().replace(/\s+/g, '');
    if (/^\d{8}$/.test(normalized)) return `311-${normalized}`;
    const match = normalized.match(/^311-?(\d{8})$/);
    return match ? `311-${match[1]}` : null;
  }

  function coordinateNumber(value) {
    if (value == null || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function recordCoordinates(record) {
    const latitude = coordinateNumber(record && record.latitude);
    const longitude = coordinateNumber(record && record.longitude);
    return latitude == null || longitude == null
      ? null
      : { lat: latitude, lng: longitude };
  }

  function recordHasMapPin(record) {
    return typeof (record && record.has_map_pin) === 'boolean'
      ? record.has_map_pin
      : Boolean(recordCoordinates(record));
  }

  function recordDetailsPending(record) {
    const state = normalizedText(record && record.public_details_state).toLowerCase();
    if (state) return state === 'pending';
    return Boolean(record && Object.prototype.hasOwnProperty.call(record, 'details_fetched_at')
      && !normalizedText(record.details_fetched_at));
  }

  function feedCardModel(record) {
    const problem = normalizedText(record && record.problem) || 'Service Request';
    const problemDetails = normalizedText(record && record.problem_details);
    return {
      srnumber: normalizedText(record && record.srnumber),
      headline: problem,
      detail: problemDetails && problemDetails.toLowerCase() !== problem.toLowerCase()
        ? problemDetails
        : '',
      address: normalizedText(record && record.address) || 'Location unavailable',
      status: normalizedText(record && record.status) || 'Unknown',
      submittedAt: record && record.submitted_at || null,
      closed: isClosed(record && record.status),
      hasMapPin: recordHasMapPin(record)
    };
  }

  function activeFilterLabel(values) {
    const count = (Array.isArray(values) ? values : [])
      .filter(value => normalizedText(value)).length;
    if (count === 0) return 'None selected';
    return `${count} active`;
  }

  return {
    activeFilterLabel,
    coordinateNumber,
    exactSrnumberQuery,
    feedCardModel,
    isClosed,
    normalizedText,
    recordCoordinates,
    recordDetailsPending,
    recordHasMapPin
  };
}));
