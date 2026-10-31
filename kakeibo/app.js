import { settle, parseReceipt, periodOf, periodRange, fixedDate, periodsBetween, addMonths } from './calc.js';
import { firebaseConfig } from './firebase-config.js';

const KEY = 'kakeibo-v1';
const PREF = 'kakeibo-pref';
const META_KEYS = ['names', 'categories', 'fixed', 'settled', 'settleDay', 'groups'];
const $ = (id) => document.getElementById(id);
const yen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

// たまる精算の「なにに使った？」（任意）
const TAB_CATS = [
  { name: 'ごはん', emoji: '🍽️' }, { name: '宿', emoji: '🏨' }, { name: '移動', emoji: '🚗' },
  { name: '買い物', emoji: '🛍️' }, { name: 'レジャー', emoji: '🎡' }, { name: 'プレゼント', emoji: '🎁' }, { name: 'その他', emoji: '📦' },
];
const SPLITS = { half: 50, A: 100, B: 0 }; // だれの分 → 私の負担割合
const COLORS = ['#2f7d6d', '#5cb8a2', '#c0673d', '#e0b08a', '#6b8fc7', '#a98bc9', '#9aa0a6'];

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
  groups: [],
  settled: {},
  settleDay: 25,
  expenses: [],
};

// ---------- 状態と保存 ----------
let state = loadLocal();
let pref = (() => { try { return JSON.parse(localStorage.getItem(PREF)) || {}; } catch { return {}; } })();
const sync = { api: null, status: firebaseConfig ? 'loading' : 'nocfg', user: null, hid: null,
  unsub: null, metaLoaded: false, serverLoaded: false, error: '' };
let period = periodOf(today(), state.settleDay);
let form = { catId: state.categories[0]?.id, payer: pref.me || 'A', book: pref.book || 'monthly',
  groupId: null, tabCat: '', split: 'half' };
let view = pref.view || 'monthly'; // 精算画面：毎月 / たまる
let groupView = null;              // 開いているグループ（'none' = グループなし）
let groupListOpen = false;         // 「過去のグループ」を開いているか
let hist = { book: 'all', group: '', q: '' };

function loadLocal() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s) {
      // 旧形式（削除IDの一覧）からの移行
      for (const id of s.deleted || []) {
        const e = s.expenses?.find((x) => x.id === id); if (e) e.deleted = true;
      }
      delete s.deleted;
      return { ...structuredClone(DEFAULT), ...s };
    }
  } catch {}
  return structuredClone(DEFAULT);
}
const remote = () => sync.status === 'on';
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
function persistLocal() {
  if (remote()) return;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { toast('保存に失敗しました'); }
}
function savePref(p) { Object.assign(pref, p); try { localStorage.setItem(PREF, JSON.stringify(pref)); } catch {} }
const fail = (err) => { console.error(err); toast('同期に失敗しました。通信環境を確認してください'); };

// 設定（名前・カテゴリ・固定費など）を保存
function saveMeta() {
  if (remote()) sync.api.saveMeta(sync.hid, pick(state, META_KEYS)).catch(fail);
  else persistLocal();
  render();
}
// 支出を追加・更新（削除は deleted: true にする）
function putExpenses(list) {
  for (const e of list) {
    const i = state.expenses.findIndex((x) => x.id === e.id);
    if (i >= 0) state.expenses[i] = e; else state.expenses.push(e);
  }
  if (remote()) sync.api.saveExpenses(sync.hid, list).catch(fail);
  else persistLocal();
  render();
}

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2400);
}
const name = (p) => state.names?.[p] || p;
const cat = (id) => state.categories.find((c) => c.id === id);
const live = () => state.expenses.filter((e) => !e.deleted);
const isTab = (e) => e.book === 'tab';
const tabItems = () => live().filter(isTab);
const group = (id) => state.groups?.find((g) => g.id === id);
const byDateDesc = (a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0);
const splitLabel = (e) => e.ratioA === 50 ? '半分ずつ' : e.ratioA === 100 ? `${name('A')}が全額`
  : e.ratioA === 0 ? `${name('B')}が全額` : `${name('A')}${e.ratioA}% : ${name('B')}${100 - e.ratioA}%`;
const tabCatEmoji = (n) => TAB_CATS.find((c) => c.name === n)?.emoji || '📦';

// 1件分の行（一覧・履歴・グループ明細で共通）
function itemRow(e, { showBook = false } = {}) {
  const g = isTab(e) && group(e.groupId);
  const title = isTab(e) ? esc(e.title || e.category || '立て替え') : esc(e.category) + (e.memo ? ' · ' + esc(e.memo) : '');
  const tag = showBook ? (isTab(e) ? (g ? `<span class="tag">${esc(g.name)}</span>` : '') : '<span class="tag monthly">毎月</span>') : '';
  return `<li>
      <span class="dot ${e.payer}" title="${esc(name(e.payer))}が支払い"></span>
      <div class="info">
        <div class="title">${title}${tag}</div>
        <div class="sub">${md(e.date)} ${esc(name(e.payer))}が支払い · ${esc(splitLabel(e))}</div>
      </div>
      <span class="yen">${yen(e.amount)}</span>
      <button class="icon" data-edit="${e.id}" aria-label="編集">✎</button>
      <button class="icon" data-del="${e.id}" aria-label="削除">✕</button>
    </li>`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- 固定費の自動追加 ----------
// 登録した期間から今の期間まで、まだ入っていない固定費を追加する。
// ID を「固定費ID+期間」にしているので、2台で同時に追加しても重複しない。
function ensureFixed() {
  if (remote() && !(sync.metaLoaded && sync.serverLoaded)) return;
  const now = periodOf(today(), state.settleDay);
  const ids = new Set(state.expenses.map((e) => e.id));
  const add = [];
  for (const f of state.fixed) {
    const c = cat(f.catId); if (!c) continue;
    for (const p of periodsBetween(f.start || now, now)) {
      const id = `fx-${f.id}-${p}`;
      if (ids.has(id)) continue;
      add.push({ id, date: fixedDate(p, f.day, state.settleDay), amount: f.amount, category: c.name,
        ratioA: c.ratioA, payer: f.payer, memo: '固定費（自動）', fixedId: f.id, createdAt: Date.now(), updatedAt: Date.now() });
    }
  }
  if (add.length) putExpenses(add);
}

// ---------- タブ ----------
document.querySelectorAll('.tabbar button').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
function showTab(t) {
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + t));
  document.querySelector('header .month').classList.toggle('invisible', t !== 'summary' || view !== 'monthly');
  scrollTo(0, 0);
}

