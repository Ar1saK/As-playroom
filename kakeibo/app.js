import { monthKey, settle, parseReceipt } from './calc.js';

const KEY = 'kakeibo-v1';
const $ = (id) => document.getElementById(id);
const yen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

const DEFAULT = {
  names: { A: '私', B: '彼' },
  categories: [
    { id: 'rent', name: '家賃', ratioA: 50 },
    { id: 'food', name: '食費', ratioA: 50 },
    { id: 'daily', name: '日用品', ratioA: 50 },
    { id: 'util', name: '光熱費', ratioA: 50 },
    { id: 'net', name: '通信費', ratioA: 50 },
    { id: 'eat', name: '外食', ratioA: 50 },
    { id: 'other', name: 'その他', ratioA: 50 },
  ],
  fixed: [],
  expenses: [],
  settled: {},
  deleted: [],
};

let state = load();
let month = monthKey(today());
let form = { catId: state.categories[0]?.id, payer: 'A' };

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s) return { ...structuredClone(DEFAULT), ...s };
  } catch {}
  return structuredClone(DEFAULT);
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { toast('保存に失敗しました'); }
  render();
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2000);
}
const name = (p) => state.names[p] || p;
const cat = (id) => state.categories.find((c) => c.id === id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- タブ ----------
document.querySelectorAll('.tabbar button').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
function showTab(t) {
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + t));
  scrollTo(0, 0);
}

// ---------- 月切り替え ----------
function shiftMonth(d) {
  const [y, m] = month.split('-').map(Number);
  const dt = new Date(y, m - 1 + d, 1);
  month = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  render();
}
$('prevMonth').onclick = () => shiftMonth(-1);
$('nextMonth').onclick = () => shiftMonth(1);

// ---------- 精算画面 ----------
const monthExpenses = () => state.expenses.filter((e) => monthKey(e.date) === month)
  .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));

function settleMessage(r) {
  const [y, m] = month.split('-');
  if (r.net === 0) return `${y}年${Number(m)}月の精算：やりとりなしでOK`;
  const [from, to] = r.net > 0 ? ['B', 'A'] : ['A', 'B'];
  return `${y}年${Number(m)}月の精算\n${name(from)} → ${name(to)}：${yen(Math.abs(r.net))}\n` +
    `（合計 ${yen(r.total)} ／ ${name('A')}負担 ${yen(r.burdenA)} ・ ${name('B')}負担 ${yen(r.burdenB)}）`;
}

