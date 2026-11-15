/**
 * App shell: state, routing (hash), data loading and view rendering.
 */

import {
  el, clear, $, $$, makeTimeFormat, fmtPercent, fmtDuration, fmtSignedDuration,
  fmtDeltaPercent, STATE_LABEL, STATE_ORDER, toast, debounce,
} from './dom.js';
import { api, qs, exportUrl } from './api.js';
import {
  renderMultiGunTimeline, renderGunTimeline, renderCompositionBar,
  renderUtilizationByGun, renderDailyUtilization, stateChip, sparkline,
} from './charts.js';
import { renderOverview } from './views/overview.js';
import { renderTimelineView } from './views/timeline.js';
import { renderConflictsView } from './views/conflicts.js';
import { renderInboxView } from './views/inbox.js';
import { renderVersionsView } from './views/versions.js';
import { renderRecordsView } from './views/records.js';
import { openSegmentDrawer, openRecordDrawer, closeDrawer, initDrawer } from './views/drawer.js';

const VIEW_RENDERERS = {
  overview: renderOverview,
  timeline: renderTimelineView,
  conflicts: renderConflictsView,
  inbox: renderInboxView,
  versions: renderVersionsView,
  records: renderRecordsView,
};

const state = {
  sites: [],
  siteId: null,
  site: null,
  days: 3,
  windowStart: null,
  windowEnd: null,
  versionId: null,
  view: 'overview',
  selectedGunId: null,
  // True only when the URL names a gun. `selectedGunId` is also set implicitly
  // (first gun) and remembers the last gun visited, so it cannot tell whether
  // the user asked for a gun-scoped page.
  gunFromRoute: false,
  data: null,
  tf: null,
  loading: false,
};

const ctx = {
  state,
  navigate,
  reload: () => loadAnalysis(),
  setView,
  selectGun(gunId) {
    state.selectedGunId = gunId;
    navigate({ view: 'timeline', gun: gunId });
  },
  showSegment(gun, seg) {
    openSegmentDrawer(ctx, gun, seg);
  },
  showRecord(kind, record, gunId) {
    openRecordDrawer(ctx, kind, record, gunId);
  },
  toast,
};

// ---------------------------------------------------------------------------
// Routing: single hash route #/<siteId>/<view>?days=3&version=12&gun=...
// ---------------------------------------------------------------------------

function readHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(queryPart || '');
  return {
    siteId: segments[0] || null,
    view: segments[1] || 'overview',
    params,
  };
}

function navigate(patch = {}) {
  const route = readHash();
  const next = {
    siteId: patch.siteId !== undefined ? patch.siteId : route.siteId || state.siteId,
    view: patch.view !== undefined ? patch.view : route.view,
    days: patch.days !== undefined ? patch.days : (route.params.get('days') ?? state.days),
    version: patch.version !== undefined ? patch.version : route.params.get('version'),
    gun: patch.gun !== undefined ? patch.gun : route.params.get('gun'),
  };
  const search = new URLSearchParams();
  // A version already determines its own window; carrying `days` alongside it
  // would leave a stale preset in the URL.
  if (next.days && !next.version) search.set('days', next.days);
  if (next.version) search.set('version', next.version);
  if (next.gun) search.set('gun', next.gun);
  const q = search.toString();
  location.hash = `#/${next.siteId}/${next.view}${q ? `?${q}` : ''}`;
}

