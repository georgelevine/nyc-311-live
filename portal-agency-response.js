'use strict';

const AGENCY_RESPONSE_FIELD = 'Agency Response';

function normalizedText(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
}

function meaningfulText(value) {
  const text = normalizedText(value);
  if (!text || /^(?:N\/?A|NONE|NOT PROVIDED)$/i.test(text)) return null;
  return text;
}

function extractPortalAgencyResponse($) {
  if (typeof $ !== 'function') return null;
  const messages = $('#page-wrapper > p')
    .map((_, element) => meaningfulText($(element).text()))
    .get()
    .filter(Boolean);
  return messages.length ? messages.join('\n\n') : null;
}

function attachPortalAgencyResponse($, fields) {
  const response = extractPortalAgencyResponse($);
  if (response && fields && typeof fields === 'object') {
    fields[AGENCY_RESPONSE_FIELD] = response;
  }
  return response;
}

function agencyResponseFromFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  return meaningfulText(fields[AGENCY_RESPONSE_FIELD]);
}

module.exports = {
  AGENCY_RESPONSE_FIELD,
  agencyResponseFromFields,
  attachPortalAgencyResponse,
  extractPortalAgencyResponse,
  meaningfulText,
  normalizedText
};
