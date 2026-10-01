import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { openSession, isBusy } from '../src/session.mjs';
import { defineModel } from '../src/orm.mjs';
import { makeCommerce, seedCommerce, joinQuery, aggregateQuery, hydrateCommerce,
  graphOracle, flatOracle, summaryOracle, prepareTransfer, BalanceRow } from '../bench/commerce.mjs';
import { runLockCase, runContended } from '../bench/contention.mjs';

const engines = ['driver', 'generic', 'compiled', 'native'];
const plain = rows => rows.map(row => ({ ...row }));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nodec-complex-test-'));
  const path = join(directory, 'test.sqlite');
  const source = makeCommerce(40);
  seedCommerce(path, source);
  const sessions = [];
  t.after(() => { for (const session of sessions) session.close(); rmSync(directory, { recursive: true, force: true }); });
  return { source, path, open(engine, busyTimeoutMs = 0) {
    const session = openSession(path, { engine, busyTimeoutMs });
    sessions.push(session);
    return session;
  } };
}

test('four LEFT JOINs preserve empty relations and deduplicate both fanout branches', t => {
  const f = fixture(t);
  for (const engine of engines) {
    const session = f.open(engine);
    for (const options of [{}, { limit: 8, offset: 3 }, { limit: 0 }, { offset: 1000 }]) {
      const { sql, parameters, model } = joinQuery(options);
      const query = session.prepareQuery(sql, parameters, model);
      const rows = query.all();
      assert.deepEqual(plain(rows), flatOracle(graphOracle(f.source, options)), engine);
      assert.deepEqual(hydrateCommerce(rows), graphOracle(f.source, options), engine);
      if (!Object.keys(options).length) {
        assert.ok(rows.length > f.source.items.length, 'exercise join fanout');
        assert.ok(hydrateCommerce(rows).some(c => c.orders.length === 0), 'empty customer');
        assert.ok(hydrateCommerce(rows).some(c => c.orders.some(o => o.items.length === 0)), 'empty order');
      }
    }
    const q = aggregateQuery;
    assert.deepEqual(plain(session.prepareQuery(q.sql, q.parameters, q.model).all()), summaryOracle(f.source), engine);
  }
});

test('separate workers exercise timeout, lock wait success, and concurrent transaction invariants', async t => {
  const f = fixture(t);
  for (const engine of ['compiled', 'native']) {
    const timeout = await runLockCase(f.path, engine, { busyTimeoutMs: 10, holdMs: 150, expectBusy: true });
    assert.equal(timeout.busy, true);
    const success = await runLockCase(f.path, engine, { busyTimeoutMs: 500, holdMs: 50, expectBusy: false });
    assert.equal(success.busy, false);
    const result = await runContended(f.path, engine, { writers: 3, operations: 8, holdMs: 1, busyTimeoutMs: 0 });
    assert.equal(result.completed, 24);
    // Timing/CPU thresholds are deliberately absent: scheduling varies by host.
  }
});

test('all engines read their own writes and atomically commit or roll back transfers', t => {
  const f = fixture(t);
  for (const engine of engines) {
    const s = f.open(engine), transfer = prepareTransfer(s);
    const before = plain(transfer.balances.all()), count = transfer.count.all()[0].count;
    const expected = [{ id: 1, balance: before[0].balance - 3 }, { id: 2, balance: before[1].balance + 3 }];
    assert.deepEqual(plain(transfer.execute()), expected, 'read own uncommitted writes');
    assert.deepEqual(plain(transfer.balances.all()), expected);
    assert.equal(transfer.count.all()[0].count, count + 1);
    assert.equal(transfer.execute(true), null);
    assert.deepEqual(plain(transfer.balances.all()), expected);
    assert.equal(transfer.count.all()[0].count, count + 1);
    const fail = s.prepareRun('INSERT INTO transfer(account_id, amount) VALUES (?, ?)', [999, 10]);
    const update = s.prepareRun('UPDATE account SET balance = balance - 10 WHERE id = 1');
    assert.throws(() => s.transaction(() => { update.run(); fail.run(); }), /FOREIGN KEY/);
    assert.deepEqual(plain(transfer.balances.all()), expected, 'constraint failure rolled back first update');
    assert.equal(transfer.count.all()[0].count, count + 1);
    assert.throws(() => s.transaction(() => s.transaction(() => {})), /Nested/);
    assert.throws(() => s.transaction(async () => { update.run(); }), /synchronous/);
    assert.throws(() => s.transaction(() => Promise.resolve()), /synchronous/);
    assert.throws(() => s.transaction(() => s.close()), /inside a transaction/);
    assert.equal(s.transaction(() => 42), 42, 'usable after rollback');
    s.close();
    assert.throws(() => transfer.execute(), /closed/);
  }
});

