/** Conflicts & unconfirmed intervals: explicit lists with overlapping evidence. */

import { el, fmtDuration, fmtPercent, STATE_LABEL } from '../dom.js';
import { stateChip } from '../charts.js';

export function renderConflictsView(root, ctx) {
  const { state } = ctx;
  const { data } = state;
  const result = data.result;

  root.append(el('div', { class: 'note info' }, [
    el('span', { text: 'ⓘ' }),
    el('span', {}, [
      el('strong', { text: '未确认 ≠ 空闲。' }),
      document.createTextNode(' 订单结束时间缺失且无独立证据的区间、状态消息未覆盖的区间都单列在此，并从“可服务时间口径”的分母中扣除。'),
    ]),
  ]));

  // Conflicts
  const conflictCard = el('section', { class: 'card', style: { marginTop: '16px' } });
  conflictCard.append(el('div', { class: 'card-head' }, [
    el('h2', { text: `冲突（${result.conflicts.length}）` }),
    el('span', { class: 'card-sub', text: '维修窗口/故障/离线与充电重叠；重叠只扣一次时间' }),
  ]));
  if (!result.conflicts.length) {
    conflictCard.append(el('div', { class: 'empty', text: '当前窗口没有检测到重叠冲突。' }));
  } else {
    const wrap = el('div', { class: 'table-wrap' });
    const table = el('table');
    table.append(el('thead', {}, [el('tr', {}, [
      el('th', { text: '枪口' }),
      el('th', { text: '类型' }),
      el('th', { text: '时段' }),
      el('th', { class: 'num', text: '重叠时长' }),
      el('th', { text: '涉及记录' }),
      el('th', { text: '说明' }),
    ])]));
    const body = el('tbody');
    for (const conflict of result.conflicts) {
      const typeLabel = ({
        maintenance_overlap_charging: '维修 × 充电',
        fault_overlap_charging: '故障 × 充电',
        offline_overlap_charging: '离线 × 充电',
        order_overlap: '订单重叠',
      })[conflict.type] || conflict.type;
      const tr = el('tr');
      tr.append(
        el('td', {}, [el('button', {
          class: 'link-btn', type: 'button', text: conflict.gunCode,
          onclick: () => ctx.selectGun(conflict.gunId),
        })]),
        el('td', {}, [el(`span`, { class: `chip ${conflict.severity === 'warning' ? 'warn' : 'info'}`, text: typeLabel })]),
        el('td', { class: 'nowrap', text: state.tf.timeRange(conflict.start, conflict.end) }),
        el('td', { class: 'num', text: fmtDuration(conflict.ms, { compact: true }) }),
        el('td', { class: 'mono', text: [...conflict.orderIds, ...conflict.repairIds, ...conflict.statusIds].join(', ') || '—' }),
        el('td', { text: conflict.detail }),
      );
      body.append(tr);
    }
    table.append(body);
    wrap.append(table);
    conflictCard.append(wrap);
  }
  root.append(conflictCard);

  // Unconfirmed
  const unconfirmed = result.unconfirmedIntervals || [];
  const uncCard = el('section', { class: 'card', style: { marginTop: '16px' } });
  const uncMs = unconfirmed.reduce((s, u) => s + u.ms, 0);
  uncCard.append(el('div', { class: 'card-head' }, [
    el('h2', { text: `未确认区间（${unconfirmed.length}）` }),
    el('span', { class: 'card-sub', text: `合计 ${fmtDuration(uncMs)}，占总自然时间 ${fmtPercent(uncMs / result.siteMetrics.naturalMs)}` }),
  ]));
  if (!unconfirmed.length) {
    uncCard.append(el('div', { class: 'empty', text: '当前窗口没有未确认区间。' }));
  } else {
    const wrap = el('div', { class: 'table-wrap' });
    const table = el('table');
    table.append(el('thead', {}, [el('tr', {}, [
      el('th', { text: '枪口' }),
      el('th', { text: '区间' }),
      el('th', { class: 'num', text: '时长' }),
      el('th', { text: '原因' }),
      el('th', { text: '相关记录' }),
      el('th', { text: '' }),
    ])]));
    const body = el('tbody');
    for (const item of unconfirmed) {
      const tr = el('tr');
      tr.append(
        el('td', {}, [el('button', {
          class: 'link-btn', type: 'button', text: item.gunName || item.gunCode,
          onclick: () => ctx.selectGun(item.gunId),
        })]),
        el('td', { class: 'nowrap', text: state.tf.timeRange(item.start, item.end) }),
        el('td', { class: 'num', text: fmtDuration(item.ms, { compact: true }) }),
        el('td', { text: item.reason }),
        el('td', { class: 'mono', text: [...item.evidence.orders, ...item.evidence.statuses, ...item.evidence.repairs].join(', ') || '—' }),
        el('td', {}, [
          el('button', {
            class: 'link-btn', type: 'button', text: '查看时间线',
            onclick: () => ctx.navigate({ view: 'timeline', gun: item.gunId }),
          }),
        ]),
      );
      body.append(tr);
    }
    table.append(body);
    wrap.append(table);
    uncCard.append(wrap);
  }
  root.append(uncCard);

  // Data quality appendix
  const dq = result.dataQuality;
  const dqCard = el('section', { class: 'card', style: { marginTop: '16px' } });
  dqCard.append(el('div', { class: 'card-head' }, [
    el('h2', { text: '数据质量问题' }),
    el('span', { class: 'card-sub', text: '无法解析、无法匹配、越界的记录都在这里' }),
  ]));
  const sections = [
    ['同一时刻状态冲突', dq.sameTimeStatusConflicts.map((c) => ({
      gun: c.gunId,
      text: `${state.tf.dateTime(c.eventTime)} · ${c.states.map((s) => STATE_LABEL[s] || s).join(' / ')} → 采用 ${c.winnerExternalId}（到达最晚）`,
    }))],
    ['结束时间缺失但已由证据界定', dq.inferredOrderEnds.map((i) => ({
      gun: i.gunId,
      text: `${i.externalId}：${state.tf.dateTime(i.startTime)} → 推断结束 ${state.tf.dateTime(i.inferredEnd)}（依据 ${i.boundKind} ${i.boundRef}）`,
    }))],
    ['结束时间无法确认的订单', dq.openOrders.map((o) => ({
      gun: o.gunId,
      text: `${o.externalId}：${state.tf.dateTime(o.startTime)} 起无结束时间且无后续证据 → 至窗口结束按未确认`,
    }))],
    ['无法匹配枪口引用', dq.unresolved.map((u) => ({
      gun: null,
      text: `${u.kind} ${u.externalId}：枪口引用 “${u.gunRef}” ${reasonText(u.reason)}`,
    }))],
    ['无效记录', dq.invalid.map((i) => ({
      gun: null,
      text: `${i.kind} ${i.externalId || ''}：${invalidText(i.reason)}`,
    }))],
  ];
  let any = false;
  for (const [title, rows] of sections) {
    if (!rows.length) continue;
    any = true;
    dqCard.append(el('h3', { style: { fontSize: '13px', margin: '14px 0 6px' }, text: `${title}（${rows.length}）` }));
    const list = el('ul', { style: { margin: 0, paddingLeft: '20px', fontSize: '12.5px', display: 'grid', gap: '3px' } });
    for (const row of rows) list.append(el('li', { text: row.text }));
    dqCard.append(list);
  }
  if (!any) dqCard.append(el('div', { class: 'empty', text: '没有检测到数据质量问题。' }));
  root.append(dqCard);
}

function reasonText(reason) {
  return ({
    unknown_gun_ref: '在当前站点中不存在',
    ambiguous_gun_ref: '同时匹配多个枪口',
    missing_gun_ref: '枪口引用为空',
  })[reason] || reason;
}

function invalidText(reason) {
  return ({
    invalid_state: '状态值无法识别',
    invalid_event_time: '事件时间无法解析',
    invalid_start_time: '开始时间无法解析',
    end_not_after_start: '结束时间不晚于开始时间',
  })[reason] || reason;
}
