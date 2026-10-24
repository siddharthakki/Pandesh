const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHandle } = require('../index');

test('ordinary handles are lowercase', () => {
  assert.equal(normalizeHandle('Alice'), 'alice');
});
