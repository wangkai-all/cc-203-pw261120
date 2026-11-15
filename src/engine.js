'use strict';

/**
 * Availability reconstruction engine.
 *
 * Pure function: analyze(normalizedInput, window) -> result.
 * No database or filesystem access. All times are ms since epoch internally.
 *
 * Evidence model
 * --------------
 *  - Status messages are a state stream: a message sets the gun state from its
 *    event time until the next message. Duplicates are collapsed; same-time
 *    conflicts are resolved by received time (latest wins) and reported.
 *  - Orders are occupancy evidence. An order with no end time is ONLY closed by
 *    independent evidence (next order, a status message leaving "occupied", or a
 *    repair start). Without such evidence it becomes an explicit "unconfirmed"
 *    interval -- never "available".
 *  - Repair windows and fault/offline statuses are unavailability evidence. Their
 *    union is used for time accounting, so a fault reported by both a repair and a
 *    status is deducted once.
 *  - Charging evidence overlapping unavailability is reported as a conflict; the
 *    overlapping time is classified as unavailable (and counted once), never as
 *    productive time.
 */

const crypto = require('node:crypto');
const {
  MINUTE, HOUR, parseTime, floorMinute,
  mergeIntervals, clipInterval, clipIntervals, measure, intersectIntervals,
  subtractIntervals, unionIntervals, splitByLocalDay, localDate,
  startOfLocalDay, addLocalDays, zoneParts, zonedTime,
} = require('./time');

const ENGINE_VERSION = '1.0.0';
/** A status message's state is carried forward for at most this long. */
const STATE_CARRY_MAX = 6 * HOUR;

const STATE = Object.freeze({
  AVAILABLE: 'available',
  OCCUPIED: 'occupied',
  FAULT: 'fault',
  OFFLINE: 'offline',
  UNCONFIRMED: 'unconfirmed',
});

const VALID_STATES = new Set(Object.values(STATE));

const STATE_SYNONYMS = new Map(Object.entries({
  available: STATE.AVAILABLE, free: STATE.AVAILABLE, idle: STATE.AVAILABLE,
  standby: STATE.AVAILABLE, '可服务': STATE.AVAILABLE, '空闲': STATE.AVAILABLE,
  '可用': STATE.AVAILABLE,
  occupied: STATE.OCCUPIED, charging: STATE.OCCUPIED, in_use: STATE.OCCUPIED,
  busy: STATE.OCCUPIED, '占用': STATE.OCCUPIED, '充电中': STATE.OCCUPIED,
  '使用中': STATE.OCCUPIED,
  fault: STATE.FAULT, error: STATE.FAULT, failed: STATE.FAULT,
  '故障': STATE.FAULT, '异常': STATE.FAULT,
  offline: STATE.OFFLINE, disconnected: STATE.OFFLINE, '离线': STATE.OFFLINE,
  '掉线': STATE.OFFLINE,
}));

function normalizeState(value) {
  if (value == null) return null;
  const key = String(value).trim().toLowerCase();
  return STATE_SYNONYMS.get(key) || STATE_SYNONYMS.get(String(value).trim()) || (VALID_STATES.has(key) ? key : null);
}

