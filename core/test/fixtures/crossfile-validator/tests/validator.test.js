const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('../index');

test('ordinary identifiers are accepted', () => {
  assert.equal(validate('hello_world'), true);
  assert.equal(validate('  User.1  '), true);
});

test('punctuation and blanks are rejected', () => {
  assert.equal(validate('!!!'), false);
  assert.equal(validate(''), false);
  assert.equal(validate('user@host'), false);
});
