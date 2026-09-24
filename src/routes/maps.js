const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { isAdmin } = require('../middleware/rowSecurity');
const { columnsFrom } = require('../utils/modelFields');
const {
  haversineDistance, isValidPoint, boundingBox, pointInPolygon, polygonBounds,
  polygonArea, polygonCentroid, circleToPolygon, encodeGeohash, clusterByGeohash,
  precisionForZoom, findWithinRadius, optimizeRoute, areaToGeoJson, markersToGeoJson,
  geoJsonToAreas, normalizeAddress, addressHash, composeAddress, bearing, compassDirection,
} = require('../utils/geo');

const router = Router();

const MAPPABLE = {
  accounts: 'account', contacts: 'contact', leads: 'lead',
  prospects: 'prospect', cases: 'case', activities: 'activity',
};

// ── WHOSE MARKERS ─────────────────────────────────────────────────────
// A marker names its record and says where it is. These routes returned and
// changed every record's marker for anyone signed in; now a module's markers
// take its permission, and a marker goes only with a record the caller can
// reach.

// Prospects answer to the leads permission, as in routes/prospects.
const permissionFor = module => (module === 'prospects' ? 'leads' : module);

/** The mappable modules the caller may read: `module` alone, when given. */
function readableModules(req, module) {
  return (module ? [module] : Object.keys(MAPPABLE))
    .filter(m => MAPPABLE[m] && permits(req, permissionFor(m), 'read'));
}

/**
 * `where`, narrowed to the module's live records the caller may see ('Read')
 * or change ('Edit'). Prospects follow the row security of leads, as in
 * routes/prospects.
 */
function reachableRecords(req, module, where = {}, minLevel = 'Read') {
  return reachableWhere(req, permissionFor(module), MAPPABLE[module], where, minLevel);
}

/** Only the markers whose record the caller can reach. */
async function reachableMarkers(req, markers) {
  const prisma = req.app.locals.prisma;
  const keep = new Set();
  for (const module of new Set(markers.map(m => m.module))) {
    if (!MAPPABLE[module]) continue;
    const ids = [...new Set(markers.filter(m => m.module === module).map(m => m.recordId))];
    const found = await prisma[MAPPABLE[module]].findMany({ where: await reachableRecords(req, module, { id: { in: ids } }), select: { id: true } });
    for (const r of found) keep.add(`${module}:${r.id}`);
  }
  return markers.filter(m => keep.has(`${m.module}:${m.recordId}`));
}

/**
 * Whether the caller may place or remove a marker for this record: the
 * module's edit permission and the record within their reach. Otherwise it
 * answers and returns false.
 */
async function mayChangeMarker(req, res, module, recordId) {
  if (!MAPPABLE[module]) { res.status(400).json({ error: `Module ${module} is not mappable` }); return false; }
  if (!permits(req, permissionFor(module), 'edit')) { res.status(403).json({ error: `Insufficient permissions for ${permissionFor(module)}` }); return false; }
  if (isAdmin(req.user)) return true;
  const found = await req.app.locals.prisma[MAPPABLE[module]].findFirst({
    where: await reachableRecords(req, module, { id: String(recordId) }, 'Edit'), select: { id: true },
  });
  if (!found) { res.status(404).json({ error: 'Record not found' }); return false; }
  return true;
}

/** Pull the address parts out of a record whatever the field naming. */
function addressFrom(record) {
  return {
    street: record.billingStreet || record.street || record.address || record.mailingStreet || null,
    city: record.billingCity || record.city || record.mailingCity || null,
    region: record.billingState || record.state || record.region || record.mailingState || null,
    postalCode: record.billingPostalCode || record.postalCode || record.zip || record.mailingPostalCode || null,
    country: record.billingCountry || record.country || record.mailingCountry || null,
  };
}

function labelFor(record) {
  return record.name
    || [record.firstName, record.lastName].filter(Boolean).join(' ')
    || record.subject || record.accountName || 'Unnamed';
}

