const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHandle } = require('../index');

test('handles ignore surrounding whitespace', () => {
  assert.equal(
    normalizeHandle(' Alice '),
    'alice',
    'expected "alice" after surrounding whitespace is ignored, got a padded handle',
  );
});
