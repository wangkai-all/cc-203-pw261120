/**
 * SVG chart primitives for the analyzer.
 * Every chart is plain SVG with a hover/focus layer; values are also reachable
 * through the tables and the detail drawer, so tooltips never gate data.
 */

import { el, svg, clear, STATE_LABEL, STATE_ORDER, fmtDuration, fmtPercent, makeTimeFormat } from './dom.js';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const STATE_VAR = {
  available: 'var(--st-available)',
  occupied: 'var(--st-occupied)',
  fault: 'var(--st-fault)',
  offline: 'var(--st-offline)',
  unconfirmed: 'var(--st-unconfirmed)',
};

let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;

export function stateChip(state, { withDot = true } = {}) {
  const chip = el('span', { class: `chip${state === 'unconfirmed' ? '' : ''}` });
  if (withDot) chip.append(el('span', { class: 'chip-dot', style: { background: STATE_VAR[state] || 'var(--ink-3)' } }));
  chip.append(document.createTextNode(STATE_LABEL[state] || state));
  return chip;
}

function hatchDefs(id) {
  return svg('defs', {}, [
    svg('pattern', { id, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, [
      svg('rect', { width: 6, height: 6, fill: 'var(--st-unconfirmed)', opacity: '0.16' }),
      svg('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--st-unconfirmed-hatch)', 'stroke-width': 1.4, opacity: 0.7 }),
    ]),
  ]);
}

function stateFill(state, hatchId) {
  if (state === 'unconfirmed') return `url(#${hatchId})`;
  return STATE_VAR[state] || 'var(--ink-3)';
}

function labelFits(text, widthPx) {
  return text.length * 6.4 + 14 <= widthPx;
}

// ---------------------------------------------------------------------------
// Time axis helper
// ---------------------------------------------------------------------------

export function timeTicks(start, end, tz) {
  const tf = makeTimeFormat(tz);
  const span = end - start;
  const target = span > 5 * DAY ? 10 : span > 2 * DAY ? 8 : 6;
  const candidates = [];
  const hourStep = span > 5 * DAY ? 24 : span > 2 * DAY ? 12 : 6;
  // Anchor hourly ticks on local wall-clock hours.
  const p0 = tf.parts(start);
  const anchor = Date.UTC(p0.year, p0.month - 1, p0.day, Math.ceil(Number(p0.hour) / hourStep) * hourStep);
  const firstLocal = anchor - (Date.UTC(p0.year, p0.month - 1, p0.day, Number(p0.hour), Number(p0.minute)) - start);
  for (let t = firstLocal; t <= end; t += hourStep * HOUR) {
    const p = tf.parts(t);
    const isMidnight = p.hour === '00' && p.minute === '00';
    candidates.push({ t, label: isMidnight ? `${Number(p.month)}/${Number(p.day)}` : p.hour, major: isMidnight });
  }
  // Thin out non-midnight ticks when there are too many.
  const major = candidates.filter((c) => c.major);
  const minorEvery = Math.max(1, Math.ceil((candidates.length - major.length) / target));
  let minorSeen = 0;
  return candidates.filter((c) => {
    if (c.major) return true;
    minorSeen += 1;
    return minorSeen % minorEvery === 0;
  });
}

export function dayBands(start, end, tz) {
  const tf = makeTimeFormat(tz);
  const bands = [];
  let cursor = start;
  let guard = 0;
  while (cursor < end && guard < 70) {
    const p = tf.parts(cursor);
    const nextLocal = Date.UTC(p.year, p.month - 1, p.day + 1);
    const localNow = Date.UTC(p.year, p.month - 1, p.day, Number(p.hour), Number(p.minute));
    const next = cursor + (nextLocal - localNow);
    bands.push({ start: cursor, end: Math.min(next, end) });
    cursor = next;
    guard += 1;
  }
  return bands;
}

// ---------------------------------------------------------------------------
// Site-wide multi-gun timeline
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} host
 * @param {{guns:Array, windowStart:number, windowEnd:number, tz:string,
 *          selectedGunId:string|null, onSelectGun:(id:string)=>void,
 *          onSegmentClick:(gun, seg)=>void}} opts
 */
