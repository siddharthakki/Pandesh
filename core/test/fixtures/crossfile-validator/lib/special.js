function isSpecial(value) {
  return typeof value === 'string' && value.includes('!');
}

module.exports = { isSpecial };
