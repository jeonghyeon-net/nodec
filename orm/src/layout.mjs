import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';

export const HEADER = 20;
export const SLOT = 16;
export const MAGIC = 0x4c4d524f; // ORML, little-endian
export const VERSION = 1;
export const TYPE = Object.freeze({ int32: 1, float64: 2, boolean: 3, string: 4 });

export function normalizeFields(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new TypeError('A model needs a field definition object');
  }
  const fields = Object.entries(definition).map(([name, input], index) => {
    if (!name || !name.isWellFormed() || ['__proto__', 'prototype', 'constructor'].includes(name)) {
      throw new TypeError(`Unsupported field name: ${name}`);
    }
    const config = typeof input === 'string' ? { type: input } : input;
    if (!config || !Object.hasOwn(TYPE, config.type) ||
        (config.nullable !== undefined && typeof config.nullable !== 'boolean')) {
      throw new TypeError(`Invalid definition for ${name}`);
    }
    return Object.freeze({ name, type: TYPE[config.type], nullable: config.nullable === true, index });
  });
  if (fields.length < 1 || fields.length > 128) throw new RangeError('Models must have 1–128 fields');
  return Object.freeze(fields);
}

export function fingerprint(fields) {
  return createHash('sha256').update(JSON.stringify(fields)).digest().readUInt32LE(0);
}

export function checkValue(field, value) {
  if (value === null && field.nullable) return;
  const valid = field.type === TYPE.int32
    ? Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
    : field.type === TYPE.float64
      ? typeof value === 'number' && Number.isFinite(value)
      : field.type === TYPE.boolean ? typeof value === 'boolean' : typeof value === 'string' && value.isWellFormed();
  if (!valid) throw new TypeError(`Invalid value for ${field.name}`);
}

export function encodeRows(fields, signature, rows) {
  if (!Array.isArray(rows)) throw new TypeError('Rows must be an array');
  const stride = fields.length * SLOT;
  let size = HEADER + rows.length * stride;
  for (const row of rows) {
    for (const field of fields) {
      const value = row?.[field.name];
      checkValue(field, value);
      if (value !== null && field.type === TYPE.string) size += Buffer.byteLength(value);
    }
  }
  if (!Number.isSafeInteger(size) || size > 0xffffffff) throw new RangeError('Fixture is too large');
  const buffer = Buffer.alloc(size);
  buffer.writeUInt32LE(MAGIC, 0);
  buffer.writeUInt32LE(VERSION, 4);
  buffer.writeUInt32LE(rows.length, 8);
  buffer.writeUInt32LE(fields.length, 12);
  buffer.writeUInt32LE(signature, 16);
  let textOffset = HEADER + rows.length * stride;
  rows.forEach((row, rowIndex) => {
    for (const field of fields) {
      const at = HEADER + rowIndex * stride + field.index * SLOT;
      const value = row[field.name];
      if (value === null) continue;
      buffer[at] = 1;
      switch (field.type) {
        case TYPE.int32: buffer.writeInt32LE(value, at + 4); break;
        case TYPE.float64: buffer.writeDoubleLE(value, at + 4); break;
        case TYPE.boolean: buffer[at + 4] = Number(value); break;
        case TYPE.string: {
          const length = buffer.write(value, textOffset, 'utf8');
          buffer.writeUInt32LE(textOffset, at + 4);
          buffer.writeUInt32LE(length, at + 8);
          textOffset += length;
          break;
        }
      }
    }
  });
  return buffer;
}

export function inspectBuffer(buffer, fields, signature) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Expected a Buffer');
  if (buffer.length < HEADER || buffer.readUInt32LE(0) !== MAGIC ||
      buffer.readUInt32LE(4) !== VERSION || buffer.readUInt32LE(12) !== fields.length ||
      buffer.readUInt32LE(16) !== signature) throw new Error('Invalid or incompatible fixture header');
  const count = buffer.readUInt32LE(8);
  const textStart = HEADER + count * fields.length * SLOT;
  if (textStart > buffer.length) throw new Error('Truncated fixture records');
  return { count, textStart };
}

export function readCell(buffer, at, type, nullable, textStart) {
  const present = buffer[at];
  if (present === 0) {
    if (!nullable) throw new Error('Null in a required field');
    return null;
  }
  if (present !== 1) throw new Error('Invalid presence marker');
  switch (type) {
    case TYPE.int32: return buffer.readInt32LE(at + 4);
    case TYPE.float64: {
      const value = buffer.readDoubleLE(at + 4);
      if (!Number.isFinite(value)) throw new Error('Non-finite float');
      return value;
    }
    case TYPE.boolean:
      if (buffer[at + 4] > 1) throw new Error('Invalid boolean');
      return buffer[at + 4] === 1;
    case TYPE.string: {
      const start = buffer.readUInt32LE(at + 4);
      const end = start + buffer.readUInt32LE(at + 8);
      if (start < textStart || end > buffer.length) throw new Error('Invalid string bounds');
      if (!isUtf8(buffer.subarray(start, end))) throw new Error('Invalid UTF-8');
      return buffer.toString('utf8', start, end);
    }
    default: throw new Error('Unknown field type');
  }
}
