/** Small DOM helpers. All labels are untrusted data: use textContent. */

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    node.setAttribute(key, String(value));
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const STATE_LABEL = {
  available: '可服务',
  occupied: '占用',
  fault: '故障',
  offline: '离线',
  unconfirmed: '未确认',
};

export const STATE_ORDER = ['available', 'occupied', 'fault', 'offline', 'unconfirmed'];

export function fmtPercent(value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function fmtDeltaPercent(value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
  return `${sign}${(Math.abs(value) * 100).toFixed(digits)}pp`;
}

export function fmtDuration(ms, { compact = false } = {}) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const sign = ms < 0 ? '−' : '';
  const abs = Math.abs(ms);
  if (compact) {
    if (abs >= HOUR) return `${sign}${(abs / HOUR).toFixed(1)}h`;
    return `${sign}${Math.round(abs / MIN)}m`;
  }
  const h = Math.floor(abs / HOUR);
  const m = Math.round((abs % HOUR) / MIN);
  if (h === 0) return `${sign}${m} 分钟`;
  if (m === 0) return `${sign}${h} 小时`;
  return `${sign}${h} 小时 ${m} 分`;
}

export function fmtSignedDuration(ms) {
  if (ms == null || ms === 0) return '0 分钟';
  return `${ms > 0 ? '+' : '−'}${fmtDuration(Math.abs(ms))}`;
}

const pad2 = (n) => String(n).padStart(2, '0');

export function makeTimeFormat(tz) {
  const fmtParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const dateFmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz, month: 'long', day: 'numeric', weekday: 'short',
  });
  return {
    parts(ms) {
      const out = {};
      for (const p of fmtParts.formatToParts(new Date(ms))) out[p.type] = p.value;
      return out;
    },
    date(ms) {
      const p = this.parts(ms);
      return `${p.year}-${p.month}-${p.day}`;
    },
    hm(ms) {
      const p = this.parts(ms);
      return `${p.hour}:${p.minute}`;
    },
    dateShort(ms) {
      const p = this.parts(ms);
      return `${Number(p.month)}/${Number(p.day)}`;
    },
    dateTime(ms) {
      const p = this.parts(ms);
      return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
    },
    timeRange(start, end) {
      const a = this.parts(start);
      const b = this.parts(end);
      const sameDay = a.year === b.year && a.month === b.month && a.day === b.day;
      if (sameDay) return `${a.hour}:${a.minute}–${b.hour}:${b.minute}`;
      return `${a.month}-${a.day} ${a.hour}:${a.minute} → ${b.month}-${b.day} ${b.hour}:${b.minute}`;
    },
    rangeLabel(start, end) {
      return `${dateFmt.format(new Date(start))} → ${dateFmt.format(new Date(end - 1))}`;
    },
  };
}

export function fmtMinutes(ms) {
  return `${(ms / MIN).toFixed(0)}`;
}

export function debounce(fn, wait = 200) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export function toast(message, ms = 2600) {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { node.hidden = true; }, ms);
}

export function setPressedGroup(nodes, active) {
  for (const node of nodes) node.setAttribute('aria-pressed', String(node === active));
}
