import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, platform, arch, release } from 'node:os';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = { customers: 1000, samples: 7, repeats: 3, 'profile-samples': 7, 'target-ms': 25, 'warmup-ms': 200,
  out: 'results/local/graph' };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace(/^--/, '');
  if (!Object.hasOwn(options, key) || args[i + 1] === undefined) throw new Error(`Invalid option ${args[i]}`);
  options[key] = key === 'out' ? args[i + 1] : Number(args[i + 1]);
}
for (const [key, max] of [['customers', 5000], ['samples', 100], ['repeats', 10], ['profile-samples', 100], ['target-ms', 1000], ['warmup-ms', 10000]]) {
  if (!Number.isInteger(options[key]) || options[key] < 1 || options[key] > max) throw new Error(`Invalid ${key}`);
}
const scenarios = ['standard', 'fanout8', 'page50'];
const variants = ['node-driver-js', 'node-compiled-js', 'native-flat-js', 'native-graph', 'native-scan', 'js-group-only'];
const results = [];
for (let repeat = 0; repeat < options.repeats; repeat++) {
  for (const [index, scenario] of scenarios.entries()) {
    const rotate = (repeat + index) % variants.length;
    for (const variant of [...variants.slice(rotate), ...variants.slice(0, rotate)]) {
      const config = { repeat, variant, scenario, customers: options.customers, samples: options.samples,
        profileSamples: options['profile-samples'], targetMs: options['target-ms'], warmupMs: options['warmup-ms'] };
      const child = spawnSync(process.execPath, ['--expose-gc', join(root, 'bench/graph-worker.mjs'), JSON.stringify(config)], {
        cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
      });
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error(child.stderr || `Worker exited ${child.status}`);
      const result = JSON.parse(child.stdout); results.push(result);
      console.log(`${repeat + 1}/${options.repeats} ${scenario.padEnd(9)} ${variant.padEnd(17)} ${result.medianMs.toFixed(3)} ms`);
    }
  }
}
const sourceFiles = ['src', 'native', 'bench', 'scripts'].flatMap(folder => readdirSync(join(root, folder)).sort().map(file => `${folder}/${file}`));
const hash = createHash('sha256');
for (const file of sourceFiles) hash.update(file).update('\0').update(readFileSync(join(root, file))).update('\0');
const compiler = spawnSync(process.env.CC || 'cc', ['--version'], { encoding: 'utf8' });
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const median = values => percentile(values, 0.5);
const summaries = scenarios.flatMap(scenario => variants.map(variant => {
  const trials = results.filter(r => r.scenario === scenario && r.variant === variant);
  const profiles = trials.flatMap(t => t.profiles), keys = Object.keys(profiles[0] ?? {});
  return { scenario, variant, counts: trials[0].counts, trialMediansMs: trials.map(t => t.medianMs),
    medianMs: median(trials.map(t => t.medianMs)), medianCpuMs: median(trials.map(t => t.medianCpuMs)),
    profileMedians: Object.fromEntries(keys.map(key => [key, median(profiles.map(p => p[key]))])),
    medianImmediateDelayMs: median(trials.flatMap(t => t.immediateDelayMs)),
    maxImmediateDelayMs: Math.max(...trials.flatMap(t => t.immediateDelayMs)),
  };
}));
const report = { measuredAtUtc: new Date().toISOString(), options,
  environment: { node: process.version, v8: process.versions.v8, napi: process.versions.napi,
    platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0]?.model,
    logicalCpus: cpus().length, compiler: compiler.stdout?.split('\n')[0] },
  sourceSha256: hash.digest('hex'), sourceFiles, summaries, results };
