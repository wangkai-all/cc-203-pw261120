'use strict';

/**
 * Generates the fictitious sample datasets used by the demo.
 * Deterministic: no randomness, no current-time dependence.
 *
 * Run: node scripts/generate-samples.js
 */

const fs = require('node:fs');
const path = require('node:path');

const D = (day, hhmm) => `2026-11-${String(day).padStart(2, '0')}T${hhmm}:00+08:00`;
const addSec = (iso, sec) => new Date(Date.parse(iso) + sec * 1000).toISOString();
const plusHours = (iso, h) => new Date(Date.parse(iso) + h * 3600 * 1000).toISOString();
const plusMinutes = (iso, m) => new Date(Date.parse(iso) + m * 60 * 1000).toISOString();
const sameMinute = (a, b) => Date.parse(a) === Date.parse(b);

const SOURCE_LABEL = {
  available: '可服务', occupied: '充电中', fault: '故障', offline: '离线',
};

function buildSite({ site, guns, plans, aliases = [], orders = [], repairs = [], extraStatuses = [], defaultAsOf }) {
  const statuses = [];
  const seqByGun = new Map();
  const aliasRules = aliases.map((a) => ({
    ...a,
    from: a.validFrom ? Date.parse(a.validFrom) : -Infinity,
    to: a.validTo ? Date.parse(a.validTo) : Infinity,
  }));

  function gunRefFor(gun, eventIso) {
    const at = Date.parse(eventIso);
    for (const rule of aliasRules) {
      if (rule.gunId === gun.id && at >= rule.from && at < rule.to) return rule.alias;
    }
    return gun.code;
  }

  function addStatus(gun, state, eventIso, opts = {}) {
    const seq = (seqByGun.get(gun.id) || 0) + 1;
    seqByGun.set(gun.id, seq);
    const externalId = opts.externalId || `ST-${gun.code}-${String(seq).padStart(3, '0')}`;
    const delay = opts.receivedAt ? 0 : 15 + ((seq * 7) % 60);
    const receivedAt = opts.receivedAt || addSec(eventIso, delay);
    const source = opts.source || (seq % 5 === 0 ? 'site-journal' : 'charger-firmware');
    statuses.push({
      externalId,
      gunRef: opts.gunRef || gunRefFor(gun, eventIso),
      state,
      eventTime: eventIso,
      receivedAt,
      source,
      payload: {
        seq,
        reported_state: SOURCE_LABEL[state] || state,
        firmware: 'AC-DC 3.8.2',
        rssi: -58 - (seq % 9),
        ...(opts.payload || {}),
      },
    });
    return externalId;
  }

  for (const gun of guns) {
    const segs = plans[gun.code] || [];
    for (const seg of segs) {
      const from = D(seg.from[0], seg.from[1]);
      const to = seg.to ? D(seg.to[0], seg.to[1]) : null;
      if (to && Date.parse(to) <= Date.parse(from)) throw new Error(`bad segment ${gun.code} ${from} ${to}`);
      let cursor = from;
      let guard = 0;
      while ((!to || Date.parse(cursor) < Date.parse(to)) && guard < 200) {
        addStatus(gun, seg.state, new Date(cursor).toISOString());
        cursor = plusHours(cursor, 4);
        guard += 1;
      }
    }
  }

  for (const extra of extraStatuses) {
    const gun = guns.find((g) => g.code === extra.gunCode);
    if (!gun) throw new Error(`unknown extra gun ${extra.gunCode}`);
    const eventIso = extra.eventTime;
    const seq = (seqByGun.get(gun.id) || 0) + 1;
    seqByGun.set(gun.id, seq);
    statuses.push({
      externalId: extra.externalId,
      gunRef: extra.gunRef || gunRefFor(gun, eventIso),
      state: extra.state,
      eventTime: eventIso,
      receivedAt: extra.receivedAt,
      source: extra.source || 'third-party-bridge',
      payload: { seq, reported_state: SOURCE_LABEL[extra.state] || extra.state, ...(extra.payload || {}) },
    });
  }

  statuses.sort((a, b) => Date.parse(a.eventTime) - Date.parse(b.eventTime) ||
    Date.parse(a.receivedAt) - Date.parse(b.receivedAt) ||
    a.externalId.localeCompare(b.externalId));

  return {
    site: { ...site, defaultAsOf },
    guns,
    aliases,
    statuses,
    orders,
    repairs,
  };
}

