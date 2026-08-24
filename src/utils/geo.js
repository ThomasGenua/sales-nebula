'use strict';

/*
 * Geospatial utilities for territory mapping and proximity search.
 *
 * All distance work uses the spherical earth model with a mean radius of
 * 6371.0088 km, which is accurate to roughly 0.3 percent for the
 * distances a CRM cares about (visit routing, territory assignment,
 * "accounts near this postcode"). Nothing here needs an ellipsoid.
 */

const EARTH_RADIUS_KM = 6371.0088;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';

// ─── Validation ──────────────────────────────────────────────

function isValidLatitude(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

function isValidPoint(point) {
  if (!point || typeof point !== 'object') return false;
  const lat = point.lat !== undefined ? point.lat : point.latitude;
  const lng = point.lng !== undefined ? point.lng : point.longitude;
  return isValidLatitude(lat) && isValidLongitude(lng);
}

/* Accept {lat,lng}, {latitude,longitude} or [lng,lat] GeoJSON order. */
function toPoint(input) {
  if (Array.isArray(input) && input.length >= 2) {
    return { lat: Number(input[1]), lng: Number(input[0]) };
  }
  if (!input || typeof input !== 'object') return null;
  const lat = input.lat !== undefined ? Number(input.lat) : Number(input.latitude);
  const lng = input.lng !== undefined ? Number(input.lng) : Number(input.longitude);
  if (!isValidLatitude(lat) || !isValidLongitude(lng)) return null;
  return { lat, lng };
}

/*
 * Normalize longitude into the range -180 to 180. Needed when a bounding
 * box or a destination calculation pushes a value past the antimeridian.
 */
function wrapLongitude(lng) {
  let value = lng;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

// ─── Distance and bearing ────────────────────────────────────

/*
 * Great circle distance in kilometres using the haversine formula.
 *
 * a = sin²(Δφ/2) + cos φ1 · cos φ2 · sin²(Δλ/2)
 * c = 2 · atan2(√a, √(1−a))
 * d = R · c
 */
function haversineDistance(a, b) {
  const p1 = toPoint(a);
  const p2 = toPoint(b);
  if (!p1 || !p2) return null;

  const dLat = (p2.lat - p1.lat) * DEG_TO_RAD;
  const dLng = (p2.lng - p1.lng) * DEG_TO_RAD;
  const lat1 = p1.lat * DEG_TO_RAD;
  const lat2 = p2.lat * DEG_TO_RAD;

  const h = (Math.sin(dLat / 2) ** 2)
    + (Math.cos(lat1) * Math.cos(lat2) * (Math.sin(dLng / 2) ** 2));
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function kmToMiles(km) { return km * 0.621371; }
function milesToKm(miles) { return miles / 0.621371; }

/* Initial bearing in degrees from point a to point b, 0 being north. */
function bearing(a, b) {
  const p1 = toPoint(a);
  const p2 = toPoint(b);
  if (!p1 || !p2) return null;

  const lat1 = p1.lat * DEG_TO_RAD;
  const lat2 = p2.lat * DEG_TO_RAD;
  const dLng = (p2.lng - p1.lng) * DEG_TO_RAD;

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = (Math.cos(lat1) * Math.sin(lat2))
    - (Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng));
  return (Math.atan2(y, x) * RAD_TO_DEG + 360) % 360;
}

function compassDirection(degrees) {
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return points[Math.round(degrees / 22.5) % 16];
}

/* Project a point a given distance along a bearing. */
function destinationPoint(origin, distanceKm, bearingDegrees) {
  const p = toPoint(origin);
  if (!p) return null;

  const angular = distanceKm / EARTH_RADIUS_KM;
  const theta = bearingDegrees * DEG_TO_RAD;
  const lat1 = p.lat * DEG_TO_RAD;
  const lng1 = p.lng * DEG_TO_RAD;

  const lat2 = Math.asin(
    (Math.sin(lat1) * Math.cos(angular))
    + (Math.cos(lat1) * Math.sin(angular) * Math.cos(theta)),
  );
  const lng2 = lng1 + Math.atan2(
    Math.sin(theta) * Math.sin(angular) * Math.cos(lat1),
    Math.cos(angular) - (Math.sin(lat1) * Math.sin(lat2)),
  );

  return { lat: lat2 * RAD_TO_DEG, lng: wrapLongitude(lng2 * RAD_TO_DEG) };
}

// ─── Bounding boxes ──────────────────────────────────────────

/*
 * Compute a bounding box around a centre point for a radius search.
 *
 * This is the cheap prefilter: the database can use a plain index range
 * on latitude and longitude to reject almost everything, and only the
 * survivors need the more expensive haversine check. Longitude degrees
 * shrink with latitude, hence the cos correction.
 */
function boundingBox(center, radiusKm) {
  const p = toPoint(center);
  if (!p) return null;

  const latDelta = (radiusKm / EARTH_RADIUS_KM) * RAD_TO_DEG;
  const cosLat = Math.cos(p.lat * DEG_TO_RAD);
  const lngDelta = Math.abs(cosLat) < 1e-9
    ? 180
    : (radiusKm / (EARTH_RADIUS_KM * cosLat)) * RAD_TO_DEG;

  return {
    minLat: Math.max(-90, p.lat - latDelta),
    maxLat: Math.min(90, p.lat + latDelta),
    minLng: Math.max(-180, p.lng - lngDelta),
    maxLng: Math.min(180, p.lng + lngDelta),
  };
}

function polygonBounds(polygon) {
  const points = (polygon || []).map(toPoint).filter(Boolean);
  if (points.length === 0) return null;

  let minLat = Infinity; let maxLat = -Infinity;
  let minLng = Infinity; let maxLng = -Infinity;

  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

function boundsContain(bounds, point) {
  const p = toPoint(point);
  if (!p || !bounds) return false;
  return p.lat >= bounds.minLat && p.lat <= bounds.maxLat
    && p.lng >= bounds.minLng && p.lng <= bounds.maxLng;
}

// ─── Polygon geometry ────────────────────────────────────────

/*
 * Point in polygon by ray casting. Counts how many polygon edges a
 * ray extending east from the point crosses; odd means inside.
 *
 * Points exactly on an edge are treated as inside, which is what a user
 * assigning a territory boundary expects.
 */
function pointInPolygon(point, polygon) {
  const p = toPoint(point);
  const ring = (polygon || []).map(toPoint).filter(Boolean);
  if (!p || ring.length < 3) return false;

  if (pointOnPolygonEdge(p, ring)) return true;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const yi = ring[i].lat; const xi = ring[i].lng;
    const yj = ring[j].lat; const xj = ring[j].lng;

    const straddles = (yi > p.lat) !== (yj > p.lat);
    if (!straddles) continue;
    const intersectLng = ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi;
    if (p.lng < intersectLng) inside = !inside;
  }
  return inside;
}

function pointOnPolygonEdge(point, ring, tolerance = 1e-9) {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const cross = ((point.lng - ring[j].lng) * (ring[i].lat - ring[j].lat))
      - ((point.lat - ring[j].lat) * (ring[i].lng - ring[j].lng));
    if (Math.abs(cross) > tolerance) continue;

    const withinLng = point.lng >= Math.min(ring[i].lng, ring[j].lng) - tolerance
      && point.lng <= Math.max(ring[i].lng, ring[j].lng) + tolerance;
    const withinLat = point.lat >= Math.min(ring[i].lat, ring[j].lat) - tolerance
      && point.lat <= Math.max(ring[i].lat, ring[j].lat) + tolerance;
    if (withinLng && withinLat) return true;
  }
  return false;
}

/*
 * Signed area of a polygon on the sphere, returned in square kilometres.
 * Uses the spherical excess formula, which stays correct for the large
 * regions a sales territory can cover where a planar approximation drifts.
 */
function polygonArea(polygon) {
  const ring = (polygon || []).map(toPoint).filter(Boolean);
  if (ring.length < 3) return 0;

  let total = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % ring.length];
    total += (p2.lng - p1.lng) * DEG_TO_RAD
      * (2 + Math.sin(p1.lat * DEG_TO_RAD) + Math.sin(p2.lat * DEG_TO_RAD));
  }
  return Math.abs((total * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

/*
 * Area weighted centroid. Falls back to the arithmetic mean when the
 * polygon is degenerate, so callers always get a usable label anchor.
 */
function polygonCentroid(polygon) {
  const ring = (polygon || []).map(toPoint).filter(Boolean);
  if (ring.length === 0) return null;
  if (ring.length < 3) {
    const sum = ring.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
    return { lat: sum.lat / ring.length, lng: sum.lng / ring.length };
  }

  let twiceArea = 0;
  let lat = 0;
  let lng = 0;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const cross = (ring[j].lng * ring[i].lat) - (ring[i].lng * ring[j].lat);
    twiceArea += cross;
    lat += (ring[j].lat + ring[i].lat) * cross;
    lng += (ring[j].lng + ring[i].lng) * cross;
  }

  if (Math.abs(twiceArea) < 1e-12) {
    const sum = ring.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
    return { lat: sum.lat / ring.length, lng: sum.lng / ring.length };
  }

  const factor = 1 / (3 * twiceArea);
  return { lat: lat * factor, lng: wrapLongitude(lng * factor) };
}

/* Perimeter of the polygon in kilometres. */
function polygonPerimeter(polygon) {
  const ring = (polygon || []).map(toPoint).filter(Boolean);
  if (ring.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < ring.length; i += 1) {
    total += haversineDistance(ring[i], ring[(i + 1) % ring.length]) || 0;
  }
  return total;
}

/* Approximate a circle as a polygon so circular areas render on a map. */
function circleToPolygon(center, radiusKm, segments = 48) {
  const points = [];
  for (let i = 0; i < segments; i += 1) {
    const point = destinationPoint(center, radiusKm, (i * 360) / segments);
    if (point) points.push(point);
  }
  return points;
}

/*
 * Ramer-Douglas-Peucker simplification. Territory polygons traced by hand
 * or imported from shapefiles routinely carry thousands of vertices; the
 * map only needs enough to keep the outline recognizable.
 */
function simplifyPolygon(polygon, toleranceKm = 1) {
  const ring = (polygon || []).map(toPoint).filter(Boolean);
  if (ring.length <= 3) return ring;

  const perpendicular = (point, lineStart, lineEnd) => {
    const total = haversineDistance(lineStart, lineEnd);
    if (!total || total === 0) return haversineDistance(point, lineStart) || 0;
    const a = haversineDistance(lineStart, point) || 0;
    const b = haversineDistance(point, lineEnd) || 0;
    const s = (a + b + total) / 2;
    const areaSq = Math.max(0, s * (s - a) * (s - b) * (s - total));
    return (2 * Math.sqrt(areaSq)) / total;
  };

  const simplifySegment = (points, first, last, keep) => {
    let maxDistance = 0;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const distance = perpendicular(points[i], points[first], points[last]);
      if (distance > maxDistance) { maxDistance = distance; index = i; }
    }
    if (maxDistance > toleranceKm && index !== -1) {
      simplifySegment(points, first, index, keep);
      keep.add(index);
      simplifySegment(points, index, last, keep);
    }
  };

  const keep = new Set([0, ring.length - 1]);
  simplifySegment(ring, 0, ring.length - 1, keep);
  return [...keep].sort((a, b) => a - b).map((i) => ring[i]);
}

