'use strict';

/**
 * HTTP server: static SPA + JSON API. Node built-ins only.
 *
 * Every analytic response is served from a persisted version row, so the page
 * can link to exact results and export them. Recomputes create a new immutable
 * version; the previous version stays addressable.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store, defaultWindowFor, DEFAULT_DB_PATH } = require('./db');
const { zoneParts, zonedTime, parseTime, addLocalDays, startOfLocalDay } = require('./time');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || DEFAULT_DB_PATH;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    });
    res.end(data);
  });
}

function serveStatic(res, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  if (decoded.includes('..') || decoded.includes('\0')) {
    res.writeHead(400).end('Bad path');
    return;
  }
  const filePath = path.join(PUBLIC_DIR, decoded === '/' ? 'index.html' : decoded);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(400).end('Bad path');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) {
      sendFile(res, filePath);
      return;
    }
    // SPA fallback for non-API routes.
    if (!decoded.includes('.')) {
      sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });
}

function parseWindow(store, site, query) {
  const tz = site.timezone;
  const startRaw = query.get('start');
  const endRaw = query.get('end');
  if (startRaw && endRaw) {
    const start = parseTime(startRaw) ?? (/^\d{4}-\d{2}-\d{2}$/.test(startRaw) ? zonedTime(dateParts(startRaw), tz) : null);
    const end = parseTime(endRaw) ?? (/^\d{4}-\d{2}-\d{2}$/.test(endRaw) ? zonedTime(dateParts(endRaw), tz) : null);
    if (start == null || end == null) throw new ApiError(400, 'invalid start/end');
    if (end <= start) throw new ApiError(400, 'end must be after start');
    if (end - start > 62 * 24 * 3600 * 1000) throw new ApiError(400, 'window too large (max 62 days)');
    return { start, end };
  }
  const daysRaw = query.get('days');
  if (daysRaw != null) {
    const days = Number(daysRaw);
    if (!Number.isInteger(days) || days < 1 || days > 31) throw new ApiError(400, 'invalid days');
    const asOf = query.get('asOf') ? parseTime(query.get('asOf')) : site.defaultAsOf;
    return defaultWindowFor(asOf, tz, days);
  }
  return defaultWindowFor(site.defaultAsOf, tz);
}

function dateParts(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return { year, month, day };
}

/** Local calendar-day list for the window, used by date-range presets. */
function windowDays(site, start, end) {
  const out = [];
  let cursor = startOfLocalDay(start, site.timezone);
  let guard = 0;
  while (cursor < end && guard < 70) {
    const p = zoneParts(cursor, site.timezone);
    out.push(`${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`);
    cursor = addLocalDays(cursor, 1, site.timezone);
    guard += 1;
  }
  return out;
}

function resolveVersion(store, siteId, query) {
  const versionId = query.get('version');
  if (versionId) {
    const version = store.getVersion(Number(versionId));
    if (!version || version.siteId !== siteId) throw new ApiError(404, 'version not found');
    return version;
  }
  const site = store.getSite(siteId);
  const win = parseWindow(store, site, query);
  const latest = store.latestVersion(siteId, win.start, win.end);
  if (!latest) {
    const created = store.createVersion(siteId, win.start, win.end, { reason: 'auto', note: '按需生成' });
    return store.getVersion(created.version.id);
  }
  return store.getVersion(latest.id);
}

function summarize(result) {
  return {
    meta: result.meta,
    siteMetrics: result.siteMetrics,
    siteDays: result.siteDays,
    guns: result.guns.map((gun) => ({
      gunId: gun.gunId,
      code: gun.code,
      displayName: gun.displayName,
      connectorType: gun.connectorType,
      powerKw: gun.powerKw,
      metrics: gun.metrics,
      days: gun.days,
      statusStats: gun.statusStats,
      historicalNames: gun.historicalNames,
      segments: gun.segments,
      unconfirmed: gun.unconfirmed,
      repairsOpen: gun.repairsOpen,
      records: gun.records,
    })),
    conflicts: result.conflicts,
    unconfirmedIntervals: result.unconfirmedIntervals,
    dataQuality: result.dataQuality,
  };
}

function versionQueryString(version) {
  return `version=${version.id}`;
}