function normName(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function num(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function interval(start, end, extra) {
  return { start, end, ...extra };
}

function setHasInterval(set, start, end) {
  // `set` is merged and sorted. Find the last interval starting <= start.
  let lo = 0;
  let hi = set.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (set[mid].start <= start) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (idx < 0) return false;
  return set[idx].end >= end;
}

function makeRecordRef(kind, row, extra) {
  return {
    kind,
    externalId: row.externalId || row.id || null,
    ...extra,
  };
}

function uniqueBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function buildGunIndex(input) {
  const entries = [];
  for (const gun of input.guns || []) {
    const valid = { validFrom: null, validTo: null, kind: 'canonical' };
    for (const value of [gun.id, gun.code, gun.displayName]) {
      if (value == null) continue;
      entries.push({ gunId: gun.id, name: String(value), ...valid });
    }
  }
  for (const alias of input.aliases || []) {
    entries.push({
      gunId: alias.gunId,
      name: String(alias.alias),
      validFrom: alias.validFrom ?? null,
      validTo: alias.validTo ?? null,
      kind: alias.kind || 'alias',
      note: alias.note || null,
    });
  }
  const byName = new Map();
  for (const entry of entries) {
    const key = normName(entry.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(entry);
  }
  return byName;
}

function resolveRef(index, ref, at) {
  const key = normName(ref);
  if (!key) return { gunId: null, reason: 'missing_gun_ref' };
  const candidates = index.get(key);
  if (!candidates || candidates.length === 0) {
    return { gunId: null, reason: 'unknown_gun_ref' };
  }
  const covering = candidates.filter((c) =>
    (c.validFrom == null || at == null || at >= c.validFrom) &&
    (c.validTo == null || at == null || at < c.validTo));
  const pool = covering.length > 0 ? covering : candidates;
  const canonical = pool.filter((c) => c.kind === 'canonical');
  const chosenPool = canonical.length > 0 ? canonical : pool;
  const gunIds = [...new Set(chosenPool.map((c) => c.gunId))];
  if (gunIds.length > 1) {
    return { gunId: null, reason: 'ambiguous_gun_ref' };
  }
  const chosen = chosenPool[0];
  return {
    gunId: gunIds[0],
    matchedName: chosen.name,
    aliasNote: chosen.note || null,
    usedAlias: chosen.kind !== 'canonical',
    outsideValidity: covering.length === 0,
  };
}

function asTime(value, fallback) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null) return fallback == null ? null : asTime(fallback, null);
  return parseTime(value);
}

/**
 * Main analysis.
 * @param {object} input normalized site data
 * @param {{start:number,end:number}} window
 * @param {{generatedAt?:number}} [options]
 */
function analyze(input, window, options = {}) {
  if (!input || !input.site) throw new Error('analyze: site is required');
  if (!window || !(window.end > window.start)) throw new Error('analyze: invalid window');
  const tz = input.site.timezone || 'UTC';
  const win = { start: floorMinute(window.start), end: floorMinute(window.end) };
  const generatedAt = options.generatedAt ?? Date.now();
  const gunIndex = buildGunIndex(input);

  const guns = (input.guns || []).map((gun) => ({
    ...gun,
    aliases: (input.aliases || []).filter((a) => a.gunId === gun.id),
  }));
  const gunById = new Map(guns.map((g) => [g.id, g]));

  const unresolved = [];
  const invalid = [];
  const gunWork = new Map(guns.map((g) => [g.id, {
    gun: g,
    statuses: [], orders: [], repairs: [],
  }]));

  // -----------------------------------------------------------------------
  // Normalize and resolve raw records
  // -----------------------------------------------------------------------
  for (const raw of input.statuses || []) {
    const state = normalizeState(raw.state);
    const eventTime = asTime(raw.eventTime, raw.eventTimeIso);
    if (!state) {
      invalid.push({ kind: 'status', externalId: raw.externalId, reason: 'invalid_state', value: raw.state });
      continue;
    }
    if (eventTime == null) {
      invalid.push({ kind: 'status', externalId: raw.externalId, reason: 'invalid_event_time' });
      continue;
    }
    const resolution = resolveRef(gunIndex, raw.gunRef, eventTime);
    if (!resolution.gunId) {
      unresolved.push({ kind: 'status', externalId: raw.externalId, gunRef: raw.gunRef, reason: resolution.reason });
      continue;
    }
    const receivedAt = asTime(raw.receivedAt, eventTime);
    const record = {
      externalId: raw.externalId || `auto-status-${input.statuses.indexOf(raw)}`,
      gunRef: raw.gunRef,
      gunId: resolution.gunId,
      state,
      eventTime: floorMinute(eventTime),
      // Arrival is kept at full precision: it is the only ordering signal for
      // same-minute late messages.
      receivedAt,
      source: raw.source || null,
      payload: raw.payload ?? null,
      resolution,
    };
    gunWork.get(resolution.gunId).statuses.push(record);
  }

  for (const raw of input.orders || []) {
    const startTime = asTime(raw.startTime, raw.startTimeIso);
    const endTime = asTime(raw.endTime, raw.endTimeIso);
    if (startTime == null) {
      invalid.push({ kind: 'order', externalId: raw.externalId, reason: 'invalid_start_time' });
      continue;
    }
    if (endTime != null && endTime <= startTime) {
      invalid.push({ kind: 'order', externalId: raw.externalId, reason: 'end_not_after_start' });
      continue;
    }
    const resolution = resolveRef(gunIndex, raw.gunRef, startTime);
    if (!resolution.gunId) {
      unresolved.push({ kind: 'order', externalId: raw.externalId, gunRef: raw.gunRef, reason: resolution.reason });
      continue;
    }
    gunWork.get(resolution.gunId).orders.push({
      externalId: raw.externalId || `auto-order-${input.orders.indexOf(raw)}`,
      gunRef: raw.gunRef,
      gunId: resolution.gunId,
      startTime: floorMinute(startTime),
      endTime: endTime == null ? null : floorMinute(endTime),
      energyKwh: num(raw.energyKwh),
      status: raw.status || null,
      source: raw.source || null,
      receivedAt: raw.receivedAt ?? null,
      resolution,
    });
  }

  for (const raw of input.repairs || []) {
    const startTime = asTime(raw.startTime, raw.startTimeIso);
    const endTime = asTime(raw.endTime, raw.endTimeIso);
    if (startTime == null) {
      invalid.push({ kind: 'repair', externalId: raw.externalId, reason: 'invalid_start_time' });
      continue;
    }
    if (endTime != null && endTime <= startTime) {
      invalid.push({ kind: 'repair', externalId: raw.externalId, reason: 'end_not_after_start' });
      continue;
    }
    const resolution = resolveRef(gunIndex, raw.gunRef, startTime);
    if (!resolution.gunId) {
      unresolved.push({ kind: 'repair', externalId: raw.externalId, gunRef: raw.gunRef, reason: resolution.reason });
      continue;
    }
    gunWork.get(resolution.gunId).repairs.push({
      externalId: raw.externalId || `auto-repair-${input.repairs.indexOf(raw)}`,
      gunRef: raw.gunRef,
      gunId: resolution.gunId,
      startTime: floorMinute(startTime),
      endTime: endTime == null ? null : floorMinute(endTime),
      kind: raw.kind || null,
      workOrder: raw.workOrder || null,
      status: raw.status || null,
      note: raw.note || null,
      source: raw.source || null,
      resolution,
    });
  }

  // -----------------------------------------------------------------------
  // Per-gun reconstruction
  // -----------------------------------------------------------------------
  const globalLate = [];
  const globalDuplicates = [];
  const globalStatusConflicts = [];
  const globalInferredEnds = [];
  const globalOpenOrders = [];
  const conflicts = [];
  const gunResults = [];
  const total = {
    naturalMs: 0, availableMs: 0, occupiedMs: 0, faultMs: 0, offlineMs: 0,
    unconfirmedMs: 0, serviceableMs: 0, conflictMs: 0,
  };
  const siteDayMap = new Map();

  for (const gun of guns) {
    const work = gunWork.get(gun.id);
    const result = analyzeGun({
      gun, work, win, tz,
      globalLate, globalDuplicates, globalStatusConflicts, globalInferredEnds, globalOpenOrders, conflicts,
    });
    gunResults.push(result);
    for (const key of Object.keys(total)) total[key] += result.metrics[key] || 0;
    for (const day of result.days) {
      if (!siteDayMap.has(day.date)) {
        siteDayMap.set(day.date, {
          date: day.date, start: day.start, end: day.end, naturalMs: 0, availableMs: 0,
          occupiedMs: 0, faultMs: 0, offlineMs: 0, unconfirmedMs: 0, serviceableMs: 0,
          conflictMs: 0,
        });
      }
      const acc = siteDayMap.get(day.date);
      for (const key of Object.keys(acc)) {
        if (key.endsWith('Ms')) acc[key] += day[key] || 0;
      }
    }
  }

  // order overlap conflicts (per gun) and repair/fault/offline overlap
  for (const gunResult of gunResults) {
    // Already added by analyzeGun into `conflicts`; nothing to do here.
  }

  const siteMetrics = finalizeMetrics(total, win);
  const siteDays = [...siteDayMap.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => {
      const finalized = finalizeMetrics(d, win);
      return {
        date: d.date, start: d.start, end: d.end,
        naturalMs: d.naturalMs, availableMs: d.availableMs, occupiedMs: d.occupiedMs,
        faultMs: d.faultMs, offlineMs: d.offlineMs, unconfirmedMs: d.unconfirmedMs,
        serviceableMs: d.serviceableMs, conflictMs: d.conflictMs,
        utilizationNatural: finalized.utilizationNatural,
        utilizationServiceable: finalized.utilizationServiceable,
      };
    });

  const lateMessages = uniqueBy(globalLate, (l) => `${l.gunId}|${l.externalId}`);
  const duplicateMessages = uniqueBy(globalDuplicates, (d) => `${d.gunId}|${d.externalId}|${d.duplicateOf}`);

  const dataQuality = {
    counts: {
      statusesIngested: (input.statuses || []).length,
      statusesEffective: gunResults.reduce((s, g) => s + g.statusStats.effective, 0),
      duplicatesSuppressed: duplicateMessages.length,
      lateStatuses: lateMessages.length,
      inferredOrderEnds: globalInferredEnds.length,
      openOrders: globalOpenOrders.length,
      unresolvedRefs: unresolved.length,
      invalidRecords: invalid.length,
      sameTimeStatusConflicts: globalStatusConflicts.length,
      repairs: (input.repairs || []).length,
      orders: (input.orders || []).length,
      guns: guns.length,
    },
    lateMessages,
    duplicates: duplicateMessages,
    sameTimeStatusConflicts: globalStatusConflicts,
    inferredOrderEnds: globalInferredEnds,
    openOrders: globalOpenOrders,
    unresolved,
    invalid,
  };

  const inputHash = hashInputs(input, win);

  return {
    meta: {
      siteId: input.site.id,
      siteName: input.site.name,
      timezone: tz,
      windowStart: win.start,
      windowEnd: win.end,
      generatedAt,
      engineVersion: ENGINE_VERSION,
      inputHash,
      stateConstants: STATE,
    },
    guns: gunResults,
    siteMetrics,
    siteDays,
    conflicts: sortConflicts(conflicts),
    dataQuality,
    unconfirmedIntervals: gunResults.flatMap((g) => g.unconfirmed.map((u) => ({
      ...u, gunId: g.gunId, gunCode: g.code, gunName: g.displayName,
    }))),
  };
}

function analyzeGun(ctx) {
  const {
    gun, work, win, tz, globalLate, globalDuplicates, globalStatusConflicts,
    globalInferredEnds, globalOpenOrders, conflicts,
  } = ctx;

  // ---------------------------------------------------------------------
  // Status dedup and lateness
  // ---------------------------------------------------------------------
  const sortedRaw = [...work.statuses].sort((a, b) =>
    a.receivedAt - b.receivedAt || a.eventTime - b.eventTime ||
    String(a.externalId).localeCompare(String(b.externalId)));
  const seenExternal = new Map();
  const seenContent = new Map();
  const deduped = [];
  for (const status of sortedRaw) {
    const contentKey = `${status.state}|${status.eventTime}`;
    const previous = seenExternal.get(status.externalId) || seenContent.get(contentKey);
    if (previous) {
      const reason = seenExternal.has(status.externalId) ? 'same_external_id' : 'same_content';
      const conflict = seenExternal.has(status.externalId) &&
        (previous.state !== status.state || previous.eventTime !== status.eventTime ||
          previous.receivedAt !== status.receivedAt);
      status.fate = 'duplicate';
      status.duplicateOf = previous.externalId;
      status.duplicateReason = conflict ? 'same_external_id_conflicting_payload' : reason;
      globalDuplicates.push({
        gunId: gun.id,
        externalId: status.externalId,
        duplicateOf: previous.externalId,
        eventTime: status.eventTime,
        receivedAt: status.receivedAt,
        state: status.state,
        source: status.source,
        reason: status.duplicateReason,
      });
      continue;
    }
    seenExternal.set(status.externalId, status);
    seenContent.set(contentKey, status);
    deduped.push(status);
  }

  // same-time, different-source messages for the same instant: latest received wins.
  // The tie-break is source-batch aware: messages are ordered by receivedAt, then by
  // source priority (site journal over charger firmware over third-party bridge).
  const SOURCE_PRIORITY = { 'site-journal': 0, 'charger-firmware': 1, 'third-party-bridge': 2 };
  const byTime = new Map();
  for (const status of deduped) {
    if (!byTime.has(status.eventTime)) byTime.set(status.eventTime, []);
    byTime.get(status.eventTime).push(status);
  }
  const effective = [];
  for (const [eventTime, group] of [...byTime.entries()].sort((a, b) => a[0] - b[0])) {
    group.sort((a, b) => a.receivedAt - b.receivedAt ||
      (SOURCE_PRIORITY[a.source] ?? 9) - (SOURCE_PRIORITY[b.source] ?? 9) ||
      String(a.externalId).localeCompare(String(b.externalId)));
    const winner = group[group.length - 1];
    if (new Set(group.map((g) => g.state)).size > 1) {
      globalStatusConflicts.push({
        gunId: gun.id,
        eventTime,
        states: [...new Set(group.map((g) => g.state))],
        winnerExternalId: winner.externalId,
        records: group.map((g) => ({
          externalId: g.externalId, state: g.state, receivedAt: g.receivedAt, source: g.source,
        })),
      });
    }
    effective.push(winner);
  }

  // Late detection: compare arrival order against event order.
  const latestKnownByGun = new Map();
  const chronologicalArrival = [...deduped].sort((a, b) =>
    a.receivedAt - b.receivedAt || a.eventTime - b.eventTime);
  for (const status of chronologicalArrival) {
    const latestEvent = latestKnownByGun.get(gun.id);
    if (latestEvent != null && status.eventTime < latestEvent) {
      globalLate.push({
        gunId: gun.id,
        externalId: status.externalId,
        state: status.state,
        eventTime: status.eventTime,
        receivedAt: status.receivedAt,
        delayMs: Math.max(0, status.receivedAt - status.eventTime),
        outOfOrder: true,
        source: status.source,
      });
    } else if (status.receivedAt - status.eventTime > 2 * HOUR) {
      globalLate.push({
        gunId: gun.id,
        externalId: status.externalId,
        state: status.state,
        eventTime: status.eventTime,
        receivedAt: status.receivedAt,
        delayMs: status.receivedAt - status.eventTime,
        outOfOrder: false,
        source: status.source,
      });
    }
    if (latestEvent == null || status.eventTime > latestEvent) {
      latestKnownByGun.set(gun.id, status.eventTime);
    }
  }

  // ---------------------------------------------------------------------
  // Status state intervals (state carried forward to the next message).
  // A state is carried at most STATE_CARRY_MAX; past that the stream is treated
  // as interrupted and the gap is unconfirmed rather than silently "available".
  // ---------------------------------------------------------------------
  const statusIntervals = [];
  for (let i = 0; i < effective.length; i += 1) {
    const ev = effective[i];
    const next = effective[i + 1];
    const carryCap = ev.eventTime + STATE_CARRY_MAX;
    const end = next ? Math.min(next.eventTime, carryCap) : Math.min(win.end, carryCap);
    const clipped = clipInterval({ start: ev.eventTime, end }, win);
    if (clipped) {
      statusIntervals.push({
        ...clipped,
        state: ev.state,
        externalId: ev.externalId,
        receivedAt: ev.receivedAt,
        source: ev.source,
      });
    }
  }
  const coverage = mergeIntervals(statusIntervals.map((s) => ({ start: s.start, end: s.end })));
  const statusByState = (state) => mergeIntervals(statusIntervals.filter((s) => s.state === state));
  const statusAvailable = statusByState(STATE.AVAILABLE);
  const statusOccupied = statusByState(STATE.OCCUPIED);
  const statusFault = statusByState(STATE.FAULT);
  const statusOffline = statusByState(STATE.OFFLINE);

  // ---------------------------------------------------------------------
  // Repairs
  // ---------------------------------------------------------------------
  const repairWindows = [];
  let repairOpenCount = 0;
  for (const repair of work.repairs) {
    let end = repair.endTime;
    if (end == null) {
      end = Math.max(win.end, repair.startTime + 1);
      repairOpenCount += 1;
      repair.open = true;
    }
    const clipped = clipInterval({ start: repair.startTime, end }, win);
    if (clipped) repairWindows.push({ ...clipped, repair });
  }
  const repairSet = mergeIntervals(repairWindows);

  // Charging can never explain an open-ended *window-closing* clamp: a repair
  // that runs past the window end is unavailable through the window end.

  // ---------------------------------------------------------------------
  // Orders, missing ends, inferred ends, overlaps
  // ---------------------------------------------------------------------
  const orders = [...work.orders].sort((a, b) => a.startTime - b.startTime ||
    String(a.externalId).localeCompare(String(b.externalId)));
  const orderIntervals = [];
  const openUncertain = [];
  const unconfirmedReasons = new Map(); // interval key -> reason
  for (let i = 0; i < orders.length; i += 1) {
    const order = orders[i];
    let end = order.endTime;
    let inference = null;
    if (end == null) {
      // Look for independent evidence on which the charging stopped. Evidence
      // outside the window still counts (a message at 07:10 bounds an order that
      // started at 23:40; it just yields no occupancy inside the window).
      const candidates = [];
      const nextOrder = orders.slice(i + 1).find((o) => o.startTime > order.startTime);
      if (nextOrder) candidates.push({ at: nextOrder.startTime, kind: 'next_order', ref: nextOrder.externalId });
      const nextNonOccupiedStatus = effective.find((s) =>
        s.eventTime > order.startTime && s.state !== STATE.OCCUPIED);
      if (nextNonOccupiedStatus) {
        candidates.push({ at: nextNonOccupiedStatus.eventTime, kind: 'status', ref: nextNonOccupiedStatus.externalId, state: nextNonOccupiedStatus.state });
      }
      const nextRepair = work.repairs
        .filter((r) => r.startTime > order.startTime)
        .sort((a, b) => a.startTime - b.startTime)[0];
      if (nextRepair) candidates.push({ at: nextRepair.startTime, kind: 'repair', ref: nextRepair.externalId });
      candidates.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind));
      const chosen = candidates[0];
      if (chosen && chosen.at > order.startTime) {
        end = chosen.at;
        inference = chosen;
      }
    }

    if (end == null) {
      // No evidence at all: unknown from start to the end of the window.
      const clipped = clipInterval({ start: order.startTime, end: win.end }, win);
      if (clipped) {
        const key = `${clipped.start}|${clipped.end}`;
        openUncertain.push(clipped);
        unconfirmedReasons.set(key, `订单 ${order.externalId} 结束时间缺失，且无后续状态/订单/维修证据可界定结束`);
      }
      globalOpenOrders.push({
        gunId: gun.id,
        externalId: order.externalId,
        startTime: order.startTime,
        windowEnd: win.end,
        reason: 'missing_end_no_evidence',
      });
      // The order still provides known occupancy evidence for the raw span; the
      // classification step lets confirmed occupied status win. We do NOT treat
      // the span as available.
      continue;
    }

    if (inference) {
      globalInferredEnds.push({
        gunId: gun.id,
        externalId: order.externalId,
        startTime: order.startTime,
        inferredEnd: end,
        boundKind: inference.kind,
        boundRef: inference.ref,
        boundState: inference.state || null,
      });
    }
    const clipped = clipInterval({ start: order.startTime, end }, win);
    if (clipped) {
      orderIntervals.push({
        ...clipped,
        order,
        inferredEnd: !!inference,
        boundKind: inference ? inference.kind : null,
      });
    }
  }
  const orderSet = mergeIntervals(orderIntervals);
  const occupancy = unionIntervals(orderSet, statusOccupied);
  const uncertainSet = mergeIntervals(openUncertain);

  // Order/order overlap conflicts. Purely inferred spans are not "orders" the
  // operator entered, so only explicit order intervals are compared.
  const explicitIvs = orderIntervals.filter((iv) => !iv.inferredEnd);
  for (let i = 0; i < explicitIvs.length; i += 1) {
    for (let j = i + 1; j < explicitIvs.length; j += 1) {
      const a = explicitIvs[i];
      const b = explicitIvs[j];
      const start = Math.max(a.start, b.start);
      const end = Math.min(a.end, b.end);
      if (end > start) {
        conflicts.push({
          id: conflictId('order_overlap', gun.id, start, end, [a.order.externalId, b.order.externalId]),
          type: 'order_overlap',
          severity: 'warning',
          gunId: gun.id,
          gunCode: gun.code,
          start,
          end,
          ms: end - start,
          title: '订单时间重叠',
          detail: `订单 ${a.order.externalId} 与 ${b.order.externalId} 在同一枪口重叠`,
          orderIds: [a.order.externalId, b.order.externalId],
          repairIds: [],
          statusIds: [],
        });
      }
    }
  }

  // ---------------------------------------------------------------------
  // Classification sweep
  // ---------------------------------------------------------------------
  const faultSet = unionIntervals(statusFault, repairSet);
  const offlineSet = statusOffline;
  const points = new Set([win.start, win.end]);
  for (const set of [faultSet, offlineSet, occupancy, uncertainSet, coverage, statusAvailable]) {
    for (const iv of set) { points.add(iv.start); points.add(iv.end); }
  }
  for (const iv of statusIntervals) { points.add(iv.start); points.add(iv.end); }
  const cuts = [...points].filter((p) => p >= win.start && p <= win.end).sort((a, b) => a - b);

  const rawSegments = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const start = cuts[i];
    const end = cuts[i + 1];
    if (end <= start) continue;
    let state;
    let flags = [];
    if (setHasInterval(faultSet, start, end)) {
      state = STATE.FAULT;
      if (setHasInterval(occupancy, start, end)) flags.push('conflict_charging');
    } else if (setHasInterval(offlineSet, start, end)) {
      state = STATE.OFFLINE;
      if (setHasInterval(occupancy, start, end)) flags.push('conflict_charging');
    } else if (setHasInterval(occupancy, start, end)) {
      state = STATE.OCCUPIED;
    } else if (setHasInterval(uncertainSet, start, end)) {
      state = STATE.UNCONFIRMED;
    } else if (setHasInterval(coverage, start, end)) {
      state = STATE.AVAILABLE;
    } else {
      state = STATE.UNCONFIRMED;
      flags.push('no_status_coverage');
    }
    rawSegments.push({ start, end, state, flags });
  }

  // Evidence + reasons; merge adjacent same-state segments
  // ---------------------------------------------------------------------
  const segmentEvidence = (seg) => {
    const evidence = { statuses: [], orders: [], repairs: [] };
    const inRange = (iv) => iv.start <= seg.start && iv.end >= seg.end;
    if (seg.state === STATE.AVAILABLE) {
      for (const iv of statusIntervals) if (iv.state === STATE.AVAILABLE && inRange(iv)) evidence.statuses.push(iv.externalId);
    } else if (seg.state === STATE.OCCUPIED) {
      for (const s of statusIntervals) if (s.state === STATE.OCCUPIED && inRange(s)) evidence.statuses.push(s.externalId);
      for (const o of orderIntervals) if (o.start <= seg.start && o.end >= seg.end) evidence.orders.push(o.order.externalId);
    } else if (seg.state === STATE.FAULT) {
      for (const s of statusIntervals) if (s.state === STATE.FAULT && inRange(s)) evidence.statuses.push(s.externalId);
      for (const r of repairWindows) if (r.start <= seg.start && r.end >= seg.end) evidence.repairs.push(r.repair.externalId);
    } else if (seg.state === STATE.OFFLINE) {
      for (const s of statusIntervals) if (s.state === STATE.OFFLINE && inRange(s)) evidence.statuses.push(s.externalId);
    } else {
      for (const o of orderIntervals) if (o.start <= seg.start && o.end >= seg.end) evidence.orders.push(o.order.externalId);
      if (evidence.orders.length === 0) {
        for (const raw of orders) {
          if (raw.endTime == null && raw.startTime <= seg.start) evidence.orders.push(raw.externalId);
        }
      }
    }
    evidence.statuses = [...new Set(evidence.statuses)].sort();
    evidence.orders = [...new Set(evidence.orders)].sort();
    evidence.repairs = [...new Set(evidence.repairs)].sort();
    return evidence;
  };

  const segments = [];
  for (const seg of rawSegments) {
    const evidence = segmentEvidence(seg);
    const reasonKey = seg.state === STATE.UNCONFIRMED
      ? unconfirmedReasonFor(seg, uncertainSet, unconfirmedReasons, coverage, win)
      : null;
    const inferred = seg.state === STATE.OCCUPIED && orderIntervals.some((o) =>
      o.inferredEnd && o.start <= seg.start && o.end >= seg.end);
    const last = segments[segments.length - 1];
    const sameKey = last && last.state === seg.state && !last.reason && !reasonKey &&
      last.inferredOrderEnd === inferred &&
      last.flags.join(',') === seg.flags.join(',');
    if (sameKey) {
      last.end = seg.end;
      for (const kind of ['statuses', 'orders', 'repairs']) {
        last.evidence[kind] = [...new Set([...last.evidence[kind], ...evidence[kind]])].sort();
      }
    } else {
      segments.push({
        start: seg.start,
        end: seg.end,
        state: seg.state,
        flags: [...seg.flags],
        reason: reasonKey || null,
        inferredOrderEnd: inferred,
        evidence,
      });
    }
  }

  // Final reasons (after conflicts exist, so conflict ids are resolvable).
  for (const seg of segments) {
    if (!seg.reason) seg.reason = describeSegment(seg, repairWindows, statusIntervals);
  }

  // ---------------------------------------------------------------------
  // Conflicts: unavailability overlapping charging
  // ---------------------------------------------------------------------
  const chargingSet = occupancy;
  const conflictKeys = new Set();
  const addOverlapConflicts = (unavailable, repairRecord, type, detail) => {
    // repair × order pairs first
    for (const o of orderIntervals) {
      const start = Math.max(unavailable.start, o.start);
      const end = Math.min(unavailable.end, o.end);
      if (end <= start) continue;
      const key = `${type}|${start}|${end}|${o.order.externalId}|${repairRecord ? repairRecord.externalId : ''}`;
      if (conflictKeys.has(key)) continue;
      conflictKeys.add(key);
      conflicts.push({
        id: conflictId(type, gun.id, start, end, [o.order.externalId, repairRecord ? repairRecord.externalId : 'status']),
        type,
        severity: type === 'maintenance_overlap_charging' ? 'warning' : 'info',
        gunId: gun.id,
        gunCode: gun.code,
        start,
        end,
        ms: end - start,
        title: type === 'maintenance_overlap_charging' ? '维修窗口与充电重叠' : detail,
        detail: repairRecord
          ? `${repairRecord.externalId}（${repairRecord.kind || '维修'}）与订单 ${o.order.externalId} 重叠。该时段按不可用计一次，不计入有效充电时长。`
          : `${detail}，与订单 ${o.order.externalId} 重叠。该时段按不可用计一次。`,
        orderIds: [o.order.externalId],
        repairIds: repairRecord ? [repairRecord.externalId] : [],
        statusIds: [],
      });
    }
    // status-only charging not covered by any order
    const residual = subtractIntervals(intersectIntervals([unavailable], chargingSet), orderSet);
    for (const piece of residual) {
      const statusIds = statusIntervals.filter((s) =>
        s.state === STATE.OCCUPIED && s.start < piece.end && s.end > piece.start).map((s) => s.externalId);
      const key = `${type}|${piece.start}|${piece.end}|status|${repairRecord ? repairRecord.externalId : ''}`;
      if (conflictKeys.has(key)) continue;
      conflictKeys.add(key);
      conflicts.push({
        id: conflictId(type, gun.id, piece.start, piece.end, [repairRecord ? repairRecord.externalId : 'status']),
        type,
        severity: 'info',
        gunId: gun.id,
        gunCode: gun.code,
        start: piece.start,
        end: piece.end,
        ms: piece.end - piece.start,
        title: type === 'maintenance_overlap_charging' ? '维修窗口与充电状态重叠' : '不可用状态与充电状态重叠',
        detail: `${repairRecord ? repairRecord.externalId + '（维修）' : detail}与状态消息报告的占用重叠。`,
        orderIds: [],
        repairIds: repairRecord ? [repairRecord.externalId] : [],
        statusIds: [...new Set(statusIds)].sort(),
      });
    }
  };

  for (const repairWindow of repairWindows) {
    addOverlapConflicts(repairWindow, repairWindow.repair, 'maintenance_overlap_charging', '维修窗口与充电重叠');
  }
  const faultWithoutRepair = subtractIntervals(statusFault, repairSet);
  for (const piece of faultWithoutRepair) {
    addOverlapConflicts(piece, null, 'fault_overlap_charging', '故障状态与充电重叠');
  }
  for (const piece of statusOffline) {
    addOverlapConflicts(piece, null, 'offline_overlap_charging', '离线状态与充电重叠');
  }

  // Conflicts exist now: attach ids to the segments they touch.
  for (const seg of segments) {
    if (seg.flags.includes('conflict_charging')) {
      seg.conflictIds = conflicts
        .filter((c) => c.gunId === gun.id && c.start < seg.end && c.end > seg.start)
        .map((c) => c.id);
    }
  }

  // ---------------------------------------------------------------------
  // Unconfirmed intervals (explicit, single list)
  // ---------------------------------------------------------------------
  const unconfirmed = buildUnconfirmedList(segments, uncertainSet, unconfirmedReasons, coverage, win);

  // ---------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------
  const totals = {
    naturalMs: win.end - win.start,
    availableMs: 0, occupiedMs: 0, faultMs: 0, offlineMs: 0, unconfirmedMs: 0,
    conflictMs: measure(intersectIntervals(occupancy, unionIntervals(faultSet, offlineSet))),
  };
  for (const seg of segments) {
    const ms = seg.end - seg.start;
    if (seg.state === STATE.AVAILABLE) totals.availableMs += ms;
    else if (seg.state === STATE.OCCUPIED) totals.occupiedMs += ms;
    else if (seg.state === STATE.FAULT) totals.faultMs += ms;
    else if (seg.state === STATE.OFFLINE) totals.offlineMs += ms;
    else totals.unconfirmedMs += ms;
  }
  totals.serviceableMs = totals.naturalMs - totals.faultMs - totals.offlineMs - totals.unconfirmedMs;
  const metrics = finalizeMetrics(totals, win);

  // ---------------------------------------------------------------------
  // Day breakdown + unconfirmed interval list
  // ---------------------------------------------------------------------
  const dayMap = new Map();
  const dayBounds = (date, sampleMs) => {
    const start = Math.max(win.start, startOfLocalDay(sampleMs, tz));
    const end = Math.min(win.end, addLocalDays(start, 1, tz));
    return { date, start, end };
  };
  const addDay = (day, state, ms) => {
    if (!dayMap.has(day.date)) {
      const bounds = dayBounds(day.date, day.start);
      dayMap.set(day.date, {
        date: day.date, start: bounds.start, end: bounds.end,
        naturalMs: 0, availableMs: 0, occupiedMs: 0, faultMs: 0, offlineMs: 0,
        unconfirmedMs: 0, serviceableMs: 0, conflictMs: 0,
      });
    }
    const acc = dayMap.get(day.date);
    if (state === STATE.AVAILABLE) acc.availableMs += ms;
    else if (state === STATE.OCCUPIED) acc.occupiedMs += ms;
    else if (state === STATE.FAULT) acc.faultMs += ms;
    else if (state === STATE.OFFLINE) acc.offlineMs += ms;
    else acc.unconfirmedMs += ms;
  };
  for (const seg of segments) {
    const pieces = splitByLocalDay([{ start: seg.start, end: seg.end }], tz, win);
    for (const piece of pieces) addDay(piece, seg.state, piece.ms);
  }
  for (const day of dayMap.values()) {
    day.naturalMs = day.end - day.start;
    day.serviceableMs = day.naturalMs - day.faultMs - day.offlineMs - day.unconfirmedMs;
    const conflictPieces = splitByLocalDay(intersectIntervals(occupancy, unionIntervals(faultSet, offlineSet)), tz, win)
      .filter((p) => p.date === day.date);
    day.conflictMs = measure(conflictPieces);
    const finalized = finalizeMetrics(day, win);
    day.utilizationNatural = finalized.utilizationNatural;
    day.utilizationServiceable = finalized.utilizationServiceable;
    day.availabilityRate = finalized.availabilityRate;
  }
  const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  const statusStats = {
    ingested: work.statuses.length,
    effective: effective.length,
    duplicates: globalDuplicates.filter((d) => d.gunId === gun.id).length,
    late: globalLate.filter((l) => l.gunId === gun.id).length,
    coverageStart: coverage.length ? coverage[0].start : null,
  };

  const historicalNames = buildHistoricalNames(gun);

  // Traceability payload: every analyzed record with its resolution and fate,
  // so the UI can trace any segment back to the raw messages behind it.
  const statusRecords = sortedRaw.map((status) => {
    const sameTime = globalStatusConflicts.find((c) => c.gunId === gun.id && c.eventTime === status.eventTime);
    let fate = status.fate || 'effective';
    if (!status.fate && sameTime && sameTime.winnerExternalId !== status.externalId) {
      fate = 'superseded_same_time';
    }
    const late = globalLate.find((l) => l.gunId === gun.id && l.externalId === status.externalId);
    return {
      externalId: status.externalId,
      gunRef: status.gunRef,
      matchedViaAlias: status.resolution.usedAlias,
      outsideAliasValidity: status.resolution.outsideValidity,
      state: status.state,
      eventTime: status.eventTime,
      receivedAt: status.receivedAt,
      source: status.source,
      payload: status.payload,
      fate,
      duplicateOf: status.duplicateOf || null,
      duplicateReason: status.duplicateReason || null,
      late: late ? { delayMs: late.delayMs, outOfOrder: late.outOfOrder } : null,
    };
  });
  const orderRecords = orders.map((order) => {
    const inferred = globalInferredEnds.find((i) => i.gunId === gun.id && i.externalId === order.externalId);
    return {
      externalId: order.externalId,
      gunRef: order.gunRef,
      matchedViaAlias: order.resolution.usedAlias,
      startTime: order.startTime,
      endTime: order.endTime,
      effectiveEnd: inferred ? inferred.inferredEnd : order.endTime,
      inferredEnd: inferred ? { boundKind: inferred.boundKind, boundRef: inferred.boundRef } : null,
      energyKwh: order.energyKwh,
      status: order.status,
      source: order.source,
    };
  });
  const repairRecords = work.repairs.map((repair) => ({
    externalId: repair.externalId,
    gunRef: repair.gunRef,
    matchedViaAlias: repair.resolution.usedAlias,
    startTime: repair.startTime,
    endTime: repair.endTime,
    open: !!repair.open,
    kind: repair.kind,
    workOrder: repair.workOrder,
    status: repair.status,
    note: repair.note,
    source: repair.source,
  }));

  return {
    gunId: gun.id,
    code: gun.code,
    displayName: gun.displayName,
    connectorType: gun.connectorType || null,
    powerKw: gun.powerKw ?? null,
    historicalNames,
    statusStats,
    metrics,
    days,
    segments,
    unconfirmed,
    repairsOpen: repairOpenCount,
    records: { statuses: statusRecords, orders: orderRecords, repairs: repairRecords },
  };
}

