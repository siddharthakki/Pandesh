function stripTags(value) {
  return String(value ?? '').replace(/<[^>]+>/g, '');
}

module.exports = { stripTags };
