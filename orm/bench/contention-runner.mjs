import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCommerce, seedCommerce } from './commerce.mjs';
import { runLockCase, runContended } from './contention.mjs';

const { engine, samples } = JSON.parse(process.argv[2]);
const directory = mkdtempSync(join(tmpdir(), 'nodec-lock-bench-'));
try {
  const path = join(directory, 'bench.sqlite');
  seedCommerce(path, makeCommerce(10));
  const locks = [], contention = [];
  for (let sample = 0; sample < samples; sample++) {
    locks.push(await runLockCase(path, engine, { busyTimeoutMs: 20, holdMs: 120, expectBusy: true }));
    locks.push(await runLockCase(path, engine, { busyTimeoutMs: 500, holdMs: 60, expectBusy: false }));
    contention.push(await runContended(path, engine));
  }
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  const latencies = contention.flatMap(r => r.workers.flatMap(w => w.latencies));
  console.log(JSON.stringify({ engine, samples, locks, contention,
    summary: { p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95), p99Ms: percentile(latencies, 0.99),
      maxMs: Math.max(...latencies), medianThroughput: percentile(contention.map(r => r.throughputPerSecond), 0.5),
      busy: contention.reduce((sum, r) => sum + r.busy, 0) } }));
} finally { rmSync(directory, { recursive: true, force: true }); }