test('WAL reader snapshot stays stable across a writer commit; stale upgrade is SQLITE_BUSY', t => {
  const f = fixture(t);
  for (const engine of engines) {
    const reader = f.open(engine), writer = f.open(engine);
    const query = reader.prepareQuery('SELECT id, balance FROM account ORDER BY id', [], BalanceRow);
    const update = writer.prepareRun('UPDATE account SET balance = balance + 1 WHERE id = 1');
    const staleUpdate = reader.prepareRun('UPDATE account SET balance = balance + 1 WHERE id = 2');
    const before = plain(query.all());
    reader.transaction(() => {
      assert.deepEqual(plain(query.all()), before);
      writer.transaction(() => update.run());
      assert.deepEqual(plain(query.all()), before, 'same snapshot');
      assert.throws(() => staleUpdate.run(), isBusy);
    }, { mode: 'DEFERRED' });
    assert.equal(query.all()[0].balance, before[0].balance + 1);
  }
});

test('writer lock rejects a different-row writer, allows WAL readers, and recovers on release', t => {
  const f = fixture(t);
  for (const engine of engines) {
    const holder = f.open(engine), contender = f.open(engine);
    const read = contender.prepareQuery('SELECT id, balance FROM account ORDER BY id', [], BalanceRow);
    const otherRow = contender.prepareRun('UPDATE account SET balance = balance + 1 WHERE id = 2');
    const before = plain(read.all());
    holder.exec('BEGIN IMMEDIATE; UPDATE account SET balance = balance + 1 WHERE id = 1;');
    try {
      assert.deepEqual(plain(read.all()), before, 'uncommitted value hidden, reader succeeds');
      assert.throws(() => contender.transaction(() => otherRow.run()), isBusy);
    } finally { holder.exec('ROLLBACK'); }
    assert.equal(contender.transaction(() => otherRow.run()), 1);
    assert.equal(read.all()[1].balance, before[1].balance + 1);
  }
});

test('native writable handles validate capabilities, arguments, and statement lifetimes', t => {
  const { path } = fixture(t);
  const native = createRequire(import.meta.url)('../build/mapper.node');
  const readOnly = native.sqliteOpen(path);
  const writable = native.sqliteOpen(path, { writable: true, busyTimeoutMs: 0 });
  try {
    assert.throws(() => native.sqliteExec(readOnly, 'DELETE FROM account'), /read-only/);
    assert.throws(() => native.sqlitePrepareRun(readOnly, 'DELETE FROM account', []), /Read-only/);
    assert.throws(() => native.sqliteOpen(path, { writable: true, busyTimeoutMs: -1 }));
    assert.throws(() => native.sqliteExec({}, 'SELECT 1'));
    assert.throws(() => native.sqliteRun({}));
    assert.throws(() => native.sqliteExec(writable, 'SELECT 1\0; DELETE FROM account'));
    assert.throws(() => native.sqlitePrepareRun(writable, 'UPDATE account SET balance = 1; DELETE FROM account', []));
    assert.throws(() => native.sqlitePrepareRun(writable, 'SELECT 1', []), /return columns/);
    const run = native.sqlitePrepareRun(writable, 'UPDATE account SET balance = balance + ? WHERE id = ?', [1, 1]);
    assert.throws(() => native.sqliteAll(run), /select/);
    assert.equal(native.sqliteRun(run), 1);
    const select = native.sqlitePrepare(writable, 'SELECT id, balance FROM account ORDER BY id', [], BalanceRow.fields);
    assert.throws(() => native.sqliteRun(select), /run statement/);
    native.sqliteClose(writable);
    assert.throws(() => native.sqliteRun(run), /closed/);
  } finally { native.sqliteClose(readOnly); native.sqliteClose(writable); }
});

test('session parameter binding and typed projection agree for Unicode, NUL, and null', t => {
  const f = fixture(t);
  const Model = defineModel('Projection', { text: 'string', value: { type: 'int32', nullable: true } });
  for (const engine of engines) {
    const s = f.open(engine);
    const value = "a\0🙂' OR 1=1 --";
    assert.deepEqual(plain(s.prepareQuery('SELECT ? AS text, ? AS value', [value, null], Model).all()), [{ text: value, value: null }]);
    assert.throws(() => s.prepareRun('SELECT ?', [undefined]));
  }
});
