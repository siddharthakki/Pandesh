/**
 * Controlled scenario for the M46 recovery ladder (used by m46LiveDogfood.test.ts, OLLAMA_AGENT_M46_SCENARIO=ladder).
 *
 * The task states a plausible but WRONG diagnosis: "the bug is in shippingFor in src/shipping.js". Every fix
 * confined to shippingFor leaves the same tests failing, because the real cause is the threshold parser
 * in src/config/billing.js (parseFloat of '$50.00' is NaN), a file the failure output never names. A model that follows the stated
 * hypothesis repeats it (rewording the same comparison), which is exactly what the ladder exists to break:
 * fingerprint sees the repeat -> the runtime widens the evidence (dependencies of the implicated files) ->
 * another strategy -> progress, or NO_PROGRESS stating what was tried.
 */
import { ladderNoiseFiles } from './m46LiveLadderNoise';

export const LADDER_TASK = 'Large orders are being charged shipping even though they are over the free-shipping threshold. The bug is in shippingFor in src/shipping.js: it does not treat these orders as free. Fix shippingFor so orders over the free-shipping threshold ship free.';

export const LADDER_TEST_FILES = ['test/order.test.js', 'test/labels.test.js'];

export const LADDER_FILES: Record<string, string> = {
  ...ladderNoiseFiles(),
  'package.json': JSON.stringify({
    name: 'shipping-fixture',
    version: '1.0.0',
    scripts: { test: 'node --test test/order.test.js test/labels.test.js', verify: 'node --test test/order.test.js test/labels.test.js' },
  }, null, 2),
  '.gitignore': '.ollama-agent/\n',
  'README.md': '# shipping-fixture\n\nOrder totals, shipping rules and label helpers for a small storefront.\n',
  'src/index.js': "'use strict';\nmodule.exports = { ...require('./order'), ...require('./labels') };\n",
  'src/order.js': `'use strict';
const { shippingFor } = require('./shipping');

function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

function orderTotal(items, region = 'default') {
  const base = subtotal(items);
  return base + shippingFor(base, region);
}

module.exports = { subtotal, orderTotal };
`,
  'src/shipping.js': `'use strict';
const { limitFor } = require('./config/billing');

const RATES = { default: 5, eu: 9 };

function shippingFor(orderValue, region) {
  if (orderValue > limitFor(region)) return 0;
  return RATES[region] ?? RATES.default;
}

module.exports = { RATES, shippingFor };
`,
  'src/config/billing.js': `'use strict';
// Per-region limits, as the billing export prints them.
const RAW = { default: '$50.00', eu: '$60.00' };

function toAmount(text) {
  return Number.parseFloat(text);
}

function limitFor(region) {
  return toAmount(RAW[region] ?? RAW.default);
}

module.exports = { limitFor };
`,
  'src/currency.js': `'use strict';
const SYMBOLS = { usd: '$', eur: 'EUR ' };

function format(amount, code = 'usd') {
  return \`\${SYMBOLS[code] ?? ''}\${amount.toFixed(2)}\`;
}

module.exports = { format };
`,
  'src/tax.js': `'use strict';
const RATES = { default: 0.2, eu: 0.21 };

function taxFor(amount, region = 'default') {
  return Math.round(amount * (RATES[region] ?? RATES.default) * 100) / 100;
}

module.exports = { taxFor };
`,
  'src/inventory.js': `'use strict';
const stock = new Map();

function restock(sku, count) {
  stock.set(sku, (stock.get(sku) ?? 0) + count);
}

function available(sku) {
  return stock.get(sku) ?? 0;
}

module.exports = { restock, available };
`,
  'src/labels.js': "'use strict';\nfunction label(order) {\n  return `#${order.id} ${order.name}`.trim();\n}\n\nmodule.exports = { label };\n",
  'test/order.test.js': `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { orderTotal } = require('../src/order');

test('a small order pays the default shipping rate', () => {
  assert.equal(orderTotal([{ price: 40, qty: 1 }]), 45);
});

test('an order above the default threshold ships free', () => {
  assert.equal(orderTotal([{ price: 60, qty: 1 }]), 60);
});

test('an eu order above the eu threshold ships free', () => {
  assert.equal(orderTotal([{ price: 70, qty: 1 }], 'eu'), 70);
});

test('an eu order below the eu threshold pays the eu rate', () => {
  assert.equal(orderTotal([{ price: 55, qty: 1 }], 'eu'), 64);
});
`,
  'test/labels.test.js': "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { label } = require('../src/labels');\n\ntest('label joins id and name', () => {\n  assert.equal(label({ id: 7, name: 'Ada' }), '#7 Ada');\n});\n",
};
