import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { openSession, isBusy } from '../src/session.mjs';
import { defineModel } from '../src/orm.mjs';
import { prepareTransfer } from './commerce.mjs';

function startWorker(config) {
  const worker = new Worker(new URL('./contention-worker.mjs', import.meta.url), { workerData: config });
  const messages = new Map(), waiters = new Map();
  let failed, exited = false;
  const fail = error => {
    failed = error;
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
  };
  worker.on('message', message => {
    messages.set(message.type, message);
    waiters.get(message.type)?.resolve(message);
    waiters.delete(message.type);
  });
  worker.on('error', fail);
  worker.on('exit', code => {
    exited = true;
    if (code !== 0 || waiters.size) fail(new Error(`Contention worker exited (${code}) before expected message`));
  });
  return {
    worker,
    async receive(type) {
      if (failed) throw failed;
      if (messages.has(type)) return messages.get(type);
      if (exited) throw new Error(`Worker exited before ${type}`);
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          waiters.set(type, { resolve, reject });
          timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 15000);
        });
      } finally { clearTimeout(timer); waiters.delete(type); }
    },
  };
}

const Counter = defineModel('Counter', { id: 'int32', value: 'int32' });
export async function runLockCase(path, engine, { busyTimeoutMs, holdMs, expectBusy }) {
  const session = openSession(path, { engine, busyTimeoutMs });
  let holder;
  try {
    session.exec('UPDATE counter SET value = 0;');
    const read = session.prepareQuery('SELECT id, value FROM counter ORDER BY id', [], Counter);
    const update = session.prepareRun('UPDATE counter SET value = value + 1 WHERE id = 2');
    holder = startWorker({ path, engine, role: 'holder', busyTimeoutMs: 1000, holdMs });
    await holder.receive('ready');
    holder.worker.postMessage('start');
    await holder.receive('locked');
    const readerStart = performance.now();
    assert.equal(read.all()[0].value, 0, 'WAL reader must not see the uncommitted write');
    const readerMs = performance.now() - readerStart;
    const start = performance.now(), cpuStart = process.cpuUsage();
    const probe = new Promise(resolve => setImmediate(() => resolve(performance.now() - start)));
    let busy = false;
    try { session.transaction(() => update.run()); }
    catch (error) { if (!isBusy(error)) throw error; busy = true; }
    const callMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
    const immediateDelayMs = await probe;
    assert.equal(busy, expectBusy, 'scheduled lock scenario');
    await holder.receive('released');
    assert.deepEqual(read.all().map(row => ({ ...row })), [{ id: 1, value: 1 }, { id: 2, value: busy ? 0 : 1 }]);
    assert.equal(session.transaction(() => update.run()), 1, 'connection recovers after lock release');
    return { engine, busyTimeoutMs, holdMs, busy, readerMs, callMs, immediateDelayMs,
      processCpuMs: (cpu.user + cpu.system) / 1000 };
  } finally {
    if (holder) await holder.worker.terminate();
    session.close();
  }
}

export async function runContended(path, engine, { writers = 3, operations = 40, holdMs = 2, busyTimeoutMs = 5 } = {}) {
  const observer = openSession(path, { engine: 'driver' });
  const children = [];
  try {
    const transfer = prepareTransfer(observer);
    const before = transfer.balances.all(), beforeCount = transfer.count.all()[0].count;
    for (let i = 0; i < writers; i++) children.push(startWorker({ path, engine, role: 'writer', busyTimeoutMs, operations, holdMs }));
    await Promise.all(children.map(child => child.receive('ready')));
    const cpuStart = process.cpuUsage(), start = performance.now();
    for (const child of children) child.worker.postMessage('start');
    const results = await Promise.all(children.map(child => child.receive('result')));
    const elapsedMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
    const completed = results.reduce((sum, r) => sum + r.operations, 0);
    assert.equal(completed, writers * operations);
    assert.equal(transfer.count.all()[0].count, beforeCount + completed);
    const balances = transfer.balances.all();
    assert.equal(balances[0].balance, before[0].balance - completed * 3);
    assert.equal(balances[1].balance, before[1].balance + completed * 3);
    return { engine, writers, operations, holdMs, busyTimeoutMs, completed, elapsedMs,
      throughputPerSecond: completed * 1000 / elapsedMs, processCpuMs: (cpu.user + cpu.system) / 1000,
      busy: results.reduce((sum, r) => sum + r.busy, 0), workers: results };
  } finally {
    await Promise.all(children.map(child => child.worker.terminate()));
    observer.close();
  }
}