// ─── Geohash ─────────────────────────────────────────────────

/*
 * Encode a point as a geohash. Adjacent points share a prefix, which
 * gives cheap proximity bucketing and a stable key for marker clustering
 * without any spatial extension in the database.
 */
function encodeGeohash(latitude, longitude, precision = 9) {
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;

  let latMin = -90; let latMax = 90;
  let lngMin = -180; let lngMax = 180;
  let hash = '';
  let bits = 0;
  let bitCount = 0;
  let even = true;

  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (longitude >= mid) { bits = (bits << 1) + 1; lngMin = mid; }
      else { bits <<= 1; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (latitude >= mid) { bits = (bits << 1) + 1; latMin = mid; }
      else { bits <<= 1; latMax = mid; }
    }
    even = !even;
    bitCount += 1;
    if (bitCount === 5) {
      hash += GEOHASH_ALPHABET[bits];
      bits = 0;
      bitCount = 0;
    }
  }
  return hash;
}

function decodeGeohash(hash) {
  if (!hash) return null;
  let latMin = -90; let latMax = 90;
  let lngMin = -180; let lngMax = 180;
  let even = true;

  for (const char of String(hash).toLowerCase()) {
    const index = GEOHASH_ALPHABET.indexOf(char);
    if (index === -1) return null;
    for (let bit = 4; bit >= 0; bit -= 1) {
      const value = (index >> bit) & 1;
      if (even) {
        const mid = (lngMin + lngMax) / 2;
        if (value === 1) lngMin = mid; else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (value === 1) latMin = mid; else latMax = mid;
      }
      even = !even;
    }
  }
  return {
    lat: (latMin + latMax) / 2,
    lng: (lngMin + lngMax) / 2,
    bounds: { minLat: latMin, maxLat: latMax, minLng: lngMin, maxLng: lngMax },
  };
}

