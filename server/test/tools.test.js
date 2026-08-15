// Isolate tests from the dev database: point db.js at a fresh, seeded
// in-memory DB. Dynamic imports are required so this env var is set BEFORE
// db.js is evaluated (static ESM imports are hoisted and would run first).
process.env.DB_PATH = ':memory:';

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { db, findCustomerByToken } = await import('../db.js');
const { executeTool } = await import('../tools/index.js');

const alice = findCustomerByToken('demo-token-alice');
const bob = findCustomerByToken('demo-token-bob');

test('lookupOrderStatus returns only the caller\'s own orders', async () => {
  const own = await executeTool(
    'lookupOrderStatus',
    { orderId: 'ORD-1001' },
    { customerId: alice.id, customer: alice }
  );
  assert.equal(own.orderId, 'ORD-1001');
  assert.equal(own.status, 'shipped');

  const denied = await executeTool(
    'lookupOrderStatus',
    { orderId: 'ORD-1001' },
    { customerId: bob.id, customer: bob }
  );
  assert.equal(denied.error, 'order_not_found');
});

test('listMyOrders is scoped per customer', async () => {
  const res = await executeTool('listMyOrders', {}, { customerId: alice.id, customer: alice });
  assert.equal(res.orders.length, 3);
  assert.ok(res.orders.every((o) => o.orderId.startsWith('ORD-1')));
});

test('requestRefund requires confirmation, then updates order and opens a ticket', async () => {
  const pending = await executeTool(
    'requestRefund',
    { orderId: 'ORD-1003', confirmed: false },
    { customerId: alice.id, customer: alice }
  );
  assert.equal(pending.status, 'needs_confirmation');

  const submitted = await executeTool(
    'requestRefund',
    { orderId: 'ORD-1003', confirmed: true },
    { customerId: alice.id, customer: alice }
  );
  assert.equal(submitted.status, 'refund_submitted');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get('ORD-1003').status, 'refund_requested');

  const tickets = db
    .prepare('SELECT subject, priority FROM tickets WHERE customer_id = ?')
    .all(alice.id);
  assert.ok(tickets.some((t) => t.subject.includes('ORD-1003') && t.priority === 'high'));
});

test('escalateToHuman creates a high-priority ticket', async () => {
  const res = await executeTool(
    'escalateToHuman',
    { subject: 'Delivery problem', reason: 'Package has not arrived' },
    { customerId: bob.id, customer: bob }
  );
  assert.ok(res.ticketId);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(res.ticketId);
  assert.equal(ticket.priority, 'high');
  assert.equal(ticket.status, 'escalated');
  assert.equal(ticket.customer_id, bob.id);
});

test('getPolicy returns known topics and rejects unknown ones', async () => {
  const shipping = await executeTool('getPolicy', { topic: 'shipping' }, { customerId: alice.id, customer: alice });
  assert.ok(shipping.policy.includes('3-5 business days'));

  const unknown = await executeTool('getPolicy', { topic: 'teleporting' }, { customerId: alice.id, customer: alice });
  assert.equal(unknown.error, 'unknown_topic');
});

test('unknown tools return a safe error', async () => {
  const res = await executeTool('deleteAllOrders', {}, { customerId: alice.id, customer: alice });
  assert.equal(res.error, 'unknown_tool');
});
