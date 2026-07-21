const fetch = require('node-fetch');
const cheerio = require('cheerio');

const MAP_URL = 'https://portal.311.nyc.gov/entity-pin-fetch-service-requests/';
const PORTAL_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (compatible; NYC-311-Cloud/1.0)',
  Referer: 'https://portal.311.nyc.gov/check-status/',
  Origin: 'https://portal.311.nyc.gov'
};
function normalizePortalTimestamp(value) {
  if (!value) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const [, month, day, year, rawHour, minute, second, period] = match;
  let hour = Number(rawHour) % 12;
  if (period.toUpperCase() === 'PM') hour += 12;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), hour, Number(minute), Number(second))).toISOString();
}

function parseDetail(html, expectedNumber, expectedPortalId = null) {
  const $ = cheerio.load(html);
  const portalId = String($('#EntityFormView_EntityID').val() || expectedPortalId || '').trim();
  const notFoundText = $('.alert, .validation-summary-errors, #MessagePanel').text().replace(/\s+/g, ' ').trim();
  if (!portalId) {
    if (/didn['’]t find a Service Request with this number/i.test(notFoundText)) return { outcome: 'not_found' };
    return { outcome: 'retry', error: 'Portal page had neither a record nor its not-found marker' };
  }

  const fields = {};
  $('.info label').each((_, label) => {
    const name = $(label).text().replace(/\s+/g, ' ').trim();
    const field = $(label).closest('[class*="col-"]');
    const value = field.find('.control span').first().text().replace(/\s+/g, ' ').trim();
    if (name && value && value !== '-') fields[name] = value;
  });
  const scripts = $('script').map((_, script) => $(script).html() || '').get().join('\n');
  const scriptDate = id => {
    const pattern = new RegExp(`\\$\\(["']#${id}["']\\)\\.text\\(getESTDate\\(["']([^"']+)["']\\)\\)`);
    const match = scripts.match(pattern);
    return match ? match[1] : null;
  };
  const srnumber = fields['SR Number'] || expectedNumber;
  if (!srnumber) return { outcome: 'retry', error: 'Portal detail did not contain a request number' };
  return {
    outcome: 'found',
    record: {
      srnumber,
      portalId,
      status: fields['SR Status'] || null,
      problem: fields.Problem || null,
      problemDetails: fields['Problem Details'] || null,
      additionalDetails: fields['Additional Details'] || null,
      address: fields['SR Address'] || null,
      nextUpdate: fields['Time To Next Update'] || null,
      dateReported: scriptDate('srdatereported'),
      updatedOn: scriptDate('srupdatedon'),
      dateClosed: scriptDate('srdateclosed'),
      fields
    }
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLatestPins() {
  const response = await fetchWithTimeout(MAP_URL, { headers: PORTAL_HEADERS }, 30_000);
  if (!response.ok) throw new Error(`Portal map returned HTTP ${response.status}`);
  const text = await response.text();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Portal map response did not contain a record list');
  const records = JSON.parse(match[0]);
  if (!Array.isArray(records)) throw new Error('Portal map response was not a record list');
  return records;
}

async function fetchDetailById(srnumber, portalId) {
  const response = await fetchWithTimeout(
    `https://portal.311.nyc.gov/sr-details/?id=${encodeURIComponent(portalId)}`,
    { headers: { ...PORTAL_HEADERS, Accept: 'text/html,application/xhtml+xml' } },
    15_000
  );
  if (!response.ok) throw new Error(`Portal detail returned HTTP ${response.status}`);
  return parseDetail(await response.text(), srnumber, portalId);
}

async function fetchDetailByNumber(srnumber) {
  const response = await fetchWithTimeout(
    `https://portal.311.nyc.gov/sr-details/?srnum=${encodeURIComponent(srnumber)}`,
    { headers: { ...PORTAL_HEADERS, Accept: 'text/html,application/xhtml+xml' } },
    30_000
  );
  if (response.status === 429 || response.status >= 500) throw new Error(`Portal detail returned HTTP ${response.status}`);
  if (!response.ok) throw new Error(`Portal detail returned HTTP ${response.status}`);
  return { ...parseDetail(await response.text(), srnumber), httpStatus: response.status };
}

module.exports = {
  PORTAL_HEADERS,
  normalizePortalTimestamp,
  fetchLatestPins,
  fetchDetailById,
  fetchDetailByNumber,
  parseDetail
};