function renderSummary() {
  const list = monthExpenses();
  const r = settle(list);
  const done = state.settled[month];
  const box = document.querySelector('.settle');
  box.classList.toggle('done', !!done);
  if (!list.length) {
    $('settleText').innerHTML = 'まだ支出がありません';
  } else if (r.net === 0) {
    $('settleText').innerHTML = 'やりとりなし 🎉';
  } else {
    const [from, to] = r.net > 0 ? ['B', 'A'] : ['A', 'B'];
    $('settleText').innerHTML = `${esc(name(from))} → ${esc(name(to))}<span class="amt">${yen(Math.abs(r.net))}</span>`;
  }
  $('settleSub').textContent = done ? `✅ ${done} に精算済み` : `今月の合計 ${yen(r.total)}`;
  $('toggleSettled').textContent = done ? '精算済みを取り消す' : '精算済みにする';
  $('toggleSettled').className = done ? 'ghost' : 'primary';
  $('toggleSettled').disabled = !list.length;
  $('copySettle').disabled = !list.length;

  document.querySelectorAll('.nameA').forEach((el) => el.textContent = name('A'));
  document.querySelectorAll('.nameB').forEach((el) => el.textContent = name('B'));
  const rows = Object.entries(r.byCategory).sort((a, b) => b[1].total - a[1].total)
    .map(([c, v]) => `<tr><td>${esc(c)}</td><td>${yen(v.total)}</td><td>${yen(v.burdenA)}</td><td>${yen(v.burdenB)}</td></tr>`).join('');
  $('breakdown').innerHTML = rows || '<tr><td colspan="4" class="muted">—</td></tr>';
  $('breakdown').parentElement.querySelector('tfoot')?.remove();
  if (rows) $('breakdown').insertAdjacentHTML('afterend',
    `<tfoot><tr><td>合計</td><td>${yen(r.total)}</td><td>${yen(r.burdenA)}</td><td>${yen(r.burdenB)}</td></tr></tfoot>`);
  $('paidLine').textContent = list.length ? `立て替え：${name('A')} ${yen(r.paidA)} ／ ${name('B')} ${yen(r.paidB)}` : '';

  $('list').innerHTML = list.map((e) => `
    <li>
      <span class="dot ${e.payer}" title="${esc(name(e.payer))}が支払い"></span>
      <div class="info">
        <div class="title">${esc(e.category)}${e.memo ? ' · ' + esc(e.memo) : ''}</div>
        <div class="sub">${e.date.slice(5).replace('-', '/')} ${esc(name(e.payer))}が支払い · ${esc(name('A'))}${e.ratioA}% : ${esc(name('B'))}${100 - e.ratioA}%</div>
      </div>
      <span class="yen">${yen(e.amount)}</span>
      <button class="icon" data-edit="${e.id}" aria-label="編集">✎</button>
      <button class="icon" data-del="${e.id}" aria-label="削除">✕</button>
    </li>`).join('') || '<li class="muted">右下の「入力」から追加できます</li>';

  // 未追加の固定費
  const pending = state.fixed.filter((f) => !state.expenses.some((e) => e.fixedId === f.id && monthKey(e.date) === month));
  $('fixedPending').classList.toggle('hidden', !pending.length);
  if (pending.length) {
    $('fixedPending').innerHTML = `<span>固定費 ${pending.length}件（${pending.map((f) => esc(cat(f.catId)?.name || '?')).join('・')}）が未追加です</span>
      <button class="primary" id="addPending">追加</button>`;
    $('addPending').onclick = () => {
      for (const f of pending) {
        const c = cat(f.catId); if (!c) continue;
        state.expenses.push({ id: uid(), date: `${month}-${String(f.day || 1).padStart(2, '0')}`, amount: f.amount,
          category: c.name, ratioA: c.ratioA, payer: f.payer, memo: '固定費', fixedId: f.id,
          createdAt: Date.now(), updatedAt: Date.now() });
      }
      save(); toast('固定費を追加しました');
    };
  }
}
$('list').onclick = (ev) => {
  const del = ev.target.closest('[data-del]')?.dataset.del;
  const edit = ev.target.closest('[data-edit]')?.dataset.edit;
  if (del && confirm('この支出を削除しますか？')) {
    state.expenses = state.expenses.filter((e) => e.id !== del);
    state.deleted.push(del); save();
  }
  if (edit) startEdit(state.expenses.find((e) => e.id === edit));
};
$('toggleSettled').onclick = () => {
  if (state.settled[month]) delete state.settled[month]; else state.settled[month] = today();
  save();
};
$('copySettle').onclick = async () => {
  const msg = settleMessage(settle(monthExpenses()));
  try {
    if (navigator.share) await navigator.share({ text: msg });
    else { await navigator.clipboard.writeText(msg); toast('コピーしました'); }
  } catch {}
};

