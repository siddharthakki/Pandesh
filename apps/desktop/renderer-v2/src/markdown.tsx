import React from 'react';

/**
 * Minimal, safe Markdown for assistant answers: paragraphs, headings, bullet
 * and numbered lists, fenced code, inline code, bold and italics. Builds React
 * elements only (no HTML injection); anything unrecognised stays plain text.
 */
function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) out.push(<code key={`${key}-${i++}`} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9em', padding: '1px 5px', borderRadius: 5, background: 'var(--raised)' }}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('**')) out.push(<strong key={`${key}-${i++}`}>{t.slice(2, -2)}</strong>);
    else out.push(<em key={`${key}-${i++}`}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0; let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\S*)\s*$/);
    if (fence) {
      const body: string[] = []; i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++} style={{ margin: 0, padding: 12, borderRadius: 10, background: 'var(--canvas)', border: '1px solid var(--line)', fontFamily: 'var(--font-mono)', fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{body.join('\n')}</pre>);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { blocks.push(<p key={k++} style={{ margin: 0, fontWeight: 600 }}>{inline(h[2], `h${k}`)}</p>); i++; continue; }
    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) { items.push(<li key={items.length}>{inline(lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, ''), `li${k}-${items.length}`)}</li>); i++; }
      blocks.push(ordered ? <ol key={k++} style={{ margin: 0, paddingLeft: 22 }}>{items}</ol> : <ul key={k++} style={{ margin: 0, paddingLeft: 22 }}>{items}</ul>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^(#{1,4})\s+/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={k++} style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{inline(para.join('\n'), `p${k}`)}</p>);
  }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 16, lineHeight: 1.55 }}>{blocks}</div>;
}