export function renderMultiGunTimeline(host, opts) {
  const { guns, windowStart, windowEnd, tz, selectedGunId, onSelectGun, onSegmentClick } = opts;
  clear(host);
  const width = Math.max(640, host.clientWidth || 900);
  const pad = { top: 26, right: 14, bottom: 26, left: 64 };
  const rowH = 40;
  const plotH = guns.length * rowH;
  const height = pad.top + plotH + pad.bottom;
  const plotW = width - pad.left - pad.right;
  const x = (t) => pad.left + ((t - windowStart) / (windowEnd - windowStart)) * plotW;
  const hatchId = nextId('hatch');
  const tf = makeTimeFormat(tz);

  const root = svg('svg', {
    class: 'chart-svg', viewBox: `0 0 ${width} ${height}`, role: 'img',
    'aria-label': `各枪口状态时间线，${tf.rangeLabel(windowStart, windowEnd)}`,
  });
  root.append(hatchDefs(hatchId));

  // Day bands + axis
  const bands = dayBands(windowStart, windowEnd, tz);
  bands.forEach((band, index) => {
    if (index % 2 === 1) {
      root.append(svg('rect', {
        x: x(band.start), y: pad.top - 8, width: Math.max(0, x(band.end) - x(band.start)),
        height: plotH + 8, fill: 'var(--surface-2)', opacity: 0.55,
      }));
    }
  });
  const axis = svg('g', { class: 'axis' });
  for (const band of bands) {
    axis.append(svg('line', { x1: x(band.start), y1: pad.top - 8, x2: x(band.start), y2: pad.top + plotH, class: 'gridline' }));
    axis.append(svg('text', {
      x: x(band.start) + 4, y: pad.top - 13, 'font-size': 10.5,
    }, `${tf.dateShort(band.start)}`));
  }
  for (const tick of timeTicks(windowStart, windowEnd, tz)) {
    if (tick.major) continue;
    axis.append(svg('line', {
      x1: x(tick.t), y1: pad.top, x2: x(tick.t), y2: pad.top + plotH,
      class: 'gridline', opacity: 0.6,
    }));
    axis.append(svg('text', { x: x(tick.t), y: pad.top + plotH + 16, 'text-anchor': 'middle', 'font-size': 10 }, `${tick.label}:00`));
  }
  root.append(axis);

  guns.forEach((gun, rowIndex) => {
    const y = pad.top + rowIndex * rowH;
    const bg = svg('rect', {
      x: 0, y, width, height: rowH, fill: selectedGunId === gun.gunId ? 'var(--surface-2)' : 'transparent',
      class: 'tl-bg', 'data-gun-id': gun.gunId, cursor: 'pointer',
      tabindex: 0, role: 'button', 'aria-label': `${gun.code} 枪口，点击查看时间线`,
    });
    root.append(svg('g', { class: 'tl-row', 'data-select-gun': gun.gunId }, [bg]));
    const label = svg('text', {
      x: pad.left - 10, y: y + rowH / 2 + 4, 'text-anchor': 'end',
      'font-size': 12, fill: 'var(--ink-1)', 'font-weight': selectedGunId === gun.gunId ? 700 : 500,
    }, gun.displayName);
    root.append(label);

    const trackY = y + 10;
    const trackH = 20;
    for (const seg of gun.segments) {
      const segX = x(seg.start);
      const segW = Math.max(1.5, x(seg.end) - segX);
      const inferred = seg.inferredOrderEnd;
      const rect = svg('rect', {
        x: segX, y: trackY, width: segW, height: trackH,
        rx: 2.5, fill: stateFill(seg.state, hatchId),
        class: 'seg-rect', tabindex: 0, role: 'button',
        'aria-label': `${gun.code} ${STATE_LABEL[seg.state]} ${tf.timeRange(seg.start, seg.end)}`,
        'data-seg-gun': gun.gunId,
        'data-start': seg.start,
      });
      if (inferred) rect.setAttribute('stroke-dasharray', '3 2');
      if (seg.flags.includes('conflict_charging')) {
        rect.setAttribute('stroke', 'var(--status-critical)');
        rect.setAttribute('stroke-width', '1.6');
      }
      root.append(rect);
      if (segW > 46 && trackH >= 16) {
        const text = STATE_LABEL[seg.state];
        if (labelFits(text, segW)) {
          root.append(svg('text', {
            x: segX + segW / 2, y: trackY + 14, 'text-anchor': 'middle',
            class: `seg-label${seg.state === 'offline' ? ' dark' : ''}`,
          }, text));
        }
      }
    }
    // Status message ticks
    for (const status of gun.records ? gun.records.statuses : []) {
      if (status.eventTime < windowStart || status.eventTime > windowEnd) continue;
      if (status.fate === 'duplicate') continue;
      root.append(svg('circle', {
        cx: x(status.eventTime), cy: y + 5.5, r: 2.2,
        fill: status.state === 'unconfirmed' ? 'var(--ink-3)' : STATE_VAR[status.state],
        opacity: status.fate === 'effective' ? 0.9 : 0.35,
        'data-status-gun': gun.gunId, 'data-status-id': status.externalId,
      }));
    }
  });

  // Hover layer
  attachSegmentTooltip(root, guns, tf, { pad, plotW, windowStart, windowEnd, rowH, padLeft: pad.left });
  attachRowNavigation(root, onSelectGun);
  attachSegmentClick(root, onSegmentClick, guns);

  host.append(root);
}