// ── GEOCODE CACHE ─────────────────────────────────────────────────────

router.get('/geocode', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'address required' });

    const hash = addressHash(normalizeAddress(address));
    const cached = await prisma.geocodeCache.findFirst({ where: { addressHash: hash } });
    if (cached && !cached.failed) {
      await prisma.geocodeCache.update({ where: { id: cached.id }, data: { hitCount: { increment: 1 }, lastUsedAt: new Date() } });
      return res.json({ cached: true, ...cached });
    }
    if (cached?.failed) return res.status(404).json({ error: 'Address previously failed to geocode', cached: true, rawAddress: cached.rawAddress });

    res.status(404).json({
      error: 'Address not in the geocode cache',
      hint: 'POST to /api/maps/geocode with latitude and longitude to store a resolved coordinate',
      addressHash: hash, normalized: normalizeAddress(address),
    });
  } catch (err) { next(err); }
});

// Store a resolved coordinate. The lookup itself happens outside the API.
// The cache is shared and feeds everyone's maps, and any signed-in user could
// overwrite any entry. Now anyone may add an address the cache lacks, or give
// a failed lookup its first coordinate; replacing an entry takes admin edit.
router.post('/geocode', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { address, latitude, longitude, formattedAddress, city, region, postalCode, country, countryCode, accuracy, provider, confidence, failed } = req.body;
    if (!address) return res.status(400).json({ error: 'address required' });

    if (!failed) {
      if (latitude === undefined || longitude === undefined) return res.status(400).json({ error: 'latitude and longitude required unless failed is true' });
      if (!isValidPoint({ lat: +latitude, lng: +longitude })) return res.status(400).json({ error: 'Coordinates out of range' });
    }

    const hash = addressHash(normalizeAddress(address));
    const data = {
      addressHash: hash, rawAddress: address, formattedAddress: formattedAddress || null,
      latitude: failed ? null : +latitude, longitude: failed ? null : +longitude,
      city, region, postalCode, country, countryCode, accuracy,
      provider: provider || 'manual', confidence: confidence != null ? +confidence : (failed ? 0 : 1),
      failed: !!failed, lastUsedAt: new Date(),
    };

    const existing = await prisma.geocodeCache.findFirst({ where: { addressHash: hash } });
    if (existing && !(existing.failed && !failed) && !permits(req, 'admin', 'edit')) {
      return res.status(403).json({ error: 'That address is already in the geocode cache; replacing it needs admin edit permission' });
    }
    const record = existing
      ? await prisma.geocodeCache.update({ where: { id: existing.id }, data })
      : await prisma.geocodeCache.create({ data });

    res.status(existing ? 200 : 201).json(record);
  } catch (err) { next(err); }
});

// Which records still need a coordinate
router.get('/geocode/pending/:module', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const model = MAPPABLE[req.params.module];
    if (!model) return res.status(400).json({ error: `Module ${req.params.module} is not mappable` });
    // Names and addresses of the caller's records only; this listed anyone's.
    if (!readableModules(req, req.params.module).length) {
      return res.status(403).json({ error: `Insufficient permissions for ${permissionFor(req.params.module)}` });
    }

    const records = await prisma[model].findMany({ where: await reachableRecords(req, req.params.module), take: Math.min(parseInt(req.query.limit, 10) || 200, 1000) });
    const markers = await prisma.mapMarker.findMany({ where: { module: req.params.module }, select: { recordId: true } });
    const mapped = new Set(markers.map(m => m.recordId));

    const pending = [];
    for (const r of records) {
      if (mapped.has(r.id)) continue;
      const parts = addressFrom(r);
      const composed = composeAddress(parts);
      if (!composed) continue;
      const hash = addressHash(normalizeAddress(composed));
      const cached = await prisma.geocodeCache.findFirst({ where: { addressHash: hash, failed: false } });
      pending.push({ recordId: r.id, label: labelFor(r), address: composed, addressHash: hash, cacheHit: !!cached, latitude: cached?.latitude ?? null, longitude: cached?.longitude ?? null });
    }

    res.json({ module: req.params.module, pending: pending.length, resolvableFromCache: pending.filter(p => p.cacheHit).length, records: pending });
  } catch (err) { next(err); }
});

