import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, platform, arch, release } from 'node:os';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = { customers: 1000, samples: 9, 'lock-samples': 3, 'target-ms': 25, 'warmup-ms': 150, out: 'results/local/complex' };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace(/^--/, '');
  if (!Object.hasOwn(options, key) || args[i + 1] === undefined) throw new Error(`Invalid option ${args[i]}`);
  options[key] = key === 'out' ? args[i + 1] : Number(args[i + 1]);
}
for (const [key, max] of [['customers', 10000], ['samples', 100], ['lock-samples', 10], ['target-ms', 1000], ['warmup-ms', 10000]]) {
  if (!Number.isInteger(options[key]) || options[key] < 1 || options[key] > max) throw new Error(`Invalid ${key}`);
}
const run = (script, config) => {
  const child = spawnSync(process.execPath, ['--expose-gc', join(root, `bench/${script}`), JSON.stringify(config)], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(child.stderr || `Benchmark exited ${child.status}`);
  return JSON.parse(child.stdout);
};
const results = [], contention = [];
const engines = ['driver', 'generic', 'compiled', 'native'];
const scenarios = ['join-flat', 'join-graph', 'join-page', 'aggregate', 'transfer-commit', 'transfer-rollback'];
for (const [i, scenario] of scenarios.entries()) {
  const rotation = i % engines.length;
  for (const engine of [...engines.slice(rotation), ...engines.slice(0, rotation)]) {
    const result = run('complex-worker.mjs', { engine, scenario, customers: options.customers, samples: options.samples,
      warmupMs: options['warmup-ms'], targetMs: options['target-ms'] });
    results.push(result);
    console.log(`${scenario.padEnd(18)} ${engine.padEnd(8)} ${result.medianMs.toFixed(3)} ms/operation`);
  }
}
for (const engine of engines) {
  const result = run('contention-runner.mjs', { engine, samples: options['lock-samples'] });
  contention.push(result);
  console.log(`contention         ${engine.padEnd(8)} ${result.summary.medianThroughput.toFixed(1)} tx/s, p99 ${result.summary.p99Ms.toFixed(1)} ms`);
}

const hash = createHash('sha256');
const sourceFiles = ['src', 'native', 'bench', 'scripts'].flatMap(folder => readdirSync(join(root, folder)).sort().map(file => `${folder}/${file}`));
for (const file of sourceFiles) hash.update(file).update('\0').update(readFileSync(join(root, file))).update('\0');
const compiler = spawnSync(process.env.CC || 'cc', ['--version'], { encoding: 'utf8' });
const report = {
  measuredAtUtc: new Date().toISOString(), options,
  environment: { node: process.version, v8: process.versions.v8, napi: process.versions.napi,
    platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length,
    compiler: compiler.stdout?.split('\n')[0] },
  sourceSha256: hash.digest('hex'), sourceFiles, results, contention,
};
const median = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length / 2) - 1];
const lines = [
  '# SQLite complex workload experiments', '',
  `- Measured UTC: ${report.measuredAtUtc}`,
  `- Host: ${report.environment.platform}/${report.environment.arch}, ${report.environment.cpu}; Node ${process.version}`,
  `- Compiler: ${report.environment.compiler}`,
  `- Source SHA-256: \`${report.sourceSha256}\` (exact files in adjacent JSON)`,
  `- Fixture counts: ${JSON.stringify(results[0].fixtureCounts)}`,
  `- SQLite: ${engines.map(engine => `${engine} ${results.find(r => r.engine === engine).sqlite.version}`).join('; ')}`,
  '- WAL; synchronous=FULL; foreign_keys=ON; wal_autocheckpoint=1000. Versions, compile options, SQL, parameters and EXPLAIN QUERY PLAN are saved in JSON.',
  '', '## JOIN, aggregation, and transactions', '',
  '| Scenario | Engine | Flat rows / returned roots | Median ms/op | p95 batch mean ms | Median CPU ms/op |',
  '| --- | --- | ---: | ---: | ---: | ---: |',
  ...results.map(r => `| ${r.scenario} | ${r.engine} | ${r.flatRows ?? '—'} / ${r.returnedRows ?? '—'} | ${r.medianMs.toFixed(3)} | ${r.p95BatchMeanMs.toFixed(3)} | ${r.medianCpuMs.toFixed(3)} |`),
  '',
  '- `join-flat`: four LEFT JOINs across five tables, including item × payment fanout. Returns every flat row.',
  '- `join-graph`: same query plus shared JS identity maps to deduplicate customers/orders/items/payments and allocate the complete nested result.',
  '- `join-page`: CTE limits 50 active customers after offset 10 BEFORE joining children; never truncates a parent’s children.',
  '- `aggregate`: pre-aggregates items and payments separately, then JOIN / GROUP BY / HAVING / SUM / ORDER BY / LIMIT. Prevents inflated sums from fanout.',
  '- `transfer-commit`: BEGIN IMMEDIATE → debit → credit → insert ledger row → read own balances → COMMIT. CHECK and foreign-key constraints enabled.',
  '- `transfer-rollback`: same body, then intentional application error and ROLLBACK; balances and ledger must remain unchanged.',
  '- Prepared statements and fixtures are outside timing. Warm cache, time-budget warmup, one forced GC after warmup. Measured output allocations and incidental GC are included.',
  '- Each variant has a fresh process/database. Engine order rotates by scenario. p95 above is over batch means, not individual request latency.',
  '', '## Writer contention (individual transaction latencies)', '',
  '| Engine | Median tx/s | p50 ms | p95 ms | p99 ms | Max ms | SQLITE_BUSY attempts |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...contention.map(r => `| ${r.engine} | ${r.summary.medianThroughput.toFixed(1)} | ${r.summary.p50Ms.toFixed(3)} | ${r.summary.p95Ms.toFixed(3)} | ${r.summary.p99Ms.toFixed(3)} | ${r.summary.maxMs.toFixed(3)} | ${r.summary.busy} |`),
  '',
  `- ${options['lock-samples']} repeated runs per engine on the same fixture; each run uses three fresh worker threads/connections that each complete 40 transfers. Workers start after all connections/statements are ready.`,
  '- Closed-loop load (one outstanding transaction per worker). Each transaction deliberately holds the write lock for 2ms, simulating work inside a transaction; this is included in latency and dominates throughput.',
  '- busy_timeout=5ms; failed BEGIN retries with explicit 1–3ms backoff and a 10-second per-operation deadline. Latencies include all lock waits, retries, application hold, SQL and commit.',
  '- All 120 commits per run must be reflected exactly once in both balances and ledger. Any non-busy failure or exhausted deadline fails the run; none are omitted.',
  '- CPU in the JSON covers the entire process including worker threads. HTTP/arrival queue latency and production concurrency are not measured.',
  '', '## Lock waits and the Node event loop', '',
  '| Engine | Outcome | busy timeout ms | Holder ms | Median call ms | Median setImmediate delay ms | Median reader ms |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ...contention.flatMap(r => [true, false].map(busy => {
    const cases = r.locks.filter(c => c.busy === busy), c = cases[0];
    return `| ${r.engine} | ${busy ? 'SQLITE_BUSY' : 'commit after release'} | ${c.busyTimeoutMs} | ${c.holdMs} | ${median(cases.map(c => c.callMs)).toFixed(3)} | ${median(cases.map(c => c.immediateDelayMs)).toFixed(3)} | ${median(cases.map(c => c.readerMs)).toFixed(3)} |`;
  })),
  '',
  '- A separate worker holds BEGIN IMMEDIATE after updating counter row 1. The main thread reads the previous committed value, then tries to update row 2. This verifies database writer contention even across different rows.',
  '- A setImmediate callback is scheduled just before the synchronous write attempt. Its delay directly probes main-thread blocking for that call, including native busy waiting; it is not an event-loop histogram under HTTP load.',
  '- The short timeout must fail, the longer timeout must commit after release, and both connections must work afterward. A missed lock schedule fails validation instead of being silently recorded as a sample.',
  '', '## Interpretation boundaries', '',
  '- This expands workload coverage, not ORM feature parity: hand-authored parameterized SQL and an explicit result schema enter an experimental single-connection session API. There is no general relation query builder or TypeORM comparison.',
  '- Native reads/writes run through C SQLite and Node-API. Graph grouping is the SAME JS function for all engines; this does not test a C relationship assembler.',
  '- Node and native SQLite versions/build options can differ; SQL execution plans are retained. These are complete-path comparisons, not proof of a language-only speedup.',
  '- Native statements retain their bound values from preparation; Node statement calls bind on execution. Preparation is excluded in both paths. This API-level difference remains part of the measured path.',
  '- The driver control skips scalar validation and returns null-prototype flat rows. Selected fields contain no booleans; nested graph values/prototypes agree. Raw flat rows are normalized only during validation.',
  '- SQLite WAL has one writer, not PostgreSQL/MySQL row locks or SELECT FOR UPDATE. Waiting in C still blocks the calling Node thread. Worker threads here generate load and do not make the session API asynchronous.',
  '- No power-loss durability, cold I/O, relation cache, peak memory, network, GraphQL, or production traffic claim follows. Run on target hardware and repeat before generalizing.',
  '', 'References: [SQLite WAL](https://www.sqlite.org/wal.html), [SQLite transactions](https://www.sqlite.org/lang_transaction.html).', '',
];
const prefix = resolve(root, options.out);
mkdirSync(dirname(prefix), { recursive: true });
writeFileSync(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${prefix}.md`, lines.join('\n'));
console.log(`Saved ${prefix}.{json,md}`);
