/* แดชบอร์ดคลังยาและการจ่ายยา (Dashboard02) : dashboard.html
 * อ่านข้อมูลจริงจาก API ของเราเอง /api/data (ฟังก์ชันบน Vercel อ่าน Supabase ด้วย key ใน env ฝั่งเซิร์ฟเวอร์)
 * หน้าเว็บไม่มี key ไม่ใช้ supabase-js และไม่เรียก URL ของ Supabase ตรง
 * ถ้า /api/data ใช้ไม่ได้ จะอ่านไฟล์ JSON สำรองใน ./data/ แทน
 * ทดสอบผ่านลิงก์ Vercel เท่านั้น (Live Server ไม่รัน /api)
 */
'use strict';

// ทุกการอ่านข้อมูลหลักผ่าน endpoint นี้เท่านั้น
const API_URL = '/api/data';
const API_TIMEOUT_MS = 8000;
// ไฟล์สำรอง: ลอง ./data/ ก่อน ถ้าไม่มีจึงลองไฟล์ที่วางไว้ข้าง dashboard.html
const FALLBACK = {
  drugs: ['./data/drugs_update.json', './drugs_update.json'],
  stock: ['./data/stock.json', './stock.json'],
  log: ['./data/dispense-log.json', './dispense-log.json'],
};
const FLAG = {
  expired_lot: { severity: 'high', message: 'จ่ายหลังวันหมดอายุของล็อต (ณ วันจ่าย)' },
  missing_incident: { severity: 'high', message: 'ไม่มี incident_ref ทั้งที่จ่ายจากล็อตหมดอายุ' },
  sku_lot_mismatch: { severity: 'medium', message: 'ไม่พบล็อตนี้ภายใต้ SKU ที่บันทึกในคลัง' },
  after_as_of: { severity: 'medium', message: 'วันที่จ่ายอยู่หลังวัน as_of' },
  fractional_qty: { severity: 'low', message: 'qty ไม่เป็นจำนวนเต็ม' },
};

const SEV_LABEL = { high: 'สูง', medium: 'กลาง', low: 'ต่ำ' };
const STATUS_BADGE = { active: 'ok', quarantine: 'warn', written_off: 'muted' };
const BUCKETS = [
  { key: 'expired', label: 'หมดอายุแล้ว', cls: 'danger', test: d => d < 0 },
  { key: 'd30', label: '≤ 30 วัน', cls: 'danger', test: d => d >= 0 && d <= 30 },
  { key: 'd60', label: '31–60 วัน', cls: 'warn', test: d => d > 30 && d <= 60 },
  { key: 'd90', label: '61–90 วัน', cls: 'info', test: d => d > 60 && d <= 90 },
  { key: 'gt90', label: '> 90 วัน', cls: 'ok', test: d => d > 90 },
];

const state = {
  drugs: null, D: {}, stock: [], log: [], meta: {},
  asOf: null, logMin: null, logMax: null,
  from: null, to: null, preset: 'all',
  bucket: null,
  charts: {},
  csv: {},
};

/* ---------------- ยูทิลิตี ---------------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (v, d = 0) => v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('th-TH', { minimumFractionDigits: d, maximumFractionDigits: d });
const baht = v => nf(v, 2);
const toUTC = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 864e5);
const addDays = (s, n) => new Date(toUTC(s) + n * 864e5).toISOString().slice(0, 10);
const thDate = s => s ? new Date(toUTC(s)).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' }) : '—';
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const drugName = sku => state.D[sku] ? `${state.D[sku].generic_name} ${state.D[sku].strength}` : sku;
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

/* ---------------- โหลดข้อมูล ---------------- */
const okBlock = b => b && Array.isArray(b.items);

// เรียก /api/data (ไม่ใส่ key ใด ๆ) หมดเวลา 8 วินาที ต้องได้ 200 และมี drugs/stock/dispense_log ครบ
async function loadFromApi() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const r = await fetch(API_URL, { cache: 'no-store', signal: ctrl.signal });
    if (r.status !== 200) throw new Error(`${API_URL}: HTTP ${r.status}`);
    const j = await r.json();
    if (!okBlock(j.drugs) || !okBlock(j.stock) || !okBlock(j.dispense_log)) throw new Error(`${API_URL}: ข้อมูลไม่ครบ (drugs/stock/dispense_log)`);
    return { source: 'supabase', drugs: j.drugs, stock: j.stock, log: j.dispense_log };
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `${API_URL}: หมดเวลา ${API_TIMEOUT_MS / 1000} วินาที` : (e.message || String(e)));
  } finally { clearTimeout(timer); }
}

// ทางสำรอง: อ่านไฟล์ JSON ทีละตำแหน่งตาม FALLBACK จนกว่าจะเจอ
async function fetchFirst(paths) {
  let last;
  for (const p of paths) {
    try {
      const r = await fetch(p, { cache: 'no-store' });
      if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
      const j = await r.json();
      if (!okBlock(j)) throw new Error(`${p}: ไม่มี items`);
      return { path: p, data: j };
    } catch (e) { last = e; }
  }
  throw last;
}
async function loadFromFiles() {
  const [d, s, l] = await Promise.all([FALLBACK.drugs, FALLBACK.stock, FALLBACK.log].map(fetchFirst));
  return { source: 'file', drugs: d.data, stock: s.data, log: l.data, files: [d.path, s.path, l.path] };
}

// ธงของรายการจ่าย คำนวณในหน้าเว็บ เพราะทั้ง /api/data และไฟล์ดิบไม่มีฟิลด์ flags
function computeFlags(x) {
  if (x.type !== 'dispense') return [];
  const out = [], add = code => out.push({ code, ...FLAG[code] });
  const lot = state.stock.find(s => s.sku === x.sku && s.lot === x.lot);
  const day = x.datetime.slice(0, 10);
  if (!lot) add('sku_lot_mismatch');
  else if (lot.expiry && day > lot.expiry) { // เกณฑ์เดียวกับ view v_dispensed_from_expired
    add('expired_lot');
    if ('incident_ref' in x && !x.incident_ref) add('missing_incident'); // ตรวจได้เฉพาะไฟล์สำรองที่มี incident_ref
  }
  if (day > state.asOf) add('after_as_of');
  if (!Number.isInteger(Number(x.qty))) add('fractional_qty');
  return out;
}

