import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { defineModel, engines } from '../src/orm.mjs';
import { HEADER, SLOT } from '../src/layout.mjs';

const addon = createRequire(import.meta.url)('../build/mapper.node');
const User = defineModel('User', {
  id: 'int32', name: 'string', active: 'boolean', score: 'float64',
  note: { type: 'string', nullable: true }, age: { type: 'int32', nullable: true },
});
const rows = [
  { id: -2147483648, name: '서울🙂', active: true, score: -0, note: null, age: null },
  { id: 0, name: '', active: false, score: -42.25, note: 'a\0b', age: 0 },
  { id: 2147483647, name: 'é é', active: true, score: 1.5e100, note: '', age: 45 },
];
const buffer = User.encode(rows);

function expected(options = {}) {
  return rows.filter(row => Object.entries(options.where ?? {}).every(([key, value]) => row[key] === value))
    .slice(0, options.limit ?? rows.length)
    .map(row => Object.fromEntries((options.select ?? Object.keys(row)).map(key => [key, row[key]])));
}

test('all engines preserve values, Unicode, nulls, projection order, and filter semantics', () => {
  for (const options of [
    {}, { limit: 0 }, { limit: 1 }, { select: ['note', 'id'] },
    { where: { active: true }, select: ['id', 'name'], limit: 1 },
    { where: { note: null } }, { where: { note: 'a\0b' } },
    { where: { score: 0 } }, { where: { id: 42 } },
    { where: { active: true, age: 45, name: 'é é' } },
  ]) {
    const query = User.prepare(options);
    for (const engine of engines) assert.deepEqual(query.execute(buffer, engine), expected(options), engine);
  }
});

test('empty fixtures and model schema mismatch', () => {
  const query = User.prepare();
  for (const engine of engines) {
    assert.deepEqual(query.execute(User.encode([]), engine), []);
    const other = defineModel('Other', { number: 'int32' });
    assert.throws(() => other.prepare().execute(buffer, engine), /header/);
  }
});

test('generated source treats unusual field names and filter values as data', () => {
  const key = 'name"\n;globalThis.__nodecInjected = true;//';
  const Model = defineModel('Quoted', { [key]: 'string', '한글\0키': 'int32' });
  const value = '";throw new Error("injected");//';
  const data = [{ [key]: value, '한글\0키': 9 }];
  const query = Model.prepare({ where: { [key]: value } });
  for (const engine of engines) assert.deepEqual(query.execute(Model.encode(data), engine), data);
  assert.equal(globalThis.__nodecInjected, undefined);
});

test('invalid schemas, values, and unsupported queries fail explicitly', () => {
  for (const definition of [{}, { id: 'unknown' }, { constructor: 'string' }, { '\ud800': 'string' }]) {
    assert.throws(() => defineModel('Bad', definition));
  }
  for (const value of [undefined, null, 3.5, 2147483648, NaN]) {
    assert.throws(() => User.encode([{ ...rows[0], id: value }]));
  }
  assert.throws(() => User.encode([{ ...rows[0], name: '\ud800' }]));
  for (const options of [
    { select: [] }, { select: ['id', 'id'] }, { select: ['missing'] },
    { where: { missing: 1 } }, { where: { id: null } }, { where: { name: '\ud800' } },
    { limit: -1 }, { limit: 1.5 }, { limit: Infinity }, { include: { orders: true } },
  ]) assert.throws(() => User.prepare(options));
  assert.throws(() => User.prepare().execute(buffer, 'typo'), /engine/);
});

test('all engines reject truncated and corrupted accessed fields', () => {
  const variants = [
    Buffer.alloc(1), buffer.subarray(0, HEADER + 1),
    (() => { const b = Buffer.from(buffer); b.writeUInt32LE(0xffffffff, 8); return b; })(),
    (() => { const b = Buffer.from(buffer); b[HEADER] = 2; return b; })(),
    (() => { const b = Buffer.from(buffer); b[HEADER] = 0; return b; })(),
    (() => { const b = Buffer.from(buffer); b[HEADER + 2 * SLOT + 4] = 2; return b; })(),
    (() => { const b = Buffer.from(buffer); b.writeDoubleLE(Infinity, HEADER + 3 * SLOT + 4); return b; })(),
    (() => { const b = Buffer.from(buffer); b.writeUInt32LE(0, HEADER + SLOT + 4); return b; })(),
    (() => { const b = Buffer.from(buffer); b.writeUInt32LE(0xffffffff, HEADER + SLOT + 8); return b; })(),
    (() => { const b = Buffer.from(buffer); b[b.readUInt32LE(HEADER + SLOT + 4)] = 0xff; return b; })(),
  ];
  for (const engine of engines) {
    const query = User.prepare();
    for (const invalid of variants) assert.throws(() => query.execute(invalid, engine), undefined, engine);
    assert.throws(() => query.execute(new Uint8Array(buffer), engine), /Buffer/);
  }
});

test('seeded datasets agree with an independent row-level oracle', () => {
  let state = 42;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const source = Array.from({ length: 250 }, (_, id) => ({
    id, name: `user-${Math.floor(random() * 10)}🙂`, active: random() > 0.5,
    score: Math.floor(random() * 200) / 4, note: random() > 0.5 ? null : 'note',
    age: random() > 0.5 ? null : Math.floor(random() * 80),
  }));
  const encoded = User.encode(source);
  for (let i = 0; i < 30; i++) {
    const active = random() > 0.5, limit = Math.floor(random() * 200);
    const query = User.prepare({ where: { active }, select: ['id', 'name', 'note'], limit });
    const oracle = source.filter(row => row.active === active).slice(0, limit)
      .map(({ id, name, note }) => ({ id, name, note }));
    for (const engine of engines) assert.deepEqual(query.execute(encoded, engine), oracle);
  }
});

test('native entry points reject fake handles and malformed preparation inputs', () => {
  assert.throws(() => addon.execute({}, buffer));
  for (const spec of [undefined, {}, { fields: [] }, { fields: Array(129).fill({}) }]) {
    assert.throws(() => addon.prepare(spec));
  }
});

test('prepared queries do not retain or mutate earlier result objects', () => {
  for (const engine of engines) {
    const query = User.prepare();
    const first = query.execute(buffer, engine);
    first[0].name = 'changed';
    assert.deepEqual(query.execute(buffer, engine), rows);
  }
});
