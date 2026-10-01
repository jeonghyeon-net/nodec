import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { openSession } from '../src/session.mjs';
import { defineModel } from '../src/orm.mjs';
import { seedCommerce, joinQuery, graphOracle, flatOracle, JoinRow } from '../bench/commerce.mjs';
import { makeGraphFixture, graphCounts } from '../bench/graph-fixture.mjs';

function fixture(t, source = makeGraphFixture(80, 'standard')) {
  const directory = mkdtempSync(join(tmpdir(), 'nodec-graph-test-'));
  const path = join(directory, 'test.sqlite');
  seedCommerce(path, source);
  const session = openSession(path, { engine: 'native' });
  t.after(() => { session.close(); rmSync(directory, { recursive: true, force: true }); });
  return { session, path, source, query(options = {}, sql) {
    const q = joinQuery(options);
    return session.prepareQuery(sql ?? q.sql, q.parameters, q.model);
  } };
}

test('C grouping returns exactly the independent graph, including empty relations and dense fanout', t => {
  for (const scenario of ['standard', 'fanout8']) {
    const f = fixture(t, makeGraphFixture(100, scenario));
    for (const options of [{}, { limit: 17, offset: 8 }, { limit: 0 }, { offset: 10000 }]) {
      const query = f.query(options), expected = graphOracle(f.source, options), flat = flatOracle(expected);
      assert.deepEqual(query.commerce(), expected);
      assert.deepEqual(query.profile().rows, flat);
      assert.equal(query.scan(), flat.length);
      const profiled = query.commerce({ profile: true });
      assert.deepEqual(profiled.rows, expected);
      assert.deepEqual(profiled.counts, { flatRows: flat.length, ...graphCounts(expected), intermediateRowObjects: 0 });
      for (const value of Object.values(profiled.timings)) assert.ok(Number.isFinite(value) && value >= 0);
      const changed = query.commerce();
      if (changed.length) changed[0].name = 'mutated';
      assert.deepEqual(query.commerce(), expected, 'output allocations are independent across calls');
    }
  }
});

test('hash grouping preserves first-seen order for unsorted entities and non-contiguous duplicates', t => {
  const f = fixture(t);
  const base = joinQuery().sql;
  const descending = base.replace('ORDER BY c.id, o.id, i.id, pay.id', 'ORDER BY c.id DESC, o.id DESC, i.id DESC, pay.id DESC');
  const expected = graphOracle(f.source).reverse().map(c => ({ ...c, orders: c.orders.reverse().map(o => ({
    ...o, items: o.items.reverse(), payments: o.payments.reverse(),
  })) }));
  assert.deepEqual(f.query({}, descending).commerce(), expected);
  // Interleave customers/orders by item/payment ids. Independent oracle sorts flat tuples first,
  // then derives first-appearance entity ordering without invoking the JS production hydrator.
  const flat = flatOracle(graphOracle(f.source));
  flat.sort((a, b) => (a.itemId ?? -Infinity) - (b.itemId ?? -Infinity) ||
    (a.paymentId ?? -Infinity) - (b.paymentId ?? -Infinity) || a.customerId - b.customerId || (a.orderId ?? -Infinity) - (b.orderId ?? -Infinity));
  const first = (field, id) => flat.findIndex(row => row[field] === id);
  const shuffledExpected = graphOracle(f.source).sort((a, b) => first('customerId', a.id) - first('customerId', b.id));
  for (const c of shuffledExpected) {
    c.orders.sort((a, b) => first('orderId', a.id) - first('orderId', b.id));
    for (const o of c.orders) {
      o.items.sort((a, b) => first('itemId', a.id) - first('itemId', b.id));
      o.payments.sort((a, b) => first('paymentId', a.id) - first('paymentId', b.id));
    }
  }
  assert.deepEqual(f.query({}, base.replace('ORDER BY c.id, o.id, i.id, pay.id', 'ORDER BY i.id, pay.id, c.id, o.id')).commerce(), shuffledExpected);
});