/* Choose a geohash precision that roughly matches a map zoom level. */
function precisionForZoom(zoom) {
  if (zoom <= 2) return 1;
  if (zoom <= 4) return 2;
  if (zoom <= 6) return 3;
  if (zoom <= 8) return 4;
  if (zoom <= 10) return 5;
  if (zoom <= 12) return 6;
  if (zoom <= 14) return 7;
  return 8;
}

// ─── Clustering ──────────────────────────────────────────────

/*
 * Grid cluster markers by geohash prefix so a map holding fifty thousand
 * accounts can render at any zoom without shipping every marker to the
 * browser. Single member cells are returned as plain markers.
 */
function clusterByGeohash(markers, zoom = 8) {
  const precision = precisionForZoom(zoom);
  const cells = new Map();

  for (const marker of markers || []) {
    const p = toPoint(marker);
    if (!p) continue;
    const key = encodeGeohash(p.lat, p.lng, precision);
    if (!key) continue;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push({ ...marker, lat: p.lat, lng: p.lng });
  }

  const clusters = [];
  for (const [key, members] of cells.entries()) {
    if (members.length === 1) {
      clusters.push({
        type: 'marker',
        geohash: key,
        count: 1,
        latitude: members[0].lat,
        longitude: members[0].lng,
        marker: members[0],
      });
      continue;
    }
    const sum = members.reduce((acc, m) => ({ lat: acc.lat + m.lat, lng: acc.lng + m.lng }), { lat: 0, lng: 0 });
    clusters.push({
      type: 'cluster',
      geohash: key,
      count: members.length,
      latitude: sum.lat / members.length,
      longitude: sum.lng / members.length,
      bounds: polygonBounds(members),
      sampleIds: members.slice(0, 5).map((m) => m.recordId || m.id).filter(Boolean),
    });
  }
  return clusters.sort((a, b) => b.count - a.count);
}

