import { makeCommerce } from './commerce.mjs';

export function makeGraphFixture(customers, scenario) {
  const source = makeCommerce(customers);
  if (scenario !== 'fanout8') return source;
  source.items = []; source.payments = [];
  for (const order of source.orders) {
    if (order.id % 6) for (let i = 0; i < 8; i++) source.items.push({
      id: source.items.length + 1, orderId: order.id, productId: (order.id + i) % 100 + 1,
      quantity: i % 3 + 1, unitCents: 100 + order.id % 37,
    });
    if (order.id % 3) for (let i = 0; i < 8; i++) source.payments.push({
      id: source.payments.length + 1, orderId: order.id, paidCents: 50 + order.id % 23,
    });
  }
  return source;
}

export function graphCounts(graph) {
  const counts = { customers: graph.length, orders: 0, items: 0, payments: 0 };
  for (const c of graph) for (const o of c.orders) {
    counts.orders++; counts.items += o.items.length; counts.payments += o.payments.length;
  }
  const { customers, orders, items, payments } = counts;
  return { ...counts, finalObjects: customers + orders + 2 * items + payments,
    finalArrays: 1 + customers + 2 * orders, finalPropertySets: 3 * customers + 4 * orders + 6 * items + 2 * payments };
}