async function load() {
  let data, apiErr = null;
  try {
    data = await loadFromApi();                       // 1) ข้อมูลจริงจาก Supabase ผ่าน /api/data
  } catch (e1) {
    apiErr = e1;
    try {
      data = await loadFromFiles();                   // 2) ทางสำรอง: ไฟล์ JSON (ไม่ใช่ข้อมูลล่าสุด)
    } catch (e2) {
      $('#error').innerHTML = `<div class="error-box"><b>โหลดข้อมูลไม่สำเร็จ</b><br>
        ${esc(apiErr.message)}<br>ไฟล์สำรอง: ${esc(e2.message || e2)}<br><br>
        ทดสอบผ่านลิงก์ Vercel เท่านั้น (Live Server ไม่รัน /api)</div>`;
      return;
    }
  }
  const { drugs, stock, log } = data;
  state.source = data.source;
  state.apiErr = apiErr;
  state.files = data.files || [];
  state.drugs = drugs;
  drugs.items.forEach(d => { state.D[d.sku] = d; });
  state.stock = stock.items;
  state.meta = { drugs: drugs.meta, stock: stock.meta, log: log.meta };
  state.asOf = stock.meta.as_of;                      // วันอ้างอิงจาก stock.meta.as_of เท่านั้น ไม่ใช้ new Date()
  state.log = log.items.map(x => ({ ...x, type: x.type || 'dispense' }));
  state.log.forEach(x => { x.flags = computeFlags(x); });
  const dates = state.log.map(x => x.datetime.slice(0, 10)).sort();
  state.logMin = dates[0];
  state.logMax = dates[dates.length - 1];
  showSource();
  init();
}

// แสดงแหล่งข้อมูลจริงที่มุมบน ใน footer และหัวแท็บการจ่ายยา
function showSource() {
  const counts = `${state.stock.length} ล็อต · ${state.log.length} รายการจ่าย`;
  if (state.source === 'supabase') {
    const b = $('#source-badge');
    b.textContent = `ข้อมูลจาก Supabase · as_of ${state.asOf} · ${counts}`;
    b.hidden = false;
    $('#footer-source').textContent = 'Supabase ผ่าน /api/data (ตาราง drugs, stock, dispense_log)';
    $('#di-source-note').textContent = 'จากตาราง dispense_log ใน Supabase · KPI นับเฉพาะ type = dispense · void และ return แสดงแยก';
  } else {
    const bn = $('#source-banner');
    bn.innerHTML = `<b>ข้อมูลสำรองจากไฟล์ (ไม่ใช่ข้อมูลล่าสุด)</b> · as_of ${esc(state.asOf)} · ${esc(counts)}<br>
      <span class="mono" style="font-size:12px">/api/data ใช้ไม่ได้: ${esc(state.apiErr ? state.apiErr.message : '')} · ทดสอบผ่านลิงก์ Vercel เท่านั้น (Live Server ไม่รัน /api)</span>`;
    bn.hidden = false;
    $('#footer-source').textContent = `ไฟล์สำรอง ${state.files.join(', ')}`;
    $('#di-source-note').textContent = `จากไฟล์สำรอง ${state.files[2] || ''} · KPI นับเฉพาะ type = dispense · void และ return แสดงแยก`;
  }
}

/* ---------------- การคำนวณ ---------------- */
function rangeDays() { return daysBetween(state.from, state.to) + 1; }
// ทุกประเภท (dispense/void/return) ในช่วงที่เลือก เทียบวันเป็นข้อความ ไม่แปลงเขตเวลา
function logInRange() {
  return state.log.filter(x => { const d = x.datetime.slice(0, 10); return d >= state.from && d <= state.to; });
}
// เฉพาะการจ่ายจริง ใช้กับ KPI กราฟ และอัตราการใช้
const isDispense = x => x.type === 'dispense';
function usagePerDay(rows) {
  const n = rangeDays(), u = {};
  rows.forEach(x => { u[x.sku] = (u[x.sku] || 0) + x.qty; });
  Object.keys(u).forEach(k => { u[k] /= n; });
  return u;
}
const isUsable = s => s.status === 'active' && !!s.expiry && s.expiry >= state.asOf && s.qty_on_hand > 0;
function stockSkus() { return [...new Set(state.stock.map(s => s.sku))]; }
function availableBySku() {
  const a = {};
  // ยอดใช้ได้ = ล็อต active ที่ expiry >= as_of และ qty_on_hand > 0 (ตรงกับ v_stock_by_sku)
  state.stock.forEach(s => {
    if (isUsable(s)) a[s.sku] = (a[s.sku] || 0) + s.qty_on_hand;
  });
  return a;
}
function lotDays(s) { return s.expiry ? daysBetween(state.asOf, s.expiry) : null; }
function lotAnomalies(s) {
  const out = [];
  if (!s.expiry) out.push('ไม่มีวันหมดอายุ');
  else if (s.expiry < s.received_date) out.push('วันหมดอายุก่อนวันรับเข้า');
  if (s.expiry && s.expiry < state.asOf && s.qty_on_hand > 0) out.push('หมดอายุแต่ยังมียอด');
  return out;
}

/* FEFO: ไล่จ่ายล็อต active ของแต่ละ SKU ตามวันหมดอายุ ด้วยอัตราการใช้คงที่
 * คืนค่าต่อล็อต: ลำดับ, จำนวนที่คาดว่าจ่ายได้ก่อนหมดอายุ, จำนวนที่คาดว่าเหลือทิ้ง */
function fefo(usage) {
  const bySku = {};
  state.stock.filter(s => s.status === 'active' && s.qty_on_hand > 0)
    .forEach(s => (bySku[s.sku] = bySku[s.sku] || []).push(s));
  const out = [];
  Object.entries(bySku).forEach(([sku, lots]) => {
    lots.sort((a, b) => (a.expiry || '9999') < (b.expiry || '9999') ? -1 : 1);
    const u = usage[sku] || 0;
    let t = 0; // วันที่ผ่านไปหลัง as_of ที่ยอดถูกจ่ายถึง
    lots.forEach((s, i) => {
      const d = lotDays(s);
      let sold, waste;
      if (d == null) { sold = s.qty_on_hand; waste = 0; t += u > 0 ? s.qty_on_hand / u : 0; }
      else if (u <= 0) { sold = 0; waste = s.qty_on_hand; }
      else if (t >= d) { sold = 0; waste = s.qty_on_hand; }
      else {
        const need = s.qty_on_hand / u;
        if (t + need <= d) { sold = s.qty_on_hand; waste = 0; t += need; }
        else { sold = Math.floor(u * (d - t)); waste = s.qty_on_hand - sold; t = d; }
      }
      out.push({ ...s, order: i + 1, lotCount: lots.length, days: d, usage: u, sold, waste, wasteValue: waste * s.unit_cost });
    });
  });
  return out;
}

