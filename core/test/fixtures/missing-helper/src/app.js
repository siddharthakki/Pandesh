function checkout(items) {
  let cents = 0;
  for (const item of items) {
    cents += item.priceCents;
  }
  return String(cents);
}

module.exports = { checkout };
