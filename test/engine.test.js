'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyze, normalizeState } = require('../src/engine');
const { at, makeInput, status, availableStream, daysWindow, HOUR, MINUTE } = require('./helpers');

const WIN = daysWindow('2026-11-02', 1);

function run(input, win = WIN) {
  return analyze(input, win, { generatedAt: 0 });
}

function gun(result, id = 'g1') {
  return result.guns.find((g) => g.gunId === id);
}

function stateSpans(g) {
  return g.segments.map((s) => [s.start, s.end, s.state]);
}

// ---------------------------------------------------------------------------
// Basic reconstruction
// ---------------------------------------------------------------------------

test('empty input is entirely unconfirmed, never available', () => {
  const result = run(makeInput());
  const g = gun(result);
  assert.equal(g.segments.length, 1);
  assert.equal(g.segments[0].state, 'unconfirmed');
  assert.equal(g.segments[0].start, WIN.start);
  assert.equal(g.segments[0].end, WIN.end);
  assert.equal(g.metrics.availableMs, 0);
  assert.equal(g.metrics.unconfirmedMs, WIN.end - WIN.start);
  assert.equal(g.metrics.utilizationNatural, 0);
  // Serviceable denominator is zero, so the serviceable caliber is undefined.
  assert.equal(g.metrics.utilizationServiceable, null);
});

test('state stream is carried forward to the next message', () => {
  const input = makeInput({
    statuses: [
      ...availableStream('G1', '2026-11-02 00:00', '2026-11-02 08:00'),
      status('G1', 'occupied', at('2026-11-02 08:00')),
      ...availableStream('G1', '2026-11-02 10:00', '2026-11-02 23:00'),
    ],
  });
  const g = gun(run(input));
  const available = g.segments.filter((s) => s.state === 'available');
  const occupied = g.segments.filter((s) => s.state === 'occupied');
  assert.equal(occupied.length, 1);
  assert.equal(occupied[0].start, Date.parse(at('2026-11-02 08:00')));
  assert.equal(occupied[0].end, Date.parse(at('2026-11-02 10:00')));
  assert.equal(available.reduce((s, x) => s + (x.end - x.start), 0), 22 * HOUR);
  assert.equal(g.metrics.unconfirmedMs, 0);
});

test('state is carried at most six hours; longer gaps stay unconfirmed', () => {
  const input = makeInput({
    statuses: [
      status('G1', 'available', at('2026-11-02 00:00')),
      status('G1', 'available', at('2026-11-02 20:00')),
    ],
  });
  const g = gun(run(input));
  assert.equal(g.segments[0].state, 'available');
  assert.equal(g.segments[0].end, Date.parse(at('2026-11-02 06:00')));
  assert.equal(g.segments[1].state, 'unconfirmed');
  assert.match(g.segments[1].reason, /未覆盖/);
});

test('status synonyms normalize to canonical states', () => {
  assert.equal(normalizeState('充电中'), 'occupied');
  assert.equal(normalizeState('可用'), 'available');
  assert.equal(normalizeState('掉线'), 'offline');
  assert.equal(normalizeState('异常'), 'fault');
  assert.equal(normalizeState('nonsense'), null);
});

// ---------------------------------------------------------------------------
// Duplicates and same-time conflicts
// ---------------------------------------------------------------------------

test('duplicate by external id is suppressed and only the first arrival counts', () => {
  const t = at('2026-11-02 03:00');
  const input = makeInput({
    statuses: [
      ...availableStream('G1', '2026-11-02 00:00', '2026-11-02 03:00'),
      status('G1', 'fault', t, '2026-11-02T03:00:05+08:00', { externalId: 'ST-DUP' }),
      status('G1', 'available', t, '2026-11-02T03:10:00+08:00', { externalId: 'ST-DUP' }),
      ...availableStream('G1', '2026-11-02 06:00', '2026-11-02 23:00'),
    ],
  });
  const result = run(input);
  const g = gun(result);
  assert.equal(result.dataQuality.counts.duplicatesSuppressed, 1);
  const dupe = g.records.statuses.find((s) => s.externalId === 'ST-DUP' && s.fate === 'duplicate');
  assert.ok(dupe);
  assert.equal(dupe.duplicateOf, 'ST-DUP');
  // The fault from the first copy is what the timeline uses.
  assert.ok(g.segments.some((s) => s.state === 'fault'));
  assert.equal(g.metrics.faultMs, 3 * HOUR); // 03:00 → 06:00 from the first copy
});

