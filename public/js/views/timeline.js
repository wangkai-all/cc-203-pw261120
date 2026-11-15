/** Timeline view: gun picker, verdict lane + evidence lanes, segment table. */

import {
  el, clear, fmtDuration, fmtPercent, STATE_LABEL, STATE_ORDER, fmtSignedDuration,
} from '../dom.js';
import { renderGunTimeline, renderMultiGunTimeline, stateChip } from '../charts.js';

export function renderTimelineView(root, ctx) {
  const { state } = ctx;
  const { data } = state;
  const result = data.result;
  const guns = result.guns;
  if (!state.selectedGunId && guns[0]) state.selectedGunId = guns[0].gunId;
  let selected = guns.find((g) => g.gunId === state.selectedGunId) || guns[0];

  const toolbar = el('div', { class: 'timeline-toolbar' });
  const pills = el('div', { class: 'gun-pills', role: 'group', 'aria-label': '选择枪口' });
  for (const gun of guns) {
    const pill = el('button', {
      class: 'gun-pill', type: 'button', 'aria-pressed': String(gun.gunId === selected.gunId),
      onclick: () => {
        state.selectedGunId = gun.gunId;
        ctx.navigate({ view: 'timeline', gun: gun.gunId });
      },
    });
    pill.append(document.createTextNode(gun.displayName));
    if (gun.metrics.unconfirmedMs > 0) pill.append(el('span', { class: 'dot', title: '存在未确认区间' }));
    if (gun.repairsOpen) pill.append(el('span', { class: 'chip warn', text: '维修中' }));
    pills.append(pill);
  }
  toolbar.append(pills);
  root.append(toolbar);

  // Gun header
  const heading = el('div', { class: 'card-head', style: { marginTop: '4px' } }, [
    el('div', {}, [
      el('h2', { text: `${selected.displayName} · ${selected.connectorType || ''}${selected.powerKw ? ` · ${selected.powerKw} kW` : ''}` }),
      el('p', {
        class: 'card-sub',
        text: selected.historicalNames && selected.historicalNames.length > 1
          ? `历史命名：${selected.historicalNames.map((n) => n.name).join(' → ')}（按事件时刻匹配别名有效期）`
          : '当前命名未变更',
      }),
    ]),
    el('span', { class: 'card-sub', text: `${state.tf.rangeLabel(data.version.windowStart, data.version.windowEnd)}` }),
  ]);
  root.append(heading);

  // Timeline card
  const card = el('section', { class: 'card' });
  const legend = el('div', { class: 'timeline-legend', role: 'group', 'aria-label': '图层开关' });
  const layerState = new Set(STATE_ORDER);
  const redraw = () => {
    const host = card.querySelector('.chart-wrap');
    if (!host) return;
    renderGunTimeline(host, selected, {
      windowStart: data.version.windowStart,
      windowEnd: data.version.windowEnd,
      tz: state.site.timezone,
      onSegmentClick: (gun, seg) => ctx.showSegment(gun, seg),
      onRecordClick: (kind, record) => ctx.showRecord(kind, record, selected.gunId),
    });
  };
  for (const stateKey of STATE_ORDER) {
    const item = el('button', {
      type: 'button', 'aria-pressed': 'true',
      onclick: (event) => {
        const btn = event.currentTarget;
        const pressed = btn.getAttribute('aria-pressed') === 'true';
        btn.setAttribute('aria-pressed', String(!pressed));
        if (pressed) layerState.delete(stateKey); else layerState.add(stateKey);
        applyLayerFilter();
      },
    });
    item.append(
      el('span', {
        class: 'swatch',
        style: {
          background: stateKey === 'unconfirmed'
            ? 'repeating-linear-gradient(45deg, color-mix(in srgb, var(--st-unconfirmed) 45%, transparent) 0 2px, transparent 2px 5px)'
            : `var(--st-${stateKey === 'unconfirmed' ? 'unconfirmed' : stateKey})`,
          border: stateKey === 'unconfirmed' ? '1px solid var(--st-unconfirmed)' : 'none',
        },
      }),
      document.createTextNode(STATE_LABEL[stateKey]),
    );
    legend.append(item);
  }
  legend.append(el('span', { class: 'muted', style: { fontSize: '11.5px', marginLeft: 'auto' }, text: '● 状态消息  ▭ 订单  ▦ 维修 · 点击任一记录查看原始载荷' }));
  card.append(legend);
  const chartWrap = el('div', { class: 'chart-wrap' });
  card.append(chartWrap);
  const applyLayerFilter = () => {
    for (const node of chartWrap.querySelectorAll('[data-state]')) {
      const visible = layerState.has(node.getAttribute('data-state'));
      node.style.opacity = visible ? '1' : '0.12';
      node.style.pointerEvents = visible ? '' : 'none';
    }
  };
  redraw();
  applyLayerFilter();
  root.append(card);

  // Segment table (table view twin of the timeline)
  const tableCard = el('section', { class: 'card', style: { marginTop: '16px' } });
  tableCard.append(el('div', { class: 'card-head' }, [
    el('h2', { text: '时段明细（时间线表格视图）' }),
    el('span', { class: 'card-sub', text: `${selected.segments.length} 段` }),
  ]));
  const wrap = el('div', { class: 'table-wrap' });
  const table = el('table', { class: 'segments-table' });
  table.append(el('thead', {}, [
    el('tr', {}, [
      el('th', { text: '开始' }),
      el('th', { text: '结束' }),
      el('th', { class: 'num', text: '时长' }),
      el('th', { text: '状态' }),
      el('th', { text: '依据' }),
      el('th', { text: '证据（状态 / 订单 / 维修）' }),
      el('th', { text: '标记' }),
    ]),
  ]));
  const body = el('tbody');
  for (const seg of selected.segments) {
    const tr = el('tr');
    tr.append(
      el('td', { class: 'nowrap', text: state.tf.dateTime(seg.start) }),
      el('td', { class: 'nowrap', text: state.tf.dateTime(seg.end) }),
      el('td', { class: 'num', text: fmtDuration(seg.end - seg.start, { compact: true }) }),
      el('td', {}, [stateChip(seg.state)]),
      el('td', { text: seg.reason || '—' }),
      el('td', { class: 'mono nowrap', text: evidenceText(seg.evidence) }),
      el('td', {}, flagsCell(seg)),
    );
    tr.addEventListener('click', () => ctx.showSegment(selected, seg));
    tr.style.cursor = 'pointer';
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  tableCard.append(wrap);
  root.append(tableCard);

  // Daily per-gun table
  const dayCard = el('section', { class: 'card', style: { marginTop: '16px' } });
  dayCard.append(el('div', { class: 'card-head' }, [el('h2', { text: '按自然日（该枪口）' })]));
  const dayWrap = el('div', { class: 'table-wrap' });
  const dayTable = el('table');
  dayTable.append(el('thead', {}, [
    el('tr', {}, [
      el('th', { text: '日期' }),
      el('th', { class: 'num', text: '自然时长' }),
      el('th', { class: 'num', text: '占用' }),
      el('th', { class: 'num', text: '可服务' }),
      el('th', { class: 'num', text: '故障' }),
      el('th', { class: 'num', text: '离线' }),
      el('th', { class: 'num', text: '未确认' }),
      el('th', { class: 'num', text: '自然口径' }),
      el('th', { class: 'num', text: '可服务口径' }),
      el('th', { class: 'num', text: '冲突' }),
    ]),
  ]));
  const dayBody = el('tbody');
  for (const day of selected.days) {
    dayBody.append(el('tr', {}, [
      el('td', { text: day.date }),
      el('td', { class: 'num', text: fmtDuration(day.naturalMs, { compact: true }) }),
      el('td', { class: 'num', text: fmtDuration(day.occupiedMs, { compact: true }) }),
      el('td', { class: 'num', text: fmtDuration(day.serviceableMs, { compact: true }) }),
      el('td', { class: 'num', text: fmtDuration(day.faultMs, { compact: true }) }),
      el('td', { class: 'num', text: fmtDuration(day.offlineMs, { compact: true }) }),
      el('td', { class: 'num', text: fmtDuration(day.unconfirmedMs, { compact: true }) }),
      el('td', { class: 'num', text: fmtPercent(day.utilizationNatural) }),
      el('td', { class: 'num', text: fmtPercent(day.utilizationServiceable) }),
      el('td', { class: 'num', text: day.conflictMs ? fmtDuration(day.conflictMs, { compact: true }) : '—' }),
    ]));
  }
  dayTable.append(dayBody);
  dayWrap.append(dayTable);
  dayCard.append(dayWrap);
  root.append(dayCard);
}

function evidenceText(evidence) {
  if (!evidence) return '—';
  const bits = [];
  if (evidence.statuses.length) bits.push(`状态 ${evidence.statuses.join(', ')}`);
  if (evidence.orders.length) bits.push(`订单 ${evidence.orders.join(', ')}`);
  if (evidence.repairs.length) bits.push(`维修 ${evidence.repairs.join(', ')}`);
  return bits.length ? bits.join(' · ') : '—';
}

function flagsCell(seg) {
  const chips = [];
  if (seg.inferredOrderEnd) chips.push(el('span', { class: 'chip info', text: '结束推断' }));
  if (seg.flags.includes('conflict_charging')) chips.push(el('span', { class: 'chip crit', text: '重叠冲突' }));
  if (seg.flags.includes('no_status_coverage')) chips.push(el('span', { class: 'chip warn', text: '无状态覆盖' }));
  if (!chips.length) chips.push(el('span', { class: 'muted', text: '—' }));
  return el('span', { style: { display: 'inline-flex', gap: '4px', flexWrap: 'wrap' } }, chips);
}
