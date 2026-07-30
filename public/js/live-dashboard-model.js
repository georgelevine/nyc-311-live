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

  function recordSuffix(record) {
    const explicit = Number(record && record.suffix);
    if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;
    const match = normalizedText(record && record.srnumber).match(/^311-(\d{8})$/);
    const derived = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(derived) && derived > 0 ? derived : null;
  }

  function collectionHas(collection, value) {
    if (!collection) return false;
    if (typeof collection.has === 'function') return collection.has(value);
    return Array.isArray(collection) && collection.includes(value);
  }

  function validatePaginatedRecords(records, {
    beforeSuffix = null,
    expectedSnapshot = null,
    requireSnapshot = false,
    page = {},
    existingNumbers = null,
    expectedTotal = null,
    loadedCount = 0,
    label = 'Data service'
  } = {}) {
    if (!Array.isArray(records)) throw new Error(`${label} returned an invalid records page`);
    const cursor = beforeSuffix == null ? null : Number(beforeSuffix);
    if (cursor != null && (!Number.isSafeInteger(cursor) || cursor < 1)) {
      throw new Error(`${label} received an invalid request cursor`);
    }
    const seen = new Set();
    let previous = cursor == null ? Number.POSITIVE_INFINITY : cursor;
    for (const record of records) {
      const number = normalizedText(record && record.srnumber);
      const suffix = recordSuffix(record);
      if (!number || suffix == null || suffix >= previous) {
        throw new Error(`${label} returned records out of order`);
      }
      if (seen.has(number) || collectionHas(existingNumbers, number)) {
        throw new Error(`${label} repeated ${number}`);
      }
      seen.add(number);
      previous = suffix;
    }

    if (page.returned != null && Number(page.returned) !== records.length) {
      throw new Error(`${label} returned an inconsistent record count`);
    }
    const snapshotAt = normalizedText(page.snapshot_at) || null;
    if (requireSnapshot && !snapshotAt) {
      throw new Error(`${label} omitted its snapshot`);
    }
    if (expectedSnapshot && snapshotAt !== expectedSnapshot) {
      throw new Error(`${label} changed snapshots during pagination`);
    }

    const hasMore = page.has_more === true;
    const nextSuffix = page.next_before_suffix == null
      ? null
      : Number(page.next_before_suffix);
    if (hasMore) {
      if (!records.length) throw new Error(`${label} made no pagination progress`);
      const lastSuffix = recordSuffix(records[records.length - 1]);
      if (!Number.isSafeInteger(nextSuffix) || nextSuffix !== lastSuffix) {
        throw new Error(`${label} returned an invalid page cursor`);
      }
    }

    const total = expectedTotal == null ? null : Number(expectedTotal);
    const accumulated = Number(loadedCount) + records.length;
    if (total != null) {
      if (!Number.isSafeInteger(total) || total < 0) {
        throw new Error(`${label} returned an invalid total`);
      }
      if (accumulated > total || (hasMore && accumulated >= total)
          || (!hasMore && accumulated !== total)) {
        throw new Error(`${label} changed while loading`);
      }
    }

    return { hasMore, nextSuffix, snapshotAt };
  }

  function feedHeadMembershipDelta(currentRecords, incomingRecords) {
    const current = Array.isArray(currentRecords)
      ? currentRecords.filter(record => recordSuffix(record) != null)
      : [];
    const incoming = Array.isArray(incomingRecords)
      ? incomingRecords.filter(record => recordSuffix(record) != null)
      : [];
    const currentNumbers = new Set(current.map(record => normalizedText(record.srnumber)));
    const incomingNumbers = new Set(incoming.map(record => normalizedText(record.srnumber)));
    if (!incoming.length) return -currentNumbers.size;
    const oldestIncoming = incoming.reduce(
      (minimum, record) => Math.min(minimum, recordSuffix(record)),
      Number.POSITIVE_INFINITY
    );
    const added = [...incomingNumbers].filter(number => !currentNumbers.has(number)).length;
    const removed = current.filter(record => (
      recordSuffix(record) >= oldestIncoming
      && !incomingNumbers.has(normalizedText(record.srnumber))
    )).length;
    return added - removed;
  }

  function boundaryCatalogIsUsable(items, boundaryVersion) {
    return Array.isArray(items) && items.length > 0 && Boolean(normalizedText(boundaryVersion));
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
    boundaryCatalogIsUsable,
    coordinateNumber,
    exactSrnumberQuery,
    feedHeadMembershipDelta,
    feedCardModel,
    isClosed,
    normalizedText,
    recordCoordinates,
    recordDetailsPending,
    recordHasMapPin,
    recordSuffix,
    validatePaginatedRecords
  };
}));