test('two different ids with identical content collapse to one', () => {
  const t = at('2026-11-02 04:00');
  const input = makeInput({
    statuses: [
      status('G1', 'available', at('2026-11-02 00:00')),
      status('G1', 'occupied', t, t, { externalId: 'ST-X' }),
      status('G1', 'occupied', t, t, { externalId: 'ST-Y' }),
      status('G1', 'available', at('2026-11-02 05:00')),
    ],
  });
  const result = run(input);
  assert.equal(result.dataQuality.counts.duplicatesSuppressed, 1);
  assert.equal(result.dataQuality.duplicates[0].reason, 'same_content');
});

test('same-time conflict: latest arrival wins and the loser is reported', () => {
  const t = at('2026-11-02 10:00');
  const input = makeInput({
    statuses: [
      status('G1', 'available', at('2026-11-02 00:00')),
      status('G1', 'fault', t, '2026-11-02T10:00:10+08:00', { externalId: 'ST-FAULT' }),
      status('G1', 'available', t, '2026-11-02T10:00:40+08:00', { externalId: 'ST-AVAIL' }),
      status('G1', 'available', at('2026-11-02 23:00')),
    ],
  });
  const result = run(input);
  const g = gun(result);
  assert.equal(result.dataQuality.counts.sameTimeStatusConflicts, 1);
  const conflict = result.dataQuality.sameTimeStatusConflicts[0];
  assert.equal(conflict.winnerExternalId, 'ST-AVAIL');
  assert.equal(g.metrics.faultMs, 0);
  const loser = g.records.statuses.find((s) => s.externalId === 'ST-FAULT');
  assert.equal(loser.fate, 'superseded_same_time');
});

test('a late message is flagged but still used', () => {
  const input = makeInput({
    statuses: [
      status('G1', 'available', at('2026-11-02 00:00')),
      status('G1', 'available', at('2026-11-02 12:00')),
      // Event at 09:00 but only received at 12:30 — out of order and > 2h late.
      status('G1', 'fault', at('2026-11-02 09:00'), '2026-11-02T12:30:00+08:00', { externalId: 'ST-LATE' }),
      status('G1', 'available', at('2026-11-02 23:00')),
    ],
  });
  const result = run(input);
  const g = gun(result);
  assert.equal(result.dataQuality.counts.lateStatuses, 1);
  const late = result.dataQuality.lateMessages[0];
  assert.equal(late.externalId, 'ST-LATE');
  assert.equal(late.outOfOrder, true);
  assert.equal(late.delayMs, 3.5 * HOUR);
  // The fault occupies 09:00–12:00 even though it arrived late.
  assert.ok(g.segments.some((s) => s.state === 'fault' && s.start === Date.parse(at('2026-11-02 09:00'))));
});

// ---------------------------------------------------------------------------
// Missing order ends
// ---------------------------------------------------------------------------

test('order without end is bounded by the next status leaving occupied', () => {
  const input = makeInput({
    statuses: [
      ...availableStream('G1', '2026-11-02 00:00', '2026-11-02 08:00'),
      status('G1', 'occupied', at('2026-11-02 08:00')),
      ...availableStream('G1', '2026-11-02 09:15', '2026-11-02 23:00', 45),
    ],
    orders: [{
      externalId: 'ORD-OPEN', gunRef: 'G1',
      startTime: at('2026-11-02 08:00'), endTime: null, energyKwh: 12.5, status: 'started',
    }],
  });
  const result = run(input);
  const g = gun(result);
  const inferred = result.dataQuality.inferredOrderEnds.find((i) => i.externalId === 'ORD-OPEN');
  assert.ok(inferred);
  assert.equal(inferred.inferredEnd, Date.parse(at('2026-11-02 09:15')));
  assert.equal(inferred.boundKind, 'status');
  assert.ok(g.segments.some((s) => s.state === 'occupied' && s.inferredOrderEnd === true));
  // Explicit record shows the inferred end.
  const rec = g.records.orders.find((o) => o.externalId === 'ORD-OPEN');
  assert.equal(rec.inferredEnd.boundRef, inferred.boundRef);
  assert.equal(g.metrics.unconfirmedMs, 0);
});