function finalizeMetrics(totals, win) {
  const naturalMs = totals.naturalMs;
  const serviceableMs = totals.serviceableMs;
  return {
    naturalMs,
    availableMs: totals.availableMs,
    occupiedMs: totals.occupiedMs,
    faultMs: totals.faultMs,
    offlineMs: totals.offlineMs,
    unconfirmedMs: totals.unconfirmedMs,
    serviceableMs,
    conflictMs: totals.conflictMs || 0,
    utilizationNatural: naturalMs > 0 ? totals.occupiedMs / naturalMs : null,
    utilizationServiceable: serviceableMs > 0 ? totals.occupiedMs / serviceableMs : null,
    availabilityRate: serviceableMs > 0 ? totals.availableMs / serviceableMs : null,
  };
}

function unconfirmedReasonFor(seg, uncertainSet, reasons, coverage, win) {
  if (setHasInterval(uncertainSet, seg.start, seg.end)) {
    for (const [key, reason] of reasons) {
      const [s, e] = key.split('|').map(Number);
      if (s <= seg.start && e >= seg.end) return reason;
    }
    return '订单结束时间缺失，无法确认该区间状态';
  }
  if (coverage.length === 0) return '窗口内没有可用的枪口状态消息';
  if (!setHasInterval(coverage, seg.start, seg.end)) return '状态消息未覆盖该区间';
  return '无法确认';
}

