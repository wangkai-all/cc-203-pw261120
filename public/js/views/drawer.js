/** Traceability drawer: any metric → segment → original records, and back. */

import { el, clear, fmtDuration, fmtPercent, STATE_LABEL } from '../dom.js';
import { stateChip } from '../charts.js';

let drawer;
let body;
let title;
let lastFocus = null;

export function initDrawer() {
  drawer = document.getElementById('detail-drawer');
  body = document.getElementById('drawer-body');
  title = document.getElementById('drawer-title');
  if (!drawer) return;
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawer && !drawer.hidden) closeDrawer();
  });
}

export function closeDrawer() {
  if (!drawer) return;
  drawer.hidden = true;
  if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  lastFocus = null;
}

function openDrawer(heading) {
  if (!drawer) initDrawer();
  if (!drawer) return;
  lastFocus = document.activeElement;
  title.textContent = heading;
  clear(body);
  drawer.hidden = false;
  body.scrollTop = 0;
  const close = document.getElementById('drawer-close');
  if (close) close.focus();
}

function gunOf(ctx, gunId) {
  return (ctx.state.data.result.guns || []).find((g) => g.gunId === gunId) || null;
}

// ---------------------------------------------------------------------------
// Segment detail
// ---------------------------------------------------------------------------

export function openSegmentDrawer(ctx, gun, seg) {
  openDrawer(`${gun.displayName} · ${STATE_LABEL[seg.state] || seg.state}`);
  const tf = ctx.state.tf;
  const result = ctx.state.data.result;

  const dl = el('dl');
  const row = (dt, dd) => {
    dl.append(el('dt', { text: dt }), el('dd', {}, Array.isArray(dd) ? dd : [dd]));
  };
  row('状态', [stateChip(seg.state)]);
  row('区间', el('span', { class: 'mono', text: `${tf.dateTime(seg.start)} → ${tf.dateTime(seg.end)}` }));
  row('时长', fmtDuration(seg.end - seg.start));
  row('依据', seg.reason || '—');
  row('枪口', el('span', { class: 'mono', text: gun.code }));
  if (seg.flags && seg.flags.length) {
    const chips = el('span', { style: { display: 'inline-flex', gap: '4px', flexWrap: 'wrap' } });
    const flagLabel = {
      conflict_charging: '充电重叠冲突',
      no_status_coverage: '状态流未覆盖',
      inferred_order_end: '订单结束推断',
    };
    for (const flag of seg.flags) {
      chips.append(el('span', {
        class: `chip ${flag === 'conflict_charging' ? 'crit' : 'warn'}`,
        text: flagLabel[flag] || flag,
      }));
    }
    row('标记', chips);
  }
  if (seg.inferredOrderEnd) {
    row('结束推断', '该占用段的结束时间由独立证据推断（见订单记录），不是直接上报的值。');
  }
  body.append(dl);

  // Evidence: statuses
  const statuses = (gun.records?.statuses || []).filter((s) => (seg.evidence?.statuses || []).includes(s.externalId));
  const orders = (gun.records?.orders || []).filter((o) => (seg.evidence?.orders || []).includes(o.externalId));
  const repairs = (gun.records?.repairs || []).filter((r) => (seg.evidence?.repairs || []).includes(r.externalId));

  body.append(el('h3', { text: `状态消息证据（${statuses.length}）` }));
  if (!statuses.length) {
    body.append(el('p', { class: 'muted', style: { fontSize: '12px' }, text: '该区间没有直接的状态消息证据。' }));
  }
  for (const status of statuses) {
    const item = el('div', { class: 'evidence-item' });
    item.append(
      el('div', {}, [
        el('div', {}, [el('b', { class: 'mono', text: status.externalId }), el('span', { class: 'muted', text: ` · ${STATE_LABEL[status.state] || status.state}` })]),
        el('div', { class: 'meta', text: `${ctx.state.tf.dateTime(status.eventTime)} · 到达 ${ctx.state.tf.dateTime(status.receivedAt)} · ${status.source || '—'}` }),
        status.late
          ? el('div', { class: 'meta', text: `迟到 ${fmtDuration(status.late.delayMs, { compact: true })}${status.late.outOfOrder ? '，乱序到达' : ''}` })
          : null,
      ]),
      el('button', {
        class: 'link-btn', type: 'button', text: '查看原始载荷',
        onclick: () => openRecordDrawer(ctx, 'status', status, gun.gunId),
      }),
    );
    body.append(item);
  }

  if (orders.length) {
    body.append(el('h3', { text: `充电订单证据（${orders.length}）` }));
    for (const order of orders) {
      const item = el('div', { class: 'evidence-item' });
      item.append(
        el('div', {}, [
          el('div', {}, [el('b', { class: 'mono', text: order.externalId })]),
          el('div', {
            class: 'meta',
            text: `${ctx.state.tf.dateTime(order.startTime)} → ${order.endTime == null ? '（缺失）' : ctx.state.tf.dateTime(order.effectiveEnd ?? order.endTime)}`
              + (order.inferredEnd ? ` · 推断依据 ${order.inferredEnd.boundKind} ${order.inferredEnd.boundRef}` : ''),
          }),
        ]),
        el('button', {
          class: 'link-btn', type: 'button', text: '查看订单',
          onclick: () => openRecordDrawer(ctx, 'order', order, gun.gunId),
        }),
      );
      body.append(item);
    }
  }

  if (repairs.length) {
    body.append(el('h3', { text: `维修记录证据（${repairs.length}）` }));
    for (const repair of repairs) {
      const item = el('div', { class: 'evidence-item' });
      item.append(
        el('div', {}, [
          el('div', {}, [el('b', { class: 'mono', text: repair.externalId })]),
          el('div', {
            class: 'meta',
            text: `${ctx.state.tf.dateTime(repair.startTime)} → ${repair.open ? '仍未结束' : ctx.state.tf.dateTime(repair.endTime)}`
              + ` · ${repair.kind || '维修'}${repair.workOrder ? ` · ${repair.workOrder}` : ''}`,
          }),
        ]),
        el('button', {
          class: 'link-btn', type: 'button', text: '查看工单',
          onclick: () => openRecordDrawer(ctx, 'repair', repair, gun.gunId),
        }),
      );
      body.append(item);
    }
  }

  // Conflicts touching this segment
  const conflictIds = seg.conflictIds || [];
  const conflicts = result.conflicts.filter((c) => conflictIds.includes(c.id));
  body.append(el('h3', { text: `相关冲突（${conflicts.length}）` }));
  if (!conflicts.length) {
    body.append(el('p', { class: 'muted', style: { fontSize: '12px' }, text: '该区间没有与充电/维修窗口的重叠冲突。' }));
  } else {
    for (const conflict of conflicts) {
      body.append(el('div', { class: 'evidence-item' }, [
        el('div', {}, [
          el('div', { text: conflict.title }),
          el('div', { class: 'meta', text: `${ctx.state.tf.timeRange(conflict.start, conflict.end)} · ${fmtDuration(conflict.ms, { compact: true })} · ${conflict.detail}` }),
        ]),
      ]));
    }
  }

  const actions = el('div', { style: { display: 'flex', gap: '10px', marginTop: '18px', flexWrap: 'wrap' } });
  actions.append(el('button', {
    class: 'btn btn-sm', type: 'button', text: '在时间线中定位',
    onclick: () => {
      closeDrawer();
      ctx.navigate({ view: 'timeline', gun: gun.gunId });
    },
  }));
  actions.append(el('button', {
    class: 'btn btn-sm btn-ghost', type: 'button', text: '查看全部冲突',
    onclick: () => { closeDrawer(); ctx.navigate({ view: 'conflicts' }); },
  }));
  body.append(actions);
}