// ---------- 入力 ----------
function renderForm() {
  if (!cat(form.catId)) form.catId = state.categories[0]?.id;
  $('catChips').innerHTML = state.categories.map((c) =>
    `<button type="button" data-cat="${c.id}" class="${c.id === form.catId ? 'on' : ''}">${esc(c.name)}</button>`).join('');
  $('payerChips').innerHTML = ['A', 'B'].map((p) =>
    `<button type="button" data-payer="${p}" class="${p === form.payer ? 'on' : ''}">${esc(name(p))}</button>`).join('');
  updateRatioLabel();
}
function updateRatioLabel() {
  const v = Number($('ratio').value);
  $('ratioLabel').textContent = `${name('A')} ${v}% : ${name('B')} ${100 - v}%`;
}
$('ratio').oninput = updateRatioLabel;
$('catChips').onclick = (ev) => {
  const id = ev.target.dataset.cat; if (!id) return;
  form.catId = id; $('ratio').value = cat(id).ratioA; renderForm();
};
$('payerChips').onclick = (ev) => {
  const p = ev.target.dataset.payer; if (!p) return;
  form.payer = p; renderForm();
};
function resetForm() {
  $('form').reset(); $('editId').value = '';
  $('date').value = today();
  $('ratio').value = cat(form.catId)?.ratioA ?? 50;
  $('submitBtn').textContent = '追加する';
  $('cancelEdit').classList.add('hidden');
  $('receiptPreview').classList.add('hidden'); $('ocrStatus').textContent = '';
  renderForm();
}
function startEdit(e) {
  $('editId').value = e.id; $('amount').value = e.amount; $('date').value = e.date; $('memo').value = e.memo || '';
  form.catId = state.categories.find((c) => c.name === e.category)?.id ?? form.catId;
  form.payer = e.payer; $('ratio').value = e.ratioA;
  $('submitBtn').textContent = '更新する'; $('cancelEdit').classList.remove('hidden');
  renderForm(); showTab('add');
}
$('cancelEdit').onclick = () => { resetForm(); showTab('summary'); };
$('form').onsubmit = (ev) => {
  ev.preventDefault();
  const amount = Math.round(Number($('amount').value));
  const c = cat(form.catId);
  if (!(amount > 0) || !c) return toast('金額とカテゴリを入れてください');
  const data = { amount, date: $('date').value, category: c.name, ratioA: Number($('ratio').value),
    payer: form.payer, memo: $('memo').value.trim(), updatedAt: Date.now() };
  const id = $('editId').value;
  if (id) Object.assign(state.expenses.find((e) => e.id === id), data);
  else state.expenses.push({ id: uid(), createdAt: Date.now(), ...data });
  month = monthKey(data.date);
  toast(id ? '更新しました' : `${c.name} ${yen(amount)} を追加しました`);
  resetForm(); save(); showTab('summary');
};

// レシート読み取り（Tesseract.js をその場で読み込む）
let tesseract;
function loadTesseract() {
  return tesseract ??= new Promise((ok, ng) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    s.onload = () => ok(window.Tesseract); s.onerror = () => { tesseract = null; ng(new Error('load')); };
    document.head.append(s);
  });
}
$('receipt').onchange = async (ev) => {
  const file = ev.target.files[0]; if (!file) return;
  ev.target.value = '';
  const url = URL.createObjectURL(file);
  $('receiptPreview').src = url; $('receiptPreview').classList.remove('hidden');
  const status = $('ocrStatus');
  status.textContent = '読み取り中…（初回は少し時間がかかります）';
  try {
    const T = await loadTesseract();
    const { data } = await T.recognize(file, 'jpn+eng', {
      logger: (m) => { if (m.status === 'recognizing text') status.textContent = `読み取り中… ${Math.round(m.progress * 100)}%`; },
    });
    const { amount, date } = parseReceipt(data.text);
    if (amount) $('amount').value = amount;
    if (date) $('date').value = date;
    status.textContent = amount
      ? `合計 ${yen(amount)} を読み取りました。違っていたら直してください。`
      : '金額を読み取れませんでした。手入力してください。';
    if (amount) $('amount').focus();
  } catch {
    status.textContent = '読み取りに失敗しました（通信環境を確認してください）。手入力もできます。';
  }
};