router.get('/geocode/stats', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [total, failed, agg] = await Promise.all([
      prisma.geocodeCache.count(),
      prisma.geocodeCache.count({ where: { failed: true } }),
      prisma.geocodeCache.aggregate({ _sum: { hitCount: true }, _avg: { confidence: true } }),
    ]);
    res.json({
      cachedAddresses: total, failedLookups: failed, successRate: total ? +(((total - failed) / total) * 100).toFixed(1) : 0,
      totalCacheHits: agg._sum.hitCount || 0, avgConfidence: +(agg._avg.confidence || 0).toFixed(2),
    });
  } catch (err) { next(err); }
});

// ── MARKERS ───────────────────────────────────────────────────────────

router.get('/markers', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, ownerId, areaId, bounds, cluster, zoom, limit = 1000 } = req.query;
    if (module && !MAPPABLE[module]) return res.status(400).json({ error: `Module ${module} is not mappable` });
    const modules = readableModules(req, module);
    if (module && !modules.length) return res.status(403).json({ error: `Insufficient permissions for ${permissionFor(module)}` });

    const where = { module: { in: modules } };
    if (ownerId) where.ownerId = ownerId;
    if (areaId) where.areaId = areaId;
    if (bounds) {
      const [minLat, minLng, maxLat, maxLng] = String(bounds).split(',').map(Number);
      if ([minLat, minLng, maxLat, maxLng].some(isNaN)) return res.status(400).json({ error: 'bounds must be minLat,minLng,maxLat,maxLng' });
      where.latitude = { gte: minLat, lte: maxLat };
      where.longitude = { gte: minLng, lte: maxLng };
    }

    const markers = await reachableMarkers(req, await prisma.mapMarker.findMany({ where, take: Math.min(+limit, 5000) }));

    if (cluster === 'true') {
      // clusterByGeohash takes the zoom and converts it itself; handed the
      // precision, it converted twice and clustered far coarser than asked.
      const zoomLevel = parseInt(zoom, 10) || 10;
      const precision = precisionForZoom(zoomLevel);
      const clusters = clusterByGeohash(markers.map(m => ({ ...m, lat: m.latitude, lng: m.longitude })), zoomLevel);
      return res.json({ clustered: true, precision, totalMarkers: markers.length, clusters });
    }

    res.json({ total: markers.length, markers });
  } catch (err) { next(err); }
});

router.post('/markers', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId, label, latitude, longitude, sublabel, markerType, color, icon, ownerId, meta } = req.body;
    if (!module || !recordId || !label) return res.status(400).json({ error: 'module, recordId, and label required' });
    if (!isValidPoint({ lat: +latitude, lng: +longitude })) return res.status(400).json({ error: 'Valid latitude and longitude required' });
    if (!(await mayChangeMarker(req, res, module, recordId))) return;

    const geohash = encodeGeohash(+latitude, +longitude, 9);
    const data = {
      module, recordId, label, sublabel, latitude: +latitude, longitude: +longitude,
      geohash, markerType: markerType || 'default', color: color || '#F5A623',
      icon, ownerId, meta: meta || null, stale: false,
    };

    // Place the marker inside whichever area contains it
    const areas = await prisma.mapArea.findMany({ where: { deletedAt: null, active: true }, orderBy: { priority: 'asc' } });
    for (const area of areas) {
      if (area.shape === 'circle' && area.centerLat != null && area.radiusKm) {
        if (haversineDistance({ lat: area.centerLat, lng: area.centerLng }, { lat: +latitude, lng: +longitude }) <= area.radiusKm) { data.areaId = area.id; break; }
      } else if (Array.isArray(area.polygon) && area.polygon.length >= 3) {
        if (pointInPolygon({ lat: +latitude, lng: +longitude }, area.polygon)) { data.areaId = area.id; break; }
      }
    }

    const existing = await prisma.mapMarker.findFirst({ where: { module, recordId } });
    const marker = existing
      ? await prisma.mapMarker.update({ where: { id: existing.id }, data })
      : await prisma.mapMarker.create({ data });

    res.status(existing ? 200 : 201).json(marker);
  } catch (err) { next(err); }
});