/*
 * K-means over lat/lng for territory suggestion. Deterministic seeding
 * (evenly spaced picks from the sorted input) so repeated runs on the
 * same data produce the same territories, which matters when the output
 * drives account assignment.
 */
function kMeansCluster(points, k, maxIterations = 40) {
  const items = (points || []).map(toPoint).filter(Boolean);
  if (items.length === 0 || k <= 0) return [];
  const clusterCount = Math.min(k, items.length);

  const sorted = [...items].sort((a, b) => (a.lat - b.lat) || (a.lng - b.lng));
  const centroids = [];
  for (let i = 0; i < clusterCount; i += 1) {
    centroids.push({ ...sorted[Math.floor((i * sorted.length) / clusterCount)] });
  }

  let assignments = new Array(items.length).fill(-1);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let changed = false;

    items.forEach((point, index) => {
      let best = 0;
      let bestDistance = Infinity;
      centroids.forEach((centroid, ci) => {
        const distance = haversineDistance(point, centroid);
        if (distance !== null && distance < bestDistance) { bestDistance = distance; best = ci; }
      });
      if (assignments[index] !== best) { assignments[index] = best; changed = true; }
    });

    const sums = centroids.map(() => ({ lat: 0, lng: 0, count: 0 }));
    items.forEach((point, index) => {
      const bucket = sums[assignments[index]];
      bucket.lat += point.lat;
      bucket.lng += point.lng;
      bucket.count += 1;
    });
    sums.forEach((bucket, ci) => {
      if (bucket.count > 0) {
        centroids[ci] = { lat: bucket.lat / bucket.count, lng: bucket.lng / bucket.count };
      }
    });

    if (!changed) break;
  }

  return centroids.map((centroid, ci) => {
    const members = items.filter((_, index) => assignments[index] === ci);
    const distances = members.map((m) => haversineDistance(m, centroid) || 0);
    return {
      index: ci,
      centroid,
      count: members.length,
      members,
      radiusKm: distances.length ? Math.max(...distances) : 0,
      avgDistanceKm: distances.length
        ? distances.reduce((a, b) => a + b, 0) / distances.length
        : 0,
    };
  });
}

