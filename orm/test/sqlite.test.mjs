import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { defineModel, engines } from '../src/orm.mjs';
import { openSqlite } from '../src/sqlite.mjs';

const native = createRequire(import.meta.url)('../build/mapper.node');
const User = defineModel('User', {
  id: 'int32', name: 'string', active: 'boolean', score: 'float64',
  note: { type: 'string', nullable: true },
});
const rows = [
  { id: 1, name: '민지🙂', active: true, score: 4.25, note: null },
  { id: 2, name: "' OR 1=1 --", active: false, score: -5.5, note: 'a\0b' },
  { id: 3, name: '', active: true, score: 0, note: '' },
];

function fixture(t, model = User) {
  const directory = mkdtempSync(join(tmpdir(), 'nodec-orm-test-'));
  const path = join(directory, 'test.sqlite');
  const db = openSqlite(path, [model]);
  db.createSchema();
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, path, table: db.tables[model.name] };
}

test('SQLite engines execute the same parameterized queries with ORM value semantics', t => {
  const { db, table } = fixture(t);
  table.insertMany(rows);
  for (const options of [
    {}, { limit: 0 }, { limit: 2 }, { select: ['note', 'id'] },
    { where: { active: true } }, { where: { note: null } },
    { where: { name: "' OR 1=1 --" } }, { where: { note: 'a\0b' } },
    { where: { id: 99 } }, { where: { active: true, score: 4.25 }, select: ['name'] },
  ]) {
    const oracle = rows.filter(row => Object.entries(options.where ?? {}).every(([key, value]) => row[key] === value))
      .slice(0, options.limit ?? rows.length)
      .map(row => Object.fromEntries((options.select ?? Object.keys(row)).map(key => [key, row[key]])));
    const query = table.prepareFindMany(options);
    for (const engine of engines) assert.deepEqual(query.all(engine), oracle, engine);
  }
  assert.equal(typeof db.versions().native, 'string');
});

test('SQLite identifiers are quoted and query values are bound', t => {
  const key = 'name"; DROP TABLE x; --';
  const Model = defineModel('table"; DROP TABLE x; --', { [key]: 'string' });
  const { table } = fixture(t, Model);
  const source = [{ [key]: "' OR 1=1 --" }, { [key]: 'other' }];
  table.insertMany(source);
  for (const engine of engines) {
    assert.deepEqual(table.findMany({ where: { [key]: source[0][key] } }, { engine }), [source[0]]);
  }
});

test('insertMany rolls back every row on validation failure', t => {
  const { table } = fixture(t);
  assert.throws(() => table.insertMany([rows[0], { ...rows[1], id: 1.5 }]));
  for (const engine of engines) assert.deepEqual(table.findMany({}, { engine }), []);
});

test('native statements are reusable and observe later committed inserts', t => {
  const { table } = fixture(t);
  const query = table.prepareFindMany({ select: ['id', 'name'] });
  assert.deepEqual(query.all('native'), []);
  table.insertMany(rows);
  for (const engine of engines) assert.deepEqual(query.all(engine), rows.map(({ id, name }) => ({ id, name })));
  const changed = query.all('native');
  changed[0].name = 'changed';
  assert.equal(query.all('native')[0].name, rows[0].name);
});

test('closing a database invalidates prepared native statements safely', t => {
  const { db, table, path } = fixture(t);
  table.insertMany(rows);
  const query = table.prepareFindMany();
  query.all('native');
  db.close();
  db.close();
  for (const engine of engines) assert.throws(() => query.all(engine), /closed/);
  const connection = native.sqliteOpen(path);
  const plan = native.sqlitePrepare(connection, 'SELECT id FROM User', [], [User.fields[0]]);
  native.sqliteClose(connection);
  assert.throws(() => native.sqliteAll(plan), /closed/);
  native.sqliteClose(connection);
});

test('corrupt model values in SQLite fail consistently and statements reset after errors', t => {
  const { table, path } = fixture(t);
  table.insertMany(rows);
  const external = new DatabaseSync(path);
  t.after(() => external.close());
  const query = table.prepareFindMany();
  external.exec('UPDATE User SET active = 2 WHERE id = 1');
  for (const engine of engines) assert.throws(() => query.all(engine), /boolean/);
  external.exec('UPDATE User SET active = 1 WHERE id = 1');
  for (const engine of engines) assert.deepEqual(query.all(engine), rows);
});

test('native SQLite API checks handles, preparation inputs, and read-only statements', t => {
  const { path } = fixture(t);
  assert.throws(() => native.sqliteAll({}));
  assert.throws(() => native.sqliteClose({}));
  const connection = native.sqliteOpen(path);
  try {
    for (const [sql, values, columns] of [
      ['SELECT id FROM User', [], []],
      ['SELECT id FROM User WHERE id = ?', [], [User.fields[0]]],
      ['SELECT id FROM User; SELECT id FROM User', [], [User.fields[0]]],
      ['DELETE FROM User', [], [User.fields[0]]],
      ['SELECT id FROM User', [], [{ name: 'id', type: 9, nullable: false }]],
    ]) assert.throws(() => native.sqlitePrepare(connection, sql, values, columns));
  } finally { native.sqliteClose(connection); }
});

test('driver control exposes raw SQLite scalars rather than claiming hydrated output', t => {
  const { table } = fixture(t);
  table.insertMany(rows);
  const query = table.prepareFindMany({ limit: 1 });
  assert.equal(query.raw()[0].active, 1);
  assert.equal(query.all('native')[0].active, true);
});
