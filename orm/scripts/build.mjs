import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!['darwin', 'linux'].includes(process.platform)) {
  throw new Error('This experiment currently builds on macOS and Linux only.');
}
const headers = process.env.NODE_INCLUDE_DIR || resolve(dirname(process.execPath), '../include/node');
if (!existsSync(resolve(headers, 'node_api.h'))) {
  throw new Error(`Node headers not found at ${headers}. Set NODE_INCLUDE_DIR to the directory containing node_api.h.`);
}
mkdirSync(resolve(root, 'build'), { recursive: true });
const args = [
  '-std=c11', '-O3', '-DNAPI_VERSION=8', '-Wall', '-Wextra', '-Werror',
  '-fPIC', '-shared', '-I', headers,
  ...(process.platform === 'darwin' ? ['-undefined', 'dynamic_lookup'] : []),
  resolve(root, 'native/mapper.c'), resolve(root, 'native/sqlite.c'), '-lsqlite3',
  '-o', resolve(root, 'build/mapper.node'),
];
const result = spawnSync(process.env.CC || 'cc', args, { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log('Built orm/build/mapper.node (C11 / Node-API 8)');