// ---------------------------------------------------------------------------
// Site 1: 星桥路充电站
// ---------------------------------------------------------------------------
const xqGuns = [
  { id: 'gun-xq-a1', code: 'A1', displayName: 'A1', connectorType: 'CCS2', powerKw: 120, position: '东区 1 号位' },
  { id: 'gun-xq-a2', code: 'A2', displayName: 'A2·东侧', connectorType: 'CCS2', powerKw: 120, position: '东区 2 号位' },
  { id: 'gun-xq-a3', code: 'A3', displayName: 'A3', connectorType: 'GB/T 直流', powerKw: 60, position: '西区 1 号位' },
  { id: 'gun-xq-a4', code: 'A4', displayName: 'A4', connectorType: 'GB/T 交流', powerKw: 7, position: '西区 2 号位' },
];

const xqPlans = {
  A1: [
    { from: [13, '00:00'], to: [13, '08:10'], state: 'available' },
    { from: [13, '08:10'], to: [13, '09:35'], state: 'occupied' },
    { from: [13, '09:35'], to: [13, '23:20'], state: 'available' },
    { from: [13, '23:20'], to: [14, '01:10'], state: 'occupied' },
    { from: [14, '01:10'], to: [14, '12:00'], state: 'available' },
    { from: [14, '12:00'], to: [14, '13:45'], state: 'occupied' },
    { from: [14, '13:45'], to: [15, '09:00'], state: 'available' },
    { from: [15, '09:00'], to: [15, '10:20'], state: 'occupied' },
    { from: [15, '10:20'], to: [15, '20:00'], state: 'available' },
    { from: [15, '20:00'], to: [15, '22:45'], state: 'occupied' },
    { from: [15, '22:45'], to: [16, '00:00'], state: 'available' },
  ],
  A2: [
    { from: [13, '00:00'], to: [13, '07:30'], state: 'available' },
    { from: [13, '07:30'], to: [13, '08:55'], state: 'occupied' },
    { from: [13, '08:55'], to: [14, '09:00'], state: 'available' },
    { from: [14, '09:00'], to: [14, '15:00'], state: 'available' },
    { from: [14, '15:00'], to: [14, '17:35'], state: 'occupied' },
    { from: [14, '17:35'], to: [14, '22:40'], state: 'available' },
    { from: [14, '22:40'], to: [15, '00:30'], state: 'offline' },
    { from: [15, '00:30'], to: [15, '10:00'], state: 'available' },
    { from: [15, '10:00'], to: [15, '11:15'], state: 'occupied' },
    { from: [15, '11:15'], to: [16, '00:00'], state: 'available' },
  ],
  A3: [
    { from: [13, '00:00'], to: [13, '10:00'], state: 'available' },
    { from: [13, '10:00'], to: [13, '11:35'], state: 'occupied' },
    { from: [13, '11:35'], to: [14, '13:10'], state: 'available' },
    { from: [14, '13:10'], to: [14, '15:05'], state: 'fault' },
    { from: [14, '15:05'], to: [14, '20:00'], state: 'available' },
    { from: [14, '20:00'], to: [14, '21:05'], state: 'occupied' },
    { from: [14, '21:05'], to: [14, '23:20'], state: 'available' },
    { from: [14, '23:20'], to: [15, '00:55'], state: 'fault' },
    { from: [15, '00:55'], to: [15, '10:00'], state: 'available' },
    { from: [15, '10:00'], to: [15, '11:05'], state: 'occupied' },
    { from: [15, '11:05'], to: [16, '00:00'], state: 'available' },
  ],
  A4: [
    { from: [13, '00:00'], to: [13, '09:00'], state: 'available' },
    { from: [13, '09:00'], to: [13, '10:05'], state: 'occupied' },
    { from: [13, '10:05'], to: [13, '12:00'], state: 'available' },
    // intentional telemetry gap 13 12:00 → 13 22:00
    { from: [13, '22:00'], to: [14, '21:12'], state: 'available' },
    { from: [14, '21:12'], to: [14, '23:00'], state: 'occupied' },
    { from: [14, '23:00'], to: [15, '08:00'], state: 'available' },
    { from: [15, '08:00'], to: [15, '11:00'], state: 'offline' },
    { from: [15, '11:00'], to: [15, '13:50'], state: 'available' },
    { from: [15, '13:50'], to: null, state: 'fault' },
  ],
};

