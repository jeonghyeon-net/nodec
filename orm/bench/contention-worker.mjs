import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { openSession, isBusy } from '../src/session.mjs';
import { prepareTransfer } from './commerce.mjs';

const { path, engine, role, busyTimeoutMs, holdMs = 0, operations = 0 } = workerData;
const session = openSession(path, { engine, busyTimeoutMs });
const sleepWord = new Int32Array(new SharedArrayBuffer(4));
const transfer = role === 'writer' ? prepareTransfer(session) : null;
parentPort.postMessage({ type: 'ready' });
parentPort.once('message', () => {
  try {
    if (role === 'holder') {
      session.exec('BEGIN IMMEDIATE; UPDATE counter SET value = value + 1 WHERE id = 1;');
      parentPort.postMessage({ type: 'locked' });
      Atomics.wait(sleepWord, 0, 0, holdMs);
      session.exec('COMMIT');
      parentPort.postMessage({ type: 'released' });
    } else {
      const latencies = [], attemptsPerOperation = [];
      let busy = 0, retries = 0;
      const start = performance.now();
      for (let i = 0; i < operations; i++) {
        const operationStart = performance.now();
        let attempts = 0;
        for (;;) {
          attempts++;
          try {
            transfer.execute(false, () => { if (holdMs) Atomics.wait(sleepWord, 0, 0, holdMs); });
            break;
          } catch (error) {
            if (!isBusy(error)) throw error;
            busy++;
            if (performance.now() - operationStart > 10000) throw new Error('Contention retry deadline exceeded', { cause: error });
            retries++;
            // Explicit bounded retry backoff, included in operation latency.
            Atomics.wait(sleepWord, 0, 0, 1 + i % 3);
          }
        }
        latencies.push(performance.now() - operationStart);
        attemptsPerOperation.push(attempts);
      }
      parentPort.postMessage({ type: 'result', operations, busy, retries, elapsedMs: performance.now() - start,
        latencies, attemptsPerOperation });
    }
  } finally { session.close(); parentPort.close(); }
});