function collectExportRows(result, site) {
  const tz = site.timezone;
  const fmt = (ms) => (ms == null ? '' : new Date(ms).toISOString());
  const local = (ms) => {
    if (ms == null) return '';
    const p = zoneParts(ms, tz);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  };
  const rows = [];
  for (const gun of result.guns) {
    for (const seg of gun.segments) {
      rows.push({
        kind: 'segment',
        site: site.name,
        gun: gun.code,
        gunName: gun.displayName,
        state: seg.state,
        startIso: fmt(seg.start),
        endIso: fmt(seg.end),
        startLocal: local(seg.start),
        endLocal: local(seg.end),
        durationMin: ((seg.end - seg.start) / 60000).toFixed(1),
        flags: seg.flags.join('|'),
        reason: seg.reason || '',
        statuses: seg.evidence.statuses.join('|'),
        orders: seg.evidence.orders.join('|'),
        repairs: seg.evidence.repairs.join('|'),
        conflictIds: (seg.conflictIds || []).join('|'),
        inferredOrderEnd: seg.inferredOrderEnd ? 'yes' : 'no',
        nature: 'timeline',
      });
    }
    for (const u of gun.unconfirmed) {
      rows.push({
        kind: 'unconfirmed',
        site: site.name,
        gun: gun.code,
        gunName: gun.displayName,
        state: 'unconfirmed',
        startIso: fmt(u.start),
        endIso: fmt(u.end),
        startLocal: local(u.start),
        endLocal: local(u.end),
        durationMin: (u.ms / 60000).toFixed(1),
        flags: u.flags.join('|'),
        reason: u.reason,
        statuses: u.evidence.statuses.join('|'),
        orders: u.evidence.orders.join('|'),
        repairs: u.evidence.repairs.join('|'),
        conflictIds: '',
        inferredOrderEnd: 'no',
        nature: 'unconfirmed',
      });
    }
  }
  for (const conflict of result.conflicts) {
    rows.push({
      kind: 'conflict',
      site: site.name,
      gun: conflict.gunCode,
      gunName: '',
      state: conflict.type,
      startIso: fmt(conflict.start),
      endIso: fmt(conflict.end),
      startLocal: local(conflict.start),
      endLocal: local(conflict.end),
      durationMin: (conflict.ms / 60000).toFixed(1),
      flags: conflict.severity,
      reason: conflict.detail,
      statuses: conflict.statusIds.join('|'),
      orders: conflict.orderIds.join('|'),
      repairs: conflict.repairIds.join('|'),
      conflictIds: conflict.id,
      inferredOrderEnd: '',
      nature: 'conflict',
    });
  }
  for (const day of result.siteDays) {
    rows.push({
      kind: 'day',
      site: site.name,
      gun: '(全站)',
      gunName: '',
      state: 'day-total',
      startIso: fmt(day.start),
      endIso: fmt(day.end),
      startLocal: local(day.start),
      endLocal: local(day.end),
      durationMin: (day.naturalMs / 60000).toFixed(1),
      flags: '',
      reason: `自然口径 ${(day.utilizationNatural * 100).toFixed(2)}% / 可服务口径 ${(day.utilizationServiceable * 100).toFixed(2)}%`,
      statuses: '',
      orders: '',
      repairs: '',
      conflictIds: '',
      inferredOrderEnd: '',
      nature: 'daily-summary',
    });
  }
  for (const gun of result.guns) {
    for (const day of gun.days) {
      rows.push({
        kind: 'gun-day',
        site: site.name,
        gun: gun.code,
        gunName: gun.displayName,
        state: 'gun-day-total',
        startIso: fmt(day.start),
        endIso: fmt(day.end),
        startLocal: local(day.start),
        endLocal: local(day.end),
        durationMin: (day.naturalMs / 60000).toFixed(1),
        flags: '',
        reason: `自然口径 ${(day.utilizationNatural * 100).toFixed(2)}% / 可服务口径 ${(day.utilizationServiceable * 100).toFixed(2)}%`,
        statuses: '',
        orders: '',
        repairs: '',
        conflictIds: '',
        inferredOrderEnd: '',
        nature: 'gun-daily-summary',
      });
    }
  }
  return rows;
}