// Build markers for a module from the geocode cache
router.post('/markers/sync/:module', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const model = MAPPABLE[req.params.module];
    if (!model) return res.status(400).json({ error: `Module ${req.params.module} is not mappable` });

    const records = await prisma[model].findMany({ where: { deletedAt: null }, take: Math.min(parseInt(req.body.limit, 10) || 2000, 5000) });
    const areas = await prisma.mapArea.findMany({ where: { deletedAt: null, active: true }, orderBy: { priority: 'asc' } });

    let created = 0, updated = 0, unresolved = 0;
    for (const record of records) {
      let lat = record.latitude, lng = record.longitude;

      if (lat == null || lng == null) {
        const composed = composeAddress(addressFrom(record));
        if (!composed) { unresolved++; continue; }
        const cached = await prisma.geocodeCache.findFirst({ where: { addressHash: addressHash(normalizeAddress(composed)), failed: false } });
        if (!cached?.latitude) { unresolved++; continue; }
        lat = cached.latitude; lng = cached.longitude;
      }
      if (!isValidPoint({ lat, lng })) { unresolved++; continue; }

      let areaId = null;
      for (const area of areas) {
        if (area.shape === 'circle' && area.centerLat != null && area.radiusKm) {
          if (haversineDistance({ lat: area.centerLat, lng: area.centerLng }, { lat, lng }) <= area.radiusKm) { areaId = area.id; break; }
        } else if (Array.isArray(area.polygon) && area.polygon.length >= 3) {
          if (pointInPolygon({ lat, lng }, area.polygon)) { areaId = area.id; break; }
        }
      }

      const data = {
        module: req.params.module, recordId: record.id, label: labelFor(record),
        sublabel: record.city || record.billingCity || null,
        latitude: lat, longitude: lng, geohash: encodeGeohash(lat, lng, 9),
        ownerId: record.ownerId || null, areaId, stale: false,
      };
      const existing = await prisma.mapMarker.findFirst({ where: { module: req.params.module, recordId: record.id } });
      if (existing) { await prisma.mapMarker.update({ where: { id: existing.id }, data }); updated++; }
      else { await prisma.mapMarker.create({ data }); created++; }
    }

    await req.audit({ action: 'update', module: 'maps', recordId: req.params.module, details: `Marker sync: ${created} created, ${updated} updated` });
    res.json({ module: req.params.module, scanned: records.length, created, updated, unresolved });
  } catch (err) { next(err); }
});

router.delete('/markers/:module/:recordId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!(await mayChangeMarker(req, res, req.params.module, req.params.recordId))) return;
    const result = await prisma.mapMarker.deleteMany({ where: { module: req.params.module, recordId: req.params.recordId } });
    res.json({ removed: result.count });
  } catch (err) { next(err); }
});

// ── PROXIMITY ─────────────────────────────────────────────────────────

