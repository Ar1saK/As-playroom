// 精算ロジック（純粋関数のみ。DOM に依存しない）

export const monthKey = (dateStr) => dateStr.slice(0, 7);

// ---- 精算期間 ----
// 期間は「精算日のある月」をキーにする。精算日 25 日なら
// "2026-10" = 2026-09-25 〜 2026-10-24 の支出を 2026-10-25 に精算する。
const pad = (n) => String(n).padStart(2, '0');
export function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
export function periodOf(dateStr, settleDay) {
  const d = Number(dateStr.slice(8, 10));
  return d >= settleDay ? addMonths(monthKey(dateStr), 1) : monthKey(dateStr);
}
export function periodRange(key, settleDay) {
  const prev = addMonths(key, -1);
  // 精算日 1 日なら前月 1 日〜前月末日
  const end = settleDay === 1 ? `${prev}-${pad(new Date(...prev.split('-').map(Number), 0).getDate())}`
    : `${key}-${pad(settleDay - 1)}`;
  return { start: `${prev}-${pad(settleDay)}`, end, payday: `${key}-${pad(settleDay)}` };
}
// 固定費の「毎月 day 日」がその期間内で何日になるか
export function fixedDate(key, day, settleDay) {
  return day >= settleDay ? `${addMonths(key, -1)}-${pad(day)}` : `${key}-${pad(day)}`;
}
// from 〜 to（両端含む）の期間キーを列挙
export function periodsBetween(from, to) {
  const out = [];
  for (let k = from; k <= to && out.length < 120; k = addMonths(k, 1)) out.push(k);
  return out;
}

// 1件の支出について、A(私) の負担額を返す。ratioA は 0〜100(%)。
export const shareA = (e) => e.amount * e.ratioA / 100;

// 月の支出リストから精算結果を計算する。
// net > 0 なら B → A へ net 円、net < 0 なら A → B へ -net 円。
export function settle(expenses) {
  let paidA = 0, paidB = 0, burdenA = 0, burdenB = 0;
  const byCategory = {};
  for (const e of expenses) {
    const a = shareA(e), b = e.amount - a;
    if (e.payer === 'A') paidA += e.amount; else paidB += e.amount;
    burdenA += a; burdenB += b;
    const c = (byCategory[e.category] ??= { total: 0, burdenA: 0, burdenB: 0 });
    c.total += e.amount; c.burdenA += a; c.burdenB += b;
  }
  const net = Math.round(paidA - burdenA);
  return {
    total: paidA + paidB, paidA, paidB,
    // 端数で合計がずれないよう、私の負担は「払った額 − 精算額」から逆算する
    burdenA: paidA - net, burdenB: paidA + paidB - (paidA - net),
    net, byCategory,
  };
}

// OCR したレシート文字列から合計金額と日付を推測する。
export function parseReceipt(text) {
  const norm = text
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
    .replace(/[，,]/g, '').replace(/[￥¥\\]/g, '');
  const lines = norm.split(/\n/).map((l) => l.replace(/\s+/g, ''));
  const num = (l) => (l.match(/\d+/g) || []).map(Number);
  let amount = null;
  const keys = [/合計|お買上|お買い上げ|総額|ご請求/, /お預|現計|計/];
  for (const re of keys) {
    for (const l of lines) {
      if (/小計|点数|お釣|釣銭|税/.test(l) && !/合計/.test(l)) continue;
      if (re.test(l)) {
        const ns = num(l).filter((n) => n >= 10);
        if (ns.length) { amount = Math.max(...ns); break; }
      }
    }
    if (amount) break;
  }
  if (!amount) {
    const all = lines.flatMap(num).filter((n) => n >= 10 && n < 1000000);
    amount = all.length ? Math.max(...all) : null;
  }
  let date = null;
  const m = norm.match(/(20\d{2})\s*[\/\-年.]\s*(\d{1,2})\s*[\/\-月.]\s*(\d{1,2})/);
  if (m) date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return { amount, date };
}

// ---- 高速・ETC ----
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Claude の返事（「2026/09/02 14:33 670」の行）から ETC の行を取り出す。
// 重なった行（同じ日時・金額）は1つにまとめる。読めなかった行は bad に入れる。
export function parseEtcRows(text) {
  const norm = text.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
    .replace(/[：]/g, ':').replace(/[／]/g, '/');
  const rows = [], bad = [], seen = new Set();
  const re = /(20\d\d)\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})日?\s+(\d{1,2}):(\d{2})\s+[¥￥\\]?\s*([\d,]+)\s*円?/;
  for (const line of norm.split(/\n/)) {
    if (!/\d{4}\s*[\/\-.年]/.test(line)) continue;
    const m = line.match(re);
    if (!m) { bad.push(line.trim()); continue; }
    const date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    const time = `${m[4].padStart(2, '0')}:${m[5]}`;
    const amount = Number(m[6].replace(/,/g, ''));
    const key = `${date} ${time} ${amount}`;
    if (!(amount > 0) || seen.has(key)) continue;
    seen.add(key);
    rows.push({ date, time, amount });
  }
  rows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return { rows, bad };
}
// 前回の ETC 精算がいつまでだったか。etc.to を持つ記録、なければ「高速(8/16〜10/11)」のようなタイトルから読む。
export function lastEtcEnd(items) {
  let last = '';
  for (const e of items) {
    let to = e.etc?.to;
    if (!to) {
      const m = (e.title || '').match(/(?:高速|ETC|etc).*?\(\s*\d{1,2}\/\d{1,2}\s*[〜~～\-]\s*(\d{1,2})\/(\d{1,2})\s*\)/);
      if (!m) continue;
      const y = Number(e.date.slice(0, 4));
      to = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
      if (to > addDays(e.date, 7)) to = `${y - 1}${to.slice(4)}`;
    }
    if (to > last) last = to;
  }
  return last;
}
