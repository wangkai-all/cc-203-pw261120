'use strict';

/**
 * API + persistence tests. Each test gets its own in-memory SQLite store and an
 * ephemeral HTTP port, so tests are independent and no files are left behind.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Store } = require('../src/db');
const { startServer } = require('../src/server');
const { at, makeInput, status, availableStream, daysWindow } = require('./helpers');

const WIN = daysWindow('2026-11-02', 1);

function dataset() {
  const input = makeInput({
    statuses: [
      ...availableStream('G1', '2026-11-02 00:00', '2026-11-02 08:00'),
      status('G1', 'occupied', at('2026-11-02 08:00')),
      ...availableStream('G1', '2026-11-02 10:00', '2026-11-02 23:00'),
      ...availableStream('G2', '2026-11-02 00:00', '2026-11-02 23:00'),
    ],
    orders: [{
      externalId: 'ORD-1', gunRef: 'G1',
      startTime: at('2026-11-02 08:00'), endTime: at('2026-11-02 10:00'),
      energyKwh: 40, status: 'finished', source: 'ocpp-csms',
    }],
    lateInbox: [{
      id: 'late-1', gunRef: 'G1', state: 'offline',
      eventTime: at('2026-11-02 15:00'), receivedAt: at('2026-11-03 09:00'),
      source: 'third-party-bridge', note: '迟到消息样例',
      scenario: 'late_status_changes_availability',
      payload: { gateway: 'bridge-2' },
    }],
  });
  return input;
}

async function withServer(fn) {
  const store = new Store(':memory:');
  store.importSite(dataset());
  const { server, port } = await startServer({ port: 0, dbPath: ':memory:', seed: false, store });
  try {
    await fn({ store, port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}

function q(start, end, extra = '') {
  return `start=${encodeURIComponent(new Date(start).toISOString())}&end=${encodeURIComponent(new Date(end).toISOString())}${extra}`;
}

async function getJson(port, path, options) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const body = await response.json();
  return { status: response.status, body };
}

test('analysis creates a version, and an identical recompute reuses it', async () => {
  await withServer(async ({ store, port }) => {
    const first = await getJson(port, `/api/sites/site-test/analysis?${q(WIN.start, WIN.end)}`);
    assert.equal(first.status, 200);
    assert.equal(first.body.version.seq, 1);
    assert.equal(first.body.result.guns.length, 2);

    const recompute = await getJson(port, '/api/sites/site-test/recompute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ start: WIN.start, end: WIN.end, reason: 'manual', note: '再算一次' }),
    });
    assert.equal(recompute.status, 200);
    assert.equal(recompute.body.unchanged, true);
    assert.equal(recompute.body.version.seq, 1);
    assert.equal(store.listVersions('site-test').length, 1);
  });
});

test('a changed input creates an immutable second version with previousResult', async () => {
  await withServer(async ({ store, port }) => {
    await getJson(port, `/api/sites/site-test/analysis?${q(WIN.start, WIN.end)}`);
    store.db.prepare(`INSERT INTO statuses
      (site_id, external_id, gun_ref, state, event_time, received_at, source, payload, added_at, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'test')`).run(
      'site-test', 'ST-NEW', 'G2', 'fault', Date.parse(at('2026-11-02 12:30')),
      Date.parse(at('2026-11-02 12:30')), 'test', null, Date.now(),
    );
    const response = await getJson(port, '/api/sites/site-test/recompute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ start: WIN.start, end: WIN.end, reason: 'manual' }),
    });
    assert.equal(response.body.unchanged, false);
    assert.equal(response.body.version.seq, 2);
    assert.equal(response.body.previous.seq, 1);
    assert.ok(response.body.previousResult);

    // Old version is still addressable and still returns the old numbers.
    const old = await getJson(port, `/api/sites/site-test/analysis?version=${response.body.previous.id}`);
    assert.equal(old.body.version.seq, 1);
    const oldG2 = old.body.result.guns.find((g) => g.code === 'G2');
    assert.equal(oldG2.metrics.faultMs, 0);
    const newG2 = response.body.result.guns.find((g) => g.code === 'G2');
    assert.ok(newG2.metrics.faultMs > 0);
  });
});

test('version lookup rejects a version belonging to another site', async () => {
  await withServer(async ({ store, port }) => {
    const created = store.createVersion('site-test', WIN.start, WIN.end, { reason: 'initial' });
    const response = await getJson(port, `/api/sites/other-site/analysis?version=${created.version.id}`);
    assert.equal(response.status, 404);
  });
});

test('inbox preview reports deltas without persisting anything', async () => {
  await withServer(async ({ store, port }) => {
    const created = store.createVersion('site-test', WIN.start, WIN.end, { reason: 'initial' });
    const before = store.listVersions('site-test').length;
    const inbox = await getJson(port, `/api/sites/site-test/inbox?version=${created.version.id}`);
    assert.equal(inbox.status, 200);
    const item = inbox.body.items.find((i) => i.id === 'late-1');
    assert.equal(item.status, 'pending');
    assert.equal(item.preview.resolved, true);
    assert.equal(item.preview.gunCode, 'G1');
    // The status stream reports available hourly, so an offline message at
    // 15:00 holds until the next message at 16:00: one hour becomes offline.
    assert.equal(item.preview.gunDelta.offlineMs, 3600 * 1000);
    assert.ok(item.preview.moments.length > 0);
    assert.equal(store.listVersions('site-test').length, before, 'preview must not persist');
    const input = store.loadSiteInput('site-test');
    assert.equal(input.statuses.filter((s) => s.externalId === 'LATE-late-1').length, 0);
  });
});

test('ingesting a late message creates a new version and marks the item ingested', async () => {
  await withServer(async ({ store, port }) => {
    const created = store.createVersion('site-test', WIN.start, WIN.end, { reason: 'initial' });
    const response = await getJson(port, '/api/sites/site-test/inbox/late-1/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ start: WIN.start, end: WIN.end }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.version.seq, 2);
    assert.equal(response.body.version.reason, 'late_message');
    assert.match(response.body.version.note, /late-1/);
    assert.equal(response.body.previous.id, created.version.id);
    const g1 = response.body.result.guns.find((g) => g.code === 'G1');
    assert.equal(g1.metrics.offlineMs, 3600 * 1000);
    assert.equal(response.body.result.dataQuality.counts.lateStatuses, 1);

    const after = await getJson(port, `/api/sites/site-test/inbox?version=${response.body.version.id}`);
    assert.equal(after.body.items.find((i) => i.id === 'late-1').status, 'ingested');

    // Second ingest is rejected.
    const again = await getJson(port, '/api/sites/site-test/inbox/late-1/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ start: WIN.start, end: WIN.end }),
    });
    assert.equal(again.status, 409);
  });
});

test('records endpoint returns every raw row plus analyzed fate', async () => {
  await withServer(async ({ store, port }) => {
    store.createVersion('site-test', WIN.start, WIN.end, { reason: 'initial' });
    const response = await getJson(port, '/api/sites/site-test/records');
    assert.equal(response.status, 200);
    assert.ok(response.body.statuses.length > 20);
    assert.equal(response.body.orders.length, 1);
    assert.ok(Array.isArray(response.body.guns));
  });
});

test('CSV export has a header, BOM and one row per segment', async () => {
  await withServer(async ({ store, port }) => {
    const created = store.createVersion('site-test', WIN.start, WIN.end, { reason: 'initial' });
    const response = await fetch(`http://127.0.0.1:${port}/api/sites/site-test/export?version=${created.version.id}&format=csv`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/csv/);
    assert.match(response.headers.get('content-disposition'), /attachment; filename="availability-site-test-v1-/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
    const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
    const lines = text.trim().split(/\r\n/);
    assert.match(lines[0], /^kind,nature,site,gun,/);
    const segmentRows = lines.filter((l) => l.startsWith('segment,'));
    assert.ok(segmentRows.length > 0);
    for (const row of segmentRows) assert.match(row, /,\d{4}-\d{2}-\d{2} \d{2}:\d{2},/);
  });
});

test('JSON export includes raw records and the version fingerprint', async () => {
  await withServer(async ({ store, port }) => {
    const created = store.createVersion('site-test', WIN.start, WIN.end, { reason: 'initial' });
    const response = await fetch(`http://127.0.0.1:${port}/api/sites/site-test/export?version=${created.version.id}&format=json`);
    const body = await response.json();
    assert.equal(body.version.seq, created.version.seq);
    assert.equal(body.version.inputHash, created.version.inputHash);
    assert.ok(body.guns[0].records.statuses.length > 0);
    assert.ok(body.siteMetrics.naturalMs > 0);
  });
});

test('an invalid window is rejected with 400', async () => {
  await withServer(async ({ port }) => {
    const response = await getJson(port, `/api/sites/site-test/analysis?start=${WIN.end}&end=${WIN.start}`);
    assert.equal(response.status, 400);
    const tooLong = await getJson(port, `/api/sites/site-test/analysis?days=400`);
    assert.equal(tooLong.status, 400);
  });
});

test('static files are served and path traversal is blocked', async () => {
  await withServer(async ({ port }) => {
    const index = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /枪口可用性分析/);
    const css = await fetch(`http://127.0.0.1:${port}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    const bad = await fetch(`http://127.0.0.1:${port}/../package.json`);
    assert.notEqual(bad.status, 200);
  });
});

test('booting with no versions auto-generates exactly one per window', async () => {
  await withServer(async ({ store, port }) => {
    await getJson(port, `/api/sites/site-test/analysis?${q(WIN.start, WIN.end)}`);
    await getJson(port, `/api/sites/site-test/analysis?${q(WIN.start, WIN.end)}`);
    assert.equal(store.listVersions('site-test').length, 1);
    const other = await getJson(port, `/api/sites/site-test/analysis?${q(WIN.start, WIN.end + 3600000)}`);
    assert.equal(other.status, 200);
    assert.equal(store.listVersions('site-test').length, 2);
  });
});