function orderPlan(usage) {
  const lead = Math.max(0, +$('#lead').value || 0);
  const cover = Math.max(0, +$('#cover').value || 0);
  const avail = availableBySku();
  return stockSkus().map(sku => {
    const d = state.D[sku];
    const lots = state.stock.filter(s => s.sku === sku);
    const latest = lots.slice().sort((a, b) => a.received_date < b.received_date ? 1 : -1)[0];
    const quarantine = sum(lots.filter(s => s.status === 'quarantine'), s => s.qty_on_hand);
    const a = avail[sku] || 0;
    const u = usage[sku] || 0;
    const daysCover = u > 0 ? a / u : null;
    const below = a < d.reorder_level;
    const fast = daysCover != null && daysCover < lead;
    const need = below || fast;
    const raw = Math.ceil(u * (lead + cover) + d.reorder_level - a);
    const suggest = need && raw > 0 ? raw : 0;
    return {
      sku, name: d.generic_name, strength: d.strength, unit: d.unit, category: d.category,
      available: a, quarantine, reorder: d.reorder_level, usage: u, daysCover,
      below, fast, need, suggest, unitCost: latest.unit_cost, cost: suggest * latest.unit_cost,
    };
  }).sort((x, y) => (y.need - x.need) || ((x.daysCover ?? 1e9) - (y.daysCover ?? 1e9)) || x.sku.localeCompare(y.sku));
}