// ─── Proximity search ────────────────────────────────────────

/*
 * Filter and rank markers by distance from an origin. The bounding box
 * check runs first because it is a pair of numeric comparisons, whereas
 * haversine costs several trig calls per candidate.
 */
function findWithinRadius(origin, markers, radiusKm, options = {}) {
  const { limit = 100, sortBy = 'distance' } = options;
  const box = boundingBox(origin, radiusKm);
  if (!box) return [];

  const results = [];
  for (const marker of markers || []) {
    const p = toPoint(marker);
    if (!p || !boundsContain(box, p)) continue;
    const distance = haversineDistance(origin, p);
    if (distance === null || distance > radiusKm) continue;
    results.push({
      ...marker,
      distanceKm: Math.round(distance * 100) / 100,
      distanceMiles: Math.round(kmToMiles(distance) * 100) / 100,
      bearing: bearing(origin, p),
      direction: compassDirection(bearing(origin, p) || 0),
    });
  }

  if (sortBy === 'distance') results.sort((a, b) => a.distanceKm - b.distanceKm);
  return results.slice(0, limit);
}

/*
 * Assign a point to the best matching area. Areas are tested in priority
 * order, and among equal priorities the smallest containing area wins so
 * that a city zone nested inside a national region takes precedence.
 */
function assignToArea(point, areas) {
  const p = toPoint(point);
  if (!p) return null;

  const matches = [];
  for (const area of areas || []) {
    if (area.active === false) continue;

    if (area.shape === 'circle' && area.centerLat != null && area.radiusKm) {
      const distance = haversineDistance(p, { lat: area.centerLat, lng: area.centerLng });
      if (distance !== null && distance <= area.radiusKm) {
        matches.push({ area, size: Math.PI * area.radiusKm * area.radiusKm });
      }
      continue;
    }

    const polygon = Array.isArray(area.polygon) ? area.polygon : null;
    if (!polygon) continue;
    if (area.minLat != null && !boundsContain({
      minLat: area.minLat, maxLat: area.maxLat, minLng: area.minLng, maxLng: area.maxLng,
    }, p)) continue;
    if (pointInPolygon(p, polygon)) {
      matches.push({ area, size: area.areaSqKm || polygonArea(polygon) });
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const priorityDiff = (a.area.priority ?? 100) - (b.area.priority ?? 100);
    if (priorityDiff !== 0) return priorityDiff;
    return a.size - b.size;
  });
  return matches[0].area;
}

