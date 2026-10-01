import { defineModel } from '../src/orm.mjs';
import { openSqlite } from '../src/sqlite.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const User = defineModel('User', {
  id: 'int32', name: 'string', active: 'boolean',
  score: 'float64', nickname: { type: 'string', nullable: true },
});

const directory = mkdtempSync(join(tmpdir(), 'nodec-orm-example-'));
const db = openSqlite(join(directory, 'users.sqlite'), [User]);
try {
  db.createSchema();
  const users = db.tables.User;
  users.insertMany([
    { id: 1, name: '민지', active: true, score: 4.5, nickname: null },
    { id: 2, name: '준호', active: false, score: 3.25, nickname: 'jun' },
    { id: 3, name: '서연', active: true, score: 4.75, nickname: '서연🙂' },
  ]);

  console.log(users.findMany({
    where: { active: true }, select: ['id', 'name', 'nickname'], limit: 10,
  }, { engine: 'native' }));
  console.log('SQLite versions:', db.versions());
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
