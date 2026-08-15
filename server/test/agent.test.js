// Use a fresh in-memory DB so importing agent.js (which imports db.js via the
// tool registry) never touches the dev database. Dynamic imports ensure this
// env var is set before db.js is evaluated.
process.env.DB_PATH = ':memory:';

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { toHistoryContents } = await import('../agent.js');

test('toHistoryContents maps user turns to user role', () => {
  const contents = toHistoryContents([{ role: 'user', content: 'Where is my order?' }]);
  assert.equal(contents[0].role, 'user');
  assert.deepEqual(contents[0].parts, [{ text: 'Where is my order?' }]);
});

test('toHistoryContents maps assistant turns to model role (never replayed as user)', () => {
  const history = [
    { role: 'user', content: 'Where is my order ORD-1001?' },
    { role: 'assistant', content: 'Your order ORD-1001 has shipped.' },
  ];
  const contents = toHistoryContents(history);
  assert.deepEqual(
    contents.map((c) => c.role),
    ['user', 'model']
  );
  assert.equal(contents[1].parts[0].text, 'Your order ORD-1001 has shipped.');
});

test('toHistoryContents handles empty and unknown-role turns safely', () => {
  assert.deepEqual(toHistoryContents([]), []);
  const contents = toHistoryContents([{ content: 'no role given' }]);
  assert.equal(contents[0].role, 'user');
});
