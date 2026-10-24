const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkout } = require('../src/app');

test('checkout formats the total as currency', () => {
  assert.equal(checkout([{ priceCents: 199 }, { priceCents: 50 }]), '$2.49');
});