const num = value => value === undefined ? '—' : value.toFixed(3);
const get = (scenario, variant) => summaries.find(s => s.scenario === scenario && s.variant === variant);
const endToEnd = summaries.filter(s => !['native-scan', 'js-group-only'].includes(s.variant));
const lines = [
  '# C relationship assembly and cost decomposition', '',
  `- Measured UTC: ${report.measuredAtUtc}`,
  `- Host: ${report.environment.platform}/${report.environment.arch}, ${report.environment.cpu}, Node ${process.version}`,
  `- Compiler: ${report.environment.compiler}`,
  `- SQLite: Node ${results.find(r => r.variant === 'node-compiled-js').sqlite.version}; ALL native variants ${results.find(r => r.variant === 'native-graph').sqlite.version}`,
  `- Source SHA-256: \`${report.sourceSha256}\`; exact source list, SQL, plans, build options and raw samples in JSON.`,
  `- ${options.repeats} fresh processes/databases per scenario/variant; ${options.samples} batches per process. Variant order rotates.`,
  '', '## End-to-end: identical nested JS results, profiling OFF', '',
  '| Scenario | Variant | Flat rows | Intermediate row objects | Median ms/op | Median CPU ms/op | Process trial medians ms |',
  '| --- | --- | ---: | ---: | ---: | ---: | --- |',
  ...endToEnd.map(s => `| ${s.scenario} | ${s.variant} | ${s.counts.flatRows} | ${s.counts.intermediateRowObjects} | ${num(s.medianMs)} | ${num(s.medianCpuMs)} | ${s.trialMediansMs.map(num).join(', ')} |`),
  '',
  ...scenarios.map(scenario => {
    const direct = get(scenario, 'native-graph'), native = get(scenario, 'native-flat-js'), js = get(scenario, 'node-compiled-js');
    return `- ${scenario}: native-graph takes ${(100 * (1 - direct.medianMs / native.medianMs)).toFixed(1)}% less time than native-flat-js (${(native.medianMs / direct.medianMs).toFixed(2)}× speedup), and ${(100 * (1 - direct.medianMs / js.medianMs)).toFixed(1)}% less time than node-compiled-js (${(js.medianMs / direct.medianMs).toFixed(2)}×). These are ratios of median query times, not server throughput measurements.`;
  }),
  '',
  '- `node-driver-js`: Node SQLite flat rows → shared JS grouping. Lower-validation control; scalar values and final graph match.',
  '- `node-compiled-js`: Node SQLite flat rows → generated typed JS mapper → shared JS grouping.',
  '- `native-flat-js`: C SQLite → typed flat JS rows → shared JS grouping (previous C architecture).',
  '- `native-graph`: SAME C SQLite and SQL → validate/decode → C hash maps and owned entity data → final nested JS objects. No intermediate JS row objects.',
  '- Both grouping implementations use global PK lookup and first-seen insertion order, including unordered/non-contiguous rows. The C graph is specialized to this commerce projection, not a general relationship planner.',
  '- All paths remain synchronous. Warmup and preparation are excluded; allocations, incidentally triggered GC and native cleanup are included. CPU is user + system for the process.',
  '', '## Diagnostic profiles (profiling ON; not speedup measurements)', '',
  '| Scenario | Variant | Node read incl. flat JS | JS type map | SQLite step | C decode | C grouping | Flat decode + JS creation | Final JS creation | JS grouping | Native cleanup | Profile wall ms |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...endToEnd.map(s => {
    const p = s.profileMedians;
    return `| ${s.scenario} | ${s.variant} | ${[p.driverReadMs, p.ormMapMs, p.sqliteStepMs, p.decodeMs, p.groupMs,
      p.flatDecodeAndMaterializeMs, p.materializeMs, p.jsGroupMs, p.cleanupMs, p.profileWallMs].map(num).join(' | ')} |`;
  }),
  '',
  '- Native phases use CLOCK_MONOTONIC around sqlite3_step, per-row decode, grouping, final V8 materialization, and native cleanup. Per-row clock calls perturb execution; primary results above have those clocks disabled.',
  '- SQLite step includes VM execution, JOIN/sort/I/O and creation of SQLite values. C decode validates storage and reads scalar/text pointers; grouping includes hash lookup, native allocations and unique string copies.',
  '- Final JS creation includes Node-API value conversion, objects, arrays, property writes and any incidental GC. The old flat path combines decoding and JS value creation; it cannot honestly label that whole interval as allocation alone.',
  '- Node driver read combines SQLite execution and its internal V8 row creation; the public API does not expose a clean split. JS type map includes validation plus extra row objects. JS grouping includes identity maps and final graph objects.',
  '- Profile wall includes envelopes and JS wrappers. Phase medians are independently calculated and need not sum to the median total; clocks/loop overhead is not assigned to a fake cost category.',
  '', '## Lower-work diagnostic controls (different return contracts)', '',
  '| Scenario | SQLite step-only scan ms | JS grouping of reused flat fixture ms | Final graph objects | Final graph arrays | C final property writes |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...scenarios.map(scenario => {
    const c = get(scenario, 'native-graph').counts;
    return `| ${scenario} | ${num(get(scenario, 'native-scan').medianMs)} | ${num(get(scenario, 'js-group-only').medianMs)} | ${c.finalObjects} | ${c.finalArrays} | ${c.finalPropertySets} |`;
  }),
  '',
  '- Scan executes the original SQL and counts rows without extracting fields or making row objects. It is a lower-work diagnostic, NOT an ORM result and not subtracted from a separate run to claim exact allocation time.',
  '- JS-only grouping reuses prebuilt plain flat objects outside the timed region. Its cache, lifetime and heap context differ from freshly returned driver rows. It is not an additive phase estimate.',
  '- Object/property counts are logical construction counts (excluding profiling envelopes), not measured heap bytes or GC counts.',
  '', '## Main-thread blocking probe', '',
  '| Scenario | Variant | Median setImmediate delay ms | Max delay ms |',
  '| --- | --- | ---: | ---: |',
  ...endToEnd.map(s => `| ${s.scenario} | ${s.variant} | ${num(s.medianImmediateDelayMs)} | ${num(s.maxImmediateDelayMs)} |`),
  '',
  '- A callback is scheduled before one unprofiled synchronous query. This measures its scheduling delay for one call, not HTTP p95/p99 or an asynchronous implementation.',
  '- Primary comparison is native-flat-js versus native-graph: same SQLite build, connection options, SQL, bindings, scalar validation and result values. Node comparisons retain the different SQLite build confound.',
  '- Data scenarios: standard commerce fixture; fanout8 has eight items × eight payments for eligible orders (empty relations retained); page50 limits 50 standard customers before JOIN.',
  '- Correctness uses an independent entity-array oracle before and after measurements and for every profile. Tests also cover sparse/negative ids, Unicode/NUL, null children, unsorted/interleaved rows, mutation isolation, corrupted data and transaction visibility.',
  '- No general ORM, TypeORM/class-transformer speedup, asynchronous execution, peak-memory, cold-I/O or production throughput claim follows from this experiment.', '',
];
const prefix = resolve(root, options.out);
mkdirSync(dirname(prefix), { recursive: true });
writeFileSync(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${prefix}.md`, lines.join('\n'));
console.log(`Saved ${prefix}.{json,md}`);
