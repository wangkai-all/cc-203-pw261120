/** Overview: headline metrics, dual-caliber utilization, day chart, gun table. */

import {
  el, clear, fmtPercent, fmtDuration, fmtDeltaPercent, STATE_LABEL, STATE_ORDER, makeTimeFormat,
} from '../dom.js';
import {
  renderCompositionBar, renderUtilizationByGun, renderDailyUtilization, stateChip, sparkline,
} from '../charts.js';

export function renderOverview(root, ctx) {
  const { state } = ctx;
  const { data } = state;
  const result = data.result;
  const prev = data.previousResult;
  const tf = state.tf;
  const metrics = result.siteMetrics;

  const kpis = el('section', { class: 'grid grid-kpi', 'aria-label': '关键指标' });

  // KPI 1: utilization, both calibers
  kpis.append(kpiUtilization(result, prev, tf));
  // KPI 2: state composition
  kpis.append(kpiStates(metrics, tf));
  // KPI 3: conflicts
  kpis.append(kpiConflicts(result));
  // KPI 4: data quality
  kpis.append(kpiQuality(result, prev));

  root.append(kpis);

  const actions = el('div', { class: 'grid grid-2', style: { marginTop: '16px' } });

  // Utilization by gun
  const utilCard = el('section', { class: 'card', 'aria-label': '按枪口利用率' });
  utilCard.append(el('div', { class: 'card-head' }, [
    el('h2', { text: '按枪口利用率（双口径）' }),
    el('span', { class: 'card-sub', text: prev ? '细线标记 = 上一版本' : '占用时长 ÷ 口径时长' }),
  ]));
  const utilHost = el('div');
  renderUtilizationByGun(utilHost, result.guns, { previousGuns: prev ? prev.guns : null });
  utilCard.append(utilHost);
  utilCard.append(el('p', {
    class: 'card-note',
    text: '自然口径把故障、离线、未确认都算在分母里；可服务口径只算真正能提供服务的时段。两者差距大，说明不可用或不可确认时间占比高。',
  }));
  actions.append(utilCard);

  // Daily chart
  const dailyCard = el('section', { class: 'card', 'aria-label': '按日利用率' });
  dailyCard.append(el('div', { class: 'card-head' }, [
    el('h2', { text: '按自然日利用率' }),
    el('span', { class: 'card-sub', text: '全站加权（所有枪口合计）' }),
  ]));
  const dailyHost = el('div', { class: 'chart-wrap' });
  renderDailyUtilization(dailyHost, result.siteDays, {
    tz: state.site.timezone,
    previousDays: prev ? prev.siteDays : null,
  });
  dailyCard.append(dailyHost);
  dailyCard.append(legendRow([
    ['var(--util-natural)', '自然时间口径'],
    ['var(--util-serviceable)', '可服务时间口径'],
  ]));
  dailyCard.append(el('p', {
    class: 'card-note',
    text: '柱上细横线为上一版本的同口径值，便于对比迟到消息补入前后的变化。',
  }));
  actions.append(dailyCard);

  root.append(actions);

  // Conflicts summary + data quality notes
  if (result.conflicts.length || result.siteMetrics.unconfirmedMs) {
    root.append(conflictBanner(result, ctx));
  }

  // Gun table
  root.append(gunTable(result, prev, ctx));
}

