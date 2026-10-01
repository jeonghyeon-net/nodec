import { defineModel } from '../src/orm.mjs';

export const User = defineModel('User', {
  id: 'int32', name: 'string', email: 'string', active: 'boolean',
  score: 'float64', nickname: { type: 'string', nullable: true },
});

export function makeRows(count) {
  return Array.from({ length: count }, (_, id) => ({
    id, name: `사용자-${id}🙂`, email: `user-${id}@example.invalid`,
    active: id % 3 !== 0, score: (id % 1000) / 8,
    nickname: id % 4 === 0 ? null : `nick-${id}`,
  }));
}

// No boolean column in these projections: the raw SQLite control then has the
// same scalar values as ORM outputs, although its objects have null prototypes.
export const scenarios = Object.freeze({
  full: { select: ['id', 'name', 'email', 'score', 'nickname'] },
  filtered: { where: { active: true }, select: ['id', 'name', 'nickname'] },
  limited: { where: { active: true }, select: ['id', 'name'], limit: 100 },
});

export function oracle(rows, options) {
  return rows.filter(row => Object.entries(options.where ?? {}).every(([name, value]) => row[name] === value))
    .slice(0, options.limit ?? rows.length)
    .map(row => Object.fromEntries(options.select.map(name => [name, row[name]])));
}
