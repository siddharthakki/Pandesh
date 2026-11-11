import { describe, expect, it } from 'vitest';
import { encodeQr, qrSvgPath } from '../renderer-v2/src/qr';

/**
 * Reference matrices: when the encoder was written, these two were rendered to PNG and compared module by module
 * with OpenCV 5's own QR encoder (same version, level and mask: 0 modules differ) and decoded exactly by OpenCV's
 * Aruco-based QR detector. A sweep of 60 codes (versions 1–10, levels L/M/Q/H, Unicode) decoded exactly as well.
 */
const SECURE_LINK = 'https://desktop-1.tailnet-0000.ts.net/?pair=ABCD-EFGH';
const SECURE_LINK_V4_M_MASK4 = [
  '111111101110010101100001001111111',
  '100000100001111000110000101000001',
  '101110100101101111000101101011101',
  '101110101011000111010101001011101',
  '101110101001010011110100001011101',
  '100000101010111100010110001000001',
  '111111101010101010101010101111111',
  '000000001110000001011101100000000',
  '100010111110101111011111011111001',
  '001101001011001101100011010001110',
  '001100111110111110101011111001000',
  '100000011110110110000110011000011',
  '010010101000010010011011001111011',
  '011100000001101001110001100001000',
  '101100111001111100100111011001110',
  '100101001110001111011110011000000',
  '010010110100011011011100101010010',
  '011111000111110100100001010001100',
  '110101100110110111000011100101010',
  '000111010000110111101100000100000',
  '011000110101001000111010001011001',
  '111101001101001010010101010001010',
  '000110101111110011101101110111110',
  '001111000001100001101101000010010',
  '110011101011001111010101111110001',
  '000000001011110101000011100010100',
  '111111101100000100100100101011010',
  '100000100010010100011110100010001',
  '101110101110111110001100111111000',
  '101110100010101000110001101111100',
  '101110100100111101101110001110000',
  '100000100110011111001101100000000',
  '111111101011101001101101101001001',
];
const V7_TEXT = Array.from({ length: 120 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[i % 36]).join('');
const V7_M_MASK2 = [
  '111111100100110111010101010001101000101111111',
  '100000100111001100111011101110011101001000001',
  '101110101101001000010000110110011101001011101',
  '101110101110111001111010000001100101101011101',
  '101110101100100011001111110111111011101011101',
  '100000101011110001001000101010010000001000001',
  '111111101010101010101010101010101010101111111',
  '000000001110101000011000110011101110100000000',
  '101111100111111101001111100000110001001111100',
  '011001000011111010100010010011111000110001101',
  '000100110000000010100111111100000111001001110',
  '000001010010111010000000111110001001101010110',
  '110101100001111100100110011000110100010001000',
  '001000010100010101011110010010100001110000111',
  '000001101110011010011001111101001111001110110',
  '010010000000011000110001101111001110110010110',
  '011110111011001011110111001001010100000101010',
  '001100001111100101000111010101110101100011111',
  '101011101110100000111001101111011010111100000',
  '100001010000001011010000010110011100001011101',
  '001111111001001001101111110000000011111111001',
  '011010001101011011011000110001101101100010111',
  '010110101010101100111010101010010010101010000',
  '111010001110101001101000110011101110100011100',
  '010011111010111000111111110001110111111110010',
  '001011001110010011110010110111101000101101101',
  '000111101111111001000001011100000110000100010',
  '100001001001100000000101100110001001111110100',
  '010100110111110011100001000001110000110111001',
  '011010001110011010011011110111111001001000111',
  '100011111001011110101010011100010110110101110',
  '010010001110100110110011101110101111001000100',
  '001011111101001101011001011000110000100011010',
  '101011001010001011111011110011100001110001111',
  '000010110010000110000110001001011110110101010',
  '011110010111000111100111110110011001001111110',
  '100110101000100000001111101001000100111111001',
  '000000001101010010011000110101110101100010111',
  '111111100001100100011010101010010011101011000',
  '100000101000100101111000110011101111100011111',
  '101110101110010011101111101000010010111110000',
  '101110101011101000110000110001110001010011111',
  '101110101010000010110111011100000110110101010',
  '100000100110100100111111000110101000100110100',
  '111111101110110111100111110001110110111101010',
];

const rows = (m: boolean[][]) => m.map((r) => r.map((b) => (b ? '1' : '0')).join(''));

/** Reads the 15-bit format information next to the top-left finder and checks its BCH code. */
function formatInfo(m: boolean[][]): { ecc: number; mask: number } {
  const get = (x: number, y: number) => (m[y][x] ? 1 : 0);
  let bits = 0;
  const order: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i += 1) order.push([8, i]);
  order.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i += 1) order.push([14 - i, 8]);
  order.forEach(([x, y], i) => { bits |= get(x, y) << i; });
  const raw = bits ^ 0x5412;
  const data = raw >>> 10;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  expect(raw & 0x3ff).toBe(rem & 0x3ff);
  return { ecc: data >>> 3, mask: data & 7 };
}

