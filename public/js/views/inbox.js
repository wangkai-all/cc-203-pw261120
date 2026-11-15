/** Late-message inbox: preview the effect, then ingest explicitly. */

import {
  el, clear, fmtDuration, fmtPercent, fmtSignedDuration, STATE_LABEL, toast,
} from '../dom.js';
import { api } from '../api.js';
import { stateChip } from '../charts.js';

const SCENARIO_LABEL = {
  late_status_changes_availability: '改变可服务判定',
  late_status_extends_fault: '延长故障时段',
  late_status_creates_occupancy: '新增占用（可疑）',
  late_status_fixes_coverage: '补足状态覆盖',
  late_status_reduces_occupancy: '缩短占用',
};

export async function renderInboxView(root, ctx) {
  const { state } = ctx;
  const header = el('div', { class: 'card-head' });
  header.append(
    el('div', {}, [
      el('h2', { text: '迟到消息待入箱' }),
      el('p', {
        class: 'card-sub',
        text: `这些消息在事件发生后很久才到达，尚未进入当前分析（v${state.data.version.seq}）。下面的变化预览假设“只补入这一条”并重算同一窗口。`,
      }),
    ]),
  );
  root.append(header);

  const host = el('div');
  root.append(host);
  host.append(el('div', { class: 'empty', text: '正在计算补入影响…' }));

  let payload;
  try {
    payload = await api.inbox(state.siteId, { version: state.data.version.id });
  } catch (error) {
    clear(host);
    host.append(el('div', { class: 'note critical', text: `加载迟到消息失败：${error.message}` }));
    return;
  }
  clear(host);

  const pending = payload.items.filter((i) => i.status === 'pending');
  const ingested = payload.items.filter((i) => i.status === 'ingested');

  if (!payload.items.length) {
    host.append(el('div', { class: 'empty', text: '该站点没有迟到消息样例。' }));
    return;
  }

  for (const item of pending) {
    host.append(renderInboxItem(item, ctx));
  }

  if (ingested.length) {
    const card = el('section', { class: 'card', style: { marginTop: '16px' } });
    card.append(el('div', { class: 'card-head' }, [el('h2', { text: '已补入' })]));
    const list = el('div', { style: { display: 'grid', gap: '6px' } });
    for (const item of ingested) {
      list.append(el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', fontSize: '12.5px', flexWrap: 'wrap' } }, [
        stateChip(item.state),
        el('span', { class: 'mono', text: item.id }),
        el('span', { class: 'muted', text: `${state.tf.dateTime(item.eventTime)} 事件 · ${state.tf.dateTime(item.receivedAt)} 到达` }),
        item.ingestedVersionId
          ? el('button', {
            class: 'link-btn', type: 'button', text: `查看补入版本 v${item.ingestedVersionId}`,
            onclick: () => ctx.navigate({ view: 'versions', version: item.ingestedVersionId }),
          })
          : el('span', { class: 'muted', text: '未记录版本' }),
      ]));
    }
    card.append(list);
    host.append(card);
  }
}

