import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const libSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'mobile', 'lib.js'), 'utf8');
const sandbox: any = {};
// eslint-disable-next-line no-new-func
new Function('window', libSource)(sandbox);
const lib = sandbox.PandeshMobileLib;

describe('pairing code entry on the phone', () => {
  it('formats as the person types and accepts only real codes', () => {
    expect(lib.formatCodeInput('abcd')).toBe('ABCD');
    expect(lib.formatCodeInput('abcde')).toBe('ABCD-E');
    expect(lib.formatCodeInput('ab cd-ef gh ij')).toBe('ABCD-EFGH');
    expect(lib.normalizeCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(lib.normalizeCode('ABCD-EFG0')).toBe(''); // 0 is not in the alphabet
    expect(lib.normalizeCode('ABCD')).toBe('');
  });
});

describe('the recording the phone sends is a WAV the PC can read', () => {
  it('48 kHz float chunks become 16 kHz 16-bit mono PCM with a correct RIFF header', () => {
    const chunk = new Float32Array(4800).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5);
    const wav: Uint8Array = lib.encodeWav([chunk, chunk], 48000, 16000);
    const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const ascii = (o: number) => String.fromCharCode(wav[o], wav[o + 1], wav[o + 2], wav[o + 3]);
    expect(ascii(0)).toBe('RIFF');
    expect(ascii(8)).toBe('WAVE');
    expect(ascii(12)).toBe('fmt ');
    expect(v.getUint16(20, true)).toBe(1); // PCM: what Core's WAV reader accepts
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(ascii(36)).toBe('data');
    expect(v.getUint32(40, true)).toBe(3200 * 2); // 9600 samples at 48 kHz -> 3200 at 16 kHz
    expect(v.getUint32(4, true)).toBe(wav.length - 8);
    const peak = Math.max(...Array.from({ length: 3200 }, (_, i) => Math.abs(v.getInt16(44 + i * 2, true))));
    expect(peak).toBeGreaterThan(0.4 * 0x7fff);
    expect(peak).toBeLessThanOrEqual(0x7fff);
  });

  it('clips instead of wrapping, and an empty recording is a valid empty WAV', () => {
    const loud: Uint8Array = lib.encodeWav([Float32Array.from([2, -2])], 16000, 16000);
    const v = new DataView(loud.buffer);
    expect(v.getInt16(44, true)).toBe(0x7fff);
    expect(v.getInt16(46, true)).toBe(-0x8000);
    expect(lib.encodeWav([], 48000, 16000).length).toBe(44);
  });
});

describe('markdown on the phone never becomes HTML or a script link', () => {
  const md = lib.parseMarkdown;

  it('keeps tags as text and makes links only from http(s)', () => {
    const blocks = md('<img src=x onerror=alert(1)> [click](javascript:alert(1)) [docs](https://example.com/a)');
    expect(blocks).toHaveLength(1);
    const inline = blocks[0].inl;
    expect(inline.filter((n: any) => n.t === 'a')).toEqual([{ t: 'a', href: 'https://example.com/a', c: [{ t: 'text', v: 'docs' }] }]);
    expect(JSON.stringify(inline)).toContain('<img src=x onerror=alert(1)>');
    expect(JSON.stringify(inline)).not.toContain('"href":"javascript');
  });

  it('artifacts only by plain ids; anything else stays text', () => {
    expect(md('![x](artifact:abc-123)')).toEqual([{ t: 'img', alt: 'x', id: 'abc-123' }]);
    expect(md('![x](artifact:../../etc)')[0].t).toBe('p');
    expect(md('![x](https://tracker.example/pixel.png)')[0].t).toBe('p');
  });

  it('reads the structure replies use', () => {
    const blocks = md('# Plan\n\n1. Check\n2. Fix\n\n- a\n- **b** and `c`\n\n```js\nlet x = 1;\n```\n\n> note\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\nVisit https://example.com/x.');
    expect(blocks.map((b: any) => b.t)).toEqual(['h', 'ol', 'ul', 'code', 'quote', 'table', 'hr', 'p']);
    expect(blocks[3]).toEqual({ t: 'code', lang: 'js', text: 'let x = 1;' });
    expect(blocks[5].rows).toEqual([['a', 'b'], ['1', '2']]);
    const last = blocks[7].inl;
    expect(last.find((n: any) => n.t === 'a').href).toBe('https://example.com/x');
    expect(blocks[2].items[1].map((n: any) => n.t)).toEqual(['b', 'text', 'code']);
  });

  it('snake_case and multiplication stay plain text', () => {
    const inline = md('use read_file_now and 2*3*4')[0].inl;
    expect(inline).toEqual([{ t: 'text', v: 'use read_file_now and 2*3*4' }]);
  });

  it('speech gets words, not markup, links or code', () => {
    expect(lib.plainForSpeech('**Done.** See [the docs](https://example.com) or `run.sh`.\n```\nrm -rf x\n```\nBye')).toBe('Done. See the docs or run.sh. Bye');
  });
});
