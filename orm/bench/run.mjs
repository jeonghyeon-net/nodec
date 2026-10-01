import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, platform, arch, release } from 'node:os';
import { createHash } from 'node:crypto';
import { scenarios } from './fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = { rows: 10000, samples: 9, 'target-ms': 25, 'warmup-ms': 100, out: 'results/local/latest' };
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace(/^--/, '');
  if (!Object.hasOwn(options, key) || args[i + 1] === undefined) throw new Error(`Unknown/missing option: ${args[i]}`);
  options[key] = key === 'out' ? args[i + 1] : Number(args[i + 1]);
}
for (const [key, max] of [['rows', 1000000], ['samples', 100], ['target-ms', 1000], ['warmup-ms', 10000]]) {
  if (!Number.isInteger(options[key]) || options[key] < 1 || options[key] > max) throw new Error(`Invalid ${key}`);
}
const results = [];
for (const study of ['mapping', 'sqlite']) {
  let index = 0;
  for (const scenario of Object.keys(scenarios)) {
    const engines = study === 'mapping' ? ['generic', 'compiled', 'native'] : ['driver', 'generic', 'compiled', 'native'];
    // Rotate order across scenarios. Every measurement still gets a fresh process.
    const order = [...engines.slice(index), ...engines.slice(0, index)];
    index++;
    for (const engine of order) {
      const config = {
        study, scenario, engine, rowCount: options.rows, samples: options.samples,
        targetMs: options['target-ms'], warmupMs: options['warmup-ms'],
      };
      const child = spawnSync(process.execPath, ['--expose-gc', join(root, 'bench/worker.mjs'), JSON.stringify(config)], {
        cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
      });
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error(child.stderr || `Benchmark failed: ${child.status}`);
      const result = JSON.parse(child.stdout);
      results.push(result);
      console.log(`${study.padEnd(7)} ${scenario.padEnd(8)} ${engine.padEnd(8)} ${result.medianMs.toFixed(3)} ms/query`);
    }
  }
}

const source = createHash('sha256');
const sourceFiles = ['src', 'native', 'bench', 'scripts'].flatMap(folder =>
  readdirSync(join(root, folder)).sort().map(file => `${folder}/${file}`));
for (const file of sourceFiles) source.update(file).update('\0').update(readFileSync(join(root, file))).update('\0');
const compiler = spawnSync(process.env.CC || 'cc', ['--version'], { encoding: 'utf8' });
const report = {
  measuredAtUtc: new Date().toISOString(),
  environment: { node: process.version, v8: process.versions.v8, napi: process.versions.napi,
    platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0]?.model,
    logicalCpus: cpus().length, compiler: compiler.stdout?.split('\n')[0] },
  sourceSha256: source.digest('hex'), sourceFiles, options, results,
};
const sqliteVersions = results.find(result => result.sqliteVersions)?.sqliteVersions;
const lines = [
  '# ORM initial experiment results', '',
  `- Measured (UTC): ${report.measuredAtUtc}`,
  `- Node: ${report.environment.node}; V8: ${report.environment.v8}`,
  `- Host: ${report.environment.platform}/${report.environment.arch}, ${report.environment.cpu}`,
  `- Compiler: ${report.environment.compiler}`,
  `- SQLite: Node ${sqliteVersions.node}; C addon ${sqliteVersions.native}`,
  `- Source SHA-256: \`${report.sourceSha256}\` (file list in adjacent JSON)`,
  `- Input: ${options.rows.toLocaleString('en-US')} rows; ${options.samples} measured batches per variant; fresh process per variant.`,
  '',
  'Each row includes decoding/mapping and allocation of the complete returned JS result. Lower is better.',
  'Preparation, fixture creation, insertion, and warmup are outside timing. Warmup uses a time budget, not a proof of complete JIT stabilization.',
  'p95 is the p95 of batch means, not an HTTP request latency percentile. CPU includes user + system time across the process.',
  '',
  '| Study | Scenario | Engine | Rows returned | Median ms/query | p95 batch mean ms | Median CPU ms/query |',
  '| --- | --- | --- | ---: | ---: | ---: | ---: |',
  ...results.map(r => `| ${r.study} | ${r.scenario} | ${r.engine} | ${r.returnedRows} | ${r.medianMs.toFixed(3)} | ${r.p95BatchMeanMs.toFixed(3)} | ${r.medianCpuMs.toFixed(3)} |`),
  '', '## Interpretation boundaries', '',
  '- `mapping` uses the same pre-encoded fixture across engines, including output creation and accessed-cell validation. It isolates mapping; it is not a database latency benchmark.',
  '- `sqlite` uses real file-backed SQLite, the same SQL and bound values, deterministic insertion order, and warm caches. The native implementation directly materializes ORM values; JS implementations map `node:sqlite` rows.',
  '- `driver` is a lower-overhead control returning SQLite values in null-prototype objects. Projections in this benchmark exclude booleans, so scalar values match; raw() is not a general substitute for ORM conversion.',
  ...(sqliteVersions.node !== sqliteVersions.native
    ? ['- **SQLite versions differ. The SQLite comparison measures complete implementation paths, not an isolated language or hydration effect. Use the mapping study to separate that question.**'] : []),
  '- These are synchronous APIs. Moving a loop into C does not move it off the Node event loop.',
  '- No claim about TypeORM speedups, relations, production traffic, peak memory, cold I/O, or concurrent load follows from these measurements.',
  '- Re-run on the target host; compiler, Node, SQLite, dataset, JIT, GC, and system load affect results.', '',
];
const prefix = resolve(root, options.out);
mkdirSync(dirname(prefix), { recursive: true });
writeFileSync(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${prefix}.md`, lines.join('\n'));
console.log(`Saved ${relative(root, prefix)}.{json,md}`);