function attachRowNavigation(root, onSelectGun) {
  if (!onSelectGun) return;
  for (const node of root.querySelectorAll('[data-select-gun]')) {
    const handler = (event) => {
      if (event.target.closest('[data-seg-gun]')) return;
      onSelectGun(node.getAttribute('data-select-gun'));
    };
    node.addEventListener('click', handler);
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handler(event); }
    });
  }
}

function attachSegmentClick(root, onSegmentClick, guns) {
  if (!onSegmentClick) return;
  const byId = new Map(guns.map((g) => [g.gunId, g]));
  for (const node of root.querySelectorAll('[data-seg-gun]')) {
    const activate = (event) => {
      const gun = byId.get(node.getAttribute('data-seg-gun'));
      if (!gun) return;
      const start = Number(node.dataset.start);
      const seg = gun.segments.find((s) => s.start === start) || null;
      if (seg) onSegmentClick(gun, seg, event);
    };
    node.addEventListener('click', activate);
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(event); }
    });
  }
}

function attachSegmentTooltip(root, guns, tf, geom) {
  const tooltip = document.getElementById('tooltip');
  if (!tooltip) return;
  const byId = new Map(guns.map((g) => [g.gunId, g]));
  const show = (event) => {
    const rect = event.target.closest('[data-seg-gun]');
    if (!rect) { hide(); return; }
    const gun = byId.get(rect.getAttribute('data-seg-gun'));
    if (!gun) return;
    const seg = gun.segments.find((s) => String(s.start) === rect.getAttribute('data-start')) ||
      nearestToMiddle(gun, rect, geom);
    if (!seg) return;
    tooltip.innerHTML = '';
    tooltip.append(
      el('div', { class: 'tt-head', text: `${gun.displayName} · ${STATE_LABEL[seg.state]}` }),
      el('div', { class: 'tt-row' }, [
        el('span', { class: 'name', text: '时段' }),
        el('span', { class: 'val', text: tf.timeRange(seg.start, seg.end) }),
      ]),
      el('div', { class: 'tt-row' }, [
        el('span', { class: 'name', text: '时长' }),
        el('span', { class: 'val', text: fmtDuration(seg.end - seg.start) }),
      ]),
      el('div', { class: 'tt-row' }, [
        el('span', { class: 'name', text: '依据' }),
        el('span', { class: 'val', text: seg.reason || '—' }),
      ]),
    );
    if (seg.flags && seg.flags.includes('conflict_charging')) {
      tooltip.append(el('div', { class: 'tt-sub', text: '⚠ 该时段存在维修/故障与充电重叠，按不可用计一次' }));
    }
    if (seg.inferredOrderEnd) {
      tooltip.append(el('div', { class: 'tt-sub', text: '⟲ 订单结束时间由独立证据推断' }));
    }
    tooltip.hidden = false;
    const box = rect.getBoundingClientRect();
    const pad = 12;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    const pointerX = event.clientX || box.left + box.width / 2;
    const pointerY = event.clientY || box.top;
    tooltip.style.left = `${Math.min(window.innerWidth - tw - pad, Math.max(pad, pointerX + 14))}px`;
    tooltip.style.top = `${Math.min(window.innerHeight - th - pad, Math.max(pad, pointerY - th - 12))}px`;
  };
  const hide = () => { tooltip.hidden = true; };
  root.addEventListener('pointermove', show);
  root.addEventListener('pointerleave', hide);
  root.addEventListener('focusin', (event) => { show(event); });
  root.addEventListener('focusout', hide);
}

function nearestToMiddle(gun, rect, geom) {
  const mid = Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) / 2;
  return nearestSegment(gun, mid, geom);
}


