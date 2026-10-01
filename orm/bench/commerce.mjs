import { DatabaseSync } from 'node:sqlite';
import { defineModel } from '../src/orm.mjs';

const optional = type => ({ type, nullable: true });
export const JoinRow = defineModel('JoinRow', {
  customerId: 'int32', customerName: 'string', orderId: optional('int32'),
  status: optional('string'), itemId: optional('int32'), productId: optional('int32'),
  productName: optional('string'), quantity: optional('int32'), unitCents: optional('int32'),
  paymentId: optional('int32'), paidCents: optional('int32'),
});
export const SummaryRow = defineModel('SummaryRow', {
  customerId: 'int32', customerName: 'string', orderCount: 'int32',
  totalCents: 'int32', paidCents: 'int32',
});
export const BalanceRow = defineModel('BalanceRow', { id: 'int32', balance: 'int32' });
export const CountRow = defineModel('CountRow', { count: 'int32' });

export function makeCommerce(customerCount = 1000) {
  const products = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `상품 ${i + 1}🙂` }));
  const customers = [], orders = [], items = [], payments = [];
  for (let id = 1; id <= customerCount; id++) {
    customers.push({ id, name: `고객 ${id}`, active: id % 7 !== 0 ? 1 : 0 });
    for (let j = 0; j < id % 5; j++) {
      const orderId = orders.length + 1;
      orders.push({ id: orderId, customerId: id, status: orderId % 3 ? 'paid' : 'pending' });
      for (let k = 0; k < orderId % 6; k++) {
        items.push({ id: items.length + 1, orderId, productId: (orderId + k) % 100 + 1,
          quantity: k % 3 + 1, unitCents: 100 + orderId % 37 });
      }
      for (let k = 0; k < orderId % 3; k++) {
        payments.push({ id: payments.length + 1, orderId, paidCents: 50 + orderId % 23 });
      }
    }
  }
  return { customers, orders, items, products, payments };
}