function toCsv(rows) {
  const columns = [
    'kind', 'nature', 'site', 'gun', 'gunName', 'state', 'startIso', 'endIso',
    'startLocal', 'endLocal', 'durationMin', 'flags', 'reason', 'statuses',
    'orders', 'repairs', 'conflictIds', 'inferredOrderEnd',
  ];
  const esc = (value) => {
    const s = value == null ? '' : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => esc(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

function makeHandler(store) {
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname, searchParams } = url;
    try {
      if (!pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end('Method not allowed'); return; }
        serveStatic(res, pathname);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        json(res, 200, { ok: true, engine: require('./engine').ENGINE_VERSION });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/sites') {
        json(res, 200, { sites: store.listSites() });
        return;
      }

      let match = pathname.match(/^\/api\/sites\/([^/]+)$/);
      if (req.method === 'GET' && match) {
        const site = store.getSite(match[1]);
        if (!site) throw new ApiError(404, 'site not found');
        const win = parseWindow(store, site, searchParams);
        json(res, 200, {
          site,
          guns: store.listGuns(site.id),
          aliases: store.listAliases(site.id),
          defaultWindow: win,
          days: windowDays(site, win.start, win.end),
        });
        return;
      }

      match = pathname.match(/^\/api\/sites\/([^/]+)\/analysis$/);
      if (req.method === 'GET' && match) {
        const site = store.getSite(match[1]);
        if (!site) throw new ApiError(404, 'site not found');
        const version = resolveVersion(store, site.id, searchParams);
        const previous = store.previousVersion(site.id, version.windowStart, version.windowEnd, version.id);
        const previousResult = previous ? store.getVersion(previous.id) : null;
        const requestedDays = Number(searchParams.get('days')) || 3;
        json(res, 200, {
          site,
          requestedDays,
          version: {
            id: version.id, seq: version.seq, windowStart: version.windowStart,
            windowEnd: version.windowEnd, generatedAt: version.generatedAt,
            engineVersion: version.engineVersion, inputHash: version.inputHash,
            note: version.note, reason: version.reason,
          },
          days: windowDays(site, version.windowStart, version.windowEnd),
          versions: store.listVersions(site.id, { start: version.windowStart, end: version.windowEnd }),
          previousVersion: previous ? {
            id: previous.id, seq: previous.seq, generatedAt: previous.generatedAt,
            note: previous.note, reason: previous.reason, inputHash: previous.inputHash,
          } : null,
          previousResult: previousResult ? summarize(previousResult.result) : null,
          result: summarize(version.result),
        });
        return;
      }

      match = pathname.match(/^\/api\/sites\/([^/]+)\/timeline$/);
      if (req.method === 'GET' && match) {
        const site = store.getSite(match[1]);
        if (!site) throw new ApiError(404, 'site not found');
        const version = resolveVersion(store, site.id, searchParams);
        json(res, 200, {
          site,
          version: {
            id: version.id, seq: version.seq, windowStart: version.windowStart,
            windowEnd: version.windowEnd, generatedAt: version.generatedAt,
          },
          guns: version.result.guns,
        });
        return;
      }

      match = pathname.match(/^\/api\/sites\/([^/]+)\/guns\/([^/]+)\/timeline$/);
      if (req.method === 'GET' && match) {
        const site = store.getSite(match[1]);
        if (!site) throw new ApiError(404, 'site not found');
        const version = resolveVersion(store, site.id, searchParams);
        const gun = version.result.guns.find((g) => g.gunId === match[2] || g.code === match[2]);
        if (!gun) throw new ApiError(404, 'gun not found');
        json(res, 200, {
          site,
          version: { id: version.id, seq: version.seq, generatedAt: version.generatedAt, windowStart: version.windowStart, windowEnd: version.windowEnd },
          gun,
        });
        return;
      }

      match = pathname.match(/^\/api\/sites\/([^/]+)\/versions$/);
      if (match && req.method === 'GET') {
        const site = store.getSite(match[1]);
        if (!site) throw new ApiError(404, 'site not found');
        const startRaw = searchParams.get('start');
        const endRaw = searchParams.get('end');
        const opts = startRaw && endRaw ? { start: parseTime(startRaw), end: parseTime(endRaw) } : {};
        json(res, 200, { versions: store.listVersions(site.id, opts) });
        return;
      }

      match = pathname.match(/^\/api\/sites\/([^/]+)\/recompute$/);
      if (match && req.method === 'POST') {
        const site = store.getSite(match[1]);
        if (!site) throw new ApiError(404, 'site not found');
        const body = await readJson(req);
        const win = body.start != null && body.end != null
          ? { start: Number(body.start), end: Number(body.end) }
          : parseWindow(store, site, new URLSearchParams(body.query || ''));
        if (!(win.end > win.start)) throw new ApiError(400, 'invalid window');
        const { version, unchanged, previous } = store.createVersion(site.id, win.start, win.end, {
          reason: body.reason || 'manual',
          note: body.note || '手动重算',
        });
        json(res, 200, {
          version,
          unchanged,
          previous,
          previousResult: previous ? summarize(store.getVersion(previous.id).result) : null,
          result: summarize(store.getVersion(version.id).result),
        });
        return;
      }

      match = pathname.match(/^\/api\/sites\/([^/]+)\/inbox$/);
      if (match && req.method === 'GET') {
        const site = store.getSite(match[1]);
        if (!site) throw new ApiError(404, 'site not found');
        const version = resolveVersion(store, site.id, searchParams);
        const items = store.listLateInbox(site.id);
        // Sensitivity preview: what happens to the current version if each
        // pending message were ingested? Computed against an in-memory input copy.
        const baseInput = store.loadSiteInput(site.id);
        const { analyze, normalizeState } = require('./engine');
        const preview = items.map((item) => {
          if (item.status === 'ingested') return { ...item, preview: null };
          const inputCopy = structuredClone(baseInput);
          inputCopy.statuses.push({
            externalId: `LATE-${item.id}`, gunRef: item.gunRef, state: item.state,
            eventTime: item.eventTime, receivedAt: item.receivedAt, source: item.source || 'late-backfill',
          });
          const result = analyze(inputCopy, { start: version.windowStart, end: version.windowEnd }, { generatedAt: Date.now() });
          const before = version.result;
          const gunId = matchedGunId(baseInput, item.gunRef);
          const gunBefore = before.guns.find((g) => g.gunId === gunId);
          const gunAfter = result.guns.find((g) => g.gunId === gunId);
          const moments = collectMomentChanges(gunBefore, gunAfter);
          return {
            ...item,
            preview: {
              gunId,
              gunCode: gunBefore ? gunBefore.code : null,
              resolved: !!gunId,
              siteDelta: metricDelta(before.siteMetrics, result.siteMetrics),
              gunDelta: gunBefore && gunAfter ? metricDelta(gunBefore.metrics, gunAfter.metrics) : null,
              moments: moments.slice(0, 12),
              momentCount: moments.length,
              conflictDelta: result.conflicts.length - before.conflicts.length,
              lateStatusCount: result.dataQuality.lateMessages.length - before.dataQuality.lateMessages.length,
            },
          };
        });
        json(res, 200, { items: preview, version: { id: version.id, seq: version.seq, windowStart: version.windowStart, windowEnd: version.windowEnd } });
        return;
      }

      match = pathname.match(/^\/api\/sites\/([^/]+)\/inbox\/([^/]+)\/ingest$/);
      if (match && req.method === 'POST') {
        const site = store.getSite(match[1]);
        if (!site) throw new ApiError(404, 'site not found');
        const body = await readJson(req);
        const win = body.start != null && body.end != null
          ? { start: Number(body.start), end: Number(body.end) }
          : parseWindow(store, site, new URLSearchParams(body.query || ''));
        const { version, previous, unchanged } = store.insertLateAndCompute(site.id, match[2], win.start, win.end, {
          note: body.note || null,
        });
        json(res, 200, {
          version, previous, unchanged,
          previousResult: previous ? summarize(store.getVersion(previous.id).result) : null,
          result: summarize(store.getVersion(version.id).result),
          inbox: store.listLateInbox(site.id),
        });
        return;
      }

      match = pathname.match(/^\/api\/sites\/([^/]+)\/records$/);
      if (match && req.method === 'GET') {
        const site = store.getSite(match[1]);
        if (!site) throw new ApiError(404, 'site not found');
        json(res, 200, { ...store.listRecords(site.id), aliases: store.listAliases(site.id), guns: store.listGuns(site.id) });
        return;
      }

      match = pathname.match(/^\/api\/sites\/([^/]+)\/export$/);
      if (match && req.method === 'GET') {
        const site = store.getSite(match[1]);
        if (!site) throw new ApiError(404, 'site not found');
        const version = resolveVersion(store, site.id, searchParams);
        const format = (searchParams.get('format') || 'csv').toLowerCase();
        const rows = collectExportRows(version.result, site);
        const filename = `availability-${site.id}-v${version.seq}`
          + `-${formatDateStamp(version.windowStart, site.timezone)}`
          + `-${formatDateStamp(version.windowEnd, site.timezone, { exclusiveEnd: true })}`;
        if (format === 'json') {
          const payload = JSON.stringify({
            site, version: {
              id: version.id, seq: version.seq, windowStart: version.windowStart,
              windowEnd: version.windowEnd, generatedAt: version.generatedAt,
              engineVersion: version.engineVersion, inputHash: version.inputHash,
            },
            meta: version.result.meta,
            siteMetrics: version.result.siteMetrics,
            siteDays: version.result.siteDays,
            dataQuality: version.result.dataQuality,
            guns: version.result.guns.map((gun) => ({
              gunId: gun.gunId, code: gun.code, displayName: gun.displayName,
              metrics: gun.metrics, days: gun.days, segments: gun.segments,
              unconfirmed: gun.unconfirmed, historicalNames: gun.historicalNames,
              records: gun.records,
            })),
            conflicts: version.result.conflicts,
          }, null, 2);
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="${filename}.json"`,
            'cache-control': 'no-store',
          });
          res.end(payload);
          return;
        }
        const csv = toCsv(rows);
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}.csv"`,
          'cache-control': 'no-store',
        });
        res.end(`﻿${csv}`);
        return;
      }

      if (pathname === '/api/dev/reset-samples' && req.method === 'POST') {
        const imported = store.seedFromSamples({ reset: true });
        json(res, 200, { imported });
        return;
      }

      throw new ApiError(404, 'not found');
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) console.error(error);
      json(res, status, { error: error.message || 'internal error', ...(error.extra || {}) });
    }
  };
}