/* ---------------- ตาราง ---------------- */
function renderTable(el, cols, rows, rowClass) {
  if (!rows.length) { el.innerHTML = `<tbody><tr><td class="empty">ไม่มีรายการ</td></tr></tbody>`; return; }
  el.innerHTML = `<thead><tr>${cols.map(c => `<th class="${c.num ? 'num' : ''}" scope="col">${esc(c.label)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map(r => `<tr class="${rowClass ? rowClass(r) : ''}">${cols.map(c =>
    `<td class="${c.num ? 'num' : ''}">${c.html ? c.html(r) : esc(c.val(r))}</td>`).join('')}</tr>`).join('')}</tbody>`;
}
function setCsv(key, cols, rows, filename) {
  state.csv[key] = { cols, rows, filename };
}
function downloadCsv(key) {
  const c = state.csv[key];
  if (!c) return;
  const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [c.cols.map(x => q(x.label)).join(','), ...c.rows.map(r => c.cols.map(x => q(x.csv ? x.csv(r) : x.val(r))).join(','))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${c.filename}_${state.from}_${state.to}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------------- กราฟ ---------------- */
function chart(id, config) {
  if (state.charts[id]) state.charts[id].destroy();
  const ink = cssVar('--text'), muted = cssVar('--muted'), grid = cssVar('--c-grid');
  Chart.defaults.font.family = '"Inter","Noto Sans Thai",sans-serif';
  Chart.defaults.color = muted;
  const scales = config.options?.scales || {};
  Object.values(scales).forEach(s => {
    s.grid = { color: grid, ...(s.grid || {}) };
    s.ticks = { color: muted, ...(s.ticks || {}) };
    s.border = { color: grid };
  });
  const userPlugins = config.options?.plugins || {};
  config.options = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    ...config.options,
    plugins: {
      ...userPlugins,
      legend: { display: false, labels: { color: ink }, ...(userPlugins.legend || {}) },
      tooltip: { backgroundColor: ink, titleColor: cssVar('--bg'), bodyColor: cssVar('--bg'), ...(userPlugins.tooltip || {}) },
    },
  };
  state.charts[id] = new Chart(document.getElementById(id), config);
}
function dailySeries(rows) {
  const n = rangeDays(), labels = [], counts = [];
  const c = {};
  rows.forEach(x => { const d = x.datetime.slice(0, 10); c[d] = (c[d] || 0) + 1; });
  for (let i = 0; i < n; i++) { const d = addDays(state.from, i); labels.push(thDate(d)); counts.push(c[d] || 0); }
  return { labels, counts };
}
function barDaily(id, rows) {
  const s = dailySeries(rows);
  chart(id, {
    type: 'bar',
    data: { labels: s.labels, datasets: [{ label: 'ครั้ง', data: s.counts, backgroundColor: cssVar('--c-bar'), borderRadius: 4 }] },
    options: { scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });
}

/* ---------------- ช่วงเวลา ---------------- */
function setPreset(p) {
  state.preset = p;
  state.to = state.logMax;
  state.from = p === 'all' ? state.logMin : addDays(state.logMax, -(+p - 1));
  if (state.from < state.logMin) state.from = state.logMin;
  syncRangeInputs();
  renderAll();
}
function syncRangeInputs() {
  $('#date-from').value = state.from;
  $('#date-to').value = state.to;
  $$('[data-preset]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset)));
  $('#range-info').textContent = `${thDate(state.from)} – ${thDate(state.to)} · ${rangeDays()} วัน`;
}
function onDateInput() {
  let f = $('#date-from').value || state.logMin, t = $('#date-to').value || state.logMax;
  f = f < state.logMin ? state.logMin : f > state.logMax ? state.logMax : f;
  t = t < state.logMin ? state.logMin : t > state.logMax ? state.logMax : t;
  if (f > t) [f, t] = [t, f];
  state.from = f; state.to = t; state.preset = null;
  syncRangeInputs();
  renderAll();
}

/* ---------------- แท็บ: ภาพรวม ---------------- */
function renderOverview(ctx) {
  const { rows, plan, risk, lots } = ctx;
  const availValue = sum(state.stock.filter(s => s.status === 'active'), s => s.qty_on_hand * s.unit_cost);
  // ใกล้หมดอายุ ≤ 90 วัน: ล็อต active ที่ยังมียอด และ 0 ≤ วันคงเหลือ ≤ 90 (ตรงกับ v_near_expiry)
  const soon = lots.filter(s => s.status === 'active' && s.days != null && s.days >= 0 && s.days <= 90);
  const soonDanger = soon.filter(s => s.days <= 30).length;
  const expiredN = lots.filter(s => s.days != null && s.days < 0).length;
  const others = ctx.allRows.filter(r => !isDispense(r));
  const needs = plan.filter(p => p.need);
  const flagged = rows.filter(r => r.flags.length);
  const high = flagged.filter(r => r.flags.some(f => f.severity === 'high'));
  $('#ov-kpis').innerHTML = [
    kpiCard('stock', 'มูลค่าคงคลังพร้อมจ่าย', `฿${baht(availValue)}`, `${stockSkus().length} SKU · ${state.stock.filter(s => s.status === 'active').length} ล็อต active`),
    kpiCard('expiry', 'ล็อตใกล้หมดอายุ ≤ 90 วัน', nf(soon.length), `≤ 30 วัน ${soonDanger} ล็อต · หมดอายุแล้วยังมียอด ${expiredN} ล็อต`, soonDanger || expiredN ? 'danger' : 'warn'),
    kpiCard('order', 'SKU ที่ต้องสั่งซื้อ', nf(needs.length), `ประมาณ ฿${baht(sum(needs, p => p.cost))}`, needs.length ? 'warn' : ''),
    kpiCard('dispense', 'การจ่ายยาในช่วงที่เลือก', nf(rows.length), `${nf(sum(rows, r => r.qty), 1)} หน่วย · ${new Set(rows.map(r => r.patient_code)).size} ผู้ป่วย · void ${others.filter(r => r.type === 'void').length} · return ${others.filter(r => r.type === 'return').length}`),
    kpiCard('dispense-flag', 'รายการติดธง', nf(flagged.length), `ระดับสูง ${high.length} รายการ`, high.length ? 'danger' : ''),
  ].join('');

  const todo = [];
  lots.filter(s => s.days != null && s.days < 0).forEach(s => todo.push({ sev: 'high', view: 'expiry',
    t: `${drugName(s.sku)} ล็อต ${s.lot} หมดอายุแล้ว`, d: `เหลือ ${nf(s.qty_on_hand)} ${s.unit || ''} · สถานะ ${s.status} · หมดอายุ ${thDate(s.expiry)}` }));
  const expiredIds = new Set(lots.filter(s => s.days != null && s.days < 0).map(s => s.stock_id));
  state.stock.filter(s => s.status === 'quarantine' && !expiredIds.has(s.stock_id)).forEach(s => todo.push({ sev: 'medium', view: 'stock',
    t: `${drugName(s.sku)} ล็อต ${s.lot} อยู่ระหว่างกักกัน`, d: `${nf(s.qty_on_hand)} หน่วย · ฿${baht(s.qty_on_hand * s.unit_cost)} · ${lotAnomalies(s).join(', ') || 'รอตรวจสอบ'}` }));
  // งานด่วนนับเฉพาะล็อตที่จะหมดอายุภายใน 90 วัน ส่วนที่เหลือดูได้ในแท็บตรวจวันหมดอายุ
  risk.filter(r => r.days <= 90).forEach(r => todo.push({ sev: r.days <= 30 ? 'high' : 'medium', view: 'expiry',
    t: `${drugName(r.sku)} ล็อต ${r.lot} คาดว่าจ่ายไม่ทัน`, d: `คาดเหลือทิ้ง ${nf(r.waste)} หน่วย (฿${baht(r.wasteValue)}) · หมดอายุใน ${r.days} วัน` }));
  needs.forEach(p => todo.push({ sev: p.daysCover != null && p.daysCover < (+$('#lead').value || 0) ? 'high' : 'medium', view: 'order',
    t: `สั่ง ${p.name} ${p.strength} ${nf(p.suggest)} ${p.unit}`, d: `พร้อมจ่าย ${nf(p.available)} / จุดสั่งซื้อ ${nf(p.reorder)} · พอใช้ ${p.daysCover == null ? '—' : nf(p.daysCover, 0) + ' วัน'}` }));
  high.forEach(r => todo.push({ sev: 'high', view: 'dispense-flag',
    t: `${r.dispense_id} ${drugName(r.sku)}`, d: r.flags.map(f => f.message).join(' · ') }));
  const order = { high: 0, medium: 1, low: 2 };
  todo.sort((a, b) => order[a.sev] - order[b.sev]);
  $('#ov-todo').innerHTML = todo.length ? todo.map(x => `<li>
      <span class="badge ${x.sev === 'high' ? 'danger' : 'warn'}">${SEV_LABEL[x.sev]}</span>
      <div class="what"><b>${esc(x.t)}</b><span>${esc(x.d)}</span></div>
      <a class="btn sm" href="#${x.view.split('-')[0]}" data-go="${x.view}">ดู</a></li>`).join('')
    : '<li class="empty">ไม่มีรายการที่ต้องจัดการ</li>';

  barDaily('ov-chart', rows);
}
function kpiCard(view, label, value, hint, cls = '') {
  return `<button type="button" class="kpi ${cls}" data-go="${view}"><span class="go">ดู →</span>
    <div class="label">${esc(label)}</div><div class="value">${value}</div><div class="hint">${esc(hint)}</div></button>`;
}

/* ---------------- แท็บ: คลังยา ---------------- */
function renderStock() {
  const active = state.stock.filter(s => s.status === 'active');
  const quar = state.stock.filter(s => s.status === 'quarantine');
  const woff = state.stock.filter(s => s.status === 'written_off');
  const avail = availableBySku();
  const plan = state.lastPlan || [];
  $('#st-kpis').innerHTML = [
    simpleKpi('มูลค่าพร้อมจ่าย', `฿${baht(sum(active, s => s.qty_on_hand * s.unit_cost))}`, `${active.length} ล็อต active`),
    simpleKpi('จำนวน SKU ที่มีสต็อก', nf(stockSkus().length), `จากบัญชียา ${state.drugs.items.length} รายการ · มียอดใช้ได้ ${Object.keys(avail).length} SKU`),
    simpleKpi('ล็อตกักกัน (quarantine)', nf(quar.length), `${nf(sum(quar, s => s.qty_on_hand))} หน่วย · ฿${baht(sum(quar, s => s.qty_on_hand * s.unit_cost))}`, quar.length ? 'warn' : ''),
    simpleKpi('ล็อตตัดจำหน่าย', nf(woff.length), 'written_off (ยอด 0)'),
    simpleKpi('ต่ำกว่าจุดสั่งซื้อ', nf(plan.filter(p => p.below).length), plan.filter(p => p.below).map(p => p.sku).join(', ') || 'SKU', plan.some(p => p.below) ? 'warn' : ''),
  ].join('');

  // กราฟมูลค่าตามหมวด
  const byCat = {};
  active.forEach(s => { const c = state.D[s.sku].category; byCat[c] = (byCat[c] || 0) + s.qty_on_hand * s.unit_cost; });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  chart('st-chart', {
    type: 'bar',
    data: { labels: cats.map(c => c[0]), datasets: [{ label: 'บาท', data: cats.map(c => +c[1].toFixed(2)), backgroundColor: cssVar('--c-bar'), borderRadius: 4 }] },
    options: { indexAxis: 'y', scales: { x: { beginAtZero: true }, y: { grid: { display: false } } },
      plugins: { tooltip: { callbacks: { label: c => `฿${baht(c.raw)}` } } } },
  });

  // ล็อตผิดปกติ
  const issues = state.stock.filter(s => s.status === 'quarantine' || (lotAnomalies(s).length && s.qty_on_hand > 0));
  $('#st-issues').innerHTML = issues.length ? issues.map(s => `<li>
    <span class="badge ${STATUS_BADGE[s.status]}">${esc(s.status)}</span>
    <div class="what"><b>${esc(s.stock_id)} · ${esc(drugName(s.sku))} · ล็อต ${esc(s.lot)}</b>
    <span>${nf(s.qty_on_hand)} หน่วย · ฿${baht(s.qty_on_hand * s.unit_cost)} · รับ ${thDate(s.received_date)} · หมดอายุ ${thDate(s.expiry)}${lotAnomalies(s).length ? ' · ⚠ ' + esc(lotAnomalies(s).join(', ')) : ''}</span></div></li>`).join('')
    : '<li class="empty">ไม่มี</li>';

  renderStockTable();
}
function renderStockTable() {
  const q = $('#st-search').value.trim().toLowerCase();
  const st = $('#st-status').value, cat = $('#st-cat').value;
  const rows = state.stock.filter(s => {
    const d = state.D[s.sku];
    if (st && s.status !== st) return false;
    if (cat && d.category !== cat) return false;
    if (q && ![s.sku, s.lot, s.stock_id, d.generic_name].some(v => v.toLowerCase().includes(q))) return false;
    return true;
  }).sort((a, b) => a.sku.localeCompare(b.sku) || (a.expiry || '9999').localeCompare(b.expiry || '9999'));
  const cols = [
    { label: 'Stock ID', val: r => r.stock_id },
    { label: 'SKU', val: r => r.sku },
    { label: 'ชื่อยา', val: r => drugName(r.sku) },
    { label: 'หมวด', val: r => state.D[r.sku].category },
    { label: 'ล็อต', val: r => r.lot },
    { label: 'รับเข้า', val: r => r.received_date, html: r => thDate(r.received_date) },
    { label: 'หมดอายุ', val: r => r.expiry || '', html: r => thDate(r.expiry) },
    { label: 'เหลือ (วัน)', num: true, val: r => lotDays(r) ?? '', html: r => expiryCell(lotDays(r)) },
    { label: 'คงเหลือ', num: true, val: r => r.qty_on_hand, html: r => nf(r.qty_on_hand) },
    { label: 'หน่วย', val: r => state.D[r.sku].unit },
    { label: 'ต้นทุน/หน่วย', num: true, val: r => r.unit_cost, html: r => baht(r.unit_cost) },
    { label: 'มูลค่า', num: true, val: r => (r.qty_on_hand * r.unit_cost).toFixed(2), html: r => baht(r.qty_on_hand * r.unit_cost) },
    { label: 'สถานะ', val: r => r.status, html: r => `<span class="badge ${STATUS_BADGE[r.status]}">${esc(r.status)}</span>` +
        lotAnomalies(r).map(a => `<span class="badge danger">${esc(a)}</span>`).join(''), csv: r => [r.status, ...lotAnomalies(r)].join('; ') },
  ];
  $('#st-count').textContent = `${rows.length} จาก ${state.stock.length} ล็อต`;
  renderTable($('#st-table'), cols, rows);
  setCsv('stock', cols, rows, 'stock');
}
function expiryCell(d) {
  if (d == null) return '<span class="badge danger">ไม่ระบุ</span>';
  const b = BUCKETS.find(x => x.test(d));
  const cls = b.cls === 'ok' ? '' : b.cls === 'info' ? 'info' : b.cls;
  return cls ? `<span class="badge ${cls}">${nf(d)}</span>` : nf(d);
}
function simpleKpi(label, value, hint, cls = '') {
  return `<div class="kpi ${cls}"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="hint">${esc(hint)}</div></div>`;
}

/* ---------------- แท็บ: ตรวจวันหมดอายุ ---------------- */
function renderExpiry(ctx) {
  const { lots, fefoRows, risk } = ctx;
  const counts = BUCKETS.map(b => {
    const ls = lots.filter(s => s.days != null && b.test(s.days));
    return { ...b, n: ls.length, value: sum(ls, s => s.qty_on_hand * s.unit_cost) };
  });
  $('#ex-buckets').innerHTML = counts.map(b => `<button type="button" class="bucket ${b.cls === 'ok' ? 'ok' : b.cls}" data-bucket="${b.key}" aria-pressed="${state.bucket === b.key}">
    <div class="t">${esc(b.label)}</div><div class="n">${b.n}</div><div class="t">฿${baht(b.value)}</div></button>`).join('');

  const noExp = lots.filter(s => s.days == null);
  $('#ex-kpis').innerHTML = [
    simpleKpi('มูลค่าที่คาดว่าเหลือทิ้ง', `฿${baht(sum(risk, r => r.wasteValue))}`, `${risk.length} ล็อต · ${nf(sum(risk, r => r.waste))} หน่วย`, risk.length ? 'danger' : ''),
    simpleKpi('ล็อตหมดอายุ ≤ 90 วัน', nf(lots.filter(s => s.status === 'active' && s.days != null && s.days >= 0 && s.days <= 90).length), 'ล็อต active ที่ยังมียอด'),
    simpleKpi('ล็อตไม่ระบุวันหมดอายุ', nf(noExp.length), noExp.map(s => `${s.sku}/${s.lot}`).join(', ') || '—', noExp.length ? 'warn' : ''),
  ].join('');

  const riskCols = [
    { label: 'SKU', val: r => r.sku },
    { label: 'ชื่อยา', val: r => drugName(r.sku) },
    { label: 'ล็อต', val: r => r.lot },
    { label: 'หมดอายุ', val: r => r.expiry, html: r => thDate(r.expiry) },
    { label: 'เหลือ (วัน)', num: true, val: r => r.days, html: r => expiryCell(r.days) },
    { label: 'ลำดับ FEFO', num: true, val: r => `${r.order}/${r.lotCount}` },
    { label: 'คงเหลือ', num: true, val: r => r.qty_on_hand, html: r => nf(r.qty_on_hand) },
    { label: 'ใช้/วัน', num: true, val: r => r.usage.toFixed(2), html: r => nf(r.usage, 2) },
    { label: 'คาดจ่ายได้', num: true, val: r => r.sold, html: r => nf(r.sold) },
    { label: 'คาดเหลือทิ้ง', num: true, val: r => r.waste, html: r => `<b style="color:var(--danger)">${nf(r.waste)}</b>` },
    { label: 'มูลค่าเสี่ยง', num: true, val: r => r.wasteValue.toFixed(2), html: r => baht(r.wasteValue) },
    { label: 'ข้อเสนอ', val: r => riskAdvice(r) },
  ];
  renderTable($('#ex-risk'), riskCols, risk);
  setCsv('risk', riskCols, risk, 'expiry_risk');

  let rows = fefoRows;
  if (state.bucket) { const b = BUCKETS.find(x => x.key === state.bucket); rows = lots.filter(s => s.days != null && b.test(s.days)).map(s => fefoRows.find(f => f.stock_id === s.stock_id) || { ...s, order: '—', lotCount: '—', usage: 0, sold: 0, waste: 0 }); }
  const cols = [
    { label: 'SKU', val: r => r.sku },
    { label: 'ชื่อยา', val: r => drugName(r.sku) },
    { label: 'ลำดับจ่าย', num: true, val: r => r.order === '—' ? '—' : `${r.order}/${r.lotCount}`, html: r => r.order === 1 ? `<span class="badge info">จ่ายก่อน</span>` : esc(r.order === '—' ? '—' : `${r.order}/${r.lotCount}`) },
    { label: 'ล็อต', val: r => r.lot },
    { label: 'หมดอายุ', val: r => r.expiry || '', html: r => thDate(r.expiry) },
    { label: 'เหลือ (วัน)', num: true, val: r => r.days ?? '', html: r => expiryCell(r.days) },
    { label: 'คงเหลือ', num: true, val: r => r.qty_on_hand, html: r => nf(r.qty_on_hand) },
    { label: 'สถานะ', val: r => r.status, html: r => `<span class="badge ${STATUS_BADGE[r.status]}">${esc(r.status)}</span>` },
    { label: 'คาดเหลือทิ้ง', num: true, val: r => r.waste ?? 0, html: r => r.waste ? `<b style="color:var(--danger)">${nf(r.waste)}</b>` : '0' },
  ];
  const bl = state.bucket ? BUCKETS.find(x => x.key === state.bucket).label : null;
  $('#ex-count').innerHTML = `${rows.length} ล็อต${bl ? ` · กรอง: ${esc(bl)} <button type="button" class="btn sm" data-bucket="">ล้างตัวกรอง</button>` : ' · กดกล่องด้านบนเพื่อกรองตามช่วงวันหมดอายุ'}`;
  renderTable($('#ex-table'), cols, rows, r => r.days != null && r.days <= 30 ? 'flag-high' : '');
  setCsv('fefo', cols, rows, 'fefo');
}
function riskAdvice(r) {
  if (r.usage <= 0) return 'ไม่มีการจ่ายในช่วงนี้ · พิจารณาคืนผู้จำหน่าย/โอนสาขา';
  if (r.days <= 30) return 'จ่ายล็อตนี้ก่อน · เตรียมตัดจำหน่าย/คืนผู้จำหน่าย';
  return 'จ่ายล็อตนี้ก่อน · ชะลอการสั่งเพิ่ม';
}

/* ---------------- แท็บ: การสั่งซื้อ ---------------- */
function renderOrder(ctx) {
  const plan = ctx.plan;
  const needs = plan.filter(p => p.need);
  const only = $('#only-need').checked;
  const rows = only ? needs : plan;
  $('#or-kpis').innerHTML = [
    simpleKpi('SKU ที่ต้องสั่ง', nf(needs.length), `จาก ${plan.length} SKU ที่มีสต็อก`, needs.length ? 'warn' : ''),
    simpleKpi('ต่ำกว่าจุดสั่งซื้อ', nf(plan.filter(p => p.below).length), 'ยอดใช้ได้ < reorder_level'),
    simpleKpi('ใช้เร็ว พอไม่ถึง lead time', nf(plan.filter(p => p.fast).length), `พอใช้ < ${+$('#lead').value || 0} วัน`),
    simpleKpi('มูลค่าสั่งซื้อโดยประมาณ', `฿${baht(sum(needs, p => p.cost))}`, 'ใช้ต้นทุนของล็อตที่รับเข้าล่าสุด'),
  ].join('');
  const cols = [
    { label: 'SKU', val: r => r.sku },
    { label: 'ชื่อยา', val: r => `${r.name} ${r.strength}` },
    { label: 'หมวด', val: r => r.category },
    { label: 'พร้อมจ่าย', num: true, val: r => r.available, html: r => nf(r.available) },
    { label: 'กักกัน', num: true, val: r => r.quarantine, html: r => r.quarantine ? `<span class="badge warn">${nf(r.quarantine)}</span>` : '0' },
    { label: 'จุดสั่งซื้อ', num: true, val: r => r.reorder, html: r => nf(r.reorder) },
    { label: 'ใช้/วัน', num: true, val: r => r.usage.toFixed(2), html: r => nf(r.usage, 2) },
    { label: 'พอใช้ (วัน)', num: true, val: r => r.daysCover == null ? '' : r.daysCover.toFixed(1), html: r => r.daysCover == null ? '—' : nf(r.daysCover, 1) },
    { label: 'เหตุผล', val: r => reasons(r).join('; '), html: r => reasons(r).map(x => `<span class="badge ${x.startsWith('ต่ำ') ? 'warn' : 'danger'}">${esc(x)}</span>`).join('') || '<span class="badge ok">เพียงพอ</span>' },
    { label: 'แนะนำสั่ง', num: true, val: r => r.suggest, html: r => r.suggest ? `<b>${nf(r.suggest)}</b>` : '—' },
    { label: 'หน่วย', val: r => r.unit },
    { label: 'ต้นทุน/หน่วย', num: true, val: r => r.unitCost, html: r => baht(r.unitCost) },
    { label: 'มูลค่า', num: true, val: r => r.cost.toFixed(2), html: r => r.cost ? baht(r.cost) : '—' },
  ];
  $('#or-count').textContent = `${rows.length} รายการ · เรียงตามความเร่งด่วน (พอใช้น้อยสุดก่อน)`;
  renderTable($('#or-table'), cols, rows, r => r.fast ? 'flag-high' : r.below ? 'flag-medium' : '');
  setCsv('order', cols, rows, 'order_plan');
  buildPO(); // สร้างไว้ล่วงหน้า เพื่อให้ Ctrl+P ได้ใบสั่งซื้อเช่นกัน
}
function reasons(r) {
  const out = [];
  if (r.below) out.push('ต่ำกว่าจุดสั่งซื้อ');
  if (r.fast) out.push('จะหมดก่อนของใหม่มาถึง');
  return out;
}
function buildPO() {
  const needs = (state.lastPlan || []).filter(p => p.need && p.suggest > 0);
  const lead = +$('#lead').value || 0, cover = +$('#cover').value || 0;
  $('#print-po').innerHTML = `
    <h1>ใบขอสั่งซื้อยา</h1>
    <p>วันที่อ้างอิงข้อมูล: ${thDate(state.asOf)} · อัตราการใช้จากช่วง ${thDate(state.from)} – ${thDate(state.to)} (${rangeDays()} วัน) · Lead time ${lead} วัน · วันสำรอง ${cover} วัน</p>
    <table><thead><tr><th>#</th><th>SKU</th><th>ชื่อยา</th><th>พร้อมจ่าย</th><th>จุดสั่งซื้อ</th><th>จำนวนสั่ง</th><th>หน่วย</th><th>ต้นทุน/หน่วย</th><th>มูลค่า (บาท)</th></tr></thead>
    <tbody>${needs.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.sku)}</td><td>${esc(p.name)} ${esc(p.strength)}</td><td>${nf(p.available)}</td><td>${nf(p.reorder)}</td><td><b>${nf(p.suggest)}</b></td><td>${esc(p.unit)}</td><td>${baht(p.unitCost)}</td><td>${baht(p.cost)}</td></tr>`).join('') || '<tr><td colspan="9">ไม่มีรายการที่ต้องสั่ง</td></tr>'}
    <tr><td colspan="8" style="text-align:right"><b>รวม</b></td><td><b>${baht(sum(needs, p => p.cost))}</b></td></tr></tbody></table>
    <p style="font-size:9pt">ต้นทุนต่อหน่วยอ้างอิงล็อตที่รับเข้าล่าสุด · ข้อมูลจำลองเพื่อการเรียน</p>
    <div class="sign"><div>ผู้ขอสั่งซื้อ</div><div>เภสัชกรผู้อนุมัติ</div></div>`;
}
function printPO() { buildPO(); window.print(); }