// ---------- 設定 ----------
function renderSettings() {
  $('nameA').value = state.names.A; $('nameB').value = state.names.B;
  $('catSettings').innerHTML = state.categories.map((c) => `
    <div class="cat-row">
      <strong>${esc(c.name)}</strong>
      <span class="lbl"><span data-lbl="${c.id}">${esc(name('A'))} ${c.ratioA}% : ${esc(name('B'))} ${100 - c.ratioA}%</span>
        <button class="icon" data-delcat="${c.id}" aria-label="削除" style="border:0;background:none;color:var(--muted)">✕</button></span>
      <input type="range" min="0" max="100" step="5" value="${c.ratioA}" data-ratio="${c.id}">
    </div>`).join('');
  const opts = state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  const keep = $('fxCat').value; $('fxCat').innerHTML = opts; if (cat(keep)) $('fxCat').value = keep;
  $('fxPayer').innerHTML = ['A', 'B'].map((p) => `<option value="${p}">${esc(name(p))}が払う</option>`).join('');
  $('fixedList').innerHTML = state.fixed.map((f) => `
    <li><div class="info"><div class="title">${esc(cat(f.catId)?.name || '(削除済み)')}</div>
      <div class="sub">毎月${f.day}日 · ${esc(name(f.payer))}が支払い</div></div>
      <span class="yen">${yen(f.amount)}</span>
      <button class="icon" data-delfixed="${f.id}" aria-label="削除">✕</button></li>`).join('')
    || '<li class="muted small">未登録（例：家賃）</li>';
}
for (const p of ['A', 'B']) $('name' + p).onchange = (ev) => { state.names[p] = ev.target.value.trim() || DEFAULT.names[p]; save(); };
$('catSettings').oninput = (ev) => {
  const id = ev.target.dataset.ratio; if (!id) return;
  const c = cat(id); c.ratioA = Number(ev.target.value);
  document.querySelector(`[data-lbl="${id}"]`).textContent = `${name('A')} ${c.ratioA}% : ${name('B')} ${100 - c.ratioA}%`;
};
$('catSettings').onchange = (ev) => {
  if (ev.target.dataset.ratio) { save(); if (!$('editId').value) $('ratio').value = cat(form.catId)?.ratioA ?? 50; }
};
$('catSettings').onclick = (ev) => {
  const id = ev.target.dataset.delcat; if (!id) return;
  if (state.categories.length <= 1) return toast('カテゴリは1つ以上必要です');
  if (confirm(`「${cat(id).name}」を削除しますか？（登録済みの支出は残ります）`)) {
    state.categories = state.categories.filter((c) => c.id !== id); save();
  }
};
$('addCat').onclick = () => {
  const n = $('newCat').value.trim(); if (!n) return;
  if (state.categories.some((c) => c.name === n)) return toast('同じ名前のカテゴリがあります');
  state.categories.push({ id: uid(), name: n, ratioA: 50 }); $('newCat').value = ''; save();
};
$('addFixed').onclick = () => {
  const amount = Math.round(Number($('fxAmount').value));
  if (!(amount > 0)) return toast('金額を入れてください');
  const day = Math.min(28, Math.max(1, Number($('fxDay').value) || 1));
  state.fixed.push({ id: uid(), catId: $('fxCat').value, amount, payer: $('fxPayer').value, day });
  $('fxAmount').value = ''; save(); toast('固定費を登録しました');
};
$('fixedList').onclick = (ev) => {
  const id = ev.target.dataset.delfixed;
  if (id && confirm('この固定費を削除しますか？')) { state.fixed = state.fixed.filter((f) => f.id !== id); save(); }
};

// 書き出し / 読み込み（2台のデータを合わせる）
function download(filename, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('exportBtn').onclick = () => download(`kakeibo-${today()}.json`, JSON.stringify(state, null, 1), 'application/json');
$('exportCsv').onclick = () => {
  const head = '日付,カテゴリ,金額,払った人,' + name('A') + '負担%,メモ';
  const rows = [...state.expenses].sort((a, b) => a.date.localeCompare(b.date)).map((e) =>
    [e.date, e.category, e.amount, name(e.payer), e.ratioA, e.memo || ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
  download(`kakeibo-${today()}.csv`, '﻿' + [head, ...rows].join('\n'), 'text/csv');
};
$('importFile').onchange = async (ev) => {
  const file = ev.target.files[0]; ev.target.value = ''; if (!file) return;
  try {
    const inc = JSON.parse(await file.text());
    if (!Array.isArray(inc.expenses)) throw 0;
    const deleted = new Set([...state.deleted, ...(inc.deleted || [])]);
    const map = new Map(state.expenses.map((e) => [e.id, e]));
    let added = 0;
    for (const e of inc.expenses) {
      const cur = map.get(e.id);
      if (!cur) added++;
      if (!cur || (e.updatedAt || 0) > (cur.updatedAt || 0)) map.set(e.id, e);
    }
    state.expenses = [...map.values()].filter((e) => !deleted.has(e.id));
    state.deleted = [...deleted];
    state.settled = { ...inc.settled, ...state.settled };
    for (const c of inc.categories || []) if (!state.categories.some((x) => x.id === c.id)) state.categories.push(c);
    for (const f of inc.fixed || []) if (!state.fixed.some((x) => x.id === f.id)) state.fixed.push(f);
    save(); toast(`読み込みました（新しい支出 ${added}件）`);
  } catch { toast('ファイルを読み込めませんでした'); }
};

// ---------- 描画 ----------
function render() {
  const [y, m] = month.split('-');
  $('monthLabel').textContent = `${y}年${Number(m)}月`;
  renderSummary(); renderForm(); renderSettings();
}
resetForm();
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