function nearestSegment(gun, px, geom) {
  let best = null;
  let bestDist = Infinity;
  for (const seg of gun.segments) {
    const sx = geom.padLeft + ((seg.start - geom.windowStart) / (geom.windowEnd - geom.windowStart)) * geom.plotW;
    const ex = geom.padLeft + ((seg.end - geom.windowStart) / (geom.windowEnd - geom.windowStart)) * geom.plotW;
    const dist = px < sx ? sx - px : px > ex ? px - ex : 0;
    if (dist < bestDist) { bestDist = dist; best = seg; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Single-gun detailed timeline: verdict + evidence lanes
// ---------------------------------------------------------------------------

export function renderGunTimeline(host, gun, opts) {
  const { windowStart, windowEnd, tz, onSegmentClick, onRecordClick } = opts;
  clear(host);
  const width = Math.max(620, host.clientWidth || 900);
  const pad = { top: 30, right: 16, bottom: 24, left: 84 };
  const laneGap = 8;
  const verdictH = 30;
  const laneH = 22;
  const lanes = [
    { key: 'status', label: '状态消息' },
    { key: 'order', label: '充电订单' },
    { key: 'repair', label: '维修记录' },
  ];
  const height = pad.top + verdictH + laneGap + lanes.length * (laneH + laneGap) + pad.bottom;
  const plotW = width - pad.left - pad.right;
  const x = (t) => pad.left + ((t - windowStart) / (windowEnd - windowStart)) * plotW;
  const tf = makeTimeFormat(tz);
  const hatchId = nextId('hatch2');

  const root = svg('svg', {
    class: 'chart-svg', viewBox: `0 0 ${width} ${height}`, role: 'img',
    'aria-label': `${gun.displayName} 详细时间线`,
  });
  root.append(hatchDefs(hatchId));

  // Day bands
  const bands = dayBands(windowStart, windowEnd, tz);
  bands.forEach((band, index) => {
    if (index % 2 === 1) {
      root.append(svg('rect', {
        x: x(band.start), y: pad.top - 6, width: Math.max(0, x(band.end) - x(band.start)),
        height: height - pad.top - pad.bottom + 10, fill: 'var(--surface-2)', opacity: .55,
      }));
    }
  });
  const axis = svg('g', { class: 'axis' });
  for (const tick of timeTicks(windowStart, windowEnd, tz)) {
    axis.append(svg('line', {
      x1: x(tick.t), y1: pad.top - 6, x2: x(tick.t), y2: height - pad.bottom,
      class: tick.major ? 'gridline' : 'gridline', opacity: tick.major ? 0.9 : 0.5,
    }));
    axis.append(svg('text', {
      x: x(tick.t), y: height - pad.bottom + 15, 'text-anchor': 'middle',
    }, tick.major ? tick.label : `${tick.label}:00`));
  }
  root.append(axis);

  // Verdict lane
  root.append(svg('text', {
    x: pad.left - 10, y: pad.top + verdictH / 2 + 4, 'text-anchor': 'end',
    'font-size': 12, 'font-weight': 600, fill: 'var(--ink-1)',
  }, '还原结论'));
  for (const seg of gun.segments) {
    const segX = x(seg.start);
    const segW = Math.max(1.5, x(seg.end) - segX);
    const rect = svg('rect', {
      x: segX, y: pad.top, width: segW, height: verdictH, rx: 3,
      fill: stateFill(seg.state, hatchId), class: 'seg-rect', tabindex: 0, role: 'button',
      'data-seg-gun': gun.gunId, 'data-start': seg.start, 'data-state': seg.state,
      'aria-label': `${STATE_LABEL[seg.state]} ${tf.timeRange(seg.start, seg.end)}，${seg.reason || ''}`,
    });
    if (seg.flags.includes('conflict_charging')) {
      rect.setAttribute('stroke', 'var(--status-critical)');
      rect.setAttribute('stroke-width', '1.6');
    }
    if (seg.inferredOrderEnd) rect.setAttribute('stroke-dasharray', '4 3');
    root.append(rect);
    if (segW > 52) {
      const label = STATE_LABEL[seg.state];
      if (labelFits(label, segW)) {
        root.append(svg('text', {
          x: segX + segW / 2, y: pad.top + 19.5, 'text-anchor': 'middle',
          class: `seg-label${seg.state === 'offline' ? ' dark' : ''}`,
        }, label));
      }
    }
  }
  attachSegmentClick(root, onSegmentClick, [gun]);
  attachGunSegmentTooltip(root, gun, tf);

  // Evidence lanes
  const laneTop = (index) => pad.top + verdictH + laneGap + index * (laneH + laneGap);
  lanes.forEach((lane, index) => {
    const y = laneTop(index);
    root.append(svg('text', {
      x: pad.left - 10, y: y + laneH / 2 + 4, 'text-anchor': 'end',
      'font-size': 11.5, fill: 'var(--ink-3)',
    }, lane.label));
    root.append(svg('rect', {
      x: pad.left, y, width: plotW, height: laneH, rx: 3, fill: 'var(--surface-2)', opacity: .8,
    }));
  });

  if (gun.records) {
    for (const status of gun.records.statuses) {
      if (status.eventTime < windowStart || status.eventTime > windowEnd) continue;
      const cy = laneTop(0) + laneH / 2;
      const cx = x(status.eventTime);
      const dim = status.fate === 'duplicate';
      root.append(svg('circle', {
        cx, cy, r: 4.2,
        fill: STATE_VAR[status.state] || 'var(--ink-3)',
        stroke: 'var(--surface-1)', 'stroke-width': 2,
        opacity: dim ? 0.3 : 1,
        'data-record': status.externalId, 'data-record-kind': 'status',
        class: 'seg-rect', tabindex: 0, role: 'button',
        'aria-label': `状态消息 ${status.externalId}，${STATE_LABEL[status.state]}，${tf.dateTime(status.eventTime)}${dim ? '，重复已抑制' : ''}`,
      }));
      if (status.late) {
        root.append(svg('circle', {
          cx, cy, r: 8.5, fill: 'none',
          stroke: 'var(--status-warning)', 'stroke-width': 1.4, opacity: .8,
        }));
      }
    }
    for (const order of gun.records.orders) {
      const end = order.effectiveEnd ?? order.endTime;
      const start = Math.max(order.startTime, windowStart);
      const stop = Math.min(end ?? windowEnd, windowEnd);
      if (stop <= start) continue;
      const y = laneTop(1);
      const inferred = order.inferredEnd;
      const rect = svg('rect', {
        x: x(start), y: y + 4, width: Math.max(2, x(stop) - x(start)), height: laneH - 8, rx: 2.5,
        fill: 'var(--st-occupied)', opacity: inferred ? 0.55 : 0.85,
        'data-record': order.externalId, 'data-record-kind': 'order',
        class: 'seg-rect', tabindex: 0, role: 'button',
        'aria-label': `订单 ${order.externalId}，${tf.timeRange(start, stop)}${inferred ? '，结束时间推断' : ''}`,
      });
      if (inferred) rect.setAttribute('stroke-dasharray', '4 3');
      root.append(rect);
    }
    for (const repair of gun.records.repairs) {
      const end = repair.endTime ?? windowEnd;
      const start = Math.max(repair.startTime, windowStart);
      const stop = Math.min(end, windowEnd);
      if (stop <= start) continue;
      const y = laneTop(2);
      const rect = svg('rect', {
        x: x(start), y: y + 4, width: Math.max(2, x(stop) - x(start)), height: laneH - 8, rx: 2.5,
        fill: 'var(--st-fault)', opacity: repair.open ? 0.5 : 0.8,
        'data-record': repair.externalId, 'data-record-kind': 'repair',
        class: 'seg-rect', tabindex: 0, role: 'button',
        'aria-label': `维修 ${repair.externalId}，${tf.timeRange(start, stop)}${repair.open ? '，仍未结束' : ''}`,
      });
      if (repair.open) rect.setAttribute('stroke-dasharray', '3 2');
      root.append(rect);
    }
  }

  if (onRecordClick) {
    const handler = (event) => {
      const node = event.target.closest('[data-record]');
      if (!node) return;
      const kind = node.getAttribute('data-record-kind');
      const id = node.getAttribute('data-record');
      const record = kind === 'status'
        ? gun.records.statuses.find((s) => s.externalId === id)
        : kind === 'order'
          ? gun.records.orders.find((o) => o.externalId === id)
          : gun.records.repairs.find((r) => r.externalId === id);
      if (record) onRecordClick(kind, record);
    };
    root.addEventListener('click', handler);
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handler(event); }
    });
  }

  host.append(root);
}