function describeSegment(seg, repairWindows, statusIntervals) {
  switch (seg.state) {
    case STATE.AVAILABLE:
      return '状态消息：可服务';
    case STATE.OCCUPIED: {
      const hasOrders = seg.evidence.orders.length > 0;
      const hasStatus = seg.evidence.statuses.length > 0;
      if (hasOrders && hasStatus) return '充电订单占用（状态消息同时报告占用）';
      if (hasOrders) return '充电订单占用';
      return '状态消息：占用';
    }
    case STATE.FAULT: {
      const hasRepair = seg.evidence.repairs.length > 0;
      const hasStatus = seg.evidence.statuses.length > 0;
      if (hasRepair && hasStatus) return '维修工单 + 状态故障';
      if (hasRepair) return '维修工单';
      return '状态消息：故障';
    }
    case STATE.OFFLINE:
      return '状态消息：离线';
    default:
      return null;
  }
}

function buildUnconfirmedList(segments, uncertainSet, reasons, coverage, win) {
  const pieces = segments.filter((s) => s.state === STATE.UNCONFIRMED);
  const merged = [];
  for (const seg of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.end === seg.start) {
      last.end = seg.end;
      last.reasons.push(seg.reason);
      last.evidence.orders = [...new Set([...last.evidence.orders, ...seg.evidence.orders])];
      last.evidence.statuses = [...new Set([...last.evidence.statuses, ...seg.evidence.statuses])];
      last.evidence.repairs = [...new Set([...last.evidence.repairs, ...seg.evidence.repairs])];
      last.flags = [...new Set([...last.flags, ...seg.flags])];
    } else {
      merged.push({
        start: seg.start,
        end: seg.end,
        ms: seg.end - seg.start,
        reasons: [seg.reason],
        flags: [...seg.flags],
        evidence: {
          statuses: [...seg.evidence.statuses],
          orders: [...seg.evidence.orders],
          repairs: [...seg.evidence.repairs],
        },
      });
    }
  }
  return merged.map((u) => ({
    start: u.start,
    end: u.end,
    ms: u.end - u.start,
    reason: [...new Set(u.reasons.filter(Boolean))].join('；') || '无法确认',
    flags: u.flags,
    evidence: u.evidence,
  }));
}