// ─── Route ordering ──────────────────────────────────────────

/*
 * Nearest neighbour tour with a 2-opt improvement pass. This is a
 * heuristic, not an optimal solve, but for the ten to thirty stops a
 * field rep plans in a day it lands within a few percent of optimal in
 * negligible time.
 */
function optimizeRoute(origin, stops, options = {}) {
  const { returnToStart = false } = options;
  const points = (stops || []).map((stop, index) => ({ ...stop, _point: toPoint(stop), _index: index }))
    .filter((s) => s._point);
  if (points.length === 0) return { order: [], totalKm: 0, legs: [] };

  const start = toPoint(origin) || points[0]._point;
  const remaining = [...points];
  const ordered = [];
  let current = start;

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    remaining.forEach((candidate, i) => {
      const distance = haversineDistance(current, candidate._point);
      if (distance !== null && distance < bestDistance) { bestDistance = distance; bestIndex = i; }
    });
    const [chosen] = remaining.splice(bestIndex, 1);
    ordered.push(chosen);
    current = chosen._point;
  }

  const tourLength = (sequence) => {
    let total = 0;
    let previous = start;
    for (const stop of sequence) {
      total += haversineDistance(previous, stop._point) || 0;
      previous = stop._point;
    }
    if (returnToStart) total += haversineDistance(previous, start) || 0;
    return total;
  };

  let improved = true;
  let guard = 0;
  while (improved && guard < 60) {
    improved = false;
    guard += 1;
    for (let i = 0; i < ordered.length - 1; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const candidate = [
          ...ordered.slice(0, i),
          ...ordered.slice(i, j + 1).reverse(),
          ...ordered.slice(j + 1),
        ];
        if (tourLength(candidate) < tourLength(ordered) - 1e-9) {
          ordered.splice(0, ordered.length, ...candidate);
          improved = true;
        }
      }
    }
  }

  const legs = [];
  let previous = start;
  for (const stop of ordered) {
    const distance = haversineDistance(previous, stop._point) || 0;
    legs.push({
      to: stop.label || stop.name || stop.recordId,
      distanceKm: Math.round(distance * 100) / 100,
      bearing: Math.round(bearing(previous, stop._point) || 0),
    });
    previous = stop._point;
  }
  if (returnToStart) {
    legs.push({
      to: 'start',
      distanceKm: Math.round((haversineDistance(previous, start) || 0) * 100) / 100,
      bearing: Math.round(bearing(previous, start) || 0),
    });
  }

  return {
    order: ordered.map((s) => s._index),
    stops: ordered.map(({ _point, _index, ...rest }) => rest),
    totalKm: Math.round(tourLength(ordered) * 100) / 100,
    legs,
  };
}

// ─── GeoJSON ─────────────────────────────────────────────────

