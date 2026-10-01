import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { checkValue, TYPE } from './layout.mjs';
import { normalizeQuery } from './orm.mjs';

const require = createRequire(import.meta.url);
let addon;
const native = () => addon ??= require('../build/mapper.node');
const sqlTypes = { [TYPE.int32]: 'INTEGER', [TYPE.float64]: 'REAL', [TYPE.boolean]: 'INTEGER', [TYPE.string]: 'TEXT' };

function quote(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) throw new TypeError('Invalid SQLite identifier');
  return `"${name.replaceAll('"', '""')}"`;
}

function fromSqlite(field, value) {
  if (field.type === TYPE.boolean && value !== null) {
    if (value !== 0 && value !== 1) throw new Error(`Invalid SQLite boolean: ${field.name}`);
    return value === 1;
  }
  checkValue(field, value);
  return value;
}

function createMapper(fields) {
  const properties = fields.map((field, index) =>
    `${JSON.stringify(field.name)}: read(fields[${index}], row[${JSON.stringify(field.name)}])`).join(',');
  return new Function('read', 'fields', `return row => ({ ${properties} });`)(fromSqlite, fields);
}

/** Experimental file-backed SQLite adapter. All three engines are synchronous. */
export function openSqlite(path, models) {
  if (typeof path !== 'string' || !path || path === ':memory:' || path.includes('\0') || path.startsWith('file:')) {
    throw new TypeError('Use a filesystem path: both SQLite implementations must open the same database');
  }
  if (!Array.isArray(models) || !models.length || new Set(models.map(model => model.name)).size !== models.length) {
    throw new TypeError('Provide uniquely named models');
  }
  for (const model of models) {
    quote(model.name);
    model.fields.forEach(field => quote(field.name));
  }
  path = resolve(path);
  const driver = new DatabaseSync(path);
  driver.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;');
  let nativeDatabase, closed = false;
  const tables = Object.create(null);
  const ensureOpen = () => { if (closed) throw new Error('Database is closed'); };

  for (const model of models) {
    const tableName = quote(model.name);
    tables[model.name] = Object.freeze({
      insertMany(rows) {
        ensureOpen();
        if (!Array.isArray(rows)) throw new TypeError('Rows must be an array');
        const columns = model.fields.map(field => quote(field.name)).join(', ');
        const statement = driver.prepare(`INSERT INTO ${tableName} (${columns}) VALUES (${model.fields.map(() => '?').join(',')})`);
        driver.exec('BEGIN');
        try {
          for (const row of rows) {
            const values = model.fields.map(field => {
              const value = row?.[field.name];
              checkValue(field, value);
              return typeof value === 'boolean' ? Number(value) : value;
            });
            statement.run(...values);
          }
          driver.exec('COMMIT');
        } catch (error) {
          driver.exec('ROLLBACK');
          throw error;
        }
      },
      prepareFindMany(options) {
        ensureOpen();
        const query = normalizeQuery(model.fields, options);
        const parameters = [];
        const predicates = query.filters.map(({ field, value }) => {
          if (value === null) return `${quote(field.name)} IS NULL`;
          parameters.push(typeof value === 'boolean' ? Number(value) : value);
          return `${quote(field.name)} = ?`;
        });
        parameters.push(query.limit);
        // Deterministic insertion order for this fixture adapter, including LIMIT queries.
        const sql = `SELECT ${query.selected.map(field => quote(field.name)).join(', ')} FROM ${tableName}` +
          (predicates.length ? ` WHERE ${predicates.join(' AND ')}` : '') + ' ORDER BY rowid LIMIT ?';
        const statement = driver.prepare(sql);
        const map = createMapper(query.selected);
        let nativeQuery;
        return Object.freeze({
          sql,
          parameters: Object.freeze(parameters),
          raw() {
            ensureOpen();
            return statement.all(...parameters);
          },
          all(engine = 'compiled') {
            ensureOpen();
            if (engine === 'native') {
              nativeDatabase ??= native().sqliteOpen(path);
              nativeQuery ??= native().sqlitePrepare(nativeDatabase, sql, parameters, query.selected);
              return native().sqliteAll(nativeQuery);
            }
            if (engine !== 'generic' && engine !== 'compiled') throw new TypeError(`Unknown engine: ${engine}`);
            const rows = statement.all(...parameters);
            if (engine === 'compiled') return rows.map(map);
            return rows.map(row => {
              const result = {};
              for (const field of query.selected) result[field.name] = fromSqlite(field, row[field.name]);
              return result;
            });
          },
        });
      },
      findMany(options, { engine = 'compiled' } = {}) {
        return this.prepareFindMany(options).all(engine);
      },
    });
  }

  return Object.freeze({
    tables: Object.freeze(tables),
    versions() {
      ensureOpen();
      return {
        node: driver.prepare('SELECT sqlite_version() AS version').get().version,
        native: native().sqliteVersion,
      };
    },
    createSchema() {
      ensureOpen();
      for (const model of models) {
        const columns = model.fields.map(field =>
          `${quote(field.name)} ${sqlTypes[field.type]}${field.nullable ? '' : ' NOT NULL'}`).join(', ');
        driver.exec(`CREATE TABLE IF NOT EXISTS ${quote(model.name)} (${columns}) STRICT`);
      }
    },
    close() {
      if (closed) return;
      if (nativeDatabase) native().sqliteClose(nativeDatabase);
      driver.close();
      closed = true;
    },
  });
}
