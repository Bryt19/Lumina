import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      email       TEXT NOT NULL UNIQUE,
      token       TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS orders (
      id           TEXT PRIMARY KEY,
      customer_id  TEXT NOT NULL REFERENCES customers(id),
      item         TEXT NOT NULL,
      status       TEXT NOT NULL,
      eta          TEXT,
      total        REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id           TEXT PRIMARY KEY,
      customer_id  TEXT NOT NULL REFERENCES customers(id),
      subject      TEXT NOT NULL,
      status       TEXT NOT NULL,
      priority     TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id           TEXT PRIMARY KEY,
      customer_id  TEXT NOT NULL REFERENCES customers(id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const customerCount = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  if (customerCount === 0) {
    seed();
  }
}

function seed() {
  const insertCustomer = db.prepare(
    'INSERT INTO customers (id, name, email, token) VALUES (?, ?, ?, ?)'
  );
  const customers = [
    ['cust-alice', 'Alice Chen', 'alice@example.com', 'demo-token-alice'],
    ['cust-bob', 'Bob Martinez', 'bob@example.com', 'demo-token-bob'],
    ['cust-carol', 'Carol Nguyen', 'carol@example.com', 'demo-token-carol'],
  ];
  for (const c of customers) insertCustomer.run(...c);

  const insertOrder = db.prepare(
    'INSERT INTO orders (id, customer_id, item, status, eta, total) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const orders = [
    ['ORD-1001', 'cust-alice', 'Wireless Headphones', 'shipped', '2026-08-18', 129.99],
    ['ORD-1002', 'cust-alice', 'Mechanical Keyboard', 'delivered', null, 89.5],
    ['ORD-1003', 'cust-alice', 'USB-C Dock', 'processing', '2026-08-20', 59.0],
    ['ORD-2001', 'cust-bob', '27" 4K Monitor', 'delayed', '2026-08-22', 349.0],
    ['ORD-2002', 'cust-bob', 'Webcam', 'processing', '2026-08-19', 74.99],
    ['ORD-3001', 'cust-carol', 'Laptop Stand', 'delivered', null, 42.0],
  ];
  for (const o of orders) insertOrder.run(...o);

  const insertTicket = db.prepare(
    'INSERT INTO tickets (id, customer_id, subject, status, priority) VALUES (?, ?, ?, ?, ?)'
  );
  const tickets = [
    ['TKT-5001', 'cust-alice', 'Headphones battery drains fast', 'open', 'normal'],
    ['TKT-5002', 'cust-carol', 'Need invoice copy for ORD-3001', 'open', 'low'],
  ];
  for (const t of tickets) insertTicket.run(...t);

  console.log('[db] Seeded demo customers, orders, and tickets.');
}

// ---- Query helpers -------------------------------------------------------

export function findCustomerByToken(token) {
  return db.prepare('SELECT * FROM customers WHERE token = ?').get(token);
}

export function findCustomerById(id) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

export function getOrdersForCustomer(customerId) {
  return db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY rowid').all(customerId);
}

export function findOrderForCustomer(orderId, customerId) {
  return db
    .prepare('SELECT * FROM orders WHERE id = ? AND customer_id = ?')
    .get(orderId, customerId);
}

export function getTicketsForCustomer(customerId) {
  return db
    .prepare('SELECT * FROM tickets WHERE customer_id = ? ORDER BY created_at DESC')
    .all(customerId);
}

export function findTicketForCustomer(ticketId, customerId) {
  return db
    .prepare('SELECT * FROM tickets WHERE id = ? AND customer_id = ?')
    .get(ticketId, customerId);
}

export function updateOrderStatus(orderId, status) {
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, orderId);
}

export function createTicket(customerId, subject, status, priority) {
  const id = `TKT-${Date.now().toString().slice(-6)}`;
  db.prepare(
    'INSERT INTO tickets (id, customer_id, subject, status, priority) VALUES (?, ?, ?, ?, ?)'
  ).run(id, customerId, subject, status, priority);
  return findTicketForCustomer(id, customerId);
}

// ---- Conversations --------------------------------------------------------

export function createConversation(customerId) {
  const id = `CONV-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare('INSERT INTO conversations (id, customer_id) VALUES (?, ?)').run(id, customerId);
  return id;
}

export function addMessage(conversationId, role, content) {
  db.prepare(
    'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)'
  ).run(conversationId, role, content);
}

export function getMessages(conversationId) {
  return db
    .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id')
    .all(conversationId);
}

initDb();
