import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { openSqlite } from '../src/sqlite.mjs';
import { User, makeRows, oracle, scenarios } from './fixtures.mjs';

const config = JSON.parse(process.argv[2]);
const { study, scenario, engine, rowCount, samples, targetMs, warmupMs } = config;
const rows = makeRows(rowCount), options = scenarios[scenario];
let db, directory, execute, versions = null;
try {
  if (study === 'mapping') {
    const buffer = User.encode(rows);
    const plan = User.prepare(options);
    execute = () => plan.execute(buffer, engine);
  } else {
    directory = mkdtempSync(join(tmpdir(), 'nodec-orm-bench-'));
    db = openSqlite(join(directory, 'bench.sqlite'), [User]);
    db.createSchema();
    db.tables.User.insertMany(rows);
    versions = db.versions();
    const plan = db.tables.User.prepareFindMany(options);
    execute = engine === 'driver' ? () => plan.raw() : () => plan.all(engine);
  }
  const reference = oracle(rows, options);
  const actual = execute();
  assert.deepEqual(actual.map(row => ({ ...row })), reference);

  let warmupOps = 0;
  const warmupStart = performance.now();
  do {
    globalThis.__nodecResult = execute();
    warmupOps++;
  } while (performance.now() - warmupStart < warmupMs);
  const estimateMs = (performance.now() - warmupStart) / warmupOps;
  const batchSize = Math.max(1, Math.min(2000, Math.ceil(targetMs / estimateMs)));
  globalThis.__nodecResult = undefined;
  global.gc?.();

  const wallMsPerQuery = [], cpuMsPerQuery = [];
  for (let sample = 0; sample < samples; sample++) {
    await setImmediate();
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    for (let i = 0; i < batchSize; i++) globalThis.__nodecResult = execute();
    const elapsed = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    wallMsPerQuery.push(elapsed / batchSize);
    cpuMsPerQuery.push((cpu.user + cpu.system) / 1000 / batchSize);
  }
  assert.deepEqual(globalThis.__nodecResult.map(row => ({ ...row })), reference);
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  console.log(JSON.stringify({
    ...config, returnedRows: reference.length, batchSize, warmupOps, sqliteVersions: versions,
    medianMs: percentile(wallMsPerQuery, 0.5), p95BatchMeanMs: percentile(wallMsPerQuery, 0.95),
    medianCpuMs: percentile(cpuMsPerQuery, 0.5), wallMsPerQuery, cpuMsPerQuery,
  }));
} finally {
  db?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
}