function formatDateStamp(ms, tz, { exclusiveEnd = false } = {}) {
  // Local calendar day for filenames. Window ends are exclusive, so the end
  // stamp steps back one millisecond to name the last included day.
  const p = zoneParts(exclusiveEnd ? ms - 1 : ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function matchedGunId(input, gunRef) {
  // Mirror the engine's name resolution enough for the inbox preview.
  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
  const key = norm(gunRef);
  for (const gun of input.guns) {
    if (norm(gun.code) === key || norm(gun.id) === key || norm(gun.displayName) === key) return gun.id;
  }
  for (const alias of input.aliases || []) {
    if (norm(alias.alias) === key) return alias.gunId;
  }
  return null;
}

function metricDelta(before, after) {
  const keys = ['naturalMs', 'availableMs', 'occupiedMs', 'faultMs', 'offlineMs', 'unconfirmedMs', 'serviceableMs', 'conflictMs'];
  const out = {};
  for (const key of keys) out[key] = (after[key] || 0) - (before[key] || 0);
  out.utilizationNatural = (after.utilizationNatural ?? 0) - (before.utilizationNatural ?? 0);
  out.utilizationServiceable = (after.utilizationServiceable ?? 0) - (before.utilizationServiceable ?? 0);
  return out;
}

function collectMomentChanges(gunBefore, gunAfter) {
  if (!gunBefore || !gunAfter) return [];
  const stateAt = (segments, t) => {
    for (const seg of segments) if (seg.start <= t && t < seg.end) return seg;
    return null;
  };
  const bounds = new Set();
  for (const seg of gunBefore.segments) { bounds.add(seg.start); bounds.add(seg.end); }
  for (const seg of gunAfter.segments) { bounds.add(seg.start); bounds.add(seg.end); }
  const times = [...bounds].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < times.length - 1; i += 1) {
    const start = times[i];
    const end = times[i + 1];
    if (end <= start) continue;
    const mid = start + (end - start) / 2;
    const before = stateAt(gunBefore.segments, mid);
    const after = stateAt(gunAfter.segments, mid);
    const beforeState = before ? before.state : null;
    const afterState = after ? after.state : null;
    if (beforeState === afterState) continue;
    const last = out[out.length - 1];
    if (last && last.end === start && last.beforeState === beforeState && last.afterState === afterState) {
      last.end = end;
      continue;
    }
    out.push({
      start,
      end,
      beforeState,
      afterState,
      beforeReason: before ? before.reason : null,
      afterReason: after ? after.reason : null,
    });
  }
  return out;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new ApiError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {
        reject(new ApiError(400, 'invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function startServer({ port = PORT, host = HOST, dbPath = DB_PATH, seed = true, store = null } = {}) {
  const db = store || new Store(dbPath);
  const hasSites = db.listSites().length > 0;
  if (seed && store == null && !hasSites) db.seedFromSamples();
  const server = http.createServer(makeHandler(db));
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({ server, store: db, port: server.address().port, dbPath });
    });
  });
}

if (require.main === module) {
  startServer().then(({ port }) => {
    console.log(`充电枪口可用性分析 → http://127.0.0.1:${port}`);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { startServer, makeHandler, toCsv, collectExportRows, matchedGunId, collectMomentChanges };
