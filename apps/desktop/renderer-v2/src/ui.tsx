import React from 'react';

const P = {
  home: 'M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17zM12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z',
  board: 'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z',
  team: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3.5 19a5.5 5.5 0 0111 0M16 11a2.5 2.5 0 100-5M17 14.5a4.5 4.5 0 013.5 4.5',
  spaces: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  system: 'M4 7h10M18 7h2M4 17h4M12 17h8',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  expand: 'M9 6l6 6-6 6',
  collapse: 'M15 6l-6 6 6 6',
  chats: 'M4 5h16v14H4zM9 5v14',
  search: 'M16 16l4 4',
  mic: 'M12 4a3 3 0 013 3v5a3 3 0 01-6 0V7a3 3 0 013-3zM6 11a6 6 0 0012 0M12 17v3',
  send: 'M12 19V5M6 11l6-6 6 6',
  stop: 'M7 7h10v10H7z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  plus: 'M12 5v14M5 12h14',
  attach: 'M8.5 12.5l6.2-6.2a3 3 0 014.2 4.2l-7.8 7.8a5 5 0 01-7.1-7.1l7.1-7.1',
  folder: 'M3.5 7.5A1.5 1.5 0 015 6h4l2 2h8a1.5 1.5 0 011.5 1.5v8A1.5 1.5 0 0119 19H5a1.5 1.5 0 01-1.5-1.5z',
};
export type IconName = keyof typeof P;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {name === 'search' && <circle cx="11" cy="11" r="6.5" />}
      {name === 'system' && <><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>}
      <path d={P[name]} />
    </svg>
  );
}

/** The restrained Pandesh presence mark (static: no idle animation). */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" role="img" aria-label="Pandesh" style={{ flex: '0 0 auto' }}>
      <circle cx="14" cy="14" r="12" fill="none" stroke="var(--pulse)" strokeWidth={1.5} />
      <circle cx="14" cy="14" r="4.5" fill="var(--pulse)" />
    </svg>
  );
}

export function elapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function timeOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Tracks the window width so the layout can switch to the narrow form (< 900 px). */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = React.useState(() => window.innerWidth < 900);
  React.useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 900);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return narrow;
}
