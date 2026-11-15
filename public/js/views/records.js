/** Raw-record browser: every ingested message, with its resolution fate. */

import { el, clear, fmtDuration, STATE_LABEL } from '../dom.js';
import { api } from '../api.js';
import { stateChip } from '../charts.js';

const KIND_LABEL = { status: '状态消息', order: '充电订单', repair: '维修记录' };

const FATE_LABEL = {
  effective: '已采用',
  duplicate: '重复抑制',
  superseded_same_time: '同时刻未采用',
};

export async function renderRecordsView(root, ctx) {
  const { state } = ctx;
  const result = state.data.result;
  const tf = state.tf;

  // Build an index from the analyzed per-gun records, which carry the
  // resolution fate (dedup, aliasing, inferred end).
  const analyzed = new Map(); // key -> { gun, record }
  for (const gun of result.guns) {
    for (const status of gun.records.statuses) {
      analyzed.set(keyOf('status', status), { gun, record: status });
    }
    for (const order of gun.records.orders) {
      analyzed.set(keyOf('order', order), { gun, record: order });
    }
    for (const repair of gun.records.repairs) {
      analyzed.set(keyOf('repair', repair), { gun, record: repair });
    }
  }

  let payload;
  try {
    payload = await api.records(state.siteId);
  } catch (error) {
    root.append(el('div', { class: 'note critical', text: `加载原始记录失败：${error.message}` }));
    return;
  }

  const dq = result.dataQuality;
  const unresolvedIndex = new Map(
    dq.unresolved.map((u) => [`${u.kind}|${u.externalId}`, u.reason]),
  );
  const invalidIndex = new Map(
    dq.invalid.map((i) => [`${i.kind}|${i.externalId}`, i.reason]),
  );

  const rows = [];
  for (const status of payload.statuses) {
    rows.push({
      kind: 'status',
      time: status.eventTime,
      externalId: status.externalId,
      gunRef: status.gunRef,
      source: status.source,
      raw: status,
      analyzed: analyzed.get(keyOf('status', { externalId: status.externalId, eventTime: status.eventTime, receivedAt: status.receivedAt })) || null,
      issue: unresolvedIndex.get(`status|${status.externalId}`) || invalidIndex.get(`status|${status.externalId}`) || null,
    });
  }
  for (const order of payload.orders) {
    rows.push({
      kind: 'order',
      time: order.startTime,
      externalId: order.externalId,
      gunRef: order.gunRef,
      source: order.source,
      raw: order,
      analyzed: analyzed.get(keyOf('order', { externalId: order.externalId, startTime: order.startTime })) || null,
      issue: unresolvedIndex.get(`order|${order.externalId}`) || invalidIndex.get(`order|${order.externalId}`) || null,
    });
  }
  for (const repair of payload.repairs) {
    rows.push({
      kind: 'repair',
      time: repair.startTime,
      externalId: repair.externalId,
      gunRef: repair.gunRef,
      source: repair.source,
      raw: repair,
      analyzed: analyzed.get(keyOf('repair', { externalId: repair.externalId, startTime: repair.startTime })) || null,
      issue: unresolvedIndex.get(`repair|${repair.externalId}`) || invalidIndex.get(`repair|${repair.externalId}`) || null,
    });
  }
  rows.sort((a, b) => (a.time || 0) - (b.time || 0) || a.kind.localeCompare(b.kind));

  // Header
  const header = el('div', { class: 'card-head' }, [
    el('div', {}, [
      el('h2', { text: '原始记录' }),
      el('p', {
        class: 'card-sub',
        text: `共 ${rows.length} 条：状态 ${payload.statuses.length} · 订单 ${payload.orders.length} · 维修 ${payload.repairs.length}。每行都标出它在本次分析中的去向。`,
      }),
    ]),
  ]);
  root.append(header);

  // Filters
  const filters = el('div', { class: 'record-filters' });
  const gunFilter = el('select', { 'aria-label': '按枪口筛选' });
  gunFilter.append(el('option', { value: '', text: '全部枪口' }));
  for (const gun of result.guns) {
    gunFilter.append(el('option', { value: gun.gunId, text: gun.displayName }));
  }
  gunFilter.append(el('option', { value: '__issue', text: '仅异常/未匹配' }));
  const kindFilter = el('div', { class: 'segmented', role: 'group', 'aria-label': '按记录类型筛选' });
  for (const [value, label] of [['all', '全部'], ['status', '状态'], ['order', '订单'], ['repair', '维修']]) {
    kindFilter.append(el('button', { type: 'button', dataset: { kind: value }, text: label, 'aria-pressed': String(value === 'all') }));
  }
  const search = el('input', { type: 'search', placeholder: '搜索 ID / 枪口 / 来源…', 'aria-label': '搜索原始记录' });

  filters.append(
    el('label', { class: 'field-inline' }, [el('span', { text: '枪口' }), gunFilter]),
    el('label', { class: 'field-inline' }, [el('span', { text: '类型' }), kindFilter]),
    el('label', { class: 'field-inline' }, [el('span', { text: '搜索' }), search]),
  );
  root.append(filters);
  if (state.gunFromRoute && state.selectedGunId) gunFilter.value = state.selectedGunId;

  const tableHost = el('div');
  root.append(tableHost);

  const active = { gun: gunFilter.value, kind: 'all', text: '' };
  const rerender = () => {
    clear(tableHost);
    tableHost.append(recordsTable(rows, active, ctx, { tf, dq }));
  };
  gunFilter.addEventListener('change', () => { active.gun = gunFilter.value; rerender(); });
  for (const btn of kindFilter.querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      active.kind = btn.dataset.kind;
      for (const other of kindFilter.querySelectorAll('button')) {
        other.setAttribute('aria-pressed', String(other === btn));
      }
      rerender();
    });
  }
  search.addEventListener('input', () => { active.text = search.value.trim().toLowerCase(); rerender(); });
  rerender();
}