router.get('/nearby', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { lat, lng, radiusKm = 25, module, limit = 50 } = req.query;
    if (!isValidPoint({ lat: +lat, lng: +lng })) return res.status(400).json({ error: 'Valid lat and lng required' });
    const radius = Math.min(+radiusKm, 20000);
    if (module && !MAPPABLE[module]) return res.status(400).json({ error: `Module ${module} is not mappable` });
    const modules = readableModules(req, module);
    if (module && !modules.length) return res.status(403).json({ error: `Insufficient permissions for ${permissionFor(module)}` });

    // Bounding box first so the database does the coarse filtering
    const box = boundingBox({ lat: +lat, lng: +lng }, radius);
    const where = {
      latitude: { gte: box.minLat, lte: box.maxLat },
      longitude: { gte: box.minLng, lte: box.maxLng },
      module: { in: modules },
    };

    const candidates = await reachableMarkers(req, await prisma.mapMarker.findMany({ where, take: 5000 }));
    const origin = { lat: +lat, lng: +lng };
    // Results carry distanceKm; reading `distance` threw whenever anything
    // was in range. findWithinRadius stops at 100 unless told otherwise.
    const within = findWithinRadius(origin, candidates.map(c => ({ ...c, lat: c.latitude, lng: c.longitude })), radius, { limit: Math.min(+limit || 50, 200) })
      .map(m => ({
        module: m.module, recordId: m.recordId, label: m.label, sublabel: m.sublabel,
        latitude: m.latitude, longitude: m.longitude,
        distanceKm: m.distanceKm,
        bearing: compassDirection(bearing(origin, { lat: m.latitude, lng: m.longitude })),
      }));

    res.json({ origin, radiusKm: radius, candidatesScanned: candidates.length, found: within.length, results: within });
  } catch (err) { next(err); }
});

// Order stops to shorten a field visit route
router.post('/route', authenticate, async (req, res, next) => {
  try {
    const { start, stops, returnToStart } = req.body;
    if (!Array.isArray(stops) || stops.length < 2) return res.status(400).json({ error: 'At least two stops required' });
    // The optimizer's passes grow with the cube of the stops.
    if (stops.length > 100) return res.status(400).json({ error: 'At most 100 stops per route' });
    for (const s of stops) {
      // +undefined is NaN, not null, so `+s.lat ?? +s.latitude` never fell back.
      if (!isValidPoint({ lat: +(s.lat ?? s.latitude), lng: +(s.lng ?? s.longitude) })) {
        return res.status(400).json({ error: `Invalid coordinates on stop: ${s.label || s.id || 'unknown'}` });
      }
    }

    const normalized = stops.map(s => ({ ...s, lat: +(s.lat ?? s.latitude), lng: +(s.lng ?? s.longitude) }));
    const origin = start ? { lat: +(start.lat ?? start.latitude), lng: +(start.lng ?? start.longitude) } : normalized[0];
    const optimized = optimizeRoute(origin, normalized, { returnToStart: !!returnToStart });

    res.json(optimized);
  } catch (err) { next(err); }
});

// ── AREAS AND TERRITORIES ─────────────────────────────────────────────

router.get('/areas', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const where = { deletedAt: null };
    if (req.query.type) where.type = req.query.type;
    if (req.query.active !== 'false') where.active = true;

    // An area is a shape and its settings, no record's data, so it stays open
    // to anyone signed in. Its count took in every module's markers, records
    // the caller cannot open included; now it is of those GET /markers shows.
    const areas = await prisma.mapArea.findMany({ where, orderBy: [{ priority: 'asc' }, { name: 'asc' }] });
    const markers = await reachableMarkers(req, await prisma.mapMarker.findMany({
      where: { module: { in: readableModules(req) }, areaId: { in: areas.map(a => a.id) } },
      select: { module: true, recordId: true, areaId: true }, take: 20000,
    }));
    const byArea = new Map();
    for (const m of markers) byArea.set(m.areaId, (byArea.get(m.areaId) || 0) + 1);

    res.json(areas.map(a => ({ ...a, markerCount: byArea.get(a.id) || 0 })));
  } catch (err) { next(err); }
});