function areaToGeoJson(area) {
  const polygon = area.shape === 'circle' && area.centerLat != null
    ? circleToPolygon({ lat: area.centerLat, lng: area.centerLng }, area.radiusKm || 1)
    : (Array.isArray(area.polygon) ? area.polygon : []);

  const ring = polygon.map(toPoint).filter(Boolean).map((p) => [p.lng, p.lat]);
  if (ring.length > 0) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  }

  return {
    type: 'Feature',
    id: area.id,
    properties: {
      name: area.name,
      type: area.type,
      color: area.color,
      territoryId: area.territoryId || null,
      areaSqKm: area.areaSqKm || null,
    },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

function markersToGeoJson(markers) {
  return {
    type: 'FeatureCollection',
    features: (markers || []).map((marker) => ({
      type: 'Feature',
      id: marker.id,
      properties: {
        module: marker.module,
        recordId: marker.recordId,
        label: marker.label,
        sublabel: marker.sublabel || null,
        color: marker.color,
      },
      geometry: { type: 'Point', coordinates: [marker.longitude, marker.latitude] },
    })),
  };
}

/*
 * Read a GeoJSON Feature or FeatureCollection into internal polygons.
 * Only the outer ring of each polygon is retained; holes are not part
 * of the territory model.
 */
function geoJsonToAreas(geojson) {
  const features = geojson?.type === 'FeatureCollection'
    ? (geojson.features || [])
    : [geojson].filter(Boolean);
  const areas = [];

  for (const feature of features) {
    const geometry = feature?.geometry;
    if (!geometry) continue;
    const rings = geometry.type === 'Polygon'
      ? [geometry.coordinates?.[0]]
      : geometry.type === 'MultiPolygon'
        ? (geometry.coordinates || []).map((poly) => poly[0])
        : [];

    rings.forEach((ring, index) => {
      const polygon = (ring || []).map(toPoint).filter(Boolean);
      if (polygon.length < 3) return;
      const bounds = polygonBounds(polygon);
      const centroid = polygonCentroid(polygon);
      areas.push({
        name: feature.properties?.name
          ? (rings.length > 1 ? `${feature.properties.name} ${index + 1}` : feature.properties.name)
          : `Imported area ${areas.length + 1}`,
        type: feature.properties?.type || 'Territory',
        shape: 'polygon',
        polygon,
        centerLat: centroid?.lat ?? null,
        centerLng: centroid?.lng ?? null,
        areaSqKm: Math.round(polygonArea(polygon) * 100) / 100,
        ...bounds,
      });
    });
  }
  return areas;
}

// ─── Address hashing ─────────────────────────────────────────

/*
 * Stable cache key for an address. Normalizes case, whitespace and the
 * common street type abbreviations so that "123 King St. W" and
 * "123 King Street West" resolve to a single cached geocode.
 */
const STREET_ABBREVIATIONS = {
  street: 'st', road: 'rd', avenue: 'ave', boulevard: 'blvd', drive: 'dr',
  court: 'ct', lane: 'ln', place: 'pl', square: 'sq', terrace: 'ter',
  parkway: 'pkwy', highway: 'hwy', crescent: 'cres', circle: 'cir',
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  apartment: 'apt', suite: 'ste', unit: 'unit', floor: 'fl',
};

function normalizeAddress(address) {
  if (!address) return '';
  const words = String(address)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');
  return words
    .map((word) => STREET_ABBREVIATIONS[word] || word)
    .filter(Boolean)
    .join(' ');
}

function addressHash(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) return null;
  // FNV-1a, adequate for a cache key and cheap enough to run per record.
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}${normalized.length.toString(16)}`;
}

function composeAddress(parts) {
  return [parts.street, parts.city, parts.state || parts.region, parts.postalCode, parts.country]
    .map((p) => (p ? String(p).trim() : ''))
    .filter(Boolean)
    .join(', ');
}

module.exports = {
  EARTH_RADIUS_KM,
  isValidLatitude,
  isValidLongitude,
  isValidPoint,
  toPoint,
  wrapLongitude,
  haversineDistance,
  kmToMiles,
  milesToKm,
  bearing,
  compassDirection,
  destinationPoint,
  boundingBox,
  polygonBounds,
  boundsContain,
  pointInPolygon,
  pointOnPolygonEdge,
  polygonArea,
  polygonCentroid,
  polygonPerimeter,
  circleToPolygon,
  simplifyPolygon,
  encodeGeohash,
  decodeGeohash,
  precisionForZoom,
  clusterByGeohash,
  kMeansCluster,
  findWithinRadius,
  assignToArea,
  optimizeRoute,
  areaToGeoJson,
  markersToGeoJson,
  geoJsonToAreas,
  normalizeAddress,
  addressHash,
  composeAddress,
};
