/*
 * Pandesh Mobile: pure helpers (no DOM, no network), shared by app.js and the unit tests.
 * Loaded as a classic script before app.js; attaches window.PandeshMobileLib.
 */
(function (root) {
  'use strict';

  var CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

  /** "abcd efgh" / "ABCD-EFGH" -> "ABCDEFGH", or '' when it cannot be a pairing code. */
  function normalizeCode(input) {
    var s = String(input == null ? '' : input).toUpperCase().replace(/[\s-]+/g, '');
    if (s.length !== 8) return '';
    for (var i = 0; i < s.length; i += 1) if (CODE_ALPHABET.indexOf(s[i]) < 0) return '';
    return s;
  }

  /** As the person types: upper case, letters and digits only, a dash after the fourth. */
  function formatCodeInput(input) {
    var s = String(input == null ? '' : input).toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
    return s.length > 4 ? s.slice(0, 4) + '-' + s.slice(4) : s;
  }

  /**
   * Resample mono float audio. Downsampling averages each output sample's source span (a box low-pass), so hiss and
   * hum above the new Nyquist are not folded into the speech band; upsampling interpolates linearly. Same method as
   * the desktop capture (renderer/voiceCapture.js).
   */
  function resample(input, fromRate, toRate) {
    if (!input || !input.length) return new Float32Array(0);
    if (!fromRate || !toRate || fromRate === toRate) return input instanceof Float32Array ? input : Float32Array.from(input);
    var ratio = fromRate / toRate;
    var outLen = Math.max(0, Math.floor(input.length / ratio));
    var out = new Float32Array(outLen);
    var i;
    if (ratio > 1) {
      for (i = 0; i < outLen; i += 1) {
        var start = Math.floor(i * ratio);
        var end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
        var sum = 0;
        for (var k = start; k < end; k += 1) sum += input[k];
        out[i] = sum / (end - start);
      }
      return out;
    }
    for (i = 0; i < outLen; i += 1) {
      var src = i * ratio;
      var i0 = Math.floor(src);
      var i1 = Math.min(i0 + 1, input.length - 1);
      var t = src - i0;
      out[i] = input[i0] * (1 - t) + input[i1] * t;
    }
    return out;
  }

  /** Recorded float chunks at `fromRate` -> a 16-bit PCM mono WAV at `toRate` (what the PC's Whisper reads). */
  function encodeWav(chunks, fromRate, toRate) {
    var total = 0;
    var c;
    for (c = 0; c < chunks.length; c += 1) total += chunks[c].length;
    var joined = new Float32Array(total);
    var offset = 0;
    for (c = 0; c < chunks.length; c += 1) {
      joined.set(chunks[c], offset);
      offset += chunks[c].length;
    }
    var samples = resample(joined, fromRate, toRate);
    var buffer = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buffer);
    function ascii(at, text) { for (var j = 0; j < text.length; j += 1) view.setUint8(at + j, text.charCodeAt(j)); }
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, toRate, true);
    view.setUint32(28, toRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    var p = 44;
    for (var i = 0; i < samples.length; i += 1) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      p += 2;
    }
    return new Uint8Array(buffer);
  }

  function rms(samples) {
    if (!samples || !samples.length) return 0;
    var sum = 0;
    for (var i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Markdown, as a small tree app.js turns into DOM nodes (never HTML strings). Links are http(s) only; artifacts
  // are referenced by id and fetched from this server.

  var URL_START = /^https?:\/\//i;

  function parseInline(src) {
    var out = [];
    var text = '';
    function flush() { if (text) { out.push({ t: 'text', v: text }); text = ''; } }
    var i = 0;
    var m;
    while (i < src.length) {
      var ch = src[i];
      if (ch === '`') {
        var close = src.indexOf('`', i + 1);
        if (close > i + 1) { flush(); out.push({ t: 'code', v: src.slice(i + 1, close) }); i = close + 1; continue; }
      }
      if (ch === '*' && src[i + 1] === '*') {
        var boldEnd = src.indexOf('**', i + 2);
        if (boldEnd > i + 2) { flush(); out.push({ t: 'b', c: parseInline(src.slice(i + 2, boldEnd)) }); i = boldEnd + 2; continue; }
      }
      if ((ch === '*' || ch === '_') && src[i + 1] && src[i + 1] !== ch && src[i + 1] !== ' ' && (i === 0 || /[\s(]/.test(src[i - 1]))) {
        var italicEnd = src.indexOf(ch, i + 1);
        if (italicEnd > i + 1 && src[italicEnd - 1] !== ' ' && (italicEnd + 1 >= src.length || /[\s.,;:!?)]/.test(src[italicEnd + 1]))) {
          flush(); out.push({ t: 'i', c: parseInline(src.slice(i + 1, italicEnd)) }); i = italicEnd + 1; continue;
        }
      }
      if (ch === '[' && (m = /^\[([^\]\n]{1,500})\]\((https?:\/\/[^\s)]{1,2000})\)/i.exec(src.slice(i)))) {
        flush(); out.push({ t: 'a', href: m[2], c: parseInline(m[1]) }); i += m[0].length; continue;
      }
      if ((ch === 'h' || ch === 'H') && URL_START.test(src.slice(i, i + 8)) && (i === 0 || /[\s(]/.test(src[i - 1]))) {
        m = /^https?:\/\/[^\s<>()"']+/i.exec(src.slice(i));
        if (m) {
          var url = m[0].replace(/[.,;:!?]+$/, '');
          flush(); out.push({ t: 'a', href: url, c: [{ t: 'text', v: url }] }); i += url.length; continue;
        }
      }
      text += ch;
      i += 1;
    }
    flush();
    return out;
  }

  function joinInline(lines) {
    var out = [];
    for (var k = 0; k < lines.length; k += 1) {
      if (k) out.push({ t: 'br' });
      var parts = parseInline(lines[k].trim());
      for (var j = 0; j < parts.length; j += 1) out.push(parts[j]);
    }
    return out;
  }

  function parseMarkdown(source) {
    var lines = String(source == null ? '' : source).replace(/\r\n?/g, '\n').split('\n');
    var blocks = [];
    var para = [];
    function flushPara() { if (para.length) { blocks.push({ t: 'p', inl: joinInline(para) }); para = []; } }
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      var trimmed = line.trim();
      var m;
      var fence = /^(```|~~~)\s*([\w+.-]*)\s*$/.exec(trimmed);
      if (fence) {
        flushPara();
        var body = [];
        i += 1;
        while (i < lines.length && lines[i].trim() !== fence[1]) { body.push(lines[i]); i += 1; }
        blocks.push({ t: 'code', lang: fence[2] || '', text: body.join('\n') });
        continue;
      }
      if (!trimmed) { flushPara(); continue; }
      if ((m = /^!\[([^\]]*)\]\(artifact:([\w-]{1,128})\)$/.exec(trimmed))) { flushPara(); blocks.push({ t: 'img', alt: m[1], id: m[2] }); continue; }
      if ((m = /^\[([^\]]*)\]\(artifact:([\w-]{1,128})\)$/.exec(trimmed))) { flushPara(); blocks.push({ t: 'doc', name: m[1], id: m[2] }); continue; }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(trimmed))) { flushPara(); blocks.push({ t: 'h', level: m[1].length, inl: parseInline(m[2].replace(/\s+#+$/, '')) }); continue; }
      if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) { flushPara(); blocks.push({ t: 'hr' }); continue; }
      if ((m = /^>\s?(.*)$/.exec(trimmed))) {
        flushPara();
        var quote = [m[1]];
        while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) { i += 1; quote.push(lines[i].trim().replace(/^>\s?/, '')); }
        blocks.push({ t: 'quote', inl: joinInline(quote) });
        continue;
      }
      if ((m = /^[-*•+]\s+(.*)$/.exec(trimmed))) {
        flushPara();
        var items = [parseInline(m[1])];
        var next;
        while (i + 1 < lines.length && (next = /^\s*[-*•+]\s+(.*)$/.exec(lines[i + 1]))) { i += 1; items.push(parseInline(next[1])); }
        blocks.push({ t: 'ul', items: items });
        continue;
      }
      if ((m = /^(\d{1,9})[.)]\s+(.*)$/.exec(trimmed))) {
        flushPara();
        var ordered = [parseInline(m[2])];
        var more;
        while (i + 1 < lines.length && (more = /^\s*\d{1,9}[.)]\s+(.*)$/.exec(lines[i + 1]))) { i += 1; ordered.push(parseInline(more[1])); }
        blocks.push({ t: 'ol', start: Number(m[1]), items: ordered });
        continue;
      }
      if (/^\|.*\|$/.test(trimmed)) {
        flushPara();
        var rows = [];
        var j = i;
        while (j < lines.length && /^\|.*\|$/.test(lines[j].trim())) {
          var cells = lines[j].trim().slice(1, -1).split('|').map(function (cell) { return cell.trim(); });
          var separator = cells.every(function (cell) { return /^:?-{2,}:?$/.test(cell); });
          if (!separator) rows.push(cells);
          j += 1;
        }
        i = j - 1;
        blocks.push({ t: 'table', rows: rows });
        continue;
      }
      para.push(line);
    }
    flushPara();
    return blocks;
  }

  /** Reply text for the phone's speech: no markup, no code blocks read out character by character. */
  function plainForSpeech(source) {
    return String(source == null ? '' : source)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[*_#>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);
  }

  var lib = {
    CODE_ALPHABET: CODE_ALPHABET,
    normalizeCode: normalizeCode,
    formatCodeInput: formatCodeInput,
    resample: resample,
    encodeWav: encodeWav,
    rms: rms,
    parseInline: parseInline,
    parseMarkdown: parseMarkdown,
    plainForSpeech: plainForSpeech,
  };
  root.PandeshMobileLib = lib;
})(typeof window !== 'undefined' ? window : globalThis);