function keyOf(kind, record) {
  if (kind === 'status') return `status|${record.externalId}|${record.eventTime ?? ''}`;
  if (kind === 'order') return `order|${record.externalId}|${record.startTime ?? ''}`;
  return `repair|${record.externalId}|${record.startTime ?? ''}`;
}

function recordsTable(rows, active, ctx, { tf, dq }) {
  const filtered = rows.filter((row) => {
    if (active.kind !== 'all' && row.kind !== active.kind) return false;
    if (active.gun === '__issue') {
      if (!row.issue && !isSuspicious(row)) return false;
    } else if (active.gun) {
      if (!row.analyzed || row.analyzed.gun.gunId !== active.gun) return false;
    }
    if (active.text) {
      const hay = `${row.externalId || ''} ${row.gunRef || ''} ${row.source || ''} ${row.analyzed ? row.analyzed.gun.displayName : ''}`.toLowerCase();
      if (!hay.includes(active.text)) return false;
    }
    return true;
  });

  const wrap = el('div', { class: 'table-wrap' });
  const card = el('div', { style: { marginTop: '12px' } });
  card.append(el('div', { class: 'card-sub', style: { marginBottom: '8px' }, text: `显示 ${filtered.length} / ${rows.length} 条` }));
  if (!filtered.length) {
    card.append(el('div', { class: 'empty', text: '没有符合条件的记录。' }));
    return card;
  }

  const table = el('table');
  table.append(el('thead', {}, [el('tr', {}, [
    el('th', { text: '类型' }),
    el('th', { text: '外部 ID' }),
    el('th', { text: '枪口引用' }),
    el('th', { text: '时间' }),
    el('th', { text: '内容' }),
    el('th', { text: '来源' }),
    el('th', { text: '分析去向' }),
    el('th', { text: '' }),
  ])]));
  const body = el('tbody');
  for (const row of filtered) {
    const tr = el('tr');
    const timeText = row.kind === 'status'
      ? (row.time == null ? '无法解析' : tf.dateTime(row.raw.eventTime))
      : (row.time == null ? '无法解析'
        : `${tf.dateTime(row.raw.startTime)} → ${row.raw.endTime == null ? (row.analyzed && row.analyzed.record.effectiveEnd ? `${tf.dateTime(row.analyzed.record.effectiveEnd)}（推断）` : '缺失') : tf.dateTime(row.raw.endTime)}`);

    let content;
    if (row.kind === 'status') {
      content = STATE_LABEL[row.raw.state] || row.raw.state || '—';
    } else if (row.kind === 'order') {
      if (row.raw.endTime == null) {
        content = '结束时间缺失 · 由后续独立证据界定，否则按未确认处理';
      } else {
        content = `${fmtDuration(row.raw.endTime - row.raw.startTime, { compact: true })} · ${row.raw.energyKwh != null ? `${row.raw.energyKwh} kWh` : '电量未知'}`;
      }
    } else {
      const end = row.raw.endTime == null ? '未结束' : tf.dateTime(row.raw.endTime);
      content = `${row.raw.kind || '维修'} · ${row.raw.startTime == null ? '?' : tf.dateTime(row.raw.startTime)} → ${end}`;
    }

    tr.append(
      el('td', { class: 'nowrap' }, [
        row.issue ? el('span', { class: 'chip crit', text: KIND_LABEL[row.kind] }) : el('span', { class: 'chip', text: KIND_LABEL[row.kind] }),
      ]),
      el('td', { class: 'mono nowrap', text: row.externalId || '—' }),
      el('td', { class: 'mono nowrap', text: row.gunRef || '—' }),
      el('td', { class: 'nowrap', text: timeText }),
      el('td', { text: content }),
      el('td', { class: 'nowrap', text: row.source || '—' }),
      el('td', {}, [fateCell(row) ]),
      el('td', {}, [
        row.analyzed
          ? el('button', {
            class: 'link-btn', type: 'button', text: '详情',
            onclick: () => ctx.showRecord(row.kind, row.analyzed.record, row.analyzed.gun.gunId),
          })
          : el('button', {
            class: 'link-btn', type: 'button', text: '详情',
            onclick: () => ctx.showRecord(row.kind, rawRecordForDrawer(row), null),
          }),
      ]),
    );
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  card.append(wrap);
  void dq;
  return card;
}

function fateCell(row) {
  const chips = [];
  const record = row.analyzed ? row.analyzed.record : null;

  if (!record) {
    if (row.issue) {
      chips.push(el('span', {
        class: 'chip crit',
        text: row.issue === 'unknown_gun_ref' ? '枪口引用无法匹配' : (row.issue === 'ambiguous_gun_ref' ? '枪口引用歧义' : issueLabel(row.issue)),
      }));
    } else if (row.issueText) {
      chips.push(el('span', { class: 'chip crit', text: issueLabel(row.issueText) }));
    } else {
      chips.push(el('span', { class: 'muted', text: '未进入分析' }));
    }
    return el('span', { style: { display: 'inline-flex', gap: '4px', flexWrap: 'wrap' } }, chips);
  }

  if (row.kind === 'status') {
    chips.push(el('span', {
      class: record.fate === 'effective' ? 'chip' : 'chip warn',
      text: FATE_LABEL[record.fate] || record.fate,
    }));
    if (record.duplicateOf) {
      chips.push(el('span', { class: 'muted', text: `重复于 ${record.duplicateOf}` }));
    }
    if (record.late) {
      chips.push(el('span', {
        class: 'chip warn',
        text: `${record.late.outOfOrder ? '乱序' : '迟到'} ${fmtDuration(record.late.delayMs, { compact: true })}`,
      }));
    }
    if (record.matchedViaAlias) chips.push(el('span', { class: 'chip info', text: '别名匹配' }));
  } else if (row.kind === 'order') {
    if (record.inferredEnd) {
      chips.push(el('span', {
        class: 'chip info',
        text: `结束推断 · ${record.inferredEnd.boundRef}`,
      }));
    } else if (record.endTime == null) {
      chips.push(el('span', { class: 'chip crit', text: '结束无法确认' }));
    } else {
      chips.push(el('span', { class: 'chip', text: '已计入占用' }));
    }
    if (record.matchedViaAlias) chips.push(el('span', { class: 'chip info', text: '别名匹配' }));
  } else {
    chips.push(el('span', { class: record.open ? 'chip warn' : 'chip', text: record.open ? '未结束 · 按故障计' : '已计入故障' }));
    if (record.note) chips.push(el('span', { class: 'muted', text: record.note }));
  }
  return el('span', { style: { display: 'inline-flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' } }, chips);
}

function issueLabel(reason) {
  return ({
    invalid_state: '状态值无法识别',
    invalid_event_time: '事件时间无法解析',
    invalid_start_time: '开始时间无法解析',
    end_not_after_start: '结束早于开始',
    missing_gun_ref: '枪口引用为空',
    unknown_gun_ref: '枪口引用无法匹配',
    ambiguous_gun_ref: '枪口引用歧义',
  })[reason] || reason || '异常';
}

function rawRecordForDrawer(row) {
  const unresolved = row.issue ? issueLabel(row.issue) : null;
  if (row.kind === 'status') {
    return {
      externalId: row.raw.externalId,
      gunRef: row.raw.gunRef,
      state: row.raw.state,
      eventTime: row.raw.eventTime,
      receivedAt: row.raw.receivedAt,
      source: row.raw.source,
      payload: row.raw.payload,
      unresolved,
      fate: undefined,
    };
  }
  if (row.kind === 'order') {
    return {
      externalId: row.raw.externalId,
      gunRef: row.raw.gunRef,
      startTime: row.raw.startTime,
      endTime: row.raw.endTime,
      status: row.raw.status,
      source: row.raw.source,
      unresolved,
    };
  }
  return {
    externalId: row.raw.externalId,
    gunRef: row.raw.gunRef,
    startTime: row.raw.startTime,
    endTime: row.raw.endTime,
    kind: row.raw.kind,
    workOrder: row.raw.workOrder,
    status: row.raw.status,
    note: row.raw.note,
    source: row.raw.source,
    unresolved,
  };
}

function isSuspicious(row) {
  return !row.analyzed && !row.issue;
}
