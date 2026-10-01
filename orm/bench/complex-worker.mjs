import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { openSession } from '../src/session.mjs';
import { defineModel } from '../src/orm.mjs';
import { makeCommerce, seedCommerce, joinQuery, aggregateQuery, hydrateCommerce,
  graphOracle, flatOracle, summaryOracle, prepareTransfer } from './commerce.mjs';

const config = JSON.parse(process.argv[2]);
const { engine, scenario, customers, samples, warmupMs, targetMs } = config;
const directory = mkdtempSync(join(tmpdir(), 'nodec-complex-bench-'));
let session;
try {
  const path = join(directory, 'bench.sqlite'), source = makeCommerce(customers);
  seedCommerce(path, source);
  session = openSession(path, { engine });
  const text = (sql, name) => session.prepareQuery(sql, [], defineModel('Text', { [name]: 'string' })).all();
  const number = (sql, name) => session.prepareQuery(sql, [], defineModel('Number', { [name]: 'int32' })).all()[0][name];
  const sqlite = {
    version: text('SELECT sqlite_version() AS version', 'version')[0].version,
    compileOptions: text('PRAGMA compile_options', 'compile_options').map(r => r.compile_options),
    journalMode: text('SELECT journal_mode FROM pragma_journal_mode', 'journal_mode')[0].journal_mode,
    synchronous: number('PRAGMA synchronous', 'synchronous'),
    busyTimeout: number('PRAGMA busy_timeout', 'timeout'),
    walAutocheckpoint: number('PRAGMA wal_autocheckpoint', 'wal_autocheckpoint'),
    pageSize: number('PRAGMA page_size', 'page_size'),
  };
  let execute, validate, sql = null, parameters = null, queryPlan = null, returnedRows = null, flatRows = null;
  let operations = 0;
  if (scenario.startsWith('transfer-')) {
    const transfer = prepareTransfer(session), rollback = scenario === 'transfer-rollback';
    execute = () => {
      const result = transfer.execute(rollback);
      operations++;
      return result;
    };
    validate = () => {
      const committed = rollback ? 0 : operations;
      assert.deepEqual(transfer.balances.all().map(r => ({ ...r })),
        [{ id: 1, balance: 1000000000 - committed * 3 }, { id: 2, balance: 1000000000 + committed * 3 }]);
      assert.equal(transfer.count.all()[0].count, committed);
    };
  } else {
    const page = scenario === 'join-page' ? { limit: 50, offset: 10 } : {};
    const q = scenario === 'aggregate' ? aggregateQuery : joinQuery(page);
    ({ sql, parameters } = q);
    const plan = session.prepareQuery(sql, parameters, q.model);
    queryPlan = session.prepareQuery(`EXPLAIN QUERY PLAN ${sql}`, parameters,
      defineModel('Plan', { id: 'int32', parent: 'int32', notused: 'int32', detail: 'string' })).all().map(r => ({ ...r }));
    const graph = scenario === 'aggregate' ? null : graphOracle(source, page);
    const expected = scenario === 'aggregate' ? summaryOracle(source)
      : scenario === 'join-flat' ? flatOracle(graph) : graph;
    flatRows = plan.all().length;
    returnedRows = expected.length;
    execute = scenario === 'join-flat' || scenario === 'aggregate' ? () => plan.all() : () => hydrateCommerce(plan.all());
    validate = actual => assert.deepEqual(actual.map(row => ({ ...row })), expected);
  }
  validate(execute());
  let warmupOps = 0;
  const startWarmup = performance.now();
  do { globalThis.__result = execute(); warmupOps++; } while (performance.now() - startWarmup < warmupMs);
  const batchSize = Math.max(1, Math.min(2000, Math.ceil(targetMs * warmupOps / (performance.now() - startWarmup))));
  globalThis.__result = undefined;
  global.gc?.();
  const wallMsPerOperation = [], cpuMsPerOperation = [];
  for (let sample = 0; sample < samples; sample++) {
    await setImmediate();
    const cpuStart = process.cpuUsage(), start = performance.now();
    for (let i = 0; i < batchSize; i++) globalThis.__result = execute();
    const elapsed = performance.now() - start, cpu = process.cpuUsage(cpuStart);
    wallMsPerOperation.push(elapsed / batchSize);
    cpuMsPerOperation.push((cpu.user + cpu.system) / 1000 / batchSize);
  }
  validate(globalThis.__result);
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  console.log(JSON.stringify({ ...config, sqlite, sql, parameters, queryPlan, returnedRows, flatRows,
    fixtureCounts: Object.fromEntries(Object.entries(source).map(([name, rows]) => [name, rows.length])),
    operationsIncludingWarmup: operations || null, warmupOps, batchSize,
    medianMs: percentile(wallMsPerOperation, 0.5), p95BatchMeanMs: percentile(wallMsPerOperation, 0.95),
    medianCpuMs: percentile(cpuMsPerOperation, 0.5), wallMsPerOperation, cpuMsPerOperation }));
} finally {
  session?.close();
  rmSync(directory, { recursive: true, force: true });
}