// ---------------------------------------------------------------------------
// Raw record detail
// ---------------------------------------------------------------------------

export function openRecordDrawer(ctx, kind, record, gunId) {
  const gun = gunId ? gunOf(ctx, gunId) : null;
  const tf = ctx.state.tf;
  const heading = kind === 'status'
    ? `状态消息 ${record.externalId}`
    : kind === 'order'
      ? `充电订单 ${record.externalId}`
      : `维修记录 ${record.externalId}`;
  openDrawer(heading);

  const dl = el('dl');
  const row = (dt, dd) => dl.append(el('dt', { text: dt }), el('dd', {}, Array.isArray(dd) ? dd : [dd]));
  row('类型', { status: '状态消息', order: '充电订单', repair: '维修记录' }[kind]);
  row('枪口', [el('span', { class: 'mono', text: record.gunRef || record.code || '—' })]);
  if (gun) row('归属', gun.displayName);
  if (record.unresolved) row('处理结果', [el('span', { class: 'chip crit', text: record.unresolved })]);
  if (kind === 'status') {
    row('状态', [stateChip(record.state)]);
    row('事件时刻', tf.dateTime(record.eventTime));
    row('到达时间', tf.dateTime(record.receivedAt));
    row('来源', record.source || '—');
    if (!record.unresolved) row('处理结果', fateLabel(record.fate));
    if (record.duplicateOf) {
      row('重复于', [el('span', { class: 'mono', text: record.duplicateOf }), el('span', { class: 'muted', text: `（${dupReason(record.duplicateReason)}）` })]);
    }
    if (record.late) {
      row('迟到', `${fmtDuration(record.late.delayMs)}${record.late.outOfOrder ? '，并按事件时间乱序到达' : ''}`);
    }
    if (record.matchedViaAlias) row('名称匹配', '通过历史别名解析到该枪口');
    if (record.outsideAliasValidity) row('别名有效期', '消息时刻不在别名有效期内（仍按唯一别名回溯）');
  } else if (kind === 'order') {
    row('开始', tf.dateTime(record.startTime));
    row('上报结束', record.endTime == null ? '缺失' : tf.dateTime(record.endTime));
    if (record.inferredEnd) {
      row('采用结束', tf.dateTime(record.effectiveEnd));
      row('推断依据', `${record.inferredEnd.boundKind}：${record.inferredEnd.boundRef}`);
    }
    if (record.energyKwh != null) row('电量', `${record.energyKwh} kWh`);
    row('订单状态', record.status || '—');
    row('来源', record.source || '—');
    if (record.matchedViaAlias) row('名称匹配', '通过历史别名解析到该枪口');
  } else {
    row('开始', tf.dateTime(record.startTime));
    row('结束', record.open || record.endTime == null ? '仍未结束（按窗口结束计）' : tf.dateTime(record.endTime));
    row('维修类型', record.kind || '—');
    if (record.workOrder) row('工单号', el('span', { class: 'mono', text: record.workOrder }));
    row('工单状态', record.status || '—');
    if (record.note) row('备注', record.note);
    row('来源', record.source || '—');
    if (record.matchedViaAlias) row('名称匹配', '通过历史别名解析到该枪口');
  }
  body.append(dl);

  if (record.payload !== undefined && record.payload !== null) {
    body.append(el('h3', { text: '原始载荷' }));
    body.append(el('pre', { class: 'payload', text: JSON.stringify(record.payload, null, 2) }));
  }

  // Which segments does this record support?
  if (gun) {
    const refs = [];
    for (const seg of gun.segments || []) {
      const ev = seg.evidence || {};
      const hit = kind === 'status'
        ? (ev.statuses || []).includes(record.externalId)
        : kind === 'order'
          ? (ev.orders || []).includes(record.externalId)
          : (ev.repairs || []).includes(record.externalId);
      if (hit) refs.push(seg);
    }
    body.append(el('h3', { text: `影响的还原区间（${refs.length}）` }));
    if (!refs.length) {
      body.append(el('p', {
        class: 'muted', style: { fontSize: '12px' },
        text: '该记录未作为任何区间的证据出现（可能被覆盖、重复抑制或落在窗口外）。',
      }));
    }
    for (const seg of refs) {
      const item = el('div', { class: 'evidence-item' });
      item.append(
        el('div', {}, [
          el('div', {}, [stateChip(seg.state), el('span', { style: { marginLeft: '6px' }, text: `${tf.timeRange(seg.start, seg.end)}` })]),
          el('div', { class: 'meta', text: fmtDuration(seg.end - seg.start, { compact: true }) + ` · ${seg.reason || ''}` }),
        ]),
        el('button', {
          class: 'link-btn', type: 'button', text: '查看区间',
          onclick: () => openSegmentDrawer(ctx, gun, seg),
        }),
      );
      body.append(item);
    }
    const actions = el('div', { style: { display: 'flex', gap: '10px', marginTop: '18px' } });
    actions.append(el('button', {
      class: 'btn btn-sm', type: 'button', text: `打开 ${gun.displayName} 时间线`,
      onclick: () => { closeDrawer(); ctx.navigate({ view: 'timeline', gun: gun.gunId }); },
    }));
    body.append(actions);
  }
}

function fateLabel(fate) {
  return ({
    effective: '已采用',
    duplicate: '重复消息，已抑制',
    superseded_same_time: '同时刻冲突，未采用',
  })[fate] || fate || '—';
}

function dupReason(reason) {
  return ({
    same_external_id: '同一外部 ID',
    same_content: '内容完全相同',
    same_external_id_conflicting_payload: '同一外部 ID 但载荷不同',
  })[reason] || reason || '';
}