export function seedCommerce(path, source) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE customer(id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL) STRICT;
      CREATE TABLE product(id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
      CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id), status TEXT NOT NULL) STRICT;
      CREATE TABLE item(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
        product_id INTEGER NOT NULL REFERENCES product(id), quantity INTEGER NOT NULL, unit_cents INTEGER NOT NULL) STRICT;
      CREATE TABLE payment(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), paid_cents INTEGER NOT NULL) STRICT;
      CREATE INDEX customer_active_id ON customer(active, id);
      CREATE INDEX orders_customer ON orders(customer_id, id);
      CREATE INDEX item_order ON item(order_id, id);
      CREATE INDEX payment_order ON payment(order_id, id);
      CREATE TABLE account(id INTEGER PRIMARY KEY, balance INTEGER NOT NULL CHECK(balance >= 0)) STRICT;
      CREATE TABLE transfer(id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES account(id), amount INTEGER NOT NULL) STRICT;
      CREATE TABLE counter(id INTEGER PRIMARY KEY, value INTEGER NOT NULL) STRICT;
      INSERT INTO account VALUES (1, 1000000000), (2, 1000000000);
      INSERT INTO counter VALUES (1, 0), (2, 0);
      BEGIN IMMEDIATE;`);
    for (const [table, rows] of [['customer', source.customers], ['product', source.products],
      ['orders', source.orders], ['item', source.items], ['payment', source.payments]]) {
      if (!rows.length) continue;
      const insert = db.prepare(`INSERT INTO ${table} VALUES (${Object.keys(rows[0]).map(() => '?').join(',')})`);
      for (const row of rows) insert.run(...Object.values(row));
    }
    db.exec('COMMIT; ANALYZE; PRAGMA wal_checkpoint(TRUNCATE);');
  } finally { db.close(); }
}

export function joinQuery({ limit = 2147483647, offset = 0 } = {}) {
  return {
    model: JoinRow, parameters: [1, limit, offset],
    sql: `WITH page AS (SELECT id, name FROM customer WHERE active = ? ORDER BY id LIMIT ? OFFSET ?)
      SELECT c.id AS customerId, c.name AS customerName, o.id AS orderId, o.status,
        i.id AS itemId, p.id AS productId, p.name AS productName, i.quantity, i.unit_cents AS unitCents,
        pay.id AS paymentId, pay.paid_cents AS paidCents
      FROM page c
      LEFT JOIN orders o ON o.customer_id = c.id
      LEFT JOIN item i ON i.order_id = o.id
      LEFT JOIN product p ON p.id = i.product_id
      LEFT JOIN payment pay ON pay.order_id = o.id
      ORDER BY c.id, o.id, i.id, pay.id`,
  };
}

export const aggregateQuery = {
  model: SummaryRow, parameters: [1, 2, 50],
  // Pre-aggregate the two one-to-many branches so joining them cannot multiply sums.
  sql: `WITH line_total AS (SELECT order_id, SUM(quantity * unit_cents) AS total FROM item GROUP BY order_id),
    paid_total AS (SELECT order_id, SUM(paid_cents) AS paid FROM payment GROUP BY order_id)
    SELECT c.id AS customerId, c.name AS customerName, COUNT(o.id) AS orderCount,
      COALESCE(SUM(l.total), 0) AS totalCents, COALESCE(SUM(p.paid), 0) AS paidCents
    FROM customer c JOIN orders o ON o.customer_id = c.id
    LEFT JOIN line_total l ON l.order_id = o.id LEFT JOIN paid_total p ON p.order_id = o.id
    WHERE c.active = ? GROUP BY c.id, c.name HAVING COUNT(o.id) >= ?
    ORDER BY totalCents DESC, c.id LIMIT ?`,
};

/** Shared O(join rows) identity maps. This part is JS in EVERY engine, including native. */
export function hydrateCommerce(rows) {
  const customers = new Map(), orders = new Map(), items = new Set(), payments = new Set();
  for (const row of rows) {
    let customer = customers.get(row.customerId);
    if (!customer) {
      customer = { id: row.customerId, name: row.customerName, orders: [] };
      customers.set(row.customerId, customer);
    }
    if (row.orderId === null) continue;
    let order = orders.get(row.orderId);
    if (!order) {
      order = { id: row.orderId, status: row.status, items: [], payments: [] };
      orders.set(row.orderId, order);
      customer.orders.push(order);
    }
    if (row.itemId !== null && !items.has(row.itemId)) {
      items.add(row.itemId);
      order.items.push({ id: row.itemId, quantity: row.quantity, unitCents: row.unitCents,
        product: { id: row.productId, name: row.productName } });
    }
    if (row.paymentId !== null && !payments.has(row.paymentId)) {
      payments.add(row.paymentId);
      order.payments.push({ id: row.paymentId, paidCents: row.paidCents });
    }
  }
  return [...customers.values()];
}

// Independent oracle traverses original entities, never JOIN rows or hydrateCommerce().
export function graphOracle(source, { limit = 2147483647, offset = 0 } = {}) {
  return source.customers.filter(c => c.active === 1).slice(offset, offset + limit).map(c => ({
    id: c.id, name: c.name, orders: source.orders.filter(o => o.customerId === c.id).map(o => ({
      id: o.id, status: o.status,
      items: source.items.filter(i => i.orderId === o.id).map(i => ({
        id: i.id, quantity: i.quantity, unitCents: i.unitCents,
        product: { ...source.products.find(p => p.id === i.productId) },
      })),
      payments: source.payments.filter(p => p.orderId === o.id).map(p => ({ id: p.id, paidCents: p.paidCents })),
    })),
  }));
}

export function summaryOracle(source) {
  return graphOracle(source).filter(c => c.orders.length >= 2).map(c => ({
    customerId: c.id, customerName: c.name, orderCount: c.orders.length,
    totalCents: c.orders.reduce((sum, o) => sum + o.items.reduce((s, i) => s + i.quantity * i.unitCents, 0), 0),
    paidCents: c.orders.reduce((sum, o) => sum + o.payments.reduce((s, p) => s + p.paidCents, 0), 0),
  })).sort((a, b) => b.totalCents - a.totalCents || a.customerId - b.customerId).slice(0, 50);
}

export function flatOracle(graph) {
  const result = [];
  for (const c of graph) for (const o of c.orders.length ? c.orders : [null]) {
    for (const i of o?.items.length ? o.items : [null]) for (const p of o?.payments.length ? o.payments : [null]) {
      result.push({ customerId: c.id, customerName: c.name, orderId: o?.id ?? null, status: o?.status ?? null,
        itemId: i?.id ?? null, productId: i?.product.id ?? null, productName: i?.product.name ?? null,
        quantity: i?.quantity ?? null, unitCents: i?.unitCents ?? null, paymentId: p?.id ?? null, paidCents: p?.paidCents ?? null });
    }
  }
  return result;
}

export function prepareTransfer(session) {
  const debit = session.prepareRun('UPDATE account SET balance = balance - ? WHERE id = ?', [3, 1]);
  const credit = session.prepareRun('UPDATE account SET balance = balance + ? WHERE id = ?', [3, 2]);
  const log = session.prepareRun('INSERT INTO transfer(account_id, amount) VALUES (?, ?)', [1, 3]);
  const balances = session.prepareQuery('SELECT id, balance FROM account ORDER BY id', [], BalanceRow);
  const count = session.prepareQuery('SELECT COUNT(*) AS count FROM transfer', [], CountRow);
  const abort = new Error('Intentional rollback');
  return {
    balances, count,
    execute(rollback = false, hold = () => {}) {
      try {
        return session.transaction(() => {
          if (debit.run() !== 1 || credit.run() !== 1 || log.run() !== 1) throw new Error('Missing transfer row');
          const result = balances.all();
          hold();
          if (rollback) throw abort;
          return result;
        });
      } catch (error) {
        if (rollback && error === abort) return null;
        throw error;
      }
    },
  };
}