function setView(view) {
  if (!VIEW_RENDERERS[view]) view = 'overview';
  state.view = view;
  for (const btn of $$('.tabs [role="tab"]')) {
    btn.setAttribute('aria-selected', String(btn.dataset.view === view));
  }
  navigate({ view });
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function hourOfDayLabel(ms) {
  const p = state.tf.parts(ms);
  return `${p.hour}:${p.minute}`;
}

async function loadSites() {
  const { sites } = await api.sites();
  state.sites = sites;
  const select = $('#site-select');
  clear(select);
  for (const site of sites) {
    const option = document.createElement('option');
    option.value = site.id;
    option.textContent = site.name;
    select.append(option);
  }
  if (!sites.length) {
    $('#loading').textContent = '没有可分析的站点数据。';
    return;
  }
}

function windowFor(days) {
  // The server derives the window from the site's data cutoff and `days`.
  return { days };
}

async function loadAnalysis({ silent = false } = {}) {
  if (!state.siteId) return;
  if (!silent) $('#loading').hidden = false;
  const viewRoot = $('#view-root');
  viewRoot.style.opacity = state.data ? '0.55' : '1';
  state.loading = true;
  try {
    const params = state.versionId
      ? { version: state.versionId }
      : { days: state.days };
    const data = await api.analysis(state.siteId, params);
    state.data = data;
    state.site = data.site;
    state.tf = makeTimeFormat(data.site.timezone);
    state.windowStart = data.version.windowStart;
    state.windowEnd = data.version.windowEnd;
    state.versionId = data.version.id;
    state.days = Array.isArray(data.days) && data.days.length ? data.days.length : (data.requestedDays || state.days);
    if (!state.selectedGunId || !data.result.guns.some((g) => g.gunId === state.selectedGunId)) {
      state.selectedGunId = data.result.guns[0] ? data.result.guns[0].gunId : null;
    }
    renderChrome();
    renderCurrentView();
  } catch (error) {
    toast(error.message);
    $('#loading').hidden = true;
  } finally {
    state.loading = false;
    $('#loading').hidden = true;
    viewRoot.style.opacity = '1';
    $('#recompute-btn').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Chrome (filters, clock, version selector)
// ---------------------------------------------------------------------------

function renderChrome() {
  const { data, tf } = state;
  if (!data) return;
  const select = $('#site-select');
  select.value = state.siteId;

  const versionSelect = $('#version-select');
  clear(versionSelect);
  const versions = data.versions || [];
  for (const version of versions) {
    const option = document.createElement('option');
    option.value = String(version.id);
    // Notes can be long (record IDs, ISO timestamps) and auto-generated versions
    // repeat the reason inside them — keep the quick switcher short and put the
    // full note in the tooltip; the versions view lists it in full.
    option.textContent = `v${version.seq} · ${tf.dateTime(version.generatedAt).slice(5)} · ${reasonLabel(version.reason)}`;
    option.title = version.note || '';
    versionSelect.append(option);
  }
  versionSelect.value = String(data.version.id);
  if (!versions.some((v) => v.id === data.version.id)) {
    const option = document.createElement('option');
    option.value = String(data.version.id);
    option.textContent = `v${data.version.seq} · 当前`;
    versionSelect.prepend(option);
    versionSelect.value = String(data.version.id);
  }

  $('#engine-version').textContent = data.version.engineVersion;
  $('#site-clock').textContent = `站点时区 ${data.site.timezone}`;
  const start = data.version.windowStart;
  const end = data.version.windowEnd;
  $('#window-note').textContent =
    `窗口 ${tf.dateTime(start)} → ${tf.dateTime(end)}（${tf.rangeLabel(start, end)}，按站点本地日划分）· ` +
    `版本 v${data.version.seq} / 输入指纹 ${data.version.inputHash.slice(0, 10)} · 生成于 ${tf.dateTime(data.version.generatedAt)}`;

  for (const btn of $$('#range-presets button')) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.days) === state.days));
  }
  $('#recompute-btn').disabled = state.loading;
  void hourOfDayLabel;
  void windowFor;
}

function reasonLabel(reason) {
  return ({
    initial: '初始',
    manual: '手动重算',
    late_message: '迟到补入',
    auto: '按需生成',
  })[reason] || reason || '分析';
}