test('order without end and without evidence becomes unconfirmed, never available', () => {
  const input = makeInput({
    statuses: availableStream('G1', '2026-11-02 00:00', '2026-11-02 12:00'),
    orders: [{
      externalId: 'ORD-ORPHAN', gunRef: 'G1',
      startTime: at('2026-11-02 11:00'), endTime: null, status: 'started',
    }],
  });
  const result = run(input);
  const g = gun(result);
  assert.equal(result.dataQuality.counts.openOrders, 1);
  const unc = g.unconfirmed.find((u) => u.evidence.orders.includes('ORD-ORPHAN'));
  assert.ok(unc, 'unconfirmed interval exists');
  assert.ok(unc.end <= WIN.end);
  const occupied = g.segments.filter((s) => s.state === 'occupied');
  for (const seg of occupied) {
    assert.ok(seg.start <= WIN.end, 'occupied only where an order interval exists');
  }
  // Everything after the order start is unconfirmed, not available.
  const tail = g.segments.filter((s) => s.start >= Date.parse(at('2026-11-02 12:00')));
  assert.ok(tail.length > 0);
  assert.ok(tail.every((s) => s.state === 'unconfirmed'));
  assert.equal(g.metrics.availableMs, 11 * HOUR);
});

test('order without end is bounded by the next order start', () => {
  const input = makeInput({
    statuses: [
      ...availableStream('G1', '2026-11-02 00:00', '2026-11-02 08:00'),
      status('G1', 'occupied', at('2026-11-02 08:00')),
      status('G1', 'occupied', at('2026-11-02 12:00')),
      ...availableStream('G1', '2026-11-02 14:00', '2026-11-02 23:00'),
    ],
    orders: [
      { externalId: 'ORD-1', gunRef: 'G1', startTime: at('2026-11-02 08:00'), endTime: null },
      { externalId: 'ORD-2', gunRef: 'G1', startTime: at('2026-11-02 12:00'), endTime: at('2026-11-02 14:00') },
    ],
  });
  const result = run(input);
  const inferred = result.dataQuality.inferredOrderEnds.find((i) => i.externalId === 'ORD-1');
  assert.equal(inferred.boundKind, 'next_order');
  assert.equal(inferred.inferredEnd, Date.parse(at('2026-11-02 12:00')));
});

// ---------------------------------------------------------------------------
// Repairs, faults, conflicts, no double deduction
// ---------------------------------------------------------------------------

test('repair and fault overlap is deducted once', () => {
  const input = makeInput({
    statuses: [
      ...availableStream('G1', '2026-11-02 00:00', '2026-11-02 10:00'),
      status('G1', 'fault', at('2026-11-02 10:00')),
      status('G1', 'available', at('2026-11-02 14:00')),
      status('G1', 'available', at('2026-11-02 23:00')),
    ],
    repairs: [{
      externalId: 'REP-1', gunRef: 'G1',
      startTime: at('2026-11-02 09:30'), endTime: at('2026-11-02 11:30'),
      kind: '更换枪线', workOrder: 'WO-1', status: 'closed',
    }],
  });
  const result = run(input);
  const g = gun(result);
  // Fault set = status fault (10:00–14:00) ∪ repair (09:30–11:30) = 09:30–14:00.
  assert.equal(g.metrics.faultMs, 4.5 * HOUR);
  const rep = g.records.repairs.find((r) => r.externalId === 'REP-1');
  assert.ok(rep);
  // The repair/order overlap appears as a conflict only if charging overlaps.
  assert.equal(result.conflicts.filter((c) => c.repairIds.includes('REP-1')).length, 0);
});