function renderInboxItem(item, ctx) {
  const { state } = ctx;
  const card = el('section', { class: 'card', style: { marginTop: '16px' } });
  const preview = item.preview;
  const head = el('div', { class: 'card-head' }, [
    el('div', {}, [
      el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, [
        stateChip(item.state),
        el('span', { class: 'mono', text: item.id }),
        item.scenario ? el('span', { class: 'chip info', text: SCENARIO_LABEL[item.scenario] || item.scenario }) : null,
      ]),
      el('p', { class: 'card-sub', style: { marginTop: '6px' } }, [
        document.createTextNode(`事件时刻 ${state.tf.dateTime(item.eventTime)} · `),
        document.createTextNode(`到达 ${state.tf.dateTime(item.receivedAt)} · `),
        document.createTextNode(`延迟 ${fmtDuration(item.receivedAt - item.eventTime, { compact: true })} · `),
        document.createTextNode(`来源 ${item.source || '—'}`),
      ]),
      item.note ? el('p', { class: 'card-sub', text: item.note }) : null,
    ]),
  ]);
  card.append(head);

  if (!preview || !preview.resolved) {
    card.append(el('div', { class: 'note critical', text: '该消息的枪口引用无法匹配，补入后会被记为“无法匹配的枪口引用”，不会改变时间线。' }));
    return card;
  }

  // Comparison: current vs after
  const compare = el('div', { class: 'grid grid-2', style: { marginTop: '10px' } });
  compare.append(metricCompare('该枪口（' + (preview.gunCode || '') + '）', preview.gunDelta));
  compare.append(metricCompare('全站', preview.siteDelta));
  card.append(compare);

  // Moment-level changes
  if (preview.moments && preview.moments.length) {
    card.append(el('h3', { style: { fontSize: '12.5px', margin: '16px 0 6px' }, text: `时段变化（${preview.momentCount} 处）` }));
    const list = el('div', { style: { display: 'grid', gap: '4px', fontSize: '12px' } });
    for (const moment of preview.moments) {
      const before = moment.beforeState ? STATE_LABEL[moment.beforeState] : '（不存在）';
      const after = moment.afterState ? STATE_LABEL[moment.afterState] : '（不存在）';
      const row = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'baseline' } });
      row.append(
        el('span', { class: 'mono nowrap', text: state.tf.timeRange(moment.start, moment.end) }),
        el('span', { class: 'muted', text: `${before} → ${after}` }),
        moment.afterReason ? el('span', { class: 'muted', text: `（${moment.afterReason}）` }) : null,
      );
      list.append(row);
    }
    if (preview.momentCount > preview.moments.length) {
      list.append(el('div', { class: 'muted', text: `… 其余 ${preview.momentCount - preview.moments.length} 处略` }));
    }
    card.append(list);
  } else {
    card.append(el('p', { class: 'card-note', text: '补入后时间线没有发生变化（该消息可能已被现有状态覆盖）。' }));
  }

  const footer = el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '16px', flexWrap: 'wrap' } });
  const button = el('button', { class: 'btn', type: 'button' }, '补入并重算');
  const note = el('span', {
    class: 'muted', style: { fontSize: '11.5px' },
    text: `将新建版本并保留当前 v${state.data.version.seq}`,
  });
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const response = await api.ingestLate(state.siteId, item.id, {
        start: state.data.version.windowStart,
        end: state.data.version.windowEnd,
      });
      toast(`已补入 ${item.id}，生成 v${response.version.seq}`);
      ctx.navigate({ view: 'versions', version: response.version.id });
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
  });
  footer.append(button, note);
  if (preview.conflictDelta) {
    footer.append(el('span', {
      class: `chip ${preview.conflictDelta > 0 ? 'warn' : 'info'}`,
      text: `冲突 ${preview.conflictDelta > 0 ? '+' : ''}${preview.conflictDelta}`,
    }));
  }
  if (preview.lateStatusCount) {
    footer.append(el('span', { class: 'chip info', text: `迟到消息 +${preview.lateStatusCount}` }));
  }
  card.append(footer);
  return card;
}

function metricCompare(label, delta) {
  const box = el('div', { style: { border: '1px solid var(--hairline)', borderRadius: '8px', padding: '10px 12px' } });
  box.append(el('div', { class: 'kpi-label', text: label }));
  const rows = [
    ['可服务', delta.availableMs],
    ['占用', delta.occupiedMs],
    ['故障', delta.faultMs],
    ['离线', delta.offlineMs],
    ['未确认', delta.unconfirmedMs],
  ];
  const grid = el('div', { style: { display: 'grid', gap: '3px', marginTop: '8px', fontSize: '12px' } });
  for (const [name, ms] of rows) {
    const row = el('div', { style: { display: 'flex', justifyContent: 'space-between' } });
    row.append(
      el('span', { class: 'muted', text: name }),
      el('b', {
        style: { color: ms === 0 ? 'var(--ink-3)' : ms > 0 ? 'var(--status-good)' : 'var(--status-critical)' },
        text: ms === 0 ? '±0' : fmtSignedDuration(ms),
      }),
    );
    grid.append(row);
  }
  for (const [name, key] of [['自然口径', 'utilizationNatural'], ['可服务口径', 'utilizationServiceable']]) {
    const value = delta[key] || 0;
    const row = el('div', { style: { display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--grid)', paddingTop: '4px' } });
    row.append(
      el('span', { class: 'muted', text: name }),
      el('b', {
        style: { color: value === 0 ? 'var(--ink-3)' : value > 0 ? 'var(--status-good)' : 'var(--status-critical)' },
        text: `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(value * 100).toFixed(1)}pp`,
      }),
    );
    grid.append(row);
  }
  box.append(grid);
  return box;
}