// ---------- 期間切り替え ----------
$('prevMonth').onclick = () => { period = shift(period, -1); render(); };
$('nextMonth').onclick = () => { period = shift(period, 1); render(); };
function shift(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---------- 精算画面 ----------
const periodExpenses = () => live().filter((e) => !isTab(e) && periodOf(e.date, state.settleDay) === period)
  .sort(byDateDesc);

function settleMessage(r) {
  const { start, end, payday } = periodRange(period, state.settleDay);
  const head = `${md(payday)}の精算（${md(start)}〜${md(end)}）`;
  if (r.net === 0) return `${head}\nやりとりなしでOK`;
  const [from, to] = r.net > 0 ? ['B', 'A'] : ['A', 'B'];
  return `${head}\n${name(from)} → ${name(to)}：${yen(Math.abs(r.net))}\n` +
    `（合計 ${yen(r.total)} ／ ${name('A')}負担 ${yen(r.burdenA)} ・ ${name('B')}負担 ${yen(r.burdenB)}）`;
}

function renderSummary() {
  const list = periodExpenses();
  const r = settle(list);
  const done = state.settled?.[period];
  const { start, end, payday } = periodRange(period, state.settleDay);
  const box = document.querySelector('.settle');
  box.classList.toggle('done', !!done);
  $('periodText').textContent = `${md(payday)} 精算分（${md(start)}〜${md(end)}）`;
  if (!list.length) {
    $('settleText').innerHTML = 'まだ支出がありません';
  } else if (r.net === 0) {
    $('settleText').innerHTML = 'やりとりなし 🎉';
  } else {
    const [from, to] = r.net > 0 ? ['B', 'A'] : ['A', 'B'];
    $('settleText').innerHTML = `${esc(name(from))} → ${esc(name(to))}<span class="amt">${yen(Math.abs(r.net))}</span>`;
  }
  const days = Math.round((new Date(payday) - new Date(today())) / 86400000);
  $('settleSub').textContent = done ? `✅ ${md(done)} に精算済み`
    : `合計 ${yen(r.total)} · ` + (days > 0 ? `精算日まであと${days}日` : days === 0 ? '今日が精算日です' : '精算日を過ぎています');
  $('toggleSettled').textContent = done ? '精算済みを取り消す' : '精算済みにする';
  $('toggleSettled').className = done ? 'ghost' : 'primary';
  $('toggleSettled').disabled = !list.length;
  $('copySettle').disabled = !list.length;

  document.querySelectorAll('.nameA').forEach((el) => el.textContent = name('A'));
  document.querySelectorAll('.nameB').forEach((el) => el.textContent = name('B'));
  const rows = Object.entries(r.byCategory).sort((a, b) => b[1].total - a[1].total)
    .map(([c, v]) => `<tr><td>${esc(c)}</td><td>${yen(v.total)}</td><td>${yen(v.burdenA)}</td><td>${yen(v.total - Math.round(v.burdenA))}</td></tr>`).join('');
  $('breakdown').innerHTML = rows || '<tr><td colspan="4" class="muted">—</td></tr>';
  $('breakdown').parentElement.querySelector('tfoot')?.remove();
  if (rows) $('breakdown').insertAdjacentHTML('afterend',
    `<tfoot><tr><td>合計</td><td>${yen(r.total)}</td><td>${yen(r.burdenA)}</td><td>${yen(r.burdenB)}</td></tr></tfoot>`);
  $('paidLine').textContent = list.length ? `立て替え：${name('A')} ${yen(r.paidA)} ／ ${name('B')} ${yen(r.paidB)}` : '';

  $('list').innerHTML = list.map((e) => itemRow(e)).join('') || '<li class="muted">下の「入力」から追加できます</li>';
}
// 編集・削除ボタン（どの一覧からでも）
document.querySelector('main').addEventListener('click', (ev) => {
  const del = ev.target.closest('[data-del]')?.dataset.del;
  const edit = ev.target.closest('[data-edit]')?.dataset.edit;
  const e = state.expenses.find((x) => x.id === (del || edit));
  if (!e) return;
  if (del && confirm('この支出を削除しますか？')) putExpenses([{ ...e, deleted: true, updatedAt: Date.now() }]);
  if (edit) startEdit(e);
});
$('toggleSettled').onclick = () => {
  state.settled = { ...state.settled };
  if (state.settled[period]) delete state.settled[period]; else state.settled[period] = today();
  saveMeta();
};
// LINE の「送信先を選んで送る」画面を開く
const lineUrl = (text) => 'https://line.me/R/share?text=' + encodeURIComponent(text);
$('lineSettle').onclick = () => { location.href = lineUrl(settleMessage(settle(periodExpenses()))); };

// ショートカット用：URL に #line を付けて開くと、直近の精算日の分を LINE で送る画面を出す
let pendingLine = /(^#|&)line\b/.test(location.hash);
function maybeSendLine() {
  if (!pendingLine) return;
  const ready = sync.status === 'nocfg' || (remote() && sync.metaLoaded && sync.serverLoaded);
  if (!ready) return;
  pendingLine = false;
  period = addMonths(periodOf(today(), state.settleDay), -1); // 直近の精算日（今日を含む）の期間
  view = 'monthly'; showTab('summary'); render();
  $('lineSheetText').textContent = settleMessage(settle(periodExpenses()));
  $('lineSheet').classList.remove('hidden');
  $('lineSheetGo').href = lineUrl($('lineSheetText').textContent);
  setTimeout(() => { location.href = $('lineSheetGo').href; }, 600);
}
$('lineSheetClose').onclick = () => $('lineSheet').classList.add('hidden');

$('copySettle').onclick = async () => {
  const msg = settleMessage(settle(periodExpenses()));
  try {
    if (navigator.share) await navigator.share({ text: msg });
    else { await navigator.clipboard.writeText(msg); toast('コピーしました'); }
  } catch {}
};

// ---------- たまる精算 ----------
for (const b of document.querySelectorAll('#viewSeg button')) b.onclick = () => {
  view = b.dataset.view; groupView = null; savePref({ view }); render(); scrollTo(0, 0);
};
function balanceHtml(net) {
  if (net === 0) return '貸し借りなし 🎉';
  const [from, to] = net > 0 ? ['B', 'A'] : ['A', 'B'];
  return `${esc(name(from))} → ${esc(name(to))}<span class="amt">${yen(Math.abs(net))}</span>`;
}
function dateRange(list) {
  if (!list.length) return '';
  const ds = list.map((e) => e.date).sort();
  const f = (d) => `${d.slice(0, 4)}/${md(d)}`;
  return ds[0] === ds[ds.length - 1] ? f(ds[0]) : `${f(ds[0])}〜${f(ds[ds.length - 1])}`;
}
// グループが「終わった」か：自分で終わりにした / 最後の入力から1か月たった（自動）。
// 「進行中に戻す」と closed: false になり、自動では終わらなくなる。
const AUTO_CLOSE_DAYS = 30;
function groupLastDate(id) {
  let last = '';
  for (const e of tabItems()) if (e.groupId === id && e.date > last) last = e.date;
  return last;
}
function groupStatus(g) {
  if (g.closed === true) return 'closed';
  if (g.closed === false) return 'open';
  const last = groupLastDate(g.id) || new Date(g.createdAt || Date.now()).toISOString().slice(0, 10);
  return (new Date(today()) - new Date(last)) / 86400000 > AUTO_CLOSE_DAYS ? 'auto' : 'open';
}
const isOpenGroup = (g) => groupStatus(g) === 'open';
function setGroupClosed(id, closed) {
  state.groups = state.groups.map((g) => g.id === id ? { ...g, closed } : g); saveMeta();
  toast(closed ? 'グループを終わりにしました' : '進行中に戻しました');
}
const groupEmoji = (n) => (n.match(/^\p{Extended_Pictographic}️?/u) || ['📁'])[0];
function renderTab() {
  $('monthlyView').classList.toggle('hidden', view !== 'monthly');
  $('tabView').classList.toggle('hidden', view !== 'tab');
  for (const b of document.querySelectorAll('#viewSeg button')) b.classList.toggle('on', b.dataset.view === view);
  if (view !== 'tab') return;
  const items = tabItems().sort(byDateDesc);
  const r = settle(items);
  $('tabHome').classList.toggle('hidden', !!groupView);
  $('groupDetail').classList.toggle('hidden', !groupView);
  if (groupView) return renderGroupDetail(items);

  $('tabText').innerHTML = items.length ? balanceHtml(r.net) : 'まだ立て替えがありません';
  $('tabSub').textContent = !items.length ? '「入力」で「たまる精算」を選んで追加できます'
    : r.net === 0 ? `立て替え ${items.length}件` : `${name(r.net > 0 ? 'B' : 'A')}の借り · 立て替え ${items.length}件`;
  // グループごとの合計（最近使った順）
  const rowOf = (g) => ({ id: g.id, name: g.name, list: items.filter((e) => e.groupId === g.id) });
  const recent = (a, b) => (b.list[0]?.date || '').localeCompare(a.list[0]?.date || '');
  const open = state.groups.filter(isOpenGroup).map(rowOf).sort(recent);
  const none = { id: 'none', name: '📦 グループなし', list: items.filter((e) => !group(e.groupId)) };
  if (none.list.length) open.push(none);
  const past = state.groups.filter((g) => !isOpenGroup(g)).map(rowOf).sort(recent);
  const li = (g) => {
    const em = g.id === 'none' ? '📦' : groupEmoji(g.name);
    const label = g.id === 'none' ? 'グループなし' : g.name.replace(/^\p{Extended_Pictographic}️?\s*/u, '');
    return `<li class="clickable" data-group="${g.id}"><span class="emoji">${em}</span>
      <div class="info"><div class="title">${esc(label)}</div><div class="sub">${g.list.length ? `${dateRange(g.list)} · ${g.list.length}件` : 'まだありません'}</div></div>
      <span class="yen">${yen(g.list.reduce((t, e) => t + e.amount, 0))}</span></li>`;
  };
  const years = [];
  for (const g of past) {
    const y = (g.list[0]?.date || today()).slice(0, 4);
    if (years[years.length - 1]?.y !== y) years.push({ y, list: [] });
    years[years.length - 1].list.push(g);
  }
  $('groupList').innerHTML = (open.map(li).join('') || '<li class="muted small">進行中のグループはありません（入力画面の「＋ 新しく作る」で作れます）</li>') +
    (past.length ? `<li class="past"><details${groupListOpen ? ' open' : ''} id="pastGroups"><summary>過去のグループ（${past.length}）</summary>
      ${years.map(({ y, list }) => `<div class="month-h"><span>${y}年</span><span>${yen(list.reduce((t, g) => t + g.list.reduce((s, e) => s + e.amount, 0), 0))}</span></div>
        <ul class="list">${list.map(li).join('')}</ul>`).join('')}</details></li>` : '');
  $('pastGroups')?.addEventListener('toggle', (ev) => { groupListOpen = ev.target.open; });
  $('tabRecent').innerHTML = items.slice(0, 5).map((e) => itemRow(e, { showBook: true })).join('') || '<li class="muted">まだありません</li>';
}
$('groupList').onclick = (ev) => {
  const id = ev.target.closest('[data-group]')?.dataset.group; if (!id) return;
  groupView = id; render(); scrollTo(0, 0);
};
$('groupBack').onclick = () => { groupView = null; render(); };
$('gdToggle').onclick = () => { const g = group(groupView); if (g) setGroupClosed(g.id, isOpenGroup(g)); };
$('toHistory').onclick = () => { hist = { book: 'tab', group: '', q: '' }; $('histSearch').value = ''; showTab('history'); render(); };

function renderGroupDetail(items) {
  const g = group(groupView);
  const list = items.filter((e) => groupView === 'none' ? !group(e.groupId) : e.groupId === groupView);
  const r = settle(list);
  $('gdTitle').textContent = g ? g.name : '📦 グループなし';
  const st = g ? groupStatus(g) : 'none';
  $('gdState').textContent = st === 'closed' ? '終わったグループ' : st === 'auto' ? `1か月入力がないので自動で終わりにしました` : '';
  $('gdToggle').classList.toggle('hidden', !g);
  $('gdToggle').textContent = st === 'open' ? 'このグループを終わりにする' : '進行中に戻す';
  $('gdRange').textContent = list.length ? `${dateRange(list)} · ${list.length}件` : 'まだありません';
  $('gdTotal').innerHTML = `<span class="amt">${yen(r.total)}</span>`;
  $('gdPer').textContent = `ひとりあたり ${yen(r.total / 2)}`;
  const cats = {};
  for (const e of list) cats[e.category || 'その他'] = (cats[e.category || 'その他'] || 0) + e.amount;
  const cs = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  $('gdBar').innerHTML = cs.map(([, v], i) => `<span style="width:${r.total ? v / r.total * 100 : 0}%;background:${COLORS[i % COLORS.length]}"></span>`).join('');
  $('gdCats').innerHTML = cs.map(([c, v], i) =>
    `<tr><td><span class="swatch" style="background:${COLORS[i % COLORS.length]}"></span>${tabCatEmoji(c)} ${esc(c)}</td><td>${yen(v)}</td></tr>`).join('')
    || '<tr><td class="muted">—</td></tr>';
  $('gdPeople').innerHTML = `<tr><td>${esc(name('A'))}</td><td>${yen(r.paidA)}</td><td>${yen(r.burdenA)}</td></tr>
    <tr><td>${esc(name('B'))}</td><td>${yen(r.paidB)}</td><td>${yen(r.burdenB)}</td></tr>`;
  $('gdNet').textContent = r.net === 0 ? 'このグループの分は貸し借りなし'
    : `このグループの分：${name(r.net > 0 ? 'B' : 'A')} → ${name(r.net > 0 ? 'A' : 'B')} ${yen(Math.abs(r.net))}（全体の貸し借りに反映済み）`;
  $('gdList').innerHTML = list.map((e) => itemRow(e)).join('') || '<li class="muted">まだありません</li>';
}

// ---------- 履歴 ----------
for (const b of document.querySelectorAll('#histSeg button')) b.onclick = () => { hist.book = b.dataset.hist; render(); };
$('histSearch').oninput = (ev) => { hist.q = ev.target.value.trim(); renderHistory(); };
$('histGroup').onchange = (ev) => { hist.group = ev.target.value; render(); };
function renderHistory() {
  for (const b of document.querySelectorAll('#histSeg button')) b.classList.toggle('on', b.dataset.hist === hist.book);
  $('histGroup').classList.toggle('hidden', hist.book === 'monthly');
  $('histGroup').innerHTML = `<option value="">グループ：すべて</option><option value="none">グループなし</option>` +
    [['進行中', state.groups.filter(isOpenGroup)], ['過去のグループ', state.groups.filter((g) => !isOpenGroup(g))]]
      .filter(([, gs]) => gs.length)
      .map(([l, gs]) => `<optgroup label="${l}">${gs.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</optgroup>`).join('');
  $('histGroup').value = hist.group;
  const q = hist.q.toLowerCase();
  const list = live().filter((e) => {
    if (hist.book === 'tab' && !isTab(e)) return false;
    if (hist.book === 'monthly' && isTab(e)) return false;
    if (hist.book !== 'monthly' && hist.group) {
      if (!isTab(e)) return false;
      if (hist.group === 'none' ? group(e.groupId) : e.groupId !== hist.group) return false;
    }
    if (q && ![e.title, e.memo, e.category, group(e.groupId)?.name, String(e.amount)].join(' ').toLowerCase().includes(q)) return false;
    return true;
  }).sort(byDateDesc);
  $('histCount').textContent = `${list.length}件 · 合計 ${yen(list.reduce((t, e) => t + e.amount, 0))}`;
  const months = [];
  for (const e of list) {
    const m = e.date.slice(0, 7);
    if (months[months.length - 1]?.m !== m) months.push({ m, list: [] });
    months[months.length - 1].list.push(e);
  }
  $('historyList').innerHTML = months.map(({ m, list }) => `
    <div class="month-h"><span>${m.slice(0, 4)}年${Number(m.slice(5))}月</span><span>${yen(list.reduce((t, e) => t + e.amount, 0))}</span></div>
    <div class="card" style="padding:4px 14px"><ul class="list">${list.map((e) => itemRow(e, { showBook: hist.book === 'all' || isTab(e) })).join('')}</ul></div>`).join('')
    || '<p class="muted small" style="text-align:center;margin-top:24px">見つかりませんでした</p>';
}

// ---------- 入力 ----------
function renderForm() {
  $('form').className = 'card book-' + form.book;
  for (const b of document.querySelectorAll('#bookSeg button')) b.classList.toggle('on', b.dataset.book === form.book);
  if (!cat(form.catId)) form.catId = state.categories[0]?.id;
  $('catChips').innerHTML = state.categories.map((c) =>
    `<button type="button" data-cat="${c.id}" class="${c.id === form.catId ? 'on' : ''}">${esc(c.name)}</button>`).join('');
  $('payerChips').innerHTML = ['A', 'B'].map((p) =>
    `<button type="button" data-payer="${p}" class="${p === form.payer ? 'on' : ''}">${esc(name(p))}</button>`).join('');
  if (form.groupId && !group(form.groupId)) form.groupId = null;
  $('groupChips').innerHTML = `<button type="button" data-group="" class="${!form.groupId ? 'on' : ''}">なし</button>` +
    state.groups.filter((g) => isOpenGroup(g) || g.id === form.groupId)
      .map((g) => `<button type="button" data-group="${g.id}" class="${g.id === form.groupId ? 'on' : ''}">${esc(g.name)}</button>`).join('') +
    '<button type="button" data-newgroup="1">＋ 新しく作る</button>';
  $('tabCatChips').innerHTML = TAB_CATS.map((c) =>
    `<button type="button" data-tabcat="${c.name}" class="${c.name === form.tabCat ? 'on' : ''}">${c.emoji} ${c.name}</button>`).join('');
  $('splitChips').innerHTML = [['half', 'ふたりで半分'], ['A', `${name('A')}が全額`], ['B', `${name('B')}が全額`], ['custom', '割合を指定']]
    .map(([k, l]) => `<button type="button" data-split="${k}" class="${k === form.split ? 'on' : ''}">${esc(l)}</button>`).join('');
  $('ratioWrap').classList.toggle('hidden', form.book === 'tab' && form.split !== 'custom');
  updateRatioLabel();
}
function updateRatioLabel() {
  const v = Number($('ratio').value);
  $('ratioLabel').textContent = `${name('A')} ${v}% : ${name('B')} ${100 - v}%`;
}
$('ratio').oninput = updateRatioLabel;
for (const b of document.querySelectorAll('#bookSeg button')) b.onclick = () => {
  form.book = b.dataset.book;
  if (!$('editId').value) savePref({ book: form.book });
  $('ratio').value = form.book === 'tab' ? (SPLITS[form.split] ?? 50) : cat(form.catId)?.ratioA ?? 50;
  renderForm();
};
$('catChips').onclick = (ev) => {
  const id = ev.target.dataset.cat; if (!id) return;
  form.catId = id; $('ratio').value = cat(id).ratioA; renderForm();
};
$('payerChips').onclick = (ev) => {
  const p = ev.target.dataset.payer; if (!p) return;
  form.payer = p; renderForm();
};
$('groupChips').onclick = (ev) => {
  if (ev.target.dataset.newgroup) {
    const n = prompt('グループの名前（例：🏝️ 沖縄旅行）')?.trim(); if (!n) return;
    const g = addGroup(n); if (g) form.groupId = g.id;
    return renderForm();
  }
  if (ev.target.dataset.group === undefined) return;
  form.groupId = ev.target.dataset.group || null; renderForm();
};
$('tabCatChips').onclick = (ev) => {
  const c = ev.target.dataset.tabcat; if (!c) return;
  form.tabCat = form.tabCat === c ? '' : c; renderForm();
};
$('splitChips').onclick = (ev) => {
  const k = ev.target.dataset.split; if (!k) return;
  form.split = k; if (k !== 'custom') $('ratio').value = SPLITS[k]; renderForm();
};
function resetForm() {
  $('form').reset(); $('editId').value = '';
  $('date').value = today();
  form.payer = pref.me || 'A';
  form.book = pref.book || 'monthly'; form.split = 'half'; form.tabCat = ''; form.groupId = null;
  $('ratio').value = form.book === 'tab' ? 50 : cat(form.catId)?.ratioA ?? 50;
  $('submitBtn').textContent = '追加する';
  $('cancelEdit').classList.add('hidden');
  $('receiptPreview').classList.add('hidden'); $('ocrStatus').textContent = '';
  renderForm();
}
function startEdit(e) {
  $('editId').value = e.id; $('amount').value = e.amount; $('date').value = e.date; $('memo').value = e.memo || '';
  form.book = isTab(e) ? 'tab' : 'monthly';
  if (isTab(e)) {
    $('title').value = e.title || '';
    form.groupId = e.groupId || null; form.tabCat = e.category || '';
    form.split = Object.keys(SPLITS).find((k) => SPLITS[k] === e.ratioA) || 'custom';
  } else {
    form.catId = state.categories.find((c) => c.name === e.category)?.id ?? form.catId;
  }
  form.payer = e.payer; $('ratio').value = e.ratioA;
  $('submitBtn').textContent = '更新する'; $('cancelEdit').classList.remove('hidden');
  renderForm(); showTab('add');
}
$('cancelEdit').onclick = () => { resetForm(); showTab('summary'); };
$('form').onsubmit = (ev) => {
  ev.preventDefault();
  const amount = Math.round(Number($('amount').value));
  if (!(amount > 0)) return toast('金額を入れてください');
  const base = { amount, date: $('date').value, payer: form.payer, ratioA: Number($('ratio').value), updatedAt: Date.now() };
  let data, label;
  if (form.book === 'tab') {
    const title = $('title').value.trim();
    data = { ...base, book: 'tab', title, groupId: form.groupId || null, category: form.tabCat || '', memo: '' };
    label = title || '立て替え';
  } else {
    const c = cat(form.catId);
    if (!c) return toast('カテゴリを選んでください');
    data = { ...base, book: 'monthly', category: c.name, memo: $('memo').value.trim() };
    label = c.name;
  }
  const id = $('editId').value;
  const old = id && state.expenses.find((e) => e.id === id);
  const next = old ? { ...old, ...data } : { id: uid(), createdAt: Date.now(), ...data };
  if (!isTab(next)) { delete next.title; delete next.groupId; }
  putExpenses([next]);
  if (isTab(next)) { view = 'tab'; groupView = null; savePref({ view }); }
  else { view = 'monthly'; period = periodOf(data.date, state.settleDay); }
  toast(old ? '更新しました' : `${label} ${yen(amount)} を追加しました`);
  resetForm(); render(); showTab('summary');
};

// ---------- グループの管理 ----------
function addGroup(n) {
  if (state.groups.some((g) => g.name === n)) { toast('同じ名前のグループがあります'); return null; }
  const g = { id: uid(), name: n, createdAt: Date.now() };
  state.groups = [...state.groups, g]; saveMeta();
  return g;
}
function renderGroupSettings() {
  const sorted = [...state.groups].sort((a, b) => isOpenGroup(b) - isOpenGroup(a) || groupLastDate(b.id).localeCompare(groupLastDate(a.id)));
  $('groupSettings').innerHTML = sorted.map((g) => {
    const n = tabItems().filter((e) => e.groupId === g.id).length;
    const st = groupStatus(g);
    return `<li><div class="info"><div class="title">${esc(g.name)}</div>
      <div class="sub">${n}件 · ${st === 'open' ? '進行中' : st === 'auto' ? '終わった（自動）' : '終わった'}</div></div>
      <button class="ghost small-btn" data-togglegroup="${g.id}">${st === 'open' ? '終わりにする' : '戻す'}</button>
      <button class="icon" data-renamegroup="${g.id}" aria-label="名前を変える">✎</button>
      <button class="icon" data-delgroup="${g.id}" aria-label="削除">✕</button></li>`;
  }).join('') || '<li class="muted small">まだありません</li>';
}
$('addGroup').onclick = () => {
  const n = $('newGroup').value.trim(); if (!n) return;
  if (addGroup(n)) { $('newGroup').value = ''; toast('グループを作りました'); }
};
$('groupSettings').onclick = (ev) => {
  const rn = ev.target.dataset.renamegroup, del = ev.target.dataset.delgroup, tg = ev.target.dataset.togglegroup;
  if (tg) setGroupClosed(tg, isOpenGroup(group(tg)));
  if (rn) {
    const g = group(rn); const n = prompt('新しい名前', g.name)?.trim(); if (!n || n === g.name) return;
    state.groups = state.groups.map((x) => x.id === rn ? { ...x, name: n } : x); saveMeta();
  }
  if (del && confirm(`「${group(del).name}」を削除しますか？（中の立て替えは「グループなし」になります）`)) {
    state.groups = state.groups.filter((x) => x.id !== del); saveMeta();
  }
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
  $('receiptPreview').src = URL.createObjectURL(file); $('receiptPreview').classList.remove('hidden');
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
  if (document.activeElement !== $('nameA')) $('nameA').value = state.names.A;
  if (document.activeElement !== $('nameB')) $('nameB').value = state.names.B;
  if (!$('settleDay').options.length) $('settleDay').innerHTML =
    Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}">${i + 1}日</option>`).join('');
  $('settleDay').value = state.settleDay;
  $('me').innerHTML = ['A', 'B'].map((p) => `<option value="${p}">${esc(name(p))}</option>`).join('');
  $('me').value = pref.me || 'A';
  $('catSettings').innerHTML = state.categories.map((c) => `
    <div class="cat-row">
      <strong>${esc(c.name)}</strong>
      <span class="lbl"><span data-lbl="${c.id}">${esc(name('A'))} ${c.ratioA}% : ${esc(name('B'))} ${100 - c.ratioA}%</span>
        <button class="icon" data-delcat="${c.id}" aria-label="削除">✕</button></span>
      <input type="range" min="0" max="100" step="5" value="${c.ratioA}" data-ratio="${c.id}">
    </div>`).join('');
  const opts = state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  const keep = $('fxCat').value; $('fxCat').innerHTML = opts; if (cat(keep)) $('fxCat').value = keep;
  const keepP = $('fxPayer').value;
  $('fxPayer').innerHTML = ['A', 'B'].map((p) => `<option value="${p}">${esc(name(p))}が払う</option>`).join('');
  if (keepP) $('fxPayer').value = keepP;
  $('fixedList').innerHTML = state.fixed.map((f) => `
    <li><div class="info"><div class="title">${esc(cat(f.catId)?.name || '(削除済み)')}</div>
      <div class="sub">毎月${f.day}日 · ${esc(name(f.payer))}が支払い · 自動で追加</div></div>
      <span class="yen">${yen(f.amount)}</span>
      <button class="icon" data-delfixed="${f.id}" aria-label="削除">✕</button></li>`).join('')
    || '<li class="muted small">未登録（例：家賃）</li>';
  $('shortcutUrl').value = location.origin + location.pathname + '#line';
  renderSync();
}
$('copyShortcut').onclick = async () => {
  try { await navigator.clipboard.writeText($('shortcutUrl').value); toast('コピーしました'); } catch {}
};
for (const p of ['A', 'B']) $('name' + p).onchange = (ev) => {
  state.names = { ...state.names, [p]: ev.target.value.trim() || DEFAULT.names[p] }; saveMeta();
};
$('me').onchange = (ev) => { savePref({ me: ev.target.value }); resetForm(); };
$('settleDay').onchange = (ev) => {
  const d = Math.min(28, Math.max(1, Math.round(Number(ev.target.value)) || 25));
  state.settleDay = d; period = periodOf(today(), d); saveMeta();
};
$('catSettings').oninput = (ev) => {
  const id = ev.target.dataset.ratio; if (!id) return;
  const c = cat(id); c.ratioA = Number(ev.target.value);
  document.querySelector(`[data-lbl="${id}"]`).textContent = `${name('A')} ${c.ratioA}% : ${name('B')} ${100 - c.ratioA}%`;
};
$('catSettings').onchange = (ev) => {
  if (!ev.target.dataset.ratio) return;
  saveMeta();
  if (!$('editId').value) $('ratio').value = cat(form.catId)?.ratioA ?? 50;
};
$('catSettings').onclick = (ev) => {
  const id = ev.target.dataset.delcat; if (!id) return;
  if (state.categories.length <= 1) return toast('カテゴリは1つ以上必要です');
  if (confirm(`「${cat(id).name}」を削除しますか？（登録済みの支出は残ります）`)) {
    state.categories = state.categories.filter((c) => c.id !== id); saveMeta();
  }
};
$('addCat').onclick = () => {
  const n = $('newCat').value.trim(); if (!n) return;
  if (state.categories.some((c) => c.name === n)) return toast('同じ名前のカテゴリがあります');
  state.categories = [...state.categories, { id: uid(), name: n, ratioA: 50 }]; $('newCat').value = ''; saveMeta();
};
$('addFixed').onclick = () => {
  const amount = Math.round(Number($('fxAmount').value));
  if (!(amount > 0)) return toast('金額を入れてください');
  const day = Math.min(28, Math.max(1, Number($('fxDay').value) || 1));
  const start = periodOf(today(), state.settleDay);
  state.fixed = [...state.fixed, { id: uid(), catId: $('fxCat').value, amount, payer: $('fxPayer').value, day, start }];
  $('fxAmount').value = ''; saveMeta(); ensureFixed();
  toast('固定費を登録しました。今月分から毎月自動で入ります');
};
$('fixedList').onclick = (ev) => {
  const id = ev.target.dataset.delfixed;
  if (id && confirm('この固定費を削除しますか？（もう入った分は残ります）')) {
    state.fixed = state.fixed.filter((f) => f.id !== id); saveMeta();
  }
};

// 書き出し / 読み込み
function download(filename, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('exportBtn').onclick = () => download(`kakeibo-${today()}.json`, JSON.stringify(state, null, 1), 'application/json');
$('exportCsv').onclick = () => {
  const head = '種類,日付,精算日,グループ,カテゴリ,内容,金額,払った人,' + name('A') + '負担%';
  const rows = live().sort((a, b) => a.date.localeCompare(b.date)).map((e) =>
    [isTab(e) ? 'たまる精算' : '毎月の精算', e.date,
      isTab(e) ? '' : periodRange(periodOf(e.date, state.settleDay), state.settleDay).payday,
      isTab(e) ? group(e.groupId)?.name || '' : '', e.category || '', isTab(e) ? e.title || '' : e.memo || '',
      e.amount, name(e.payer), e.ratioA].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
  download(`kakeibo-${today()}.csv`, '﻿' + [head, ...rows].join('\n'), 'text/csv');
};
$('importFile').onchange = async (ev) => {
  const file = ev.target.files[0]; ev.target.value = ''; if (!file) return;
  try {
    const inc = JSON.parse(await file.text());
    if (!Array.isArray(inc.expenses)) throw 0;
    for (const id of inc.deleted || []) { const e = inc.expenses.find((x) => x.id === id); if (e) e.deleted = true; }
    const changed = inc.expenses.filter((e) => {
      const cur = state.expenses.find((x) => x.id === e.id);
      return !cur || (e.updatedAt || 0) > (cur.updatedAt || 0);
    });
    state.settled = { ...inc.settled, ...state.settled };
    state.categories = [...state.categories, ...(inc.categories || []).filter((c) => !cat(c.id))];
    state.fixed = [...state.fixed, ...(inc.fixed || []).filter((f) => !state.fixed.some((x) => x.id === f.id))];
    state.groups = [...state.groups, ...(inc.groups || []).filter((g) => !group(g.id))];
    saveMeta();
    if (changed.length) putExpenses(changed);
    toast(`読み込みました（${changed.length}件を反映）`);
  } catch { toast('ファイルを読み込めませんでした'); }
};

// ---------- 自動同期 ----------
const authMsg = (e) => ({
  'auth/invalid-credential': 'メールアドレスかパスワードが違います',
  'auth/wrong-password': 'メールアドレスかパスワードが違います',
  'auth/user-not-found': 'このメールアドレスは登録されていません',
  'auth/email-already-in-use': 'このメールアドレスは登録済みです。ログインしてください',
  'auth/weak-password': 'パスワードは6文字以上にしてください',
  'auth/invalid-email': 'メールアドレスの形式が正しくありません',
  'permission-denied': '参加できませんでした（招待コードが違うか、すでに2人います）',
  'not-found': '招待コードが見つかりません',
})[e?.code] || 'エラーが発生しました：' + (e?.code || e?.message || e);

function renderSync() {
  const box = $('syncBody');
  const join = pref.join;
  const s = sync.status;
  const err = sync.error ? `<p class="error small">${esc(sync.error)}</p>` : '';
  if (s === 'nocfg') {
    box.innerHTML = `<p class="muted small">まだ同期の設定がされていません。データはこの端末の中だけに保存されています。
      設定手順は <code>kakeibo/SETUP.md</code> を見てください。</p>`;
  } else if (s === 'loading') {
    box.innerHTML = '<p class="muted small">接続中…</p>';
  } else if (s === 'signedout') {
    box.innerHTML = `${err}<p class="${join ? 'small' : 'muted small'}">${join
      ? '💌 招待されています。新規登録（またはログイン）すると参加できます。'
      : 'ログインすると、ふたりのスマホでデータが自動で同期されます。'}</p>
      <input id="email" type="email" placeholder="メールアドレス" autocomplete="username">
      <input id="pw" type="password" placeholder="パスワード（6文字以上）" autocomplete="current-password">
      <div class="row gap" style="margin-top:8px"><button class="primary grow" data-act="signin">ログイン</button>
      <button class="ghost" data-act="signup">新規登録</button></div>`;
  } else if (s === 'nohousehold') {
    box.innerHTML = `${err}<p class="small">${esc(sync.user.email)} でログイン中</p>
      ${join ? `<p class="small">招待されています。参加すると相手と同じデータを使います。</p>
        <button class="primary" data-act="join">招待された家計に参加する</button>` : `
      <button class="primary" data-act="create">共有を始める（相手を招待する）</button>
      <p class="muted small" style="margin:12px 0 4px">相手から招待コードをもらった場合：</p>
      <div class="row gap"><input id="joinCode" type="text" placeholder="招待コード" class="grow">
        <button class="ghost" data-act="joincode">参加</button></div>`}
      <p><button class="ghost small-btn" data-act="signout">ログアウト</button></p>`;
  } else if (s === 'on') {
    const n = state.members?.length || 1;
    box.innerHTML = `${err}<p class="small">✅ 自動同期中（${esc(sync.user.email)}）· メンバー ${n}/2人</p>
      ${n < 2 ? `<p class="muted small">相手にこのリンクを送って、開いてもらってください：</p>
        <div class="row gap"><input type="text" readonly value="${esc(inviteUrl())}" class="grow" id="inviteUrl">
        <button class="ghost" data-act="copyinvite">コピー</button></div>
        <p class="muted small">招待コード：<code>${esc(sync.hid)}</code></p>` : ''}
      ${join && join !== sync.hid ? `<div class="notice-box"><p class="small">💌 招待されています。参加すると相手と同じデータを使います。</p>
        <button class="primary" data-act="join">招待された家計に参加する</button></div>` : n < 2 ? `
      <details><summary class="small">相手から招待されている場合はこちら</summary>
        <p class="muted small">招待コード（または招待リンク）を貼り付けて参加すると、相手と同じデータを使うようになります。</p>
        <div class="row gap"><input id="joinCode" type="text" placeholder="招待コード" class="grow">
          <button class="ghost" data-act="joincode">参加</button></div></details>` : ''}
      <p><button class="ghost small-btn" data-act="signout">ログアウト</button></p>`;
  }
}
const inviteUrl = () => location.origin + location.pathname + '#join=' + sync.hid;

$('syncBody').onclick = async (ev) => {
  const act = ev.target.dataset.act; if (!act) return;
  const api = sync.api; sync.error = '';
  ev.target.disabled = true;
  try {
    if (act === 'signin' || act === 'signup') {
      const email = $('email').value.trim(), pw = $('pw').value;
      if (act === 'signin') await api.signIn(email, pw); else await api.signUp(email, pw);
    } else if (act === 'signout') {
      if (confirm('ログアウトしますか？（データはクラウドに残ります）')) await api.signOut();
    } else if (act === 'create') {
      if (!confirm('相手から招待されている場合は、ここではなく下の「招待コード」から参加してください。\n\n新しく共有を始めますか？')) return;
      const list = state.expenses;
      sync.hid = await api.createHousehold(sync.user.uid, pick(state, META_KEYS), list);
      startRemote(); toast('共有を始めました。相手を招待してください');
    } else if (act === 'join' || act === 'joincode') {
      const hid = act === 'join' ? pref.join : $('joinCode').value.trim().replace(/.*#join=/, '');
      if (!hid) return;
      if (hid === sync.hid) { savePref({ join: null }); return toast('すでにこの家計に参加しています'); }
      const switching = remote();
      if (switching && !confirm('今使っている家計から、招待された家計に移ります。よろしいですか？')) return;
      // 固定費の自動追加分は移った先でも自動で入るので、それ以外を引き継ぐ
      const mine = live().filter((e) => !e.fixedId);
      await api.joinHousehold(sync.user.uid, hid);
      if (mine.length && confirm(`${switching ? '今の家計' : 'この端末'}にある支出 ${mine.length}件 も、参加する家計に追加しますか？`)) {
        await api.saveExpenses(hid, mine);
      }
      savePref({ join: null }); sync.hid = hid; startRemote(); toast('参加しました！');
    } else if (act === 'copyinvite') {
      const url = inviteUrl();
      const text = `ふたりの家計に招待します\n${url}\n招待コード：${sync.hid}\n\n` +
        'リンクを開いて新規登録し「招待された家計に参加する」を押してね。' +
        'ホーム画面に追加したアプリでは、同じメールアドレスで「ログイン」してね。';
      if (navigator.share) await navigator.share({ text }).catch(() => {});
      else { await navigator.clipboard.writeText(text); toast('コピーしました'); }
    }
  } catch (e) {
    sync.error = authMsg(e); console.error(e);
  } finally {
    ev.target.disabled = false; renderSync();
  }
};

function startRemote() {
  sync.unsub?.();
  sync.status = 'on'; sync.metaLoaded = sync.serverLoaded = false;
  state = { ...structuredClone(DEFAULT), expenses: [] };
  sync.unsub = sync.api.subscribe(sync.hid, (meta) => {
    state = { ...state, ...pick({ ...DEFAULT, ...meta }, META_KEYS), members: meta.members };
    if (!sync.metaLoaded) period = periodOf(today(), state.settleDay);
    sync.metaLoaded = true; ensureFixed(); render();
  }, (list, fromServer) => {
    state.expenses = list;
    if (fromServer) sync.serverLoaded = true;
    ensureFixed(); render();
  }, (e) => { sync.error = authMsg(e); render(); });
}
function stopRemote() {
  sync.unsub?.(); sync.unsub = null; sync.hid = null;
  state = loadLocal(); period = periodOf(today(), state.settleDay);
}

async function initSync() {
  const m = location.hash.match(/join=([\w-]+)/);
  if (m) savePref({ join: m[1] });
  if (location.hash) history.replaceState(null, '', location.pathname);
  if (!firebaseConfig) return;
  try {
    const { connect } = await import('./sync.js');
    sync.api = await connect(firebaseConfig);
  } catch (e) {
    console.error(e); sync.status = 'nocfg'; sync.error = ''; render();
    return toast('同期サービスに接続できませんでした');
  }
  sync.api.onAuth(async (user) => {
    sync.user = user; sync.error = '';
    if (!user) { stopRemote(); sync.status = 'signedout'; if (pref.join) showTab('settings'); render(); return; }
    try {
      const hid = await sync.api.myHousehold(user.uid);
      if (hid) {
        if (pref.join === hid) savePref({ join: null });
        else if (pref.join) showTab('settings'); // 別の家計に招待されている → 設定画面で参加を確認
        sync.hid = hid; startRemote();
      } else {
        sync.status = 'nohousehold'; if (pref.join) showTab('settings');
      }
    } catch (e) { sync.error = authMsg(e); sync.status = 'nohousehold'; }
    render();
  });
}

// ---------- 描画 ----------
function render() {
  const { payday } = periodRange(period, state.settleDay);
  $('monthLabel').textContent = `${Number(payday.slice(5, 7))}月${Number(payday.slice(8))}日 精算`;
  if (!state.groups) state.groups = [];
  document.querySelector('header .month').classList.toggle('invisible',
    view !== 'monthly' || !$('tab-summary').classList.contains('active'));
  renderSummary(); renderTab(); renderHistory(); renderForm(); renderSettings(); renderGroupSettings();
  maybeSendLine();
}
resetForm();
ensureFixed();
render();
initSync();
// ---------- アプリの更新 ----------
// 新しい版が公開されたら自動で切り替える（ホーム画面のアプリでも開き直したときに確認する）
if ('serviceWorker' in navigator) {
  // 初めて開いたとき（まだ古い版がない）は再読み込みしない
  let hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    if (reloading) return;
    reloading = true; location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}
// 手動で最新版にする（ログイン状態とデータはそのまま）
$('forceUpdate').onclick = async () => {
  $('forceUpdate').disabled = true; toast('更新しています…');
  try {
    const regs = await navigator.serviceWorker?.getRegistrations() ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    const ks = await caches.keys();
    await Promise.all(ks.map((k) => caches.delete(k)));
  } catch {}
  location.reload();
};