const xqAliases = [
  {
    gunId: 'gun-xq-a2',
    alias: 'A2-旧桩',
    validFrom: D(13, '00:00'),
    validTo: D(14, '09:00'),
    kind: 'legacy',
    note: '2026-11-14 09:00 站端更名：A2-旧桩 → A2·东侧',
  },
];

const xqOrders = [
  { externalId: 'ORD-XQ-A1-01', gunRef: 'A1', startTime: D(13, '08:10'), endTime: D(13, '09:30'), energyKwh: 41.2, status: 'finished', source: 'ocpp-csms' },
  { externalId: 'ORD-XQ-A1-02', gunRef: 'A1', startTime: D(13, '23:20'), endTime: D(14, '01:05'), energyKwh: 63.8, status: 'finished', source: 'ocpp-csms' },
  { externalId: 'ORD-XQ-A1-03', gunRef: 'A1', startTime: D(14, '12:00'), endTime: D(14, '13:40'), energyKwh: 55.0, status: 'finished', source: 'ocpp-csms' },
  { externalId: 'ORD-XQ-A1-04', gunRef: 'A1', startTime: D(15, '09:00'), endTime: D(15, '10:15'), energyKwh: 44.6, status: 'finished', source: 'ocpp-csms' },
  { externalId: 'ORD-XQ-A1-05', gunRef: 'A1', startTime: D(15, '20:00'), endTime: D(15, '22:40'), energyKwh: 71.9, status: 'finished', source: 'ocpp-csms' },

  { externalId: 'ORD-XQ-A2-01', gunRef: 'A2-旧桩', startTime: D(13, '07:30'), endTime: D(13, '08:50'), energyKwh: 38.4, status: 'finished', source: 'ocpp-csms' },
  { externalId: 'ORD-XQ-A2-02', gunRef: 'A2·东侧', startTime: D(14, '15:00'), endTime: D(14, '17:30'), energyKwh: 66.1, status: 'finished', source: 'ocpp-csms' },
  { externalId: 'ORD-XQ-A2-03', gunRef: 'A2', startTime: D(15, '10:00'), endTime: D(15, '11:10'), energyKwh: 31.0, status: 'finished', source: 'ocpp-csms' },

  { externalId: 'ORD-XQ-A3-01', gunRef: 'A3', startTime: D(13, '10:00'), endTime: D(13, '11:30'), energyKwh: 22.5, status: 'finished', source: 'ocpp-csms' },
  { externalId: 'ORD-XQ-A3-02', gunRef: 'A3', startTime: D(14, '13:40'), endTime: D(14, '14:20'), energyKwh: 9.8, status: 'finished', source: 'ocpp-csms' },
  { externalId: 'ORD-XQ-A3-03', gunRef: 'A3', startTime: D(14, '20:00'), endTime: D(14, '21:00'), energyKwh: 14.2, status: 'finished', source: 'ocpp-csms' },
  { externalId: 'ORD-XQ-A3-04', gunRef: 'A3', startTime: D(14, '23:40'), endTime: D(15, '00:10'), energyKwh: 7.6, status: 'finished', source: 'ocpp-csms' },
  { externalId: 'ORD-XQ-A3-05', gunRef: 'A3', startTime: D(15, '10:00'), endTime: D(15, '11:00'), energyKwh: 13.1, status: 'finished', source: 'ocpp-csms' },

  { externalId: 'ORD-XQ-A4-01', gunRef: 'A4', startTime: D(13, '09:00'), endTime: D(13, '10:00'), energyKwh: 6.2, status: 'finished', source: 'ocpp-csms' },
  // 结束时间缺失；次日 23:00 的 available 状态可作为独立证据推断结束
  { externalId: 'ORD-XQ-A4-02', gunRef: 'A4', startTime: D(14, '21:10'), endTime: null, energyKwh: null, status: 'started', source: 'ocpp-csms' },
  { externalId: 'ORD-XQ-A4-03', gunRef: 'A4', startTime: D(15, '11:30'), endTime: D(15, '12:40'), energyKwh: 7.4, status: 'finished', source: 'ocpp-csms' },
];