test('C graph owns copied text and supports zero, negative, sparse int32 ids, Unicode and NUL', t => {
  const source = {
    customers: [{ id: -2147483648, name: '고객\0🙂', active: 1 }, { id: 0, name: '', active: 1 }],
    orders: [{ id: 2147483647, customerId: -2147483648, status: '' }],
    products: [{ id: 0, name: '상품\0é' }],
    items: [{ id: -1, orderId: 2147483647, productId: 0, quantity: 0, unitCents: -2147483648 }],
    payments: [{ id: 0, orderId: 2147483647, paidCents: 2147483647 }],
  };
  const f = fixture(t, source), q = f.query(), expected = graphOracle(source);
  const retained = q.commerce();
  f.session.exec("UPDATE customer SET name = 'changed'; UPDATE product SET name = 'changed';");
  assert.deepEqual(retained, expected);
  assert.equal(q.commerce()[0].name, 'changed');
  f.session.close();
  assert.deepEqual(retained, expected);
  assert.throws(() => q.commerce(), /closed/);
  assert.throws(() => q.profile(), /closed/);
  assert.throws(() => q.scan(), /closed/);
});

test('nullable child values preserve the same result contract', t => {
  const f = fixture(t);
  const sql = `SELECT 1 AS customerId, 'c' AS customerName, 0 AS orderId, NULL AS status,
    0 AS itemId, NULL AS productId, NULL AS productName, NULL AS quantity, NULL AS unitCents,
    0 AS paymentId, NULL AS paidCents`;
  const q = f.session.prepareQuery(sql, [], JoinRow);
  assert.deepEqual(q.commerce(), [{ id: 1, name: 'c', orders: [{ id: 0, status: null,
    items: [{ id: 0, quantity: null, unitCents: null, product: { id: null, name: null } }],
    payments: [{ id: 0, paidCents: null }],
  }] }]);
});

test('projection, corrupted scalar and fake handle errors reset safely without partial results', t => {
  const f = fixture(t), native = createRequire(import.meta.url)('../build/mapper.node');
  assert.throws(() => native.sqliteCommerceAll({}, false));
  assert.throws(() => native.sqliteProfileAll({}));
  assert.throws(() => native.sqliteScan({}));
  const wrong = f.session.prepareQuery('SELECT id FROM customer', [], defineModel('ID', { id: 'int32' }));
  assert.throws(() => wrong.commerce(), /projection/);
  const q = f.query();
  f.session.exec('UPDATE item SET quantity = 2147483648 WHERE id = 1');
  assert.throws(() => q.commerce(), /overflow/);
  assert.throws(() => q.commerce({ profile: true }), /overflow/);
  f.session.exec('UPDATE item SET quantity = 1 WHERE id = 1');
  assert.deepEqual(q.commerce(), graphOracle(f.source));
  const renamed = joinQuery().sql.replace('AS customerId', 'AS renamed');
  assert.throws(() => f.query({}, renamed).commerce(), /projection/);
});

test('native graph reads uncommitted writes on its session and observes rollback', t => {
  const f = fixture(t), q = f.query(), before = q.commerce();
  assert.throws(() => f.session.transaction(() => {
    f.session.prepareRun('UPDATE customer SET name = ? WHERE id = ?', ['inside', 1]).run();
    assert.equal(q.commerce()[0].name, 'inside');
    throw new Error('abort');
  }), /abort/);
  assert.deepEqual(q.commerce(), before);
});

test('JS profile instrumentation preserves driver and compiled results', t => {
  const f = fixture(t);
  for (const engine of ['driver', 'generic', 'compiled']) {
    const s = openSession(f.path, { engine });
    try {
      const q = joinQuery(), prepared = s.prepareQuery(q.sql, q.parameters, q.model);
      assert.deepEqual(prepared.profile().rows, prepared.all());
      assert.throws(() => prepared.commerce(), /native/);
    } finally { s.close(); }
  }
});