test('repair overlapping a charging order raises a conflict and counts the time once', () => {
  const input = makeInput({
    statuses: availableStream('G1', '2026-11-02 00:00', '2026-11-02 23:00'),
    orders: [{
      externalId: 'ORD-C', gunRef: 'G1',
      startTime: at('2026-11-02 10:00'), endTime: at('2026-11-02 12:00'), energyKwh: 30,
    }],
    repairs: [{
      externalId: 'REP-C', gunRef: 'G1',
      startTime: at('2026-11-02 11:00'), endTime: at('2026-11-02 13:00'),
      kind: '检修', status: 'closed',
    }],
  });
  const result = run(input);
  const g = gun(result);
  const conflicts = result.conflicts.filter((c) => c.type === 'maintenance_overlap_charging');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].start, Date.parse(at('2026-11-02 11:00')));
  assert.equal(conflicts[0].end, Date.parse(at('2026-11-02 12:00')));
  assert.equal(conflicts[0].ms, HOUR);
  // Occupied is 1h of charging before the overlap; the overlap is fault.
  assert.equal(g.metrics.occupiedMs, HOUR);
  assert.equal(g.metrics.faultMs, 2 * HOUR);
  assert.equal(g.metrics.conflictMs, HOUR);
  // Serviceable = 24 − 2h fault, unconfirmed 0.
  assert.equal(g.metrics.serviceableMs, 22 * HOUR);
  const conflictSeg = g.segments.find((s) => s.flags.includes('conflict_charging'));
  assert.ok(conflictSeg);
  assert.ok(conflictSeg.conflictIds.length > 0);
});

test('open repair runs to the window end and is counted as fault', () => {
  const input = makeInput({
    statuses: availableStream('G1', '2026-11-02 00:00', '2026-11-02 22:00'),
    repairs: [{
      externalId: 'REP-OPEN', gunRef: 'G1',
      startTime: at('2026-11-02 20:00'), endTime: null, kind: '紧急停机', status: 'open',
    }],
  });
  const result = run(input);
  const g = gun(result);
  assert.equal(g.repairsOpen, 1);
  assert.equal(g.metrics.faultMs, 4 * HOUR);
  const last = g.segments[g.segments.length - 1];
  assert.equal(last.end, WIN.end);
  assert.equal(last.state, 'fault');
});

// ---------------------------------------------------------------------------
// Dual calibers
// ---------------------------------------------------------------------------

test('the two utilization calibers differ when unavailable time exists', () => {
  const input = makeInput({
    statuses: [
      status('G1', 'available', at('2026-11-02 00:00')),
      status('G1', 'occupied', at('2026-11-02 00:00')),
      status('G1', 'fault', at('2026-11-02 02:00')),
      status('G1', 'available', at('2026-11-02 18:00')),
      status('G1', 'available', at('2026-11-02 23:00')),
    ],
  });
  const result = run(input);
  const g = gun(result);
  assert.equal(g.metrics.occupiedMs, 2 * HOUR);
  assert.equal(g.metrics.utilizationNatural, 2 / 24);
  assert.equal(g.metrics.utilizationServiceable, 2 / 8);
  assert.ok(g.metrics.utilizationServiceable > g.metrics.utilizationNatural);
});

test('cross-midnight order splits correctly across local days', () => {
  const win = daysWindow('2026-11-02', 2);
  const input = makeInput({
    statuses: [
      ...availableStream('G1', '2026-11-02 00:00', '2026-11-04 00:00'),
    ],
    orders: [{
      externalId: 'ORD-NIGHT', gunRef: 'G1',
      startTime: at('2026-11-02 22:30'), endTime: at('2026-11-03 01:30'), energyKwh: 20,
    }],
  });
  const result = run(input, win);
  const g = gun(result);
  const d1 = g.days.find((d) => d.date === '2026-11-02');
  const d2 = g.days.find((d) => d.date === '2026-11-03');
  assert.equal(d1.occupiedMs, 1.5 * HOUR);
  assert.equal(d2.occupiedMs, 1.5 * HOUR);
  assert.equal(d1.naturalMs, 24 * HOUR);
  assert.equal(d2.naturalMs, 24 * HOUR);
  assert.equal(result.siteDays.length, 2);
  assert.equal(result.siteDays[0].naturalMs, 2 * 24 * HOUR);
});

// ---------------------------------------------------------------------------
// Names and aliases
// ---------------------------------------------------------------------------

test('renamed gun resolves old and new names by event time', () => {
  const input = makeInput({
    aliases: [{
      gunId: 'g1', alias: 'G1-旧', validFrom: at('2026-11-02 00:00'), validTo: at('2026-11-02 12:00'),
    }],
    statuses: [
      status('G1-旧', 'available', at('2026-11-02 00:00')),
      status('G1', 'occupied', at('2026-11-02 08:00')),
      status('G1-旧', 'available', at('2026-11-02 09:00')), // stale name used after rename
      status('G1', 'available', at('2026-11-02 23:00')),
    ],
  });
  const result = run(input);
  const g = gun(result);
  assert.equal(result.dataQuality.counts.unresolvedRefs, 0);
  const stale = g.records.statuses.find((s) => s.externalId === g.records.statuses[2].externalId);
  assert.equal(stale.matchedViaAlias, true);
  assert.equal(stale.outsideAliasValidity, true);
  assert.equal(g.historicalNames.length, 2);
  // Occupied 08:00–09:00 survived despite the stale-name message.
  assert.equal(g.metrics.occupiedMs, HOUR);
});