const xqRepairs = [
  {
    externalId: 'REP-XQ-A3-01', gunRef: 'A3', startTime: D(14, '13:30'), endTime: D(14, '15:00'),
    kind: '更换充电枪线', workOrder: 'WO-2026-1114-03', status: 'closed',
    note: '枪线绝缘告警，停枪检修', source: 'maintenance-system',
  },
  {
    externalId: 'REP-XQ-A3-02', gunRef: 'A3', startTime: D(14, '23:30'), endTime: D(15, '00:50'),
    kind: '更换接触器', workOrder: 'WO-2026-1114-07', status: 'closed',
    note: '夜间窗口作业，跨日', source: 'maintenance-system',
  },
  {
    externalId: 'REP-XQ-A4-OPEN', gunRef: 'A4', startTime: D(15, '14:00'), endTime: null,
    kind: '交流模块返厂', workOrder: 'WO-2026-1115-11', status: 'open',
    note: '维修中，恢复时间未定（耗时按窗口结束截断）', source: 'maintenance-system',
  },
];

const xqExtras = [
  // 更名后仍使用旧名的消息：能解析到 A2，但标注为过期别名
  {
    gunCode: 'A2', externalId: 'ST-A2-STALE1', state: 'available',
    gunRef: 'A2-旧桩', eventTime: D(14, '10:30'), receivedAt: addSec(D(14, '10:30'), 38),
    source: 'site-journal', payload: { note: '旧名缓存未刷新' },
  },
  // 更名前发生、更名后才到达的迟到消息：按事件时刻的别名有效期解析到 A2
  {
    gunCode: 'A2', externalId: 'ST-A2-LATE1', state: 'available',
    gunRef: 'A2-旧桩', eventTime: D(14, '08:15'), receivedAt: addSec(D(14, '12:00'), 30),
    source: 'third-party-bridge', payload: { note: '网关补传' },
  },
];

const xq = buildSite({
  site: {
    id: 'site-xingqiao',
    name: '星桥路充电站',
    timezone: 'Asia/Shanghai',
    address: '虚构地址：星河路 88 号（样例数据）',
    operator: '星桥能源（虚构）',
  },
  guns: xqGuns,
  plans: xqPlans,
  aliases: xqAliases,
  orders: xqOrders,
  repairs: xqRepairs,
  extraStatuses: xqExtras,
  defaultAsOf: D(16, '00:00'),
});

// ---------------------------------------------------------------------------
// Site 2: 望京北充电站
// ---------------------------------------------------------------------------
const wjGuns = [
  { id: 'gun-wj-b1', code: 'B1', displayName: 'B1', connectorType: 'CCS2', powerKw: 180, position: '北区 1 号位' },
  { id: 'gun-wj-b2', code: 'B2', displayName: 'B2', connectorType: 'CCS2', powerKw: 180, position: '北区 2 号位' },
  { id: 'gun-wj-b3', code: 'B3', displayName: 'B3', connectorType: 'GB/T 直流', powerKw: 90, position: '北区 3 号位' },
];

const wjPlans = {
  B1: [
    { from: [13, '00:00'], to: [13, '10:00'], state: 'available' },
    { from: [13, '10:00'], to: [13, '11:05'], state: 'occupied' },
    { from: [13, '11:05'], to: [14, '16:00'], state: 'available' },
    { from: [14, '16:00'], to: [14, '17:25'], state: 'occupied' },
    { from: [14, '17:25'], to: [15, '12:00'], state: 'available' },
    // 15 12:00 之后状态流中断：18:00 起不再有可确认的状态
  ],
  B2: [
    { from: [13, '00:00'], to: [13, '10:00'], state: 'available' },
    { from: [13, '10:00'], to: [13, '11:25'], state: 'occupied' },
    { from: [13, '11:25'], to: [14, '22:30'], state: 'available' },
    { from: [14, '22:30'], to: [15, '02:15'], state: 'occupied' },
    { from: [15, '02:15'], to: [15, '12:00'], state: 'available' },
    { from: [15, '12:00'], to: [15, '13:05'], state: 'occupied' },
    { from: [15, '13:05'], to: [16, '00:00'], state: 'available' },
  ],
  B3: [
    { from: [15, '08:00'], to: [15, '12:00'], state: 'available' },
    { from: [15, '12:00'], to: [15, '13:30'], state: 'occupied' },
    { from: [15, '13:30'], to: [16, '00:00'], state: 'available' },
  ],
};