/* ---------------- แท็บ: รายการจ่ายยา ---------------- */
function renderDispense(ctx) {
  const rows = ctx.rows; // เฉพาะ type = dispense
  const voids = ctx.allRows.filter(r => r.type === 'void');
  const rets = ctx.allRows.filter(r => r.type === 'return');
  const flagged = rows.filter(r => r.flags.length);
  $('#di-kpis').innerHTML = [
    simpleKpi('รายการจ่าย (dispense)', nf(rows.length), `เฉลี่ย ${nf(rows.length / rangeDays(), 1)} ครั้ง/วัน`),
    simpleKpi('Void / Return', `${nf(voids.length)} / ${nf(rets.length)}`, 'แสดงแยก ไม่นับในรายการจ่าย', voids.length || rets.length ? 'warn' : ''),
    simpleKpi('จำนวนหน่วยที่จ่าย', nf(sum(rows, r => r.qty), 1), `SKU ที่จ่าย ${new Set(rows.map(r => r.sku)).size} SKU`),
    simpleKpi('รหัสผู้รับยา', nf(new Set(rows.map(r => r.patient_code)).size), 'รหัสแฝงไม่ซ้ำ'),
    simpleKpi('รายการติดธง', nf(flagged.length), ['high', 'medium', 'low'].map(s => `${SEV_LABEL[s]} ${flagged.filter(r => r.flags.some(f => f.severity === s) && topSev(r) === s).length}`).join(' · '), flagged.length ? 'danger' : ''),
  ].join('');

  barDaily('di-daily', rows);
  const hours = Array.from({ length: 12 }, (_, i) => i + 8), hc = {};
  rows.forEach(r => { const h = +r.datetime.slice(11, 13); hc[h] = (hc[h] || 0) + 1; });
  chart('di-hour', {
    type: 'bar',
    data: { labels: hours.map(h => `${String(h).padStart(2, '0')}:00`), datasets: [{ label: 'ครั้ง', data: hours.map(h => hc[h] || 0), backgroundColor: cssVar('--c-bar'), borderRadius: 4 }] },
    options: { scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });
  const q = {};
  rows.forEach(r => { q[r.sku] = (q[r.sku] || 0) + r.qty; });
  const top = Object.entries(q).sort((a, b) => b[1] - a[1]).slice(0, 10);
  chart('di-top', {
    type: 'bar',
    data: { labels: top.map(t => state.D[t[0]]?.generic_name || t[0]), datasets: [{ label: 'หน่วย', data: top.map(t => t[1]), backgroundColor: cssVar('--c-bar'), borderRadius: 4 }] },
    options: { indexAxis: 'y', scales: { x: { beginAtZero: true }, y: { grid: { display: false } } } },
  });
  const rx = {};
  rows.forEach(r => { rx[r.pharmacist_code] = (rx[r.pharmacist_code] || 0) + 1; });
  const rxk = Object.keys(rx).sort();
  chart('di-rx', {
    type: 'bar',
    data: { labels: rxk, datasets: [{ label: 'ครั้ง', data: rxk.map(k => rx[k]), backgroundColor: [cssVar('--c-bar'), cssVar('--c-bar-2'), cssVar('--c-bar-3')], borderRadius: 4 }] },
    options: { scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });

  const sel = $('#di-rx-filter'), cur = sel.value;
  const allRx = [...new Set(state.log.map(r => r.pharmacist_code))].sort();
  sel.innerHTML = '<option value="">เภสัชกรทุกคน</option>' + allRx.map(k => `<option ${k === cur ? 'selected' : ''}>${esc(k)}</option>`).join('');
  renderDispenseTable();
}
const TYPE_BADGE = { dispense: 'ok', void: 'muted', return: 'warn' };
// incident_ref มีเฉพาะไฟล์สำรอง ส่วน Supabase มี legacy_id และ ref_dispense_id
function refText(r) {
  return [r.incident_ref, r.legacy_id && `legacy ${r.legacy_id}`, r.ref_dispense_id && `ref ${r.ref_dispense_id}`].filter(Boolean).join(' · ');
}
function topSev(r) { return ['high', 'medium', 'low'].find(s => r.flags.some(f => f.severity === s)); }
function renderDispenseTable() {
  const base = logInRange();
  const q = $('#di-search').value.trim().toLowerCase();
  const rx = $('#di-rx-filter').value, fo = $('#di-flag-only').checked;
  const rows = base.filter(r => {
    if (rx && r.pharmacist_code !== rx) return false;
    if (fo && !r.flags.length) return false;
    if (q && ![r.dispense_id, r.sku, r.lot, r.patient_code, r.pharmacist_code, state.D[r.sku]?.generic_name || '', r.type, refText(r)]
      .some(v => String(v ?? '').toLowerCase().includes(q))) return false;
    return true;
  }).sort((a, b) => b.datetime.localeCompare(a.datetime));
  const cols = [
    { label: 'ID', val: r => r.dispense_id },
    // แสดงตรงจากข้อความ slice(0,10) และ slice(11,16) ไม่แปลงเขตเวลา (CSV ตัดเหลือ YYYY-MM-DDTHH:MM)
    { label: 'วันที่เวลา', val: r => r.datetime.slice(0, 16), html: r => `${thDate(r.datetime.slice(0, 10))} ${esc(r.datetime.slice(11, 16))}` },
    { label: 'ประเภท', val: r => r.type, html: r => `<span class="badge ${TYPE_BADGE[r.type] || 'muted'}">${esc(r.type)}</span>` },
    { label: 'SKU', val: r => r.sku },
    { label: 'ชื่อยา', val: r => drugName(r.sku) },
    { label: 'ล็อต', val: r => r.lot },
    { label: 'จำนวน', num: true, val: r => r.qty, html: r => nf(r.qty, Number.isInteger(r.qty) ? 0 : 1) },
    { label: 'หน่วย', val: r => state.D[r.sku]?.unit || '' },
    { label: 'ผู้ป่วย', val: r => r.patient_code },
    { label: 'เภสัชกร', val: r => r.pharmacist_code },
    { label: 'อ้างอิง', val: r => refText(r), html: r => refText(r) ? `<span class="badge info">${esc(refText(r))}</span>` : '—' },
    { label: 'ธง', val: r => r.flags.map(f => `[${f.severity}] ${f.message}`).join('; '),
      html: r => r.flags.map(f => `<span class="badge ${f.severity === 'high' ? 'danger' : f.severity === 'medium' ? 'warn' : 'info'}" title="${esc(f.message)}">${esc(SEV_LABEL[f.severity])}: ${esc(f.code)}</span>`).join('') || '' },
  ];
  $('#di-count').textContent = `${rows.length} จาก ${base.length} รายการในช่วงที่เลือก`;
  renderTable($('#di-table'), cols, rows, r => r.flags.length ? `flag-${topSev(r)}` : '');
  setCsv('dispense', cols, rows, 'dispense');
}

/* ---------------- รวมทุกแท็บ ---------------- */
function renderAll() {
  const allRows = logInRange();
  const rows = allRows.filter(isDispense); // KPI/กราฟ/อัตราการใช้ นับเฉพาะ type = dispense
  const usage = usagePerDay(rows);
  const plan = orderPlan(usage);
  state.lastPlan = plan;
  const fefoRows = fefo(usage);
  const risk = fefoRows.filter(r => r.waste > 0 && r.days != null).sort((a, b) => a.days - b.days);
  const lots = state.stock.filter(s => s.qty_on_hand > 0 && s.status !== 'written_off').map(s => ({ ...s, days: lotDays(s), unit: state.D[s.sku].unit }));
  const ctx = { rows, allRows, usage, plan, fefoRows, risk, lots };
  renderOverview(ctx);
  renderStock();
  renderExpiry(ctx);
  renderOrder(ctx);
  renderDispense(ctx);
}

function showView() {
  const v = (location.hash || '#overview').slice(1);
  const view = document.getElementById(`view-${v}`) ? v : 'overview';
  $$('.view').forEach(s => s.classList.toggle('active', s.id === `view-${view}`));
  $$('nav.tabs .tab').forEach(t => { if (t.dataset.view === view) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
  // Chart.js วัดขนาดไม่ได้ขณะซ่อนอยู่ จึงสั่งปรับขนาดใหม่เมื่อแท็บแสดง
  Object.values(state.charts).forEach(c => c.resize());
}
function go(target) {
  if (target === 'dispense-flag') { $('#di-flag-only').checked = true; renderDispenseTable(); target = 'dispense'; }
  if (location.hash === `#${target}`) showView(); else location.hash = target;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setThemeLabel() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  $('#theme-toggle').textContent = dark ? 'โหมดสว่าง' : 'โหมดมืด';
}

function init() {
  $('#asof-label').textContent = `ข้อมูล ณ ${thDate(state.asOf)} (as_of ${state.asOf})`;
  ['#date-from', '#date-to'].forEach(s => { $(s).min = state.logMin; $(s).max = state.logMax; $(s).addEventListener('change', onDateInput); });
  $$('[data-preset]').forEach(b => b.addEventListener('click', () => setPreset(b.dataset.preset)));

  const cats = [...new Set(state.stock.map(s => state.D[s.sku].category))].sort((a, b) => a.localeCompare(b, 'th'));
  $('#st-cat').innerHTML += cats.map(c => `<option>${esc(c)}</option>`).join('');
  ['#st-search', '#st-status', '#st-cat'].forEach(s => $(s).addEventListener('input', renderStockTable));
  ['#di-search', '#di-rx-filter', '#di-flag-only'].forEach(s => $(s).addEventListener('input', renderDispenseTable));
  ['#lead', '#cover', '#only-need'].forEach(s => $(s).addEventListener('input', renderAll));
  $('#print-po-btn').addEventListener('click', printPO);

  document.addEventListener('click', e => {
    const g = e.target.closest('[data-go]');
    if (g) { e.preventDefault(); go(g.dataset.go); return; }
    const c = e.target.closest('[data-csv]');
    if (c) { downloadCsv(c.dataset.csv); return; }
    const b = e.target.closest('[data-bucket]');
    if (b) { state.bucket = b.dataset.bucket && state.bucket !== b.dataset.bucket ? b.dataset.bucket : null; renderAll(); }
  });

  setThemeLabel();
  $('#theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('d2-theme', next); } catch (e) { /* ไม่บันทึกก็ใช้งานได้ */ }
    setThemeLabel();
    renderAll();
  });

  window.addEventListener('hashchange', showView);
  showView();
  setPreset('all');
}

load();