router.post('/areas', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, type, shape, polygon, centerLat, centerLng, radiusKm, color, territoryId, assignedUserId, priority, parentAreaId } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const data = {
      name, description, type: type || 'Territory', shape: shape || 'polygon',
      color: color || '#F5A623', territoryId, assignedUserId,
      priority: priority ?? 100, parentAreaId,
    };

    if ((shape || 'polygon') === 'circle') {
      if (!isValidPoint({ lat: +centerLat, lng: +centerLng })) return res.status(400).json({ error: 'Valid centerLat and centerLng required for a circle' });
      if (!radiusKm || +radiusKm <= 0) return res.status(400).json({ error: 'radiusKm must be positive' });
      data.centerLat = +centerLat; data.centerLng = +centerLng; data.radiusKm = +radiusKm;
      const ring = circleToPolygon({ lat: +centerLat, lng: +centerLng }, +radiusKm, 36);
      data.polygon = ring;
      const bounds = polygonBounds(ring);
      Object.assign(data, bounds);
      data.areaSqKm = +(Math.PI * radiusKm * radiusKm).toFixed(2);
    } else {
      if (!Array.isArray(polygon) || polygon.length < 3) return res.status(400).json({ error: 'polygon needs at least three points' });
      for (const pt of polygon) {
        const p = { lat: +(pt.lat ?? pt[1]), lng: +(pt.lng ?? pt[0]) };
        if (!isValidPoint(p)) return res.status(400).json({ error: 'Polygon contains an invalid coordinate' });
      }
      const ring = polygon.map(pt => ({ lat: +(pt.lat ?? pt[1]), lng: +(pt.lng ?? pt[0]) }));
      data.polygon = ring;
      const centroid = polygonCentroid(ring);
      data.centerLat = centroid.lat; data.centerLng = centroid.lng;
      Object.assign(data, polygonBounds(ring));
      data.areaSqKm = +polygonArea(ring).toFixed(2);
    }

    const area = await prisma.mapArea.create({ data });
    await req.audit({ action: 'create', module: 'maps', recordId: area.id, details: `Map area created: ${name}` });
    res.status(201).json(area);
  } catch (err) { next(err); }
});

router.put('/areas/:id', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // The area's own columns. The body went to the update whole, so a relation
    // key was a nested write (`markers` could rewrite every marker's owner);
    // deletedAt is DELETE's to set, at admin full.
    const data = columnsFrom('mapArea', req.body);
    delete data.deletedAt;
    if (data.polygon) {
      const ring = data.polygon.map(pt => ({ lat: +(pt.lat ?? pt[1]), lng: +(pt.lng ?? pt[0]) }));
      if (ring.length < 3) return res.status(400).json({ error: 'polygon needs at least three points' });
      data.polygon = ring;
      const centroid = polygonCentroid(ring);
      data.centerLat = centroid.lat; data.centerLng = centroid.lng;
      Object.assign(data, polygonBounds(ring));
      data.areaSqKm = +polygonArea(ring).toFixed(2);
    }
    res.json(await prisma.mapArea.update({ where: { id: req.params.id }, data }));
  } catch (err) { next(err); }
});

router.delete('/areas/:id', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.mapMarker.updateMany({ where: { areaId: req.params.id }, data: { areaId: null } });
    await prisma.mapArea.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), active: false } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// Recompute which area every marker falls into
router.post('/areas/reassign', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const areas = await prisma.mapArea.findMany({ where: { deletedAt: null, active: true }, orderBy: { priority: 'asc' } });
    const markers = await prisma.mapMarker.findMany({ take: 20000 });

    let reassigned = 0, orphaned = 0;
    for (const marker of markers) {
      let areaId = null;
      for (const area of areas) {
        if (area.shape === 'circle' && area.centerLat != null && area.radiusKm) {
          if (haversineDistance({ lat: area.centerLat, lng: area.centerLng }, { lat: marker.latitude, lng: marker.longitude }) <= area.radiusKm) { areaId = area.id; break; }
        } else if (Array.isArray(area.polygon) && area.polygon.length >= 3) {
          if (pointInPolygon({ lat: marker.latitude, lng: marker.longitude }, area.polygon)) { areaId = area.id; break; }
        }
      }
      if (areaId !== marker.areaId) { await prisma.mapMarker.update({ where: { id: marker.id }, data: { areaId } }); reassigned++; }
      if (!areaId) orphaned++;
    }

    await req.audit({ action: 'update', module: 'maps', recordId: 'reassign', details: `${reassigned} markers reassigned` });
    res.json({ markersScanned: markers.length, reassigned, outsideAnyArea: orphaned, areas: areas.length });
  } catch (err) { next(err); }
});