const wjOrders = [
  { externalId: 'ORD-WJ-B1-01', gunRef: 'B1', startTime: D(13, '10:00'), endTime: D(13, '11:00'), energyKwh: 52.3, status: 'finished', source: 'ocpp-csms' },
  { externalId: 'ORD-WJ-B1-02', gunRef: 'B1', startTime: D(14, '16:00'), endTime: D(14, '17:20'), energyKwh: 48.7, status: 'finished', source: 'ocpp-csms' },
  // 结束时间缺失且之后没有任何独立证据：整段无法确认
  { externalId: 'ORD-WJ-B1-OPEN', gunRef: 'B1', startTime: D(15, '19:00'), endTime: null, energyKwh: null, status: 'started', source: 'ocpp-csms' },

  { externalId: 'ORD-WJ-B2-01', gunRef: 'B2', startTime: D(13, '10:00'), endTime: D(13, '11:20'), energyKwh: 61.4, status: 'finished', source: 'ocpp-csms' },
  { externalId: 'ORD-WJ-B2-02', gunRef: 'B2', startTime: D(14, '22:30'), endTime: D(15, '02:10'), energyKwh: 88.0, status: 'finished', source: 'ocpp-csms' },
  { externalId: 'ORD-WJ-B2-03', gunRef: 'B2', startTime: D(15, '12:00'), endTime: D(15, '13:00'), energyKwh: 31.5, status: 'finished', source: 'ocpp-csms' },
  { externalId: 'ORD-WJ-B2-BAD', gunRef: 'B2', startTime: D(15, '15:00'), endTime: D(15, '14:30'), energyKwh: 0, status: 'finished', source: 'ocpp-csms' },

  { externalId: 'ORD-WJ-B3-01', gunRef: 'B3', startTime: D(15, '12:00'), endTime: D(15, '13:25'), energyKwh: 24.9, status: 'finished', source: 'ocpp-csms' },
];

const wjRepairs = [
  {
    externalId: 'REP-WJ-B2-01', gunRef: 'B2', startTime: D(13, '10:30'), endTime: D(13, '10:50'),
    kind: '紧固直流端子', workOrder: 'WO-2026-1113-02', status: 'closed',
    note: '例行巡检发现端子松动，快速处理', source: 'maintenance-system',
  },
];

const wjExtras = [
  { gunCode: 'B3', externalId: 'ST-B3-LATE1', state: 'fault', eventTime: D(15, '11:20'), receivedAt: addSec(D(16, '10:00'), 12), source: 'charger-firmware', payload: { note: '补传：绝缘检测异常' } },
];

const wj = buildSite({
  site: {
    id: 'site-wangjing',
    name: '望京北充电站',
    timezone: 'Asia/Shanghai',
    address: '虚构地址：望京北路 12 号（样例数据）',
    operator: '北望充电（虚构）',
  },
  guns: wjGuns,
  plans: wjPlans,
  aliases: [],
  orders: wjOrders,
  repairs: wjRepairs,
  extraStatuses: wjExtras,
  defaultAsOf: D(16, '00:00'),
});

// Site 2 has no gun called A0: keep the unknown-ref status but don't resolve its gunCode.
wj.statuses = wj.statuses.filter((s) => s.externalId !== 'ST-UNKNOWN-X9');
wj.statuses.push({
  externalId: 'ST-UNKNOWN-X9',
  gunRef: 'X9',
  state: 'offline',
  eventTime: D(14, '09:00'),
  receivedAt: addSec(D(14, '09:00'), 20),
  source: 'third-party-bridge',
  payload: { note: '未登记的枪口编号' },
});
wj.statuses.sort((a, b) => Date.parse(a.eventTime) - Date.parse(b.eventTime) ||
  a.externalId.localeCompare(b.externalId));

