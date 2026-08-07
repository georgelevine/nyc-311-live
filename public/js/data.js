/**
 * data.js — BID boundaries and live NYC 311 Portal data
 */
const Data = (() => {
  const BID_PARCELS_URL = 'https://data.cityofnewyork.us/resource/7jdm-inj8.geojson?$limit=100';
  const BID_BOUNDARIES_URL = '/data/nyc-bid-boundaries-2026-04-28.geojson';
  const BID_BOUNDARIES_FALLBACK_URL = 'https://services6.arcgis.com/yG5s3afENB5iO9fj/arcgis/rest/services/BusinessImprovementDistrict_view/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson';
  const BID_CACHE_KEY = 'nyc_bid_geojson_2026_04_28_v1';
  const BID_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
  const portalDetailCache = new Map();

  const BOROUGH_NAMES = {
    1: 'Manhattan',
    2: 'Bronx',
    3: 'Brooklyn',
    4: 'Queens',
    5: 'Staten Island'
  };

  function polygonParts(feature) {
    if (!feature || !feature.geometry) return [];
    if (feature.geometry.type === 'Polygon') return [feature.geometry.coordinates];
    if (feature.geometry.type === 'MultiPolygon') return feature.geometry.coordinates;
    return [];
  }

  function parcelSamplePoints(feature) {
    return polygonParts(feature).map(coords => {
      try {
        return turf.pointOnFeature(turf.polygon(coords));
      } catch (e) {
        const ring = coords[0] || [];
        const count = Math.max(1, ring.length - 1);
        const sum = ring.slice(0, count).reduce((acc, point) => [
          acc[0] + point[0],
          acc[1] + point[1]
        ], [0, 0]);
        return turf.point([sum[0] / count, sum[1] / count]);
      }
    });
  }

  function bboxesOverlap(a, b) {
    return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
  }

  function cleanBoundaryName(name) {
    return String(name || 'Business Improvement District')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+BID$/i, '')
      .trim();
  }

  /**
   * Join Open Data parcel detail to the pinned official district polygons.
   * Spatial matching avoids brittle name aliases (for example NoHo BID/NoHo NY).
   */
  function mergeBIDSources(parcelData, boundaryData) {
    const boundaries = (boundaryData.features || []).map((feature, index) => ({
      feature,
      index,
      bbox: turf.bbox(feature)
    }));
    const parcelMatches = new Map();

    for (const parcelFeature of parcelData.features || []) {
      const samples = parcelSamplePoints(parcelFeature);
      const parcelBbox = turf.bbox(parcelFeature);
      let best = null;

      for (const boundary of boundaries) {
        if (!bboxesOverlap(parcelBbox, boundary.bbox)) continue;
        const score = samples.reduce((count, point) => {
          try {
            return count + (turf.booleanPointInPolygon(point, boundary.feature) ? 1 : 0);
          } catch (e) {
            return count;
          }
        }, 0);
        if (score > 0 && (!best || score > best.score)) best = { ...boundary, score };
      }

      if (best) parcelMatches.set(best.index, parcelFeature);
    }

    return {
      type: 'FeatureCollection',
      features: boundaries.map(({ feature }, index) => {
        const parcelFeature = parcelMatches.get(index);
        const parcelProperties = parcelFeature ? parcelFeature.properties || {} : {};
        const boundaryProperties = feature.properties || {};
        const boundaryName = boundaryProperties.name || boundaryProperties.BID;
        const boroughCode = boundaryProperties.borough_code || boundaryProperties.BOROUGH;

        return {
          type: 'Feature',
          geometry: feature.geometry,
          parcelGeometry: parcelFeature ? parcelFeature.geometry : null,
          properties: {
            ...boundaryProperties,
            ...parcelProperties,
            f_all_bi_2: parcelProperties.f_all_bi_2 || cleanBoundaryName(boundaryName),
            f_all_bi_1: parcelProperties.f_all_bi_1 || boundaryProperties.borough ||
              BOROUGH_NAMES[boroughCode] || 'Unknown',
            f_all_bi_4: parcelProperties.f_all_bi_4 || null,
            year_found: parcelProperties.year_found || null,
            __boundary_source: 'arcgis'
          }
        };
      })
    };
  }

  async function fetchBoundaryResponse() {
    try {
      const snapshotResp = await fetch(BID_BOUNDARIES_URL);
      if (snapshotResp.ok) return snapshotResp;
      console.warn(`Pinned BID boundary fetch failed: ${snapshotResp.status}`);
    } catch (err) {
      console.warn('Pinned BID boundary fetch failed:', err.message);
    }
    return fetch(BID_BOUNDARIES_FALLBACK_URL);
  }

  /**
   * Fetch BID GeoJSON (with localStorage caching)
   */
  async function fetchBIDs() {
    // Check cache
    try {
      const cached = localStorage.getItem(BID_CACHE_KEY);
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < BID_CACHE_TTL) {
          console.log('BID data loaded from cache');
          return data;
        }
      }
    } catch (e) { /* cache miss */ }

    const [parcelResult, boundaryResult] = await Promise.allSettled([
      fetch(BID_PARCELS_URL),
      fetchBoundaryResponse()
    ]);
    const parcelResp = parcelResult.status === 'fulfilled' ? parcelResult.value : null;
    const boundaryResp = boundaryResult.status === 'fulfilled' ? boundaryResult.value : null;

    let parcelData = null;
    let boundaryData = null;
    if (parcelResp && parcelResp.ok) parcelData = await parcelResp.json();
    if (boundaryResp && boundaryResp.ok) boundaryData = await boundaryResp.json();

    if (!parcelData && !boundaryData) throw new Error('BID boundary sources are unavailable');

    let data;
    if (boundaryData) {
      data = mergeBIDSources(parcelData || { type: 'FeatureCollection', features: [] }, boundaryData);
    } else {
      console.warn('ArcGIS BID boundaries unavailable; using Open Data parcel geometry');
      data = parcelData;
    }

    // Cache only the complete joined result. A temporary source outage should
    // not pin reduced fallback data in the browser for a week.
    if (parcelData && boundaryData) {
      try {
        localStorage.setItem(BID_CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
      } catch (e) { /* storage full, skip */ }
    }

    return data;
  }

  /**
   * Fetch 311 requests from portal via adaptive proxy.
   * Server-side: breaks date range into daily windows, re-splits capped days
   * spatially, deduplicates, and returns all results in one response.
   */
  async function fetch311Portal(paddedBbox, fromDate, toDate, opts = {}) {
    const [west, south, east, north] = paddedBbox;
    const params = new URLSearchParams({
      minlatitude: south,
      minlongitude: west,
      maxlatitude: north,
      maxlongitude: east,
      fromdate: fromDate,
      todate: toDate
    });
    if (opts.bidId != null) params.append('bid_id', String(opts.bidId));
    if (opts.bidBoundaryVersion) {
      params.append('bid_boundary_version', String(opts.bidBoundaryVersion));
    }
    if (opts.refresh) params.append('refresh', '1');

    try {
      const resp = await fetch(`/api/portal-pins-adaptive?${params}`);
      if (!resp.ok) throw new Error(`Portal fetch failed: ${resp.status}`);
      const data = await resp.json();

      if (data.error) {
        console.warn('Portal API returned error:', data.error);
        return [];
      }

      if (data.stats) {
        console.log(`Portal adaptive: ${data.stats.total_pins} pins from ${data.stats.total_calls} calls` +
          (data.stats.phase2_capped_days > 0
            ? ` (${data.stats.phase2_capped_days} days re-split spatially)`
            : ''));
      }

      return (data.pins || []).map(p => ({
        ...p,
        _source: 'portal'
      }));
    } catch (err) {
      console.warn('Portal fetch failed (non-critical):', err.message);
      return []; // Portal data is supplementary, don't break the app
    }
  }

  function portalRecord(pin) {
    return {
      unique_key: null,
      complaint_type: pin.problem,
      descriptor: null,
      status: pin.status,
      agency: null,
      agency_name: null,
      created_date: pin.submitteddate,
      closed_date: null,
      resolution_description: null,
      incident_address: pin.address,
      city: null,
      borough: null,
      incident_zip: null,
      latitude: pin.latitude,
      longitude: pin.longitude,
      community_board: null,
      open_data_channel_type: null,
      location_type: null,
      bbl: null,
      srnumber: pin.srnumber,
      portalUrl: pin.portalUrl,
      portalId: pin.id,
      _source: 'portal'
    };
  }

  function fetchPortalDetail(portalId) {
    if (!portalId) return Promise.resolve(null);
    if (portalDetailCache.has(portalId)) return portalDetailCache.get(portalId);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    const request = fetch(`/api/portal-detail?id=${encodeURIComponent(portalId)}`, {
      signal: controller.signal
    })
      .then(resp => {
        if (!resp.ok) throw new Error(`Portal detail fetch failed: ${resp.status}`);
        return resp.json();
      })
      .catch(err => {
        portalDetailCache.delete(portalId);
        console.warn('Portal case detail unavailable:', err.message);
        return null;
      })
      .finally(() => window.clearTimeout(timeout));

    portalDetailCache.set(portalId, request);
    return request;
  }

  return { fetchBIDs, fetch311Portal, fetchPortalDetail, portalRecord };
})();