function attachGunSegmentTooltip(root, gun, tf) {
  const tooltip = document.getElementById('tooltip');
  if (!tooltip) return;
  const show = (event) => {
    const node = event.target.closest('[data-seg-gun]');
    if (!node) { tooltip.hidden = true; return; }
    const seg = gun.segments.find((s) => String(s.start) === node.getAttribute('data-start'));
    if (!seg) return;
    tooltip.innerHTML = '';
    tooltip.append(
      el('div', { class: 'tt-head', text: `${STATE_LABEL[seg.state]} · ${fmtDuration(seg.end - seg.start)}` }),
      el('div', { class: 'tt-row' }, [
        el('span', { class: 'name', text: '时段' }),
        el('span', { class: 'val', text: tf.timeRange(seg.start, seg.end) }),
      ]),
      el('div', { class: 'tt-row' }, [
        el('span', { class: 'name', text: '依据' }),
        el('span', { class: 'val', text: seg.reason || '—' }),
      ]),
      el('div', { class: 'tt-sub', text: '点击查看原始记录' }),
    );
    tooltip.hidden = false;
    const rect = node.getBoundingClientRect();
    tooltip.style.left = `${Math.min(window.innerWidth - tooltip.offsetWidth - 12, Math.max(12, rect.left))}px`;
    tooltip.style.top = `${Math.max(12, rect.top - tooltip.offsetHeight - 8)}px`;
  };
  root.addEventListener('pointermove', show);
  root.addEventListener('pointerleave', () => { tooltip.hidden = true; });
  root.addEventListener('focusin', show);
  root.addEventListener('focusout', () => { tooltip.hidden = true; });
}