describe('QR encoder for the pairing link', () => {
  it('matches the OpenCV-verified reference for a secure pairing link (version 4, level M)', () => {
    const qr = encodeQr(SECURE_LINK, 'M');
    expect({ version: qr.version, size: qr.size, mask: qr.mask }).toEqual({ version: 4, size: 33, mask: 4 });
    expect(rows(qr.modules)).toEqual(SECURE_LINK_V4_M_MASK4);
  });

  it('matches the OpenCV-verified reference for version 7 (which carries version information)', () => {
    const qr = encodeQr(V7_TEXT, 'M');
    expect({ version: qr.version, mask: qr.mask }).toEqual({ version: 7, mask: 2 });
    expect(rows(qr.modules)).toEqual(V7_M_MASK2);
  });

  it('has finder patterns, timing patterns and valid format information at every level', () => {
    for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
      const qr = encodeQr('http://192.0.2.10:3030/?pair=WXYZ-2345', ecc);
      const m = qr.modules;
      for (const [x0, y0] of [[0, 0], [qr.size - 7, 0], [0, qr.size - 7]]) {
        for (let d = 0; d < 7; d += 1) {
          expect(m[y0][x0 + d]).toBe(true);
          expect(m[y0 + 6][x0 + d]).toBe(true);
        }
        expect(m[y0 + 3][x0 + 3]).toBe(true);
        expect(m[y0 + 1][x0 + 1]).toBe(false);
      }
      for (let i = 8; i < qr.size - 8; i += 1) {
        expect(m[6][i]).toBe(i % 2 === 0);
        expect(m[i][6]).toBe(i % 2 === 0);
      }
      expect(m[qr.size - 8][8]).toBe(true); // the dark module
      expect(formatInfo(m)).toEqual({ ecc: { L: 1, M: 0, Q: 3, H: 2 }[ecc], mask: qr.mask });
    }
  });

  it('grows the version with the text, handles UTF-8, and refuses what does not fit', () => {
    expect(encodeQr('HELLO').version).toBe(1);
    expect(encodeQr('x'.repeat(14)).version).toBe(1);
    expect(encodeQr('x'.repeat(15)).version).toBe(2);
    expect(encodeQr('x'.repeat(213)).version).toBe(10);
    expect(() => encodeQr('x'.repeat(214))).toThrow(/too long/);
    expect(encodeQr('Grüße 日本').version).toBe(1);
  });

  it('draws one SVG path with a quiet zone', () => {
    const qr = encodeQr('HELLO');
    const svg = qrSvgPath(qr);
    expect(svg.viewBox).toBe(21 + 8);
    expect(svg.path.startsWith('M4,4h1v1h-1z')).toBe(true);
    const darkCount = qr.modules.flat().filter(Boolean).length;
    expect(svg.path.split('z').length - 1).toBe(darkCount);
  });
});