test('unknown gun reference is reported and excluded from timelines', () => {
  const input = makeInput({
    statuses: [
      status('G1', 'available', at('2026-11-02 00:00')),
      status('G9', 'fault', at('2026-11-02 01:00')),
    ],
  });
  const result = run(input);
  assert.equal(result.dataQuality.counts.unresolvedRefs, 1);
  assert.equal(result.dataQuality.unresolved[0].gunRef, 'G9');
  assert.equal(result.dataQuality.unresolved[0].reason, 'unknown_gun_ref');
});

test('invalid records are reported without breaking the analysis', () => {
  const input = makeInput({
    statuses: [
      status('G1', 'available', at('2026-11-02 00:00')),
      status('G1', 'not-a-state', at('2026-11-02 01:00')),
    ],
    orders: [{
      externalId: 'ORD-BAD', gunRef: 'G1',
      startTime: at('2026-11-02 10:00'), endTime: at('2026-11-02 09:00'),
    }],
  });
  const result = run(input);
  const reasons = result.dataQuality.invalid.map((i) => i.reason).sort();
  assert.deepEqual(reasons, ['end_not_after_start', 'invalid_state']);
});

// ---------------------------------------------------------------------------
// Hash / versioning invariants
// ---------------------------------------------------------------------------

test('input hash is stable and changes with the window or payload', () => {
  const { hashInputs } = require('../src/engine');
  const input = makeInput({
    statuses: [status('G1', 'available', at('2026-11-02 00:00'))],
  });
  const h1 = hashInputs(input, WIN);
  const h2 = hashInputs(JSON.parse(JSON.stringify(input)), WIN);
  assert.equal(h1, h2);
  const h3 = hashInputs(input, { start: WIN.start, end: WIN.end + MINUTE });
  assert.notEqual(h1, h3);
  input.statuses.push(status('G1', 'fault', at('2026-11-02 05:00')));
  assert.notEqual(h1, hashInputs(input, WIN));
});

test('site totals equal the sum of gun totals', () => {
  const input = makeInput({
    statuses: [
      ...availableStream('G1', '2026-11-02 00:00', '2026-11-02 23:00'),
      status('G2', 'offline', at('2026-11-02 00:00')),
      status('G2', 'available', at('2026-11-02 06:00')),
      status('G2', 'available', at('2026-11-02 23:00')),
    ],
  });
  const result = run(input);
  for (const key of ['availableMs', 'occupiedMs', 'faultMs', 'offlineMs', 'unconfirmedMs', 'serviceableMs']) {
    const sum = result.guns.reduce((s, g) => s + g.metrics[key], 0);
    assert.equal(result.siteMetrics[key], sum, key);
  }
  assert.equal(result.siteMetrics.naturalMs, 2 * 24 * HOUR);
});

test('every segment covers the window contiguously with no gaps or overlaps', () => {
  const input = makeInput({
    statuses: [
      status('G1', 'available', at('2026-11-02 00:00')),
      status('G1', 'occupied', at('2026-11-02 03:00')),
      status('G1', 'fault', at('2026-11-02 05:30')),
      status('G1', 'offline', at('2026-11-02 07:00')),
      status('G1', 'available', at('2026-11-02 08:00')),
    ],
    orders: [{
      externalId: 'ORD-X', gunRef: 'G1',
      startTime: at('2026-11-02 03:00'), endTime: null,
    }],
    repairs: [{
      externalId: 'REP-X', gunRef: 'G1',
      startTime: at('2026-11-02 05:00'), endTime: at('2026-11-02 06:00'),
    }],
  });
  const g = gun(run(input));
  assert.equal(g.segments[0].start, WIN.start);
  assert.equal(g.segments[g.segments.length - 1].end, WIN.end);
  for (let i = 1; i < g.segments.length; i += 1) {
    assert.equal(g.segments[i].start, g.segments[i - 1].end, `gap at ${i}`);
  }
});