function kpiUtilization(result, prev, tf) {
  const metrics = result.siteMetrics;
  const card = el('section', { class: 'card' });
  card.append(el('div', { class: 'kpi-label', text: '全站利用率（占用 / 口径时长）' }));
  const value = el('div', { class: 'kpi-value', text: fmtPercent(metrics.utilizationNatural) });
  card.append(value);
  const deltaText = prev
    ? `自然口径较上一版本 ${fmtDeltaPercent(metrics.utilizationNatural - prev.siteMetrics.utilizationNatural)}`
    : '自然时间口径（占用 ÷ 全部时间）';
  card.append(el('div', { class: 'kpi-delta', text: deltaText }));

  const meters = el('div', { style: { marginTop: '12px', display: 'grid', gap: '8px' } });
  for (const [key, label, color] of [
    ['utilizationNatural', '自然口径', 'var(--util-natural)'],
    ['utilizationServiceable', '可服务口径', 'var(--util-serviceable)'],
  ]) {
    const v = metrics[key] || 0;
    const row = el('div');
    row.append(el('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', color: 'var(--ink-3)' } }, [
      el('span', { text: label }),
      el('span', { text: fmtPercent(v) }),
    ]));
    const meter = el('div', { class: 'kpi-meter' });
    meter.append(el('i', { style: { width: `${Math.min(100, v * 100)}%`, background: color } }));
    row.append(meter);
    meters.append(row);
  }
  card.append(meters);
  // Sparkline over days for natural caliber
  const values = (result.siteDays || []).map((d) => d.utilizationNatural || 0);
  if (values.length > 1) {
    const spark = el('div', { style: { marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px' } });
    spark.append(el('span', { style: { fontSize: '11px', color: 'var(--ink-3)' }, text: '逐日趋势' }), sparkline(values, { color: 'var(--util-natural)' }));
    card.append(spark);
  }
  void tf;
  return card;
}

function kpiStates(metrics, tf) {
  const card = el('section', { class: 'card' });
  card.append(el('div', { class: 'kpi-label', text: '时间构成（全站 · 全部枪口）' }));
  const host = el('div', { style: { marginTop: '10px' } });
  renderCompositionBar(host, metrics, { tz: tf && null });
  card.append(host);
  card.append(el('div', { class: 'kpi-legend' }, [
    el('span', {}, [document.createTextNode(`可服务 ${fmtDuration(metrics.serviceableMs, { compact: true })}`)]),
    el('span', {}, [document.createTextNode(`未确认 ${fmtDuration(metrics.unconfirmedMs, { compact: true })}`)]),
  ]));
  return card;
}

function kpiConflicts(result) {
  const card = el('section', { class: 'card' });
  const maintenance = result.conflicts.filter((c) => c.type === 'maintenance_overlap_charging');
  card.append(el('div', { class: 'kpi-label', text: '重叠冲突（维修/故障 × 充电）' }));
  card.append(el('div', { class: 'kpi-value', text: String(result.conflicts.length) }));
  const totalMs = result.conflicts.reduce((s, c) => s + c.ms, 0);
  card.append(el('div', { class: 'kpi-delta', text: result.conflicts.length ? `涉及 ${fmtDuration(totalMs, { compact: true })}（按不可用计一次，不重复扣减）` : '未检测到重叠' }));
  const list = el('div', { style: { marginTop: '10px', display: 'grid', gap: '6px' } });
  for (const conflict of result.conflicts.slice(0, 3)) {
    const row = el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px' } });
    row.append(
      el('span', { class: `chip ${conflict.severity === 'warning' ? 'warn' : 'info'}` }, [
        el('span', { class: 'chip-dot', style: { background: conflict.severity === 'warning' ? 'var(--status-warning)' : 'var(--st-occupied)' } }),
        document.createTextNode(conflict.gunCode),
      ]),
      el('span', { class: 'muted', text: `${conflict.title} · ${fmtDuration(conflict.ms, { compact: true })}` }),
    );
    list.append(row);
  }
  if (result.conflicts.length > 3) {
    list.append(el('button', {
      class: 'link-btn', type: 'button', style: { fontSize: '12px', textAlign: 'left' },
      onclick: () => ctx.navigate({ view: 'conflicts' }),
    }, `查看全部 ${result.conflicts.length} 条冲突`));
  }
  if (maintenance.length) {
    list.append(el('p', { class: 'card-note', text: `其中维修窗口重叠 ${maintenance.length} 条。` }));
  }
  card.append(list);
  return card;
}

function kpiQuality(result, prev) {
  const counts = result.dataQuality.counts;
  const card = el('section', { class: 'card' });
  card.append(el('div', { class: 'kpi-label', text: '数据质量' }));
  card.append(el('div', {
    class: 'kpi-value',
    text: `${Math.round(result.siteMetrics.unconfirmedMs / 60000)}′`,
  }));
  card.append(el('div', { class: 'kpi-delta', text: '全站未确认时长（合计分钟）' }));
  const rows = [
    ['重复消息抑制', counts.duplicatesSuppressed],
    ['迟到消息', counts.lateStatuses],
    ['推断的订单结束', counts.inferredOrderEnds],
    ['结束时间无法确认的订单', counts.openOrders],
    ['无法匹配的枪口引用', counts.unresolvedRefs],
    ['无效记录', counts.invalidRecords],
  ];
  const list = el('div', { style: { marginTop: '10px', display: 'grid', gap: '4px', fontSize: '12px' } });
  for (const [label, value] of rows) {
    const row = el('div', { style: { display: 'flex', justifyContent: 'space-between' } });
    row.append(el('span', { class: 'muted', text: label }), el('b', { text: String(value) }));
    list.append(row);
  }
  card.append(list);
  void prev;
  return card;
}

function legendRow(items) {
  const row = el('div', { class: 'legend' });
  for (const [color, label] of items) {
    row.append(el('span', { class: 'legend-item' }, [
      el('span', { class: 'swatch', style: { background: color } }),
      el('span', { class: 'legend-label' }, [document.createTextNode(label)]),
    ]));
  }
  return row;
}

function conflictBanner(result, ctx) {
  const wrap = el('div', { class: 'grid', style: { marginTop: '16px' } });
  const maintenance = result.conflicts.filter((c) => c.type === 'maintenance_overlap_charging');
  const unconfirmed = result.siteMetrics.unconfirmedMs;
  if (maintenance.length) {
    wrap.append(el('div', { class: 'note' }, [
      el('span', { text: '⚠' }),
      el('span', {}, [
        el('strong', { text: `维修窗口与充电重叠 ${maintenance.length} 处。` }),
        document.createTextNode(' 重叠时段按不可用计一次：既不当作有效充电时长，也不重复扣减。'),
        el('button', { class: 'link-btn', type: 'button', text: ' 查看冲突明细', onclick: () => ctx.navigate({ view: 'conflicts' }) }),
      ]),
    ]));
  }
  if (unconfirmed > 0) {
    wrap.append(el('div', { class: 'note critical' }, [
      el('span', { text: '?' }),
      el('span', {}, [
        el('strong', { text: `存在 ${fmtDuration(unconfirmed)} 未确认时间。` }),
        document.createTextNode(' 这些区间没有被当作空闲，而是单列并从可服务口径的分母中扣除。'),
        el('button', { class: 'link-btn', type: 'button', text: ' 查看未确认区间', onclick: () => ctx.navigate({ view: 'conflicts' }) }),
      ]),
    ]));
  }
  return wrap;
}

function gunTable(result, prev, ctx) {
  const prevMap = new Map((prev ? prev.guns : []).map((g) => [g.gunId, g]));
  const card = el('section', { class: 'card', style: { marginTop: '16px' } });
  card.append(el('div', { class: 'card-head' }, [
    el('h2', { text: '枪口明细' }),
    el('span', { class: 'card-sub', text: '点击枪口名查看时间线；点击“原始记录”追溯依据' }),
  ]));
  const wrap = el('div', { class: 'table-wrap' });
  const table = el('table');
  const head = el('thead');
  head.append(el('tr', {}, [
    el('th', { text: '枪口' }),
    el('th', { class: 'num', text: '自然口径' }),
    el('th', { class: 'num', text: '可服务口径' }),
    el('th', { class: 'num', text: '占用' }),
    el('th', { class: 'num', text: '故障' }),
    el('th', { class: 'num', text: '离线' }),
    el('th', { class: 'num', text: '未确认' }),
    el('th', { class: 'num', text: '可服务' }),
    el('th', { class: 'num', text: '冲突' }),
    el('th', { text: '命名历史' }),
    el('th', { text: '' }),
  ]));
  table.append(head);
  const body = el('tbody');
  for (const gun of result.guns) {
    const p = prevMap.get(gun.gunId);
    const tr = el('tr');
    const nameCell = el('td');
    nameCell.append(el('button', {
      class: 'link-btn', type: 'button', text: gun.displayName,
      onclick: () => ctx.selectGun(gun.gunId),
    }));
    if (gun.repairsOpen) nameCell.append(el('span', { class: 'chip warn', style: { marginLeft: '6px' }, text: '维修未结' }));
    tr.append(nameCell);
    for (const key of ['utilizationNatural', 'utilizationServiceable']) {
      const td = el('td', { class: 'num' });
      td.append(document.createTextNode(fmtPercent(gun.metrics[key])));
      if (p && Math.abs((p.metrics[key] || 0) - (gun.metrics[key] || 0)) > 0.0005) {
        td.append(el('span', {
          class: 'split-date',
          style: { color: (gun.metrics[key] - p.metrics[key]) > 0 ? 'var(--status-good)' : 'var(--status-critical)' },
          text: fmtDeltaPercent(gun.metrics[key] - p.metrics[key], 1),
        }));
      }
      tr.append(td);
    }
    tr.append(el('td', { class: 'num', text: fmtDuration(gun.metrics.occupiedMs, { compact: true }) }));
    tr.append(el('td', { class: 'num', text: fmtDuration(gun.metrics.faultMs, { compact: true }) }));
    tr.append(el('td', { class: 'num', text: fmtDuration(gun.metrics.offlineMs, { compact: true }) }));
    tr.append(el('td', { class: 'num', text: fmtDuration(gun.metrics.unconfirmedMs, { compact: true }) }));
    tr.append(el('td', { class: 'num', text: fmtDuration(gun.metrics.serviceableMs, { compact: true }) }));
    tr.append(el('td', { class: 'num' }, [
      el('span', {
        class: gun.metrics.conflictMs ? 'chip warn' : 'muted',
        text: gun.metrics.conflictMs ? fmtDuration(gun.metrics.conflictMs, { compact: true }) : '—',
      }),
    ]));
    const names = (gun.historicalNames || []).filter((n) => !n.current);
    const historyCell = el('td');
    if (names.length) {
      historyCell.append(el('span', {
        class: 'muted', style: { fontSize: '11.5px' },
        text: names.map((n) => n.name).join(' → ') + ` → ${gun.displayName}`,
      }));
    } else {
      historyCell.append(el('span', { class: 'muted', text: '—' }));
    }
    tr.append(historyCell);
    tr.append(el('td', {}, [
      el('button', {
        class: 'link-btn', type: 'button', text: '原始记录',
        onclick: () => ctx.navigate({ view: 'records', gun: gun.gunId }),
      }),
    ]));
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  card.append(wrap);
  return card;
}