// ---------------------------------------------------------------------------
// Duration composition (stacked horizontal bar)
// ---------------------------------------------------------------------------

export function renderCompositionBar(host, metrics, { tz, label = '全站' } = {}) {
  clear(host);
  const total = metrics.naturalMs || 1;
  const parts = STATE_ORDER.map((state) => ({
    state,
    ms: metrics[`${state}Ms`] != null ? metrics[`${state}Ms`] : 0,
  })).filter((p) => p.ms > 0);
  const bar = el('div', { class: 'stack-bar', role: 'img', 'aria-label': `${label} 状态时长构成` });
  for (const part of parts) {
    const share = part.ms / total;
    const seg = el('span', {
      style: {
        flex: `${share} 1 0`,
        background: part.state === 'unconfirmed'
          ? 'repeating-linear-gradient(45deg, color-mix(in srgb, var(--st-unconfirmed) 30%, transparent) 0 2px, transparent 2px 5px)'
          : STATE_VAR[part.state],
      },
      title: `${STATE_LABEL[part.state]} ${fmtDuration(part.ms)}（${fmtPercent(share)}）`,
    });
    seg.dataset.state = part.state;
    seg.dataset.ms = part.ms;
    seg.tabIndex = 0;
    seg.setAttribute('role', 'button');
    seg.setAttribute('aria-label', `${STATE_LABEL[part.state]} ${fmtDuration(part.ms)}，占 ${fmtPercent(share)}`);
    bar.append(seg);
  }
  host.append(bar);

  const legend = el('div', { class: 'legend' });
  for (const state of STATE_ORDER) {
    const ms = metrics[`${state}Ms`] || 0;
    const item = el('span', { class: 'legend-item' });
    item.append(
      el('span', {
        class: 'swatch',
        style: {
          background: state === 'unconfirmed'
            ? 'repeating-linear-gradient(45deg, color-mix(in srgb, var(--st-unconfirmed) 40%, transparent) 0 2px, transparent 2px 5px)'
            : STATE_VAR[state],
          border: state === 'unconfirmed' ? '1px solid var(--st-unconfirmed)' : 'none',
        },
      }),
      el('span', { class: 'legend-label' }, [
        document.createTextNode(`${STATE_LABEL[state]} `),
        el('b', { text: fmtDuration(ms, { compact: true }) }),
      ]),
      el('span', { class: 'muted', text: ` · ${fmtPercent(ms / total)}` }),
    );
    legend.append(item);
  }
  host.append(legend);

  // Hover tooltip on segments
  const tooltip = document.getElementById('tooltip');
  const show = (event) => {
    const seg = event.target.closest('[data-state]');
    if (!seg || !tooltip) return;
    const state = seg.dataset.state;
    const ms = Number(seg.dataset.ms);
    tooltip.innerHTML = '';
    tooltip.append(
      el('div', { class: 'tt-head', text: STATE_LABEL[state] }),
      el('div', { class: 'tt-row' }, [
        el('span', { class: 'name', text: '时长' }),
        el('span', { class: 'val', text: fmtDuration(ms) }),
      ]),
      el('div', { class: 'tt-row' }, [
        el('span', { class: 'name', text: '占自然时间' }),
        el('span', { class: 'val', text: fmtPercent(ms / total) }),
      ]),
    );
    tooltip.hidden = false;
    const rect = seg.getBoundingClientRect();
    tooltip.style.left = `${Math.min(window.innerWidth - tooltip.offsetWidth - 12, Math.max(12, rect.left))}px`;
    tooltip.style.top = `${Math.max(12, rect.top - tooltip.offsetHeight - 8)}px`;
  };
  bar.addEventListener('pointermove', show);
  bar.addEventListener('focusin', show);
  bar.addEventListener('pointerleave', () => { if (tooltip) tooltip.hidden = true; });
  bar.addEventListener('focusout', () => { if (tooltip) tooltip.hidden = true; });
  void tz;
}

// ---------------------------------------------------------------------------
// Utilization comparison: grouped horizontal bars per gun, two calibers
// ---------------------------------------------------------------------------

