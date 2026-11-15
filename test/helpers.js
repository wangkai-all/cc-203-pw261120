'use strict';

/**
 * Small fixture builder for engine tests. All example data is fictitious.
 * Times are ISO strings with an explicit offset so the engine never guesses.
 */

const TZ = 'Asia/Shanghai';

let seq = 0;
function uid(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** YYYY-MM-DD HH:mm in the fixture timezone (+08:00). */
function at(text) {
  return `${text.replace(' ', 'T')}:00+08:00`;
}

function makeInput(overrides = {}) {
  return {
    site: { id: 'site-test', name: '测试站（虚构）', timezone: TZ, defaultAsOf: at('2026-11-02 00:00') },
    guns: [
      { id: 'g1', code: 'G1', displayName: 'G1', connectorType: 'CCS2', powerKw: 120 },
      { id: 'g2', code: 'G2', displayName: 'G2', connectorType: 'GB/T', powerKw: 7 },
    ],
    aliases: [],
    statuses: [],
    orders: [],
    repairs: [],
    ...overrides,
  };
}

function status(gunRef, state, eventTime, receivedAt = eventTime, extra = {}) {
  return {
    externalId: extra.externalId || uid('ST'),
    gunRef,
    state,
    eventTime,
    receivedAt,
    source: extra.source || 'charger-firmware',
    payload: extra.payload || null,
    ...extra,
  };
}

function availableStream(gunRef, startText, endText, stepMinutes = 60) {
  // Status every hour, all available, from start (inclusive) to end (exclusive).
  const list = [];
  const start = Date.parse(at(startText));
  const end = Date.parse(at(endText));
  for (let t = start; t < end; t += stepMinutes * 60000) {
    list.push(status(gunRef, 'available', new Date(t).toISOString(), new Date(t + 20000).toISOString()));
  }
  return list;
}

/** A window of whole local days. */
function daysWindow(startDate, days = 1) {
  const { zonedTime, addLocalDays } = require('../src/time');
  const [y, m, d] = startDate.split('-').map(Number);
  const start = zonedTime({ year: y, month: m, day: d }, TZ);
  return { start, end: addLocalDays(start, days, TZ) };
}

const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;

module.exports = {
  TZ, at, makeInput, status, availableStream, daysWindow, uid, HOUR, MINUTE,
};
