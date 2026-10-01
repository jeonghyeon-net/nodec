import { createRequire } from 'node:module';
import {
  HEADER, SLOT, TYPE, normalizeFields, fingerprint, checkValue, encodeRows, inspectBuffer, readCell,
} from './layout.mjs';

const require = createRequire(import.meta.url);
let addon;
function native() {
  return addon ??= require('../build/mapper.node');
}

export function normalizeQuery(fields, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Invalid query');
  for (const key of Object.keys(options)) {
    if (!['select', 'where', 'limit'].includes(key)) throw new TypeError(`Unsupported query option: ${key}`);
  }
  const names = new Map(fields.map(field => [field.name, field]));
  const select = options.select ?? fields.map(field => field.name);
  if (!Array.isArray(select) || !select.length || new Set(select).size !== select.length) {
    throw new TypeError('select must contain unique field names');
  }
  const selected = select.map(name => {
    const field = names.get(name);
    if (!field) throw new TypeError(`Unknown selected field: ${name}`);
    return field;
  });
  const where = options.where ?? {};
  if (!where || typeof where !== 'object' || Array.isArray(where)) throw new TypeError('Invalid where');
  const filters = Object.entries(where).map(([name, value]) => {
    const field = names.get(name);
    if (!field) throw new TypeError(`Unknown filter field: ${name}`);
    checkValue(field, value);
    return Object.freeze({ field, value });
  });
  const limit = options.limit ?? 0xffffffff;
  if (!Number.isInteger(limit) || limit < 0 || limit > 0xffffffff) throw new RangeError('Invalid limit');
  return Object.freeze({ selected: Object.freeze(selected), filters: Object.freeze(filters), limit });
}

function genericExecutor(fields, signature, query) {
  const stride = fields.length * SLOT;
  return buffer => {
    const { count, textStart } = inspectBuffer(buffer, fields, signature);
    const result = [];
    for (let row = 0; row < count && result.length < query.limit; row++) {
      const base = HEADER + row * stride;
      if (!query.filters.every(({ field, value }) =>
        readCell(buffer, base + field.index * SLOT, field.type, field.nullable, textStart) === value)) continue;
      const object = {};
      for (const field of query.selected) {
        object[field.name] = readCell(buffer, base + field.index * SLOT, field.type, field.nullable, textStart);
      }
      result.push(object);
    }
    return result;
  };
}

function compiledExecutor(fields, signature, query) {
  // Only field names and numeric schema metadata enter the generated source.
  // Filter values are captured as data, never interpolated as executable code.
  const expression = field => `readCell(buffer, base + ${field.index * SLOT}, ${field.type}, ${field.nullable}, textStart)`;
  const conditions = query.filters.map(({ field }, i) => `${expression(field)} === values[${i}]`).join(' && ') || 'true';
  const properties = query.selected.map(field => `${JSON.stringify(field.name)}: ${expression(field)}`).join(',\n');
  const source = `return function executeCompiled(buffer) {
    const { count, textStart } = inspectBuffer(buffer, fields, signature);
    const result = [];
    for (let row = 0; row < count && result.length < ${query.limit}; row++) {
      const base = ${HEADER} + row * ${fields.length * SLOT};
      if (${conditions}) result.push({ ${properties} });
    }
    return result;
  };`;
  const execute = new Function('readCell', 'inspectBuffer', 'fields', 'signature', 'values', source)(
    readCell, inspectBuffer, fields, signature, query.filters.map(filter => filter.value),
  );
  return { execute, source };
}

export const engines = Object.freeze(['generic', 'compiled', 'native']);

export function defineModel(name, definition) {
  if (typeof name !== 'string' || !name) throw new TypeError('A model needs a name');
  const fields = normalizeFields(definition);
  const signature = fingerprint(fields);
  const encode = rows => encodeRows(fields, signature, rows);
  function prepare(options) {
    const query = normalizeQuery(fields, options);
    const generic = genericExecutor(fields, signature, query);
    const compiled = compiledExecutor(fields, signature, query);
    let nativePlan;
    const plan = {
      generatedSource: compiled.source,
      execute(buffer, engine = 'compiled') {
        if (!Buffer.isBuffer(buffer)) throw new TypeError('Expected a Buffer');
        if (engine === 'generic') return generic(buffer);
        if (engine === 'compiled') return compiled.execute(buffer);
        if (engine !== 'native') throw new TypeError(`Unknown engine: ${engine}`);
        nativePlan ??= native().prepare({
          fields, signature,
          select: query.selected.map(field => field.index),
          filters: query.filters.map(({ field, value }) => ({ index: field.index, value })),
          limit: query.limit,
        });
        return native().execute(nativePlan, buffer);
      },
    };
    return Object.freeze(plan);
  }
  function table(rows) {
    const buffer = encode(rows);
    return Object.freeze({
      findMany(options, { engine = 'compiled' } = {}) {
        return prepare(options).execute(buffer, engine);
      },
      prepare(options, { engine = 'compiled' } = {}) {
        const plan = prepare(options);
        return () => plan.execute(buffer, engine);
      },
    });
  }
  return Object.freeze({ name, fields, encode, prepare, table });
}

export { TYPE };