// Assign every record inside an area to its owner
router.post('/areas/:id/assign-owner', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const area = await prisma.mapArea.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!area) return res.status(404).json({ error: 'Area not found' });

    const named = req.body.userId || area.assignedUserId;
    if (!named) return res.status(400).json({ error: 'userId required, or set assignedUserId on the area' });
    // An active staff user: the id was taken as sent, so a mistyped one or a
    // customer's portal account became the owner of every record in the area.
    const owner = await prisma.user.findFirst({ where: { id: String(named), active: true, isPortalUser: false }, select: { id: true } });
    if (!owner) return res.status(400).json({ error: 'userId does not name an active staff user' });
    const ownerId = owner.id;

    const markers = await prisma.mapMarker.findMany({ where: { areaId: area.id } });
    const byModule = {};
    for (const m of markers) (byModule[m.module] = byModule[m.module] || []).push(m.recordId);

    const summary = [];
    for (const [module, ids] of Object.entries(byModule)) {
      const model = MAPPABLE[module];
      if (!model) continue;
      // Live records the caller could change, in a module they may edit: this
      // rewrote the owner of every record in the area, deleted ones included.
      if (!permits(req, permissionFor(module), 'edit')) { summary.push({ module, error: `Insufficient permissions for ${permissionFor(module)}` }); continue; }
      try {
        const result = await prisma[model].updateMany({ where: await reachableRecords(req, module, { id: { in: ids } }, 'Edit'), data: { ownerId } });
        summary.push({ module, updated: result.count });
      } catch (e) { summary.push({ module, error: String(e.message).slice(0, 100) }); }
    }

    await req.audit({ action: 'update', module: 'maps', recordId: area.id, details: `Ownership assigned for area ${area.name}` });
    res.json({ area: area.name, ownerId, markers: markers.length, summary });
  } catch (err) { next(err); }
});

// ── LAYERS ────────────────────────────────────────────────────────────

router.get('/layers', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const layers = await prisma.mapLayer.findMany({
      where: { deletedAt: null, OR: [{ ownerId: req.user.id }, { isShared: true }] },
      orderBy: { sortOrder: 'asc' },
    });
    res.json(layers);
  } catch (err) { next(err); }
});

router.post('/layers', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, module, description, filterJson, markerColor, markerIcon, labelField, isShared, sortOrder } = req.body;
    if (!name || !module) return res.status(400).json({ error: 'name and module required' });
    if (!MAPPABLE[module]) return res.status(400).json({ error: `Module ${module} is not mappable` });

    const layer = await prisma.mapLayer.create({
      data: { name, module, description, filterJson: filterJson || null, markerColor: markerColor || '#F5A623', markerIcon, labelField, isShared: !!isShared, sortOrder: sortOrder ?? 0, ownerId: req.user.id },
    });
    res.status(201).json(layer);
  } catch (err) { next(err); }
});

