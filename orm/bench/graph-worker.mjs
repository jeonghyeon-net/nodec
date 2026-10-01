import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { openSession } from '../src/session.mjs';
import { defineModel } from '../src/orm.mjs';
import { seedCommerce, joinQuery, hydrateCommerce, graphOracle, flatOracle } from './commerce.mjs';
import { makeGraphFixture, graphCounts } from './graph-fixture.mjs';

const config = JSON.parse(process.argv[2]);
const { variant, scenario, customers, samples, profileSamples, warmupMs, targetMs } = config;
const directory = mkdtempSync(join(tmpdir(), 'nodec-graph-bench-'));
let session;
try {
  const source = makeGraphFixture(customers, scenario), path = join(directory, 'bench.sqlite');
  seedCommerce(path, source);
  const engine = variant.startsWith('native') ? 'native' : variant === 'node-driver-js' ? 'driver' : 'compiled';
  session = openSession(path, { engine });
  const options = scenario === 'page50' ? { limit: 50, offset: 10 } : {};
  const q = joinQuery(options), query = session.prepareQuery(q.sql, q.parameters, q.model);
  const expected = graphOracle(source, options), expectedFlat = flatOracle(expected), counts = graphCounts(expected);
  assert.deepEqual(query.all().map(row => ({ ...row })), expectedFlat);
  const execute = variant === 'native-graph' ? () => query.commerce()
    : variant === 'native-scan' ? () => query.scan()
    : variant === 'js-group-only' ? () => hydrateCommerce(expectedFlat)
    : () => hydrateCommerce(query.all());
  const validate = result => assert.deepEqual(result, variant === 'native-scan' ? expectedFlat.length : expected);
  validate(execute());
  const info = (sql, fields) => session.prepareQuery(sql, [], defineModel('Info', fields)).all().map(row => ({ ...row }));
  const sqlite = {
    version: info('SELECT sqlite_version() AS version', { version: 'string' })[0].version,
    compileOptions: info('PRAGMA compile_options', { compile_options: 'string' }).map(r => r.compile_options),
    journalMode: info('SELECT journal_mode FROM pragma_journal_mode', { journal_mode: 'string' })[0].journal_mode,
    synchronous: info('PRAGMA synchronous', { synchronous: 'int32' })[0].synchronous,
  };
  const queryPlan = session.prepareQuery(`EXPLAIN QUERY PLAN ${q.sql}`, q.parameters,
    defineModel('Plan', { id: 'int32', parent: 'int32', notused: 'int32', detail: 'string' })).all().map(row => ({ ...row }));
  let warmupOps = 0;
  const warmupStart = performance.now();
  do { globalThis.__result = execute(); warmupOps++; } while (performance.now() - warmupStart < warmupMs);
  const batchSize = Math.max(1, Math.min(2000, Math.ceil(targetMs * warmupOps / (performance.now() - warmupStart))));
  globalThis.__result = null;
  global.gc?.();
  const wallMs = [], cpuMs = [];
  for (let sample = 0; sample < samples; sample++) {
    await setImmediate();
    const cpuStart = process.cpuUsage(), start = performance.now();
    for (let i = 0; i < batchSize; i++) globalThis.__result = execute();
    const elapsed = performance.now() - start, cpu = process.cpuUsage(cpuStart);
    wallMs.push(elapsed / batchSize); cpuMs.push((cpu.user + cpu.system) / 1000 / batchSize);
  }
  validate(globalThis.__result);
  // Diagnostic instrumented passes run AFTER the primary benchmark and are never
  // used to claim an end-to-end speedup. Per-row clocks perturb execution.
  const profiles = [], immediateDelayMs = [], singleCallMs = [];
  global.gc?.();
  for (let sample = 0; sample < profileSamples; sample++) {
    const probeStart = performance.now();
    const probe = setImmediate().then(() => performance.now() - probeStart);
    globalThis.__result = execute();
    singleCallMs.push(performance.now() - probeStart);
    immediateDelayMs.push(await probe);
    validate(globalThis.__result);
    if (variant === 'native-scan' || variant === 'js-group-only') continue;
    const start = performance.now();
    const profile = variant === 'native-graph' ? query.commerce({ profile: true }) : query.profile();
    let rows = profile.rows, groupMs = 0;
    if (variant !== 'native-graph') {
      const groupStart = performance.now(); rows = hydrateCommerce(rows); groupMs = performance.now() - groupStart;
    }
    const profileWallMs = performance.now() - start;
    validate(rows);
    if (variant === 'native-graph') assert.deepEqual(profile.counts,
      { ...counts, flatRows: expectedFlat.length, intermediateRowObjects: 0 });
    profiles.push({ ...profile.timings, ...(variant !== 'native-graph' ? { jsGroupMs: groupMs } : {}), profileWallMs });
  }
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  console.log(JSON.stringify({ ...config, sqlite, sql: q.sql, parameters: q.parameters, queryPlan,
    fixtureCounts: Object.fromEntries(Object.entries(source).map(([name, rows]) => [name, rows.length])),
    counts: { ...counts, flatRows: expectedFlat.length,
      intermediateRowObjects: variant === 'native-graph' || variant === 'native-scan' || variant === 'js-group-only' ? 0
        : expectedFlat.length * (variant === 'node-compiled-js' ? 2 : 1) },
    batchSize, warmupOps, wallMs, cpuMs, medianMs: percentile(wallMs, 0.5), p95BatchMeanMs: percentile(wallMs, 0.95),
    medianCpuMs: percentile(cpuMs, 0.5), profiles, singleCallMs, immediateDelayMs,
  }));
} finally { session?.close(); rmSync(directory, { recursive: true, force: true }); }
