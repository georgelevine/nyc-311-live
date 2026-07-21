'use strict';

const PORTAL_CLOCK_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i;
const ZONED_ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):?(\d{2}))$/i;

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validClock({ year, month, day, hour, minute, second }) {
  return Number.isInteger(year)
    && Number.isInteger(month) && month >= 1 && month <= 12
    && Number.isInteger(day) && day >= 1 && day <= daysInMonth(year, month)
    && Number.isInteger(hour) && hour >= 0 && hour <= 23
    && Number.isInteger(minute) && minute >= 0 && minute <= 59
    && Number.isInteger(second) && second >= 0 && second <= 59;
}

/**
 * NYC311's Portal publishes its legacy clock as M/D/YYYY h:mm:ss AM/PM without
 * a zone, but that clock represents UTC. Explicitly zoned ISO timestamps are
 * accepted too. Ambiguous strings are rejected instead of being interpreted in
 * the server's local timezone.
 */
function normalizePortalTimestamp(value) {
  if (value == null || String(value).trim() === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const text = String(value).trim();
  const portal = text.match(PORTAL_CLOCK_PATTERN);
  if (portal) {
    const [, monthText, dayText, yearText, hourText, minuteText, secondText, period] = portal;
    const month = Number(monthText);
    const day = Number(dayText);
    const year = Number(yearText);
    const rawHour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    if (rawHour < 1 || rawHour > 12) return null;
    const hour = rawHour % 12 + (period.toUpperCase() === 'PM' ? 12 : 0);
    if (!validClock({ year, month, day, hour, minute, second })) return null;
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
  }

  const iso = text.match(ZONED_ISO_PATTERN);
  if (!iso) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    , zone, , offsetHourText, offsetMinuteText] = iso;
  const clock = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
    second: Number(secondText)
  };
  if (!validClock(clock)) return null;
  if (zone.toUpperCase() !== 'Z') {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function normalizePortalDetailTimestamps(detail) {
  if (!detail || typeof detail !== 'object') return detail;
  return {
    ...detail,
    dateReported: normalizePortalTimestamp(detail.dateReported),
    updatedOn: normalizePortalTimestamp(detail.updatedOn),
    dateClosed: normalizePortalTimestamp(detail.dateClosed)
  };
}

module.exports = {
  PORTAL_CLOCK_PATTERN,
  ZONED_ISO_PATTERN,
  normalizePortalDetailTimestamps,
  normalizePortalTimestamp
};
