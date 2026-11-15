'use strict';

/**
 * SQLite persistence (node:sqlite, no external dependencies).
 *
 * Tables hold the raw ingested records; every analysis is a separate immutable
 * version snapshot, so "recompute" never overwrites history. The late-message
 * inbox is kept apart from the ingested status stream until the operator
 * explicitly backfills it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { zonedTime, parseTime } = require('./time');
const { analyze, hashInputs, ENGINE_VERSION } = require('./engine');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'app.db');
const SAMPLE_DIR = path.join(__dirname, '..', 'data', 'samples');
const SAMPLE_FILES = ['site-xingqiao.json', 'site-wangjing.json'];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  address TEXT,
  operator TEXT,
  default_as_of INTEGER,
  imported_at INTEGER NOT NULL,
  source TEXT
);

CREATE TABLE IF NOT EXISTS guns (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  connector_type TEXT,
  power_kw REAL,
  position TEXT
);
CREATE INDEX IF NOT EXISTS guns_site ON guns(site_id);

CREATE TABLE IF NOT EXISTS gun_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  gun_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  valid_from INTEGER,
  valid_to INTEGER,
  kind TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS aliases_site ON gun_aliases(site_id);

CREATE TABLE IF NOT EXISTS statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  external_id TEXT,
  gun_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  event_time INTEGER,
  received_at INTEGER,
  source TEXT,
  payload TEXT,
  added_at INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'import',
  inbox_item_id TEXT
);
CREATE INDEX IF NOT EXISTS statuses_site ON statuses(site_id, event_time);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  external_id TEXT,
  gun_ref TEXT NOT NULL,
  start_time INTEGER,
  end_time INTEGER,
  energy_kwh REAL,
  status TEXT,
  source TEXT,
  received_at INTEGER,
  added_at INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'import'
);
CREATE INDEX IF NOT EXISTS orders_site ON orders(site_id, start_time);

CREATE TABLE IF NOT EXISTS repairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  external_id TEXT,
  gun_ref TEXT NOT NULL,
  start_time INTEGER,
  end_time INTEGER,
  kind TEXT,
  work_order TEXT,
  status TEXT,
  note TEXT,
  source TEXT,
  added_at INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'import'
);
CREATE INDEX IF NOT EXISTS repairs_site ON repairs(site_id, start_time);

CREATE TABLE IF NOT EXISTS late_inbox (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  gun_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  event_time INTEGER,
  received_at INTEGER,
  source TEXT,
  payload TEXT,
  note TEXT,
  scenario TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  ingested_at INTEGER,
  ingested_version_id INTEGER
);
CREATE INDEX IF NOT EXISTS inbox_site ON late_inbox(site_id, status);

CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  engine_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  note TEXT,
  reason TEXT NOT NULL,
  result_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS versions_site_window ON versions(site_id, window_start, window_end, id);
`;

function jsonOrNull(value) {
  return value == null ? null : JSON.stringify(value);
}

function parseJson(value) {
  if (value == null) return null;
  try { return JSON.parse(value); } catch { return null; }
}

class Store {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  // -----------------------------------------------------------------------
  // Import
  // -----------------------------------------------------------------------

  /**
   * Import one site dataset. Existing data for the same site id is replaced
   * (all versions too), which is used by the sample reset in the UI.
   */
  importSite(input, { source = 'import', now = Date.now() } = {}) {
    if (!input || !input.site || !Array.isArray(input.guns)) {
      throw new Error('importSite: malformed dataset');
    }
    const site = input.site;
    const tz = site.timezone || 'UTC';
    const defaultAsOf = site.defaultAsOf
      ? parseTime(site.defaultAsOf)
      : (input.orders || []).reduce((max, o) => {
        const t = parseTime(o.endTime) || parseTime(o.startTime) || 0;
        return Math.max(max, t);
      }, 0) || now;

    const tx = () => {
      this.deleteSite(site.id);
      this.db.prepare(`INSERT INTO sites
        (id, name, timezone, address, operator, default_as_of, imported_at, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        site.id, site.name || site.id, tz, site.address || null, site.operator || null,
        defaultAsOf, now, source,
      );
      const gunStmt = this.db.prepare(`INSERT INTO guns
        (id, site_id, code, display_name, connector_type, power_kw, position)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const gun of input.guns) {
        gunStmt.run(gun.id, site.id, gun.code, gun.displayName || gun.code,
          gun.connectorType || null, gun.powerKw ?? null, gun.position || null);
      }
      const aliasStmt = this.db.prepare(`INSERT INTO gun_aliases
        (site_id, gun_id, alias, valid_from, valid_to, kind, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const alias of input.aliases || []) {
        aliasStmt.run(site.id, alias.gunId, alias.alias,
          parseTime(alias.validFrom), parseTime(alias.validTo), alias.kind || null, alias.note || null);
      }
      const statusStmt = this.db.prepare(`INSERT INTO statuses
        (site_id, external_id, gun_ref, state, event_time, received_at, source, payload, added_at, origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const status of input.statuses || []) {
        statusStmt.run(site.id, status.externalId || null, String(status.gunRef),
          String(status.state), parseTime(status.eventTime), parseTime(status.receivedAt),
          status.source || null, jsonOrNull(status.payload), now, source);
      }
      const orderStmt = this.db.prepare(`INSERT INTO orders
        (site_id, external_id, gun_ref, start_time, end_time, energy_kwh, status, source, received_at, added_at, origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const order of input.orders || []) {
        orderStmt.run(site.id, order.externalId || null, String(order.gunRef),
          parseTime(order.startTime), parseTime(order.endTime), order.energyKwh ?? null,
          order.status || null, order.source || null, parseTime(order.receivedAt), now, source);
      }
      const repairStmt = this.db.prepare(`INSERT INTO repairs
        (site_id, external_id, gun_ref, start_time, end_time, kind, work_order, status, note, source, added_at, origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const repair of input.repairs || []) {
        repairStmt.run(site.id, repair.externalId || null, String(repair.gunRef),
          parseTime(repair.startTime), parseTime(repair.endTime), repair.kind || null,
          repair.workOrder || null, repair.status || null, repair.note || null,
          repair.source || null, now, source);
      }
      const inboxStmt = this.db.prepare(`INSERT INTO late_inbox
        (id, site_id, gun_ref, state, event_time, received_at, source, payload, note, scenario, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
      for (const item of input.lateInbox || []) {
        inboxStmt.run(item.id || `late-${site.id}-${inboxStmt ? Math.random().toString(36).slice(2) : ''}`,
          site.id, String(item.gunRef), String(item.state), parseTime(item.eventTime),
          parseTime(item.receivedAt), item.source || null, jsonOrNull(item.payload),
          item.note || null, item.scenario || null);
      }
    };
    this.db.exec('BEGIN');
    try {
      tx();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { siteId: site.id, tz, defaultAsOf };
  }

  deleteSite(siteId) {
    for (const table of ['statuses', 'orders', 'repairs', 'gun_aliases', 'late_inbox', 'versions', 'guns']) {
      this.db.prepare(`DELETE FROM ${table} WHERE site_id = ?`).run(siteId);
    }
    this.db.prepare('DELETE FROM sites WHERE id = ?').run(siteId);
  }

  seedFromSamples({ reset = false } = {}) {
    const imported = [];
    for (const file of SAMPLE_FILES) {
      const full = path.join(SAMPLE_DIR, file);
      if (!fs.existsSync(full)) continue;
      const input = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (reset) this.deleteSite(input.site.id);
      if (this.getSite(input.site.id) && !reset) {
        imported.push({ siteId: input.site.id, siteName: input.site.name || input.site.id, skipped: true });
        continue;
      }
      const meta = this.importSite(input, { source: 'sample', now: Date.now() });
      const inboxFile = path.join(SAMPLE_DIR, 'inbox', file);
      let inboxCount = 0;
      if (fs.existsSync(inboxFile)) {
        const inbox = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
        for (const item of inbox) {
          this.db.prepare(`INSERT INTO late_inbox
            (id, site_id, gun_ref, state, event_time, received_at, source, payload, note, scenario, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(
            item.id, input.site.id, String(item.gunRef), String(item.state),
            parseTime(item.eventTime), parseTime(item.receivedAt), item.source || null,
            jsonOrNull(item.payload), item.note || null, item.scenario || null,
          );
          inboxCount += 1;
        }
      }
      const window = defaultWindowFor(meta.defaultAsOf, meta.tz);
      this.createVersion(input.site.id, window.start, window.end, {
        reason: 'initial', note: '样例数据初始分析', generatedAt: Date.now(),
      });
      const version = this.latestVersion(input.site.id, window.start, window.end);
      imported.push({
        siteId: input.site.id,
        siteName: input.site.name,
        skipped: false,
        window,
        inboxCount,
        statuses: (input.statuses || []).length,
        orders: (input.orders || []).length,
        repairs: (input.repairs || []).length,
        inbox: inboxCount,
        version,
      });
    }
    return imported;
  }

  // -----------------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------------

  getSite(siteId) {
    const row = this.db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
    return row ? this.mapSite(row) : null;
  }

  listSites() {
    return this.db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM guns g WHERE g.site_id = s.id) AS gun_count,
        (SELECT COUNT(*) FROM statuses st WHERE st.site_id = s.id) AS status_count,
        (SELECT COUNT(*) FROM orders o WHERE o.site_id = s.id) AS order_count,
        (SELECT COUNT(*) FROM repairs r WHERE r.site_id = s.id) AS repair_count,
        (SELECT COUNT(*) FROM late_inbox li WHERE li.site_id = s.id AND li.status = 'pending') AS pending_inbox
      FROM sites s ORDER BY s.name`).all().map((row) => ({
      ...this.mapSite(row),
      gunCount: row.gun_count,
      statusCount: row.status_count,
      orderCount: row.order_count,
      repairCount: row.repair_count,
      pendingInbox: row.pending_inbox,
    }));
  }

  mapSite(row) {
    return {
      id: row.id,
      name: row.name,
      timezone: row.timezone,
      address: row.address,
      operator: row.operator,
      defaultAsOf: row.default_as_of,
      importedAt: row.imported_at,
      source: row.source,
    };
  }

  listGuns(siteId) {
    return this.db.prepare('SELECT * FROM guns WHERE site_id = ? ORDER BY code').all(siteId).map((row) => ({
      id: row.id,
      code: row.code,
      displayName: row.display_name,
      connectorType: row.connector_type,
      powerKw: row.power_kw,
      position: row.position,
    }));
  }

  listAliases(siteId) {
    return this.db.prepare('SELECT * FROM gun_aliases WHERE site_id = ? ORDER BY valid_from').all(siteId).map((row) => ({
      gunId: row.gun_id,
      alias: row.alias,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      kind: row.kind,
      note: row.note,
    }));
  }

  loadSiteInput(siteId) {
    const site = this.getSite(siteId);
    if (!site) return null;
    const statuses = this.db.prepare('SELECT * FROM statuses WHERE site_id = ? ORDER BY event_time, received_at, id').all(siteId)
      .map((row) => ({
        externalId: row.external_id,
        gunRef: row.gun_ref,
        state: row.state,
        eventTime: row.event_time,
        receivedAt: row.received_at,
        source: row.source,
        payload: parseJson(row.payload),
        origin: row.origin,
        rowId: row.id,
      }));
    const orders = this.db.prepare('SELECT * FROM orders WHERE site_id = ? ORDER BY start_time, id').all(siteId)
      .map((row) => ({
        externalId: row.external_id,
        gunRef: row.gun_ref,
        startTime: row.start_time,
        endTime: row.end_time,
        energyKwh: row.energy_kwh,
        status: row.status,
        source: row.source,
        receivedAt: row.received_at,
        origin: row.origin,
        rowId: row.id,
      }));
    const repairs = this.db.prepare('SELECT * FROM repairs WHERE site_id = ? ORDER BY start_time, id').all(siteId)
      .map((row) => ({
        externalId: row.external_id,
        gunRef: row.gun_ref,
        startTime: row.start_time,
        endTime: row.end_time,
        kind: row.kind,
        workOrder: row.work_order,
        status: row.status,
        note: row.note,
        source: row.source,
        origin: row.origin,
        rowId: row.id,
      }));
    return {
      site: {
        id: site.id, name: site.name, timezone: site.timezone,
        address: site.address, operator: site.operator,
      },
      guns: this.listGuns(siteId),
      aliases: this.listAliases(siteId),
      statuses,
      orders,
      repairs,
    };
  }

  listLateInbox(siteId) {
    return this.db.prepare('SELECT * FROM late_inbox WHERE site_id = ? ORDER BY status, received_at').all(siteId)
      .map((row) => ({
        id: row.id,
        gunRef: row.gun_ref,
        state: row.state,
        eventTime: row.event_time,
        receivedAt: row.received_at,
        source: row.source,
        payload: parseJson(row.payload),
        note: row.note,
        scenario: row.scenario,
        status: row.status,
        ingestedAt: row.ingested_at,
        ingestedVersionId: row.ingested_version_id,
      }));
  }

  // -----------------------------------------------------------------------
  // Versions
  // -----------------------------------------------------------------------

  createVersion(siteId, start, end, { reason = 'recompute', note = null, generatedAt = Date.now(), force = false } = {}) {
    const input = this.loadSiteInput(siteId);
    if (!input) { const err = new Error('site not found'); err.status = 404; throw err; }
    if (!(end > start)) { const err = new Error('invalid window'); err.status = 400; throw err; }

    const hash = hashInputs(input, { start, end });
    const previous = this.latestVersion(siteId, start, end);
    if (!force && previous && previous.inputHash === hash && previous.engineVersion === ENGINE_VERSION) {
      return { version: previous, unchanged: true, previous: null };
    }
    const result = analyze(input, { start, end }, { generatedAt });
    const seqRow = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM versions WHERE site_id = ?').get(siteId);
    const info = this.db.prepare(`INSERT INTO versions
      (site_id, seq, window_start, window_end, generated_at, engine_version, input_hash, note, reason, result_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      siteId, seqRow.seq, start, end, generatedAt, ENGINE_VERSION, hash, note, reason, JSON.stringify(result),
    );
    const version = this.getVersion(Number(info.lastInsertRowid), { withResult: false });
    return { version, unchanged: false, previous };
  }

  getVersionRow(id) {
    return this.db.prepare('SELECT * FROM versions WHERE id = ?').get(id);
  }

  getVersion(id, { withResult = true } = {}) {
    const row = this.getVersionRow(id);
    if (!row) return null;
    const version = {
      id: row.id,
      siteId: row.site_id,
      seq: row.seq,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      generatedAt: row.generated_at,
      engineVersion: row.engine_version,
      inputHash: row.input_hash,
      note: row.note,
      reason: row.reason,
    };
    if (withResult) version.result = parseJson(row.result_json);
    return version;
  }

  latestVersion(siteId, start, end) {
    const row = this.db.prepare(`SELECT * FROM versions
      WHERE site_id = ? AND window_start = ? AND window_end = ?
      ORDER BY id DESC LIMIT 1`).get(siteId, start, end);
    if (!row) return null;
    return {
      id: row.id, siteId: row.site_id, seq: row.seq,
      windowStart: row.window_start, windowEnd: row.window_end,
      generatedAt: row.generated_at, engineVersion: row.engine_version,
      inputHash: row.input_hash, note: row.note, reason: row.reason,
    };
  }

  previousVersion(siteId, start, end, beforeId) {
    const row = this.db.prepare(`SELECT * FROM versions
      WHERE site_id = ? AND window_start = ? AND window_end = ? AND id < ?
      ORDER BY id DESC LIMIT 1`).get(siteId, start, end, beforeId);
    if (!row) return null;
    return {
      id: row.id, siteId: row.site_id, seq: row.seq,
      windowStart: row.window_start, windowEnd: row.window_end,
      generatedAt: row.generated_at, engineVersion: row.engine_version,
      inputHash: row.input_hash, note: row.note, reason: row.reason,
    };
  }

  listVersions(siteId, { start = null, end = null } = {}) {
    const rows = start != null && end != null
      ? this.db.prepare(`SELECT * FROM versions WHERE site_id = ? AND window_start = ? AND window_end = ?
          ORDER BY id DESC`).all(siteId, start, end)
      : this.db.prepare('SELECT * FROM versions WHERE site_id = ? ORDER BY id DESC').all(siteId);
    return rows.map((row) => ({
      id: row.id, siteId: row.site_id, seq: row.seq,
      windowStart: row.window_start, windowEnd: row.window_end,
      generatedAt: row.generated_at, engineVersion: row.engine_version,
      inputHash: row.input_hash, note: row.note, reason: row.reason,
    }));
  }

  // -----------------------------------------------------------------------
  // Late-message backfill
  // -----------------------------------------------------------------------

  insertLateAndCompute(siteId, itemId, start, end, { note = null } = {}) {
    const row = this.db.prepare('SELECT * FROM late_inbox WHERE id = ? AND site_id = ?').get(itemId, siteId);
    if (!row) { const err = new Error('late message not found'); err.status = 404; throw err; }
    if (row.status === 'ingested') {
      const err = new Error('late message already ingested');
      err.status = 409;
      throw err;
    }
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO statuses
        (site_id, external_id, gun_ref, state, event_time, received_at, source, payload, added_at, origin, inbox_item_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'late-backfill', ?)`).run(
        siteId, `LATE-${row.id}`, row.gun_ref, row.state, row.event_time, row.received_at,
        row.source, row.payload, now, row.id,
      );
      this.db.prepare('UPDATE late_inbox SET status = ?, ingested_at = ? WHERE id = ?')
        .run('ingested', now, itemId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const { version, previous, unchanged } = this.createVersion(siteId, start, end, {
      reason: 'late_message',
      note: note || `补入迟到消息 ${itemId}：${row.state} @ ${new Date(row.event_time).toISOString()}`,
      generatedAt: now,
    });
    this.db.prepare('UPDATE late_inbox SET ingested_version_id = ? WHERE id = ?').run(version.id, itemId);
    return { version, previous, unchanged };
  }

  // -----------------------------------------------------------------------
  // Record audit helpers
  // -----------------------------------------------------------------------

  getRawStatusRow(rowId) {
    const row = this.db.prepare('SELECT * FROM statuses WHERE id = ?').get(rowId);
    return row || null;
  }

  listRecords(siteId) {
    const statuses = this.db.prepare('SELECT * FROM statuses WHERE site_id = ? ORDER BY event_time, received_at, id').all(siteId)
      .map((row) => ({
        rowId: row.id,
        kind: 'status',
        externalId: row.external_id,
        gunRef: row.gun_ref,
        state: row.state,
        eventTime: row.event_time,
        receivedAt: row.received_at,
        source: row.source,
        payload: parseJson(row.payload),
        origin: row.origin,
        inboxItemId: row.inbox_item_id,
      }));
    const orders = this.db.prepare('SELECT * FROM orders WHERE site_id = ? ORDER BY start_time, id').all(siteId)
      .map((row) => ({
        rowId: row.id,
        kind: 'order',
        externalId: row.external_id,
        gunRef: row.gun_ref,
        startTime: row.start_time,
        endTime: row.end_time,
        energyKwh: row.energy_kwh,
        status: row.status,
        source: row.source,
        origin: row.origin,
      }));
    const repairs = this.db.prepare('SELECT * FROM repairs WHERE site_id = ? ORDER BY start_time, id').all(siteId)
      .map((row) => ({
        rowId: row.id,
        kind: 'repair',
        externalId: row.external_id,
        gunRef: row.gun_ref,
        startTime: row.start_time,
        endTime: row.end_time,
        repairKind: row.kind,
        workOrder: row.work_order,
        status: row.status,
        note: row.note,
        source: row.source,
        origin: row.origin,
      }));
    return { statuses, orders, repairs };
  }
}

/** Default analysis window: 3 local days ending at the site's data cutoff. */
function defaultWindowFor(asOfMs, tz, days = 3) {
  const { addLocalDays, startOfLocalDay } = require('./time');
  // A cutoff exactly at local midnight belongs to the day that is starting;
  // shift back one second so the cutoff day is the window's last day.
  const anchor = startOfLocalDay(asOfMs, tz) === asOfMs
    ? startOfLocalDay(asOfMs - 1, tz)
    : startOfLocalDay(asOfMs, tz);
  const end = addLocalDays(anchor, 1, tz);
  const start = addLocalDays(end, -days, tz);
  return { start, end };
}

module.exports = {
  Store, DEFAULT_DB_PATH, defaultWindowFor, SCHEMA,
};
