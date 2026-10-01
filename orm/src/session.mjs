import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { types } from 'node:util';
import { performance } from 'node:perf_hooks';
import { createMapper, fromSqlite } from './sqlite.mjs';

const native = createRequire(import.meta.url)('../build/mapper.node');

/** SQL-first experimental session. Reads and writes share ONE connection per session. */
export function openSession(path, { engine = 'compiled', busyTimeoutMs = 1000 } = {}) {
  if (!['driver', 'generic', 'compiled', 'native'].includes(engine)) throw new TypeError('Unknown engine');
  if (typeof path !== 'string' || !path || path === ':memory:' || path.startsWith('file:') || path.includes('\0')) {
    throw new TypeError('Expected a database filesystem path');
  }
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60000) throw new RangeError('Invalid busy timeout');
  // The fixture creator makes the file first; the native connection never creates files.
  const connection = engine === 'native'
    ? native.sqliteOpen(resolve(path), { writable: true, busyTimeoutMs }) : new DatabaseSync(resolve(path));
  let closed = false, inTransaction = false;
  const ensureOpen = () => { if (closed) throw new Error('Session is closed'); };
  const exec = sql => {
    ensureOpen();
    if (typeof sql !== 'string' || sql.includes('\0')) throw new TypeError('Invalid SQL');
    return engine === 'native' ? native.sqliteExec(connection, sql) : connection.exec(sql);
  };
  try {
    exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000;`);
  } catch (error) {
    if (engine === 'native') native.sqliteClose(connection); else connection.close();
    throw error;
  }

  function prepare(sql, parameters, model) {
    ensureOpen();
    if (typeof sql !== 'string' || sql.includes('\0')) throw new TypeError('Invalid SQL');
    if (!Array.isArray(parameters)) throw new TypeError('Expected parameter array');
    const values = Object.freeze(parameters.map(value => {
      if (value === null || (typeof value === 'number' && Number.isFinite(value)) ||
          (typeof value === 'string' && value.isWellFormed())) return value;
      throw new TypeError('Parameters support null, finite numbers, and well-formed strings');
    }));
    if (model && (!Array.isArray(model.fields) || !model.fields.length)) throw new TypeError('Expected result model');
    const statement = engine === 'native'
      ? (model ? native.sqlitePrepare(connection, sql, values, model.fields) : native.sqlitePrepareRun(connection, sql, values))
      : connection.prepare(sql);
    const map = model && createMapper(model.fields);
    const mapRows = rows => {
      if (engine === 'driver') return rows;
      if (engine === 'compiled') return rows.map(map);
      return rows.map(row => {
        const result = {};
        for (const field of model.fields) result[field.name] = fromSqlite(field, row[field.name]);
        return result;
      });
    };
    return Object.freeze({
      sql, parameters: values,
      ...(model ? { all() {
        ensureOpen();
        if (engine === 'native') return native.sqliteAll(statement);
        return mapRows(statement.all(...values));
      },
      profile() {
        ensureOpen();
        if (engine === 'native') return native.sqliteProfileAll(statement);
        const start = performance.now();
        const raw = statement.all(...values), afterRead = performance.now();
        const rows = mapRows(raw), end = performance.now();
        return { rows, timings: { driverReadMs: afterRead - start, ormMapMs: end - afterRead, totalMs: end - start } };
      },
      commerce({ profile = false } = {}) {
        ensureOpen();
        if (engine !== 'native') throw new Error('commerce() requires the native engine and commerce projection');
        return native.sqliteCommerceAll(statement, profile);
      },
      scan() {
        ensureOpen();
        if (engine !== 'native') throw new Error('scan() is a native diagnostic control');
        return native.sqliteScan(statement);
      } } : { run() {
        ensureOpen();
        return engine === 'native' ? native.sqliteRun(statement) : Number(statement.run(...values).changes);
      } }),
    });
  }
  const session = Object.freeze({
    engine, exec,
    prepareQuery(sql, parameters, resultModel) {
      if (!resultModel) throw new TypeError('A query needs a result model');
      return prepare(sql, parameters, resultModel);
    },
    prepareRun(sql, parameters = []) { return prepare(sql, parameters); },
    transaction(callback, { mode = 'IMMEDIATE' } = {}) {
      ensureOpen();
      if (inTransaction) throw new Error('Nested transactions are not supported');
      if (typeof callback !== 'function' || types.isAsyncFunction(callback)) throw new TypeError('A transaction needs a synchronous callback');
      if (!['DEFERRED', 'IMMEDIATE', 'EXCLUSIVE'].includes(mode)) throw new TypeError('Invalid transaction mode');
      exec(`BEGIN ${mode}`);
      inTransaction = true;
      try {
        const value = callback(session);
        if (value && typeof value.then === 'function') throw new TypeError('Transaction callback must be synchronous');
        exec('COMMIT');
        return value;
      } catch (error) {
        try { exec('ROLLBACK'); } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Transaction failed and rollback failed');
        }
        throw error;
      } finally { inTransaction = false; }
    },
    close() {
      if (closed) return;
      if (inTransaction) throw new Error('Cannot close a session inside a transaction');
      if (engine === 'native') native.sqliteClose(connection); else connection.close();
      closed = true;
    },
  });
  return session;
}

export function isBusy(error) {
  const code = error.sqliteCode ?? error.errcode;
  return typeof code === 'number' && (code & 0xff) === 5;
}
