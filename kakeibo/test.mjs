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
import { periodOf, periodRange, fixedDate, periodsBetween } from './calc.js';
assert.equal(periodOf('2026-10-24', 25), '2026-10');
assert.equal(periodOf('2026-10-25', 25), '2026-11');
assert.equal(periodOf('2026-12-30', 25), '2027-01');
assert.deepEqual(periodRange('2026-10', 25), { start: '2026-09-25', end: '2026-10-24', payday: '2026-10-25' });
assert.deepEqual(periodRange('2026-03', 1), { start: '2026-02-01', end: '2026-02-28', payday: '2026-03-01' });
assert.equal(fixedDate('2026-10', 27, 25), '2026-09-27');
assert.equal(fixedDate('2026-10', 1, 25), '2026-10-01');
assert.equal(periodOf(fixedDate('2026-01', 27, 25), 25), '2026-01');
assert.deepEqual(periodsBetween('2026-11', '2027-01'), ['2026-11', '2026-12', '2027-01']);
console.log('period ok');
r = settle([{ amount: 100000, ratioA: 50, payer: 'A', category: '家賃' }, { amount: 4321, ratioA: 50, payer: 'B', category: '食費' }]);
assert.equal(r.net, 47840); assert.equal(r.burdenA + r.burdenB, r.total);
console.log('rounding ok');