// Duplicate / conflicting messages on B2 at 13 10:00.
const b2Base = wj.statuses.find((s) => s.gunRef === 'B2' && sameMinute(s.eventTime, D(13, '10:00')) && s.state === 'occupied');
if (!b2Base) throw new Error('B2 base status not found');
wj.statuses.push({
  ...b2Base,
  payload: { ...b2Base.payload, note: 'MQTT QoS1 重投（同 externalId）' },
  receivedAt: addSec(b2Base.receivedAt, 180),
});
wj.statuses.push({
  externalId: 'ST-B2-DUP-CONTENT',
  gunRef: 'B2',
  state: 'occupied',
  eventTime: b2Base.eventTime,
  receivedAt: addSec(b2Base.receivedAt, 260),
  source: 'third-party-bridge',
  payload: { note: '桥接复制（同内容，不同 ID）' },
});
wj.statuses.push({
  externalId: 'ST-B2-CONFLICT1',
  gunRef: 'B2',
  state: 'available',
  eventTime: b2Base.eventTime,
  receivedAt: addSec(b2Base.eventTime, 8),
  source: 'third-party-bridge',
  payload: { note: '桥接缓存滞后，同一时刻报告了不同状态' },
});
wj.statuses.sort((a, b) => Date.parse(a.eventTime) - Date.parse(b.eventTime) ||
  Date.parse(a.receivedAt) - Date.parse(b.receivedAt) ||
  a.externalId.localeCompare(b.externalId));

const outDir = path.join(__dirname, '..', 'data', 'samples');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, payload] of [['site-xingqiao', xq], ['site-wangjing', wj]]) {
  const file = path.join(outDir, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)} (${payload.statuses.length} statuses, ${payload.orders.length} orders, ${payload.repairs.length} repairs)`);
}

// ---------------------------------------------------------------------------
// Late-message inbox samples (delivered out of band, not yet ingested)
// ---------------------------------------------------------------------------
const inboxDir = path.join(outDir, 'inbox');
fs.mkdirSync(inboxDir, { recursive: true });

const xqInbox = [
  {
    id: 'late-xq-a2-offline',
    gunRef: 'A2·东侧',
    state: 'offline',
    eventTime: D(14, '19:20'),
    receivedAt: D(16, '08:05'),
    source: 'third-party-bridge',
    note: '网关补传：A2 在 11-14 19:20 曾短时离线，原分析中该段被判定为可服务',
    scenario: 'late_status_changes_availability',
    payload: { gateway: 'gw-3', retransmit: true, original_report: '离线' },
  },
  {
    id: 'late-xq-a4-fault',
    gunRef: 'A4',
    state: 'fault',
    eventTime: D(15, '12:50'),
    receivedAt: D(16, '08:10'),
    source: 'charger-firmware',
    note: '补传：A4 交流模块在 11-15 12:50 已上报故障，早于维修工单登记时间',
    scenario: 'late_status_extends_fault',
    payload: { gateway: 'gw-1', retransmit: true, original_report: '故障' },
  },
  {
    id: 'late-xq-a1-ghost',
    gunRef: 'A1',
    state: 'occupied',
    eventTime: D(15, '15:30'),
    receivedAt: D(16, '08:15'),
    source: 'third-party-bridge',
    note: '可疑补传：A1 当时没有订单，状态为占用的补传消息会新增占用时长',
    scenario: 'late_status_creates_occupancy',
    payload: { gateway: 'gw-2', retransmit: true, original_report: '充电中' },
  },
];

const wjInbox = [
  {
    id: 'late-wj-b1-offline',
    gunRef: 'B1',
    state: 'offline',
    eventTime: D(15, '12:30'),
    receivedAt: D(16, '09:20'),
    source: 'site-journal',
    note: '补传：B1 在 11-15 12:30 已离线，之前的状态推算把它当成了可服务',
    scenario: 'late_status_fixes_coverage',
    payload: { journal: 'j-2026-1115', retransmit: true },
  },
  {
    id: 'late-wj-b2-stale',
    gunRef: 'B2',
    state: 'available',
    eventTime: D(15, '12:20'),
    receivedAt: D(16, '09:30'),
    source: 'third-party-bridge',
    note: '竞态补传：B2 在 11-15 12:20 实际仍可服务，迟到消息会把占用结束时间提前',
    scenario: 'late_status_reduces_occupancy',
    payload: { gateway: 'gw-7', retransmit: true },
  },
];

fs.writeFileSync(path.join(inboxDir, 'site-xingqiao.json'), `${JSON.stringify(xqInbox, null, 2)}\n`);
fs.writeFileSync(path.join(inboxDir, 'site-wangjing.json'), `${JSON.stringify(wjInbox, null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), path.join(inboxDir, 'site-xingqiao.json'))} (${xqInbox.length}), ${path.relative(process.cwd(), path.join(inboxDir, 'site-wangjing.json'))} (${wjInbox.length})`);