export function renderUtilizationByGun(host, guns, { previousGuns = null } = {}) {
  clear(host);
  const prevMap = new Map((previousGuns || []).map((g) => [g.gunId, g]));
  const max = Math.max(...guns.map((g) => Math.max(g.metrics.utilizationNatural, g.metrics.utilizationServiceable)), 0.05);
  const scaleMax = Math.ceil(max * 1.25 * 100) / 100;
  const rows = el('div', { class: 'util-rows' });
  for (const gun of guns) {
    const prev = prevMap.get(gun.gunId);
    const row = el('div', { class: 'util-gun' });
    row.append(el('div', { class: 'util-gun-head' }, [
      el('span', { class: 'util-gun-name', text: gun.displayName }),
      el('span', { class: 'util-gun-meta', text: `${gun.connectorType || ''}${gun.powerKw ? ` · ${gun.powerKw} kW` : ''}` }),
    ]));
    for (const [key, label, color] of [
      ['utilizationNatural', '自然时间口径', 'var(--util-natural)'],
      ['utilizationServiceable', '可服务时间口径', 'var(--util-serviceable)'],
    ]) {
      const value = gun.metrics[key];
      const prevValue = prev ? prev.metrics[key] : null;
      const line = el('div', { class: 'util-line' });
      line.append(el('span', { class: 'util-line-label', text: label }));
      const track = el('div', { class: 'util-track' });
      const fill = el('div', {
        class: 'util-fill',
        style: { width: `${Math.min(100, (value / scaleMax) * 100)}%`, background: color },
      });
      fill.dataset.tip = `${gun.displayName} ${label}`;
      track.append(fill);
      if (prevValue != null && Math.abs(prevValue - value) > 0.0005) {
        const marker = el('div', {
          class: 'util-prev',
          style: { left: `${Math.min(100, (prevValue / scaleMax) * 100)}%` },
          title: `上一版本 ${fmtPercent(prevValue)}`,
        });
        track.append(marker);
      }
      line.append(track);
      const delta = prevValue != null ? value - prevValue : null;
      line.append(el('span', {
        class: 'util-value',
        title: prevValue != null ? `上一版本 ${fmtPercent(prevValue)}` : '',
        text: fmtPercent(value),
      }));
      row.append(line);
      if (delta != null && Math.abs(delta) > 0.0005) {
        const dir = delta > 0 ? 'up' : 'down';
        row.append(el('div', { class: 'util-delta' }, [
          el('span', { class: dir, text: `${delta > 0 ? '↑' : '↓'} ${Math.abs(delta * 100).toFixed(1)}pp` }),
          el('span', { class: 'muted', text: ' 较上一版本' }),
        ]));
      }
    }
    rows.append(row);
  }
  host.append(rows);
  host.append(el('div', { class: 'util-axis' }, [
    el('span', { text: '0%' }),
    el('span', { text: fmtPercent(scaleMax / 2, 0) }),
    el('span', { text: fmtPercent(scaleMax, 0) }),
  ]));
}