function renderCurrentView() {
  const viewRoot = $('#view-root');
  const render = VIEW_RENDERERS[state.view] || renderOverview;
  clear(viewRoot);
  render(viewRoot, ctx);
  viewRoot.hidden = false;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bindEvents() {
  $('#site-select').addEventListener('change', (event) => {
    navigate({ siteId: event.target.value, view: state.view, version: null, gun: null });
  });

  $('#version-select').addEventListener('change', (event) => {
    navigate({ version: Number(event.target.value) });
  });

  for (const btn of $$('#range-presets button')) {
    btn.addEventListener('click', () => {
      navigate({ days: Number(btn.dataset.days), version: null });
    });
  }

  for (const btn of $$('.tabs [role="tab"]')) {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  }

  $('#recompute-btn').addEventListener('click', async () => {
    const btn = $('#recompute-btn');
    btn.disabled = true;
    try {
      const response = await api.recompute(state.siteId, {
        start: state.windowStart,
        end: state.windowEnd,
        reason: 'manual',
        note: '手动重算（页面）',
      });
      if (response.unchanged) {
        toast('输入未变化，沿用当前版本（未新建版本）');
      } else {
        toast(`已生成 v${response.version.seq}：${response.version.note || '重算完成'}`);
      }
      navigate({ version: response.version.id });
      if (response.unchanged) await loadAnalysis();
    } catch (error) {
      toast(error.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('#export-csv').addEventListener('click', () => {
    window.location.href = exportUrl(state.siteId, { version: state.data.version.id }, 'csv');
  });
  $('#export-json').addEventListener('click', () => {
    window.location.href = exportUrl(state.siteId, { version: state.data.version.id }, 'json');
  });

  window.addEventListener('hashchange', () => { syncFromHash(); });

  const themeToggle = $('#theme-toggle');
  themeToggle.addEventListener('click', () => {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('gpa-theme', next); } catch { /* private mode */ }
  });

  $('#about-link').addEventListener('click', (event) => {
    event.preventDefault();
    showAbout();
  });

  initDrawer();
  $('#drawer-close').addEventListener('click', closeDrawer);

  window.addEventListener('resize', debounce(() => {
    if (state.data) renderCurrentView();
  }, 250));
}

let aboutDialog = null;
function showAbout() {
  if (!aboutDialog) {
    aboutDialog = el('dialog', { 'aria-label': '口径与假设' });
    aboutDialog.append(
      el('div', { class: 'modal-head' }, [
        el('h2', { text: '口径与假设' }),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭', onclick: () => aboutDialog.close() }, '✕'),
      ]),
      el('div', { class: 'modal-body' }, [
        el('p', { text: '本应用把三类记录还原成每个枪口的可服务时间段，并给出两种利用率口径。样例数据完全虚构。' }),
        el('h3', { text: '状态判定优先级' }),
        el('ol', {}, [
          el('li', { text: '故障：状态消息报故障，或处于维修工单窗口内（两者取并集，重叠只扣一次）。' }),
          el('li', { text: '离线：状态消息报离线。' }),
          el('li', { text: '占用：存在充电订单，或状态消息报占用。' }),
          el('li', { text: '未确认：订单结束时间缺失且无独立证据界定结束；或状态消息未覆盖该区间。未确认不当作空闲。' }),
          el('li', { text: '可服务：状态消息报可服务且无上述情况。' }),
        ]),
        el('h3', { text: '状态消息处理' }),
        el('ul', {}, [
          el('li', { text: '同一 externalId 或同内容重复消息只取首条；同 externalId 但载荷不同会单独列出。' }),
          el('li', { text: '同一事件时刻出现不同状态时，以到达时间最晚的一条为准，并记为“同时刻冲突”。' }),
          el('li', { text: '迟到消息不丢弃：先进入“迟到消息”待入箱，可在页面比较补入前后的结果，再显式补入。' }),
          el('li', { text: '状态最多向后延续 6 小时；更长的空档视为状态流中断，记为未确认。' }),
        ]),
        el('h3', { text: '两种利用率' }),
        el('ul', {}, [
          el('li', {}, [el('b', { text: '自然时间口径' }), document.createTextNode('：占用时长 ÷ 窗口自然时长，含故障与未确认时间。')]),
          el('li', {}, [el('b', { text: '可服务时间口径' }), document.createTextNode('：占用时长 ÷ 可服务时长（自然时长 − 故障 − 离线 − 未确认）。')]),
        ]),
        el('h3', { text: '重叠冲突' }),
        el('p', { text: '维修窗口与充电订单重叠时提示冲突；该时段按不可用计一次，不重复扣减，也不计作有效充电时长。' }),
        el('h3', { text: '枪口命名' }),
        el('p', { text: '按事件时刻匹配别名有效期：改名前的消息用旧名解析，改名后的消息即使误用旧名也能回溯到同一枪口，并在原始记录中标出。' }),
        el('h3', { text: '版本' }),
        el('p', { text: '每次重算或迟到补入都会生成新的不可变版本；相同输入不会重复生成。旧版本保留窗口、输入指纹与完整结果，可随时切回与导出。' }),
      ]),
    );
    document.body.append(aboutDialog);
  }
  aboutDialog.showModal();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function syncFromHash() {
  const route = readHash();
  const siteId = route.siteId || state.siteId || (state.sites[0] && state.sites[0].id);
  if (!siteId) return;
  const view = VIEW_RENDERERS[route.view] ? route.view : 'overview';
  const days = route.params.get('days') ? Number(route.params.get('days')) : 3;
  const version = route.params.get('version') ? Number(route.params.get('version')) : null;
  const gun = route.params.get('gun') || null;

  const siteChanged = siteId !== state.siteId;
  const versionChanged = version !== state.versionId;
  const daysChanged = days !== state.days;
  state.siteId = siteId;
  state.view = view;
  state.days = days;
  state.versionId = version;
  state.gunFromRoute = Boolean(gun);
  if (gun) state.selectedGunId = gun;
  if (siteChanged) state.selectedGunId = gun;

  for (const btn of $$('.tabs [role="tab"]')) {
    btn.setAttribute('aria-selected', String(btn.dataset.view === view));
  }

  if (!state.data || siteChanged || versionChanged || daysChanged) {
    loadAnalysis();
  } else {
    renderCurrentView();
  }
}

async function boot() {
  const saved = (() => { try { return localStorage.getItem('gpa-theme'); } catch { return null; } })();
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  bindEvents();
  try {
    await loadSites();
  } catch (error) {
    $('#loading').textContent = `加载站点失败：${error.message}`;
    return;
  }
  if (!location.hash || location.hash === '#') {
    const first = state.sites[0];
    if (first) {
      state.siteId = first.id;
      navigate({ siteId: first.id, view: 'overview' });
      return; // hashchange triggers syncFromHash
    }
  }
  syncFromHash();
}

boot();

// Re-export shared helpers used by views.
export { state, ctx, navigate, renderChrome };
