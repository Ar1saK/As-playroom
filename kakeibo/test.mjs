import assert from 'node:assert';
import { settle, parseReceipt } from './calc.js';
// 家賃 100000 を A が払い 50:50、食費 3000 を B が払い 60:40(A60%)
let r = settle([
  { amount: 100000, ratioA: 50, payer: 'A', category: '家賃' },
  { amount: 3000, ratioA: 60, payer: 'B', category: '食費' },
]);
assert.equal(r.net, 50000 - 1800); // B→A 48200
r = settle([{ amount: 1000, ratioA: 30, payer: 'B', category: '食費' }]);
assert.equal(r.net, -300); // A→B 300
let p = parseReceipt('スーパー\n2026年10月29日\n小計 ¥1,980\n消費税 ¥158\n合計 ¥2,138\nお預り ¥3,000\nお釣 ¥862');
assert.deepEqual(p, { amount: 2138, date: '2026-10-29' });
p = parseReceipt('合 計　￥１,２３４');
assert.equal(p.amount, 1234);
console.log('ok');