export function renderDailyUtilization(host, days, { tz, previousDays = null } = {}) {
  clear(host);
  const width = Math.max(560, host.clientWidth || 860);
  const pad = { top: 18, right: 12, bottom: 42, left: 44 };
  const height = 200;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(0.05, ...days.map((d) => Math.max(d.utilizationNatural || 0, d.utilizationServiceable || 0)));
  const scaleMax = Math.ceil(max * 1.2 * 100) / 100;
  const y = (v) => pad.top + plotH - (v / scaleMax) * plotH;
  const groupW = plotW / Math.max(1, days.length);
  const barW = Math.min(22, groupW / 3.2);
  const tf = makeTimeFormat(tz);
  const prevMap = new Map((previousDays || []).map((d) => [d.date, d]));

  const root = svg('svg', { class: 'chart-svg', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': '按日利用率，双口径' });
  const axisG = svg('g', { class: 'axis' });
  const ticks = 4;
  for (let i = 0; i <= ticks; i += 1) {
    const v = (scaleMax / ticks) * i;
    const yy = y(v);
    axisG.append(svg('line', { x1: pad.left, y1: yy, x2: width - pad.right, y2: yy, class: i === 0 ? '' : 'gridline' }));
    axisG.append(svg('text', { x: pad.left - 8, y: yy + 3.5, 'text-anchor': 'end' }, `${(v * 100).toFixed(0)}%`));
  }
  root.append(axisG);

  days.forEach((day, index) => {
    const cx = pad.left + groupW * index + groupW / 2;
    const prev = prevMap.get(day.date);
    const pairs = [
      { key: 'utilizationNatural', color: 'var(--util-natural)', label: '自然时间口径' },
      { key: 'utilizationServiceable', color: 'var(--util-serviceable)', label: '可服务时间口径' },
    ];
    pairs.forEach((pair, pairIndex) => {
      const value = day[pair.key] || 0;
      const bx = cx + (pairIndex - 0.5) * (barW + 3) - barW / 2;
      const by = y(value);
      const bar = svg('rect', {
        x: bx, y: by, width: barW, height: Math.max(1, pad.top + plotH - by),
        rx: 3, fill: pair.color, class: 'seg-rect', tabindex: 0, role: 'button',
        'aria-label': `${day.date} ${pair.label} ${fmtPercent(value)}`,
        'data-day': day.date, 'data-key': pair.key, 'data-value': value,
      });
      root.append(bar);
      if (prev && Math.abs((prev[pair.key] || 0) - value) > 0.0002) {
        const py = y(prev[pair.key] || 0);
        root.append(svg('line', {
          x1: bx - 1, y1: py, x2: bx + barW + 1, y2: py,
          stroke: 'var(--ink-3)', 'stroke-width': 1.4, opacity: 0.85,
        }));
      }
    });
    root.append(svg('text', {
      x: cx, y: height - pad.bottom + 16, 'text-anchor': 'middle',
      fill: 'var(--ink-3)', 'font-size': 10.5,
    }, tf.dateShort(day.start)));
    root.append(svg('text', {
      x: cx, y: height - pad.bottom + 30, 'text-anchor': 'middle',
      fill: 'var(--ink-3)', 'font-size': 10,
    }, day.naturalMs >= 23 * HOUR ? '' : '部分'));
  });
  root.append(svg('line', {
    x1: pad.left, y1: pad.top + plotH, x2: width - pad.right, y2: pad.top + plotH,
    stroke: 'var(--axis)', 'stroke-width': 1,
  }));

  const tooltip = document.getElementById('tooltip');
  const show = (event) => {
    const node = event.target.closest('[data-day]');
    if (!node || !tooltip) { if (tooltip) tooltip.hidden = true; return; }
    const day = days.find((d) => d.date === node.getAttribute('data-day'));
    const key = node.getAttribute('data-key');
    if (!day) return;
    tooltip.innerHTML = '';
    tooltip.append(
      el('div', { class: 'tt-head', text: `${day.date} · ${key === 'utilizationNatural' ? '自然时间口径' : '可服务时间口径'}` }),
      el('div', { class: 'tt-row' }, [
        el('span', { class: 'name', text: '利用率' }),
        el('span', { class: 'val', text: fmtPercent(day[key]) }),
      ]),
      el('div', { class: 'tt-row' }, [
        el('span', { class: 'name', text: '占用时长' }),
        el('span', { class: 'val', text: fmtDuration(day.occupiedMs) }),
      ]),
      el('div', { class: 'tt-row' }, [
        el('span', { class: 'name', text: '可服务时长' }),
        el('span', { class: 'val', text: fmtDuration(day.serviceableMs) }),
      ]),
      el('div', { class: 'tt-row' }, [
        el('span', { class: 'name', text: '未确认时长' }),
        el('span', { class: 'val', text: fmtDuration(day.unconfirmedMs) }),
      ]),
    );
    tooltip.hidden = false;
    const rect = node.getBoundingClientRect();
    tooltip.style.left = `${Math.min(window.innerWidth - tooltip.offsetWidth - 12, Math.max(12, rect.left))}px`;
    tooltip.style.top = `${Math.max(12, rect.top - tooltip.offsetHeight - 8)}px`;
  };
  root.addEventListener('pointermove', show);
  root.addEventListener('pointerleave', () => { if (tooltip) tooltip.hidden = true; });
  root.addEventListener('focusin', show);
  root.addEventListener('focusout', () => { if (tooltip) tooltip.hidden = true; });

  host.append(root);
}

// ---------------------------------------------------------------------------
// Sparkline for KPI deltas / daily trend
// ---------------------------------------------------------------------------

export function sparkline(values, { width = 96, height = 26, color = 'var(--st-occupied)' } = {}) {
  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true', class: 'spark' });
  if (!values.length) return root;
  const max = Math.max(...values, 0.001);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = width / Math.max(1, values.length - 1);
  const points = values.map((v, i) => `${i * step},${height - 2 - ((v - min) / span) * (height - 4)}`);
  root.append(svg('polyline', {
    points: points.join(' '), fill: 'none', stroke: color, 'stroke-width': 2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.9,
  }));
  const last = values[values.length - 1];
  root.append(svg('circle', {
    cx: (values.length - 1) * step, cy: height - 2 - ((last - min) / span) * (height - 4),
    r: 2.6, fill: color,
  }));
  return root;
}