router.delete('/layers/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const layer = await prisma.mapLayer.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!layer) return res.status(404).json({ error: 'Layer not found' });
    // req.user.role is the Role record, never 'admin', so no admin could delete another's layer.
    if (layer.ownerId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Not your layer' });
    await prisma.mapLayer.update({ where: { id: layer.id }, data: { deletedAt: new Date() } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ── GEOJSON IMPORT AND EXPORT ─────────────────────────────────────────

router.get('/export/geojson', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { include = 'both', module } = req.query;
    const features = [];

    if (include !== 'markers') {
      const areas = await prisma.mapArea.findMany({ where: { deletedAt: null, active: true } });
      features.push(...areas.map(a => areaToGeoJson(a)).filter(Boolean));
    }
    if (include !== 'areas') {
      // The markers GET /markers would show this caller, and no others.
      if (module && !MAPPABLE[module]) return res.status(400).json({ error: `Module ${module} is not mappable` });
      const markers = await reachableMarkers(req, await prisma.mapMarker.findMany({ where: { module: { in: readableModules(req, module) } }, take: 10000 }));
      const collection = markersToGeoJson(markers.map(m => ({ ...m, lat: m.latitude, lng: m.longitude })));
      features.push(...(collection.features || []));
    }

    res.setHeader('Content-Type', 'application/geo+json');
    res.setHeader('Content-Disposition', 'attachment; filename="sales-nebula-map.geojson"');
    res.json({ type: 'FeatureCollection', features });
  } catch (err) { next(err); }
});

router.post('/import/geojson', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { geojson, type = 'Territory' } = req.body;
    if (!geojson) return res.status(400).json({ error: 'geojson required' });

    const parsed = geoJsonToAreas(typeof geojson === 'string' ? JSON.parse(geojson) : geojson);
    if (!parsed.length) return res.status(400).json({ error: 'No polygon features found in the payload' });

    const created = [];
    for (const area of parsed.slice(0, 500)) {
      if (!Array.isArray(area.polygon) || area.polygon.length < 3) continue;
      const centroid = polygonCentroid(area.polygon);
      const record = await prisma.mapArea.create({
        data: {
          name: area.name || 'Imported area', type, shape: 'polygon',
          polygon: area.polygon, centerLat: centroid.lat, centerLng: centroid.lng,
          ...polygonBounds(area.polygon),
          areaSqKm: +polygonArea(area.polygon).toFixed(2),
        },
      });
      created.push({ id: record.id, name: record.name, areaSqKm: record.areaSqKm });
    }

    await req.audit({ action: 'create', module: 'maps', recordId: 'import', details: `${created.length} areas imported from GeoJSON` });
    res.status(201).json({ featuresParsed: parsed.length, areasCreated: created.length, areas: created });
  } catch (err) { next(err); }
});

// ── ANALYTICS ─────────────────────────────────────────────────────────

router.get('/analytics/coverage', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const areas = await prisma.mapArea.findMany({ where: { deletedAt: null, active: true } });
    // The markers GET /markers would show the caller; this counted every
    // module's for anyone signed in, records they cannot open included.
    const markers = await reachableMarkers(req, await prisma.mapMarker.findMany({ where: { module: { in: readableModules(req) } }, take: 20000 }));

    const byArea = areas.map(a => {
      const inside = markers.filter(m => m.areaId === a.id);
      const byModule = inside.reduce((acc, m) => { acc[m.module] = (acc[m.module] || 0) + 1; return acc; }, {});
      return {
        areaId: a.id, name: a.name, type: a.type, assignedUserId: a.assignedUserId,
        areaSqKm: a.areaSqKm, markers: inside.length,
        densityPerSqKm: a.areaSqKm ? +(inside.length / a.areaSqKm).toFixed(4) : null,
        byModule,
      };
    });

    const unassigned = markers.filter(m => !m.areaId);
    byArea.sort((a, b) => b.markers - a.markers);

    res.json({
      areas: areas.length,
      totalMarkers: markers.length,
      markersInAreas: markers.length - unassigned.length,
      markersOutsideAreas: unassigned.length,
      coveragePercent: markers.length ? +(((markers.length - unassigned.length) / markers.length) * 100).toFixed(1) : 0,
      emptyAreas: byArea.filter(a => a.markers === 0).map(a => ({ id: a.areaId, name: a.name })),
      byArea,
    });
  } catch (err) { next(err); }
});

module.exports = router;
