/** Versions: immutable history, input fingerprints and before/after comparison. */

import { el, clear, fmtDuration, fmtPercent, fmtDeltaPercent, fmtSignedDuration, toast } from '../dom.js';
import { api } from '../api.js';

const REASON_LABEL = {
  initial: '初始导入',
  manual: '手动重算',
  late_message: '迟到补入',
  auto: '按需生成',
};

const METRIC_ROWS = [
  ['naturalMs', '自然时长', 'ms'],
  ['serviceableMs', '可服务时长（口径分母）', 'ms'],
  ['availableMs', '可服务（空闲）', 'ms'],
  ['occupiedMs', '占用', 'ms'],
  ['faultMs', '故障', 'ms'],
  ['offlineMs', '离线', 'ms'],
  ['unconfirmedMs', '未确认', 'ms'],
  ['conflictMs', '重叠冲突', 'ms'],
  ['utilizationNatural', '自然时间口径', 'pct'],
  ['utilizationServiceable', '可服务时间口径', 'pct'],
];

export async function renderVersionsView(root, ctx) {
  const { state } = ctx;
  const { data } = state;
  const tf = state.tf;

  root.append(el('div', { class: 'note info' }, [
    el('span', { text: 'ⓘ' }),
    el('span', {}, [
      el('strong', { text: '每次重算都会新建不可变版本。' }),
      document.createTextNode(' 相同输入指纹不会重复生成；旧版本保留窗口、指纹与完整结果，可随时切回、对比与导出。'),
    ]),
  ]));

  const layout = el('div', { class: 'grid grid-2', style: { marginTop: '16px', alignItems: 'start' } });
  root.append(layout);

  // -----------------------------------------------------------------------
  // Version list (all windows for the site)
  // -----------------------------------------------------------------------
  const listCard = el('section', { class: 'card' });
  listCard.append(el('div', { class: 'card-head' }, [
    el('h2', { text: '版本历史' }),
    el('span', { class: 'card-sub', text: '当前站点全部重算版本' }),
  ]));
  const listHost = el('div', { class: 'table-wrap' });
  listHost.append(el('div', { class: 'empty', text: '正在读取版本…' }));
  listCard.append(listHost);
  layout.append(listCard);

  let versions = data.versions || [];
  try {
    const response = await api.versions(state.siteId);
    if (response.versions) versions = response.versions;
  } catch {
    // Fall back to the versions embedded in the analysis response.
  }
  clear(listHost);
  if (!versions.length) {
    listHost.append(el('div', { class: 'empty', text: '还没有版本记录。' }));
  } else {
    const table = el('table');
    table.append(el('thead', {}, [el('tr', {}, [
      el('th', { text: '版本' }),
      el('th', { text: '分析窗口' }),
      el('th', { text: '生成时间' }),
      el('th', { text: '原因 / 备注' }),
      el('th', { text: '输入指纹' }),
      el('th', { text: '' }),
    ])]));
    const body = el('tbody');
    for (const version of versions) {
      const current = version.id === data.version.id;
      const sameWindow = version.windowStart === data.version.windowStart && version.windowEnd === data.version.windowEnd;
      const tr = el('tr', { style: current ? { background: 'var(--surface-2)' } : {} });
      tr.append(
        el('td', { class: 'nowrap' }, [
          el('b', { text: `v${version.seq}` }),
          current ? el('span', { class: 'chip info', style: { marginLeft: '6px' }, text: '当前' }) : null,
          sameWindow && !current ? el('span', { class: 'chip', style: { marginLeft: '6px' }, text: '同窗口' }) : null,
        ]),
        el('td', { class: 'nowrap mono', text: `${tf.dateShort(version.windowStart)}–${tf.dateShort(version.windowEnd)}` }),
        el('td', { class: 'nowrap', text: tf.dateTime(version.generatedAt) }),
        el('td', {}, [
          el('span', { text: REASON_LABEL[version.reason] || version.reason || '—' }),
          version.note ? el('div', { class: 'muted', style: { fontSize: '11.5px' }, text: version.note }) : null,
        ]),
        el('td', {}, [
          el('span', { class: 'mono', text: version.inputHash.slice(0, 10) }),
          el('div', { class: 'muted', style: { fontSize: '11px' }, text: `引擎 ${version.engineVersion}` }),
        ]),
        el('td', {}, [
          current
            ? el('span', { class: 'muted', text: '正在查看' })
            : el('button', {
              class: 'link-btn', type: 'button', text: '查看该版本',
              onclick: () => ctx.navigate({ view: 'versions', version: version.id }),
            }),
        ]),
      );
      body.append(tr);
    }
    table.append(body);
    listHost.append(table);
  }

  // Recompute action lives here too, so the flow is discoverable.
  const actions = el('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginTop: '12px' } });
  const recompute = el('button', { class: 'btn', type: 'button' }, '重算并生成新版本');
  recompute.addEventListener('click', async () => {
    recompute.disabled = true;
    try {
      const response = await api.recompute(state.siteId, {
        start: data.version.windowStart,
        end: data.version.windowEnd,
        reason: 'manual',
        note: '手动重算（版本页）',
      });
      toast(response.unchanged
        ? '输入未变化，沿用当前版本'
        : `已生成 v${response.version.seq}`);
      ctx.navigate({ view: 'versions', version: response.version.id });
      if (response.unchanged) ctx.reload();
    } catch (error) {
      toast(error.message);
      recompute.disabled = false;
    }
  });
  actions.append(
    recompute,
    el('span', { class: 'muted', style: { fontSize: '11.5px' }, text: '相同输入指纹 → 不新建版本，直接沿用。' }),
  );
  listCard.append(actions);

  // -----------------------------------------------------------------------
  // Current vs previous (same window)
  // -----------------------------------------------------------------------
  const prev = data.previousVersion;
  const prevResult = data.previousResult;
  const compareCard = el('section', { class: 'card' });
  compareCard.append(el('div', { class: 'card-head' }, [
    el('h2', { text: '版本对比' }),
    el('span', {
      class: 'card-sub',
      text: prev ? `v${prev.seq} → v${data.version.seq}（同窗口）` : '该窗口尚无上一版本',
    }),
  ]));
  layout.append(compareCard);

  if (!prev || !prevResult) {
    compareCard.append(el('div', {
      class: 'empty',
      text: '这是该分析窗口的第一个版本。补入一条迟到消息或再次重算后，这里会显示两个版本的逐项差异。',
    }));
  } else {
    const rec = el('div', { class: 'note' });
    rec.append(el('span', { text: '↺' }));
    rec.append(el('span', {}, [
      el('strong', { text: `v${prev.seq}（${REASON_LABEL[prev.reason] || prev.reason}）` }),
      document.createTextNode(` 生成于 ${tf.dateTime(prev.generatedAt)}；`),
      el('strong', { text: ` v${data.version.seq}（${REASON_LABEL[data.version.reason] || data.version.reason}）` }),
      document.createTextNode(` 生成于 ${tf.dateTime(data.version.generatedAt)}。`),
      data.version.note ? document.createTextNode(` 备注：${data.version.note}`) : document.createTextNode(''),
    ]));
    compareCard.append(rec);

    const hashChanged = prev.inputHash !== data.version.inputHash;
    compareCard.append(el('p', {
      class: 'card-sub',
      style: { marginTop: '10px' },
      text: `输入指纹 ${prev.inputHash.slice(0, 10)} → ${data.version.inputHash.slice(0, 10)}`
        + (hashChanged ? '（输入已变化）' : '（输入未变化，仅规则/引擎或强制重算导致新版本）'),
    }));

    compareCard.append(metricTable(prevResult.siteMetrics, data.result.siteMetrics));
    compareCard.append(gunDeltaTable(prevResult.guns, data.result.guns, ctx));

    const conflictChanges = diffById(prevResult.conflicts, data.result.conflicts);
    const dqBefore = prevResult.dataQuality.counts;
    const dqAfter = data.result.dataQuality.counts;

    const detailGrid = el('div', { class: 'grid', style: { gap: '10px', marginTop: '14px' } });
    detailGrid.append(
      changeBlock(`冲突变化（+${conflictChanges.added.length} / −${conflictChanges.removed.length}）`, conflictChanges, ctx),
      dataQualityDiff(dqBefore, dqAfter),
    );
    compareCard.append(detailGrid);
  }
}

function metricCell(value, kind) {
  return kind === 'pct' ? fmtPercent(value) : fmtDuration(value, { compact: true });
}

function metricTable(before, after) {
  const wrap = el('div', { class: 'table-wrap', style: { marginTop: '12px' } });
  const table = el('table');
  table.append(el('thead', {}, [el('tr', {}, [
    el('th', { text: '全站指标' }),
    el('th', { class: 'num', text: '上一版本' }),
    el('th', { class: 'num', text: '当前版本' }),
    el('th', { class: 'num', text: '变化' }),
  ])]));
  const body = el('tbody');
  for (const [key, label, kind] of METRIC_ROWS) {
    const a = before[key] || 0;
    const b = after[key] || 0;
    const diff = b - a;
    const tr = el('tr');
    tr.append(
      el('td', { text: label }),
      el('td', { class: 'num', text: metricCell(a, kind) }),
      el('td', { class: 'num', text: metricCell(b, kind) }),
      el('td', { class: 'num' }, [deltaNode(diff, kind)]),
    );
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

function deltaNode(diff, kind) {
  const threshold = kind === 'pct' ? 0.00005 : 1000;
  if (Math.abs(diff) < threshold) return el('span', { class: 'muted', text: '±0' });
  const text = kind === 'pct' ? fmtDeltaPercent(diff, 1) : fmtSignedDuration(diff);
  return el('span', {
    class: diff > 0 ? 'up' : 'down',
    style: { color: diff > 0 ? 'var(--status-good)' : 'var(--status-critical)', fontWeight: 600 },
    text,
  });
}

function gunDeltaTable(prevGuns, guns, ctx) {
  const prevMap = new Map(prevGuns.map((g) => [g.gunId, g]));
  const wrap = el('div', { class: 'table-wrap', style: { marginTop: '14px' } });
  const table = el('table');
  table.append(el('thead', {}, [el('tr', {}, [
    el('th', { text: '枪口' }),
    el('th', { class: 'num', text: '自然口径' }),
    el('th', { class: 'num', text: '可服务口径' }),
    el('th', { class: 'num', text: '占用 Δ' }),
    el('th', { class: 'num', text: '故障 Δ' }),
    el('th', { class: 'num', text: '未确认 Δ' }),
  ])]));
  const body = el('tbody');
  for (const gun of guns) {
    const before = prevMap.get(gun.gunId);
    if (!before) continue;
    const b = before.metrics;
    const a = gun.metrics;
    const tr = el('tr');
    const name = el('td');
    name.append(el('button', {
      class: 'link-btn', type: 'button', text: gun.displayName,
      onclick: () => ctx.selectGun(gun.gunId),
    }));
    tr.append(
      name,
      el('td', { class: 'num' }, [
        el('span', { text: fmtPercent(a.utilizationNatural) }),
        Math.abs(a.utilizationNatural - b.utilizationNatural) >= 0.00005
          ? el('div', {}, [deltaNode(a.utilizationNatural - b.utilizationNatural, 'pct')])
          : null,
      ]),
      el('td', { class: 'num' }, [
        el('span', { text: fmtPercent(a.utilizationServiceable) }),
        Math.abs(a.utilizationServiceable - b.utilizationServiceable) >= 0.00005
          ? el('div', {}, [deltaNode(a.utilizationServiceable - b.utilizationServiceable, 'pct')])
          : null,
      ]),
      el('td', { class: 'num' }, [deltaNode(a.occupiedMs - b.occupiedMs, 'ms')]),
      el('td', { class: 'num' }, [deltaNode(a.faultMs - b.faultMs, 'ms')]),
      el('td', { class: 'num' }, [deltaNode(a.unconfirmedMs - b.unconfirmedMs, 'ms')]),
    );
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

function diffById(before, after) {
  const beforeMap = new Map(before.map((c) => [c.id, c]));
  const afterMap = new Map(after.map((c) => [c.id, c]));
  return {
    added: after.filter((c) => !beforeMap.has(c.id)),
    removed: before.filter((c) => !afterMap.has(c.id)),
  };
}

function changeBlock(title, changes, ctx) {
  const box = el('div', { style: { border: '1px solid var(--hairline)', borderRadius: '8px', padding: '10px 12px' } });
  box.append(el('div', { class: 'kpi-label', text: title }));
  const list = el('div', { style: { display: 'grid', gap: '4px', marginTop: '8px', fontSize: '12px' } });
  const typeLabel = {
    maintenance_overlap_charging: '维修 × 充电',
    fault_overlap_charging: '故障 × 充电',
    offline_overlap_charging: '离线 × 充电',
  };
  for (const [sign, items] of [['+', changes.added], ['−', changes.removed]]) {
    for (const conflict of items.slice(0, 6)) {
      const row = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
      row.append(
        el('span', {
          class: 'mono',
          style: { color: sign === '+' ? 'var(--status-critical)' : 'var(--status-good)' },
          text: sign,
        }),
        el('span', { text: conflict.gunCode }),
        el('span', { class: 'muted', text: `${typeLabel[conflict.type] || conflict.type} · ${ctx.state.tf.timeRange(conflict.start, conflict.end)}` }),
        el('span', { class: 'muted', text: fmtDuration(conflict.ms, { compact: true }) }),
      );
      list.append(row);
    }
    if (items.length > 6) {
      list.append(el('div', { class: 'muted', text: `… 其余 ${items.length - 6} 处略` }));
    }
  }
  if (!changes.added.length && !changes.removed.length) {
    list.append(el('div', { class: 'muted', text: '冲突集合未变化。' }));
  }
  box.append(list);
  return box;
}

function dataQualityDiff(before, after) {
  const rows = [
    ['duplicatesSuppressed', '重复消息抑制'],
    ['lateStatuses', '迟到消息'],
    ['sameTimeStatusConflicts', '同时刻状态冲突'],
    ['inferredOrderEnds', '推断的订单结束'],
    ['openOrders', '结束无法确认的订单'],
    ['unresolvedRefs', '无法匹配的引用'],
    ['invalidRecords', '无效记录'],
  ];
  const box = el('div', { style: { border: '1px solid var(--hairline)', borderRadius: '8px', padding: '10px 12px' } });
  box.append(el('div', { class: 'kpi-label', text: '数据质量变化' }));
  const grid = el('div', { style: { display: 'grid', gap: '3px', marginTop: '8px', fontSize: '12px' } });
  for (const [key, label] of rows) {
    const a = before[key] || 0;
    const b = after[key] || 0;
    const row = el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px' } });
    row.append(
      el('span', { class: 'muted', text: label }),
      el('span', {}, [
        el('span', { text: String(b) }),
        b !== a
          ? el('span', {
            class: 'muted',
            style: { marginLeft: '5px' },
            text: `(${b > a ? '+' : '−'}${Math.abs(b - a)}，原 ${a})`,
          })
          : null,
      ]),
    );
    grid.append(row);
  }
  box.append(grid);
  return box;
}