function buildHistoricalNames(gun) {
  const names = [];
  const aliases = (gun.aliases || []).slice().sort((a, b) => (a.validFrom ?? 0) - (b.validFrom ?? 0));
  for (const alias of aliases) {
    names.push({
      name: alias.alias,
      from: alias.validFrom ?? null,
      to: alias.validTo ?? null,
      note: alias.note || null,
      current: false,
    });
  }
  names.push({ name: gun.displayName, from: null, to: null, note: null, current: true });
  return uniqueBy(names, (n) => n.name);
}

function conflictId(type, gunId, start, end, refs) {
  const h = crypto.createHash('sha1')
    .update(`${type}|${gunId}|${start}|${end}|${refs.join(',')}`)
    .digest('hex').slice(0, 10);
  return `cf_${h}`;
}

function sortConflicts(conflicts) {
  return uniqueBy(conflicts, (c) => c.id).sort((a, b) =>
    a.start - b.start || a.gunCode.localeCompare(b.gunCode) || a.type.localeCompare(b.type));
}

function hashInputs(input, win) {
  const canonical = {
    window: [win.start, win.end],
    site: { id: input.site.id, timezone: input.site.timezone },
    guns: (input.guns || []).map((g) => ({
      id: g.id, code: g.code, displayName: g.displayName,
      connectorType: g.connectorType || null, powerKw: g.powerKw ?? null,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    aliases: (input.aliases || []).map((a) => ({
      gunId: a.gunId, alias: a.alias, validFrom: a.validFrom ?? null, validTo: a.validTo ?? null,
    })).sort((a, b) => `${a.gunId}|${a.alias}`.localeCompare(`${b.gunId}|${b.alias}`)),
    statuses: (input.statuses || []).map((s) => ({
      externalId: s.externalId, gunRef: s.gunRef, state: s.state,
      eventTime: s.eventTime, receivedAt: s.receivedAt ?? null, source: s.source || null,
    })).sort((a, b) => String(a.externalId).localeCompare(String(b.externalId))),
    orders: (input.orders || []).map((o) => ({
      externalId: o.externalId, gunRef: o.gunRef, startTime: o.startTime,
      endTime: o.endTime ?? null, energyKwh: o.energyKwh ?? null,
    })).sort((a, b) => String(a.externalId).localeCompare(String(b.externalId))),
    repairs: (input.repairs || []).map((r) => ({
      externalId: r.externalId, gunRef: r.gunRef, startTime: r.startTime,
      endTime: r.endTime ?? null, kind: r.kind || null, workOrder: r.workOrder || null,
    })).sort((a, b) => String(a.externalId).localeCompare(String(b.externalId))),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

module.exports = {
  ENGINE_VERSION, STATE, VALID_STATES, normalizeState,
  analyze, hashInputs, finalizeMetrics,
};
