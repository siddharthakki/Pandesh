/** @vitest-environment jsdom */
/**
 * v2 had no place to see the phone pairing code at all (only the Classic Integrations view showed it). Connections →
 * Phone shows the one-time code and a QR code, the Tailscale secure link once `tailscale serve` provides it, the paired
 * phones, and who may connect, all through the host bridge.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MobilePairing } from '../renderer-v2/src/bridge';

const SECURE = 'https://desktop-1.tailnet-0000.ts.net/?pair=ABCD-EFGH';
const WIFI = 'http://192.0.2.10:3030/?pair=ABCD-EFGH';
const base = (): MobilePairing => ({
  code: 'ABCD-EFGH',
  codeExpiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
  port: 3030,
  ip: '192.0.2.10',
  url: WIFI,
  secureUrl: null,
  secure: { state: 'not-installed', url: null, detail: 'Tailscale is not installed on this PC.' },
  localUrl: 'http://127.0.0.1:3030/',
  access: 'lan',
  pairedCount: 1,
  connectedClients: 1,
  listening: true,
  devices: [{ id: 'd1', name: 'Android · Chrome', pairedAt: '2026-11-10T20:00:00Z', lastSeenAt: new Date().toISOString(), connected: true }],
  pairingPausedUntil: null,
});
let view = base();
const bridge = {
  getMobilePairing: vi.fn(async () => view),
  rotateMobilePairingCode: vi.fn(async () => ({ ...view, code: 'WXYZ-2345' })),
  forgetMobileDevice: vi.fn(async (_id: string) => ({ ...view, devices: [] })),
  setMobileAccess: vi.fn(async (mode: MobilePairing['access']) => ({ ...view, access: mode })),
  resumeMobilePairing: vi.fn(async () => ({ ...view, pairingPausedUntil: null })),
  openExternalUrl: vi.fn(async (_url: string) => ({ opened: true })),
  onEvent: () => () => undefined,
};
let PhoneCard: typeof import('../renderer-v2/src/Phone').PhoneCard;

beforeAll(async () => {
  (window as unknown as { desktop: unknown }).desktop = bridge;
  window.confirm = () => true;
  ({ PhoneCard } = await import('../renderer-v2/src/Phone'));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); view = base(); });

const mount = () => render(React.createElement(PhoneCard));

describe('Connections → Phone', () => {
  it('shows the one-time code, a QR code of the link, the paired phone, and the Tailscale steps while there is no secure link', async () => {
    mount();
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    const qr = screen.getByRole('img', { name: /QR code with the pairing link/ });
    expect(qr.querySelector('path')!.getAttribute('d')).toMatch(/^M4,4h1v1h-1z/);
    expect(screen.getByText(WIFI)).toBeTruthy();
    expect(screen.getByText(/Works once · expires in 9 min/)).toBeTruthy();
    expect(screen.getByText('Android · Chrome')).toBeTruthy();
    expect(screen.getByText(/connected now/)).toBeTruthy();
    expect(screen.getByText('1 phone connected')).toBeTruthy();
    const steps = screen.getByText('Set up the secure link (Tailscale)').closest('details') as HTMLDetailsElement;
    expect(steps.open).toBe(true);
    expect(screen.getByText('tailscale serve --bg http://127.0.0.1:3030')).toBeTruthy();
    expect(steps.textContent).toContain('Never use tailscale funnel');
  });

  it('with Tailscale serving, the QR holds the secure link; the owner can switch it to the Wi-Fi link', async () => {
    view = { ...base(), secure: { state: 'ready', url: 'https://desktop-1.tailnet-0000.ts.net/', detail: 'Tailscale serves Pandesh.' }, secureUrl: SECURE };
    mount();
    expect(await screen.findByText(SECURE)).toBeTruthy();
    expect((screen.getByText('Set up the secure link (Tailscale)').closest('details') as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(screen.getByRole('radio', { name: 'Home Wi-Fi link' }));
    expect(screen.getByText(WIFI)).toBeTruthy();
    expect(screen.queryByText(SECURE)).toBeNull();
  });

  it('New code, Forget and the access switch go through the host', async () => {
    mount();
    await screen.findByText('ABCD-EFGH');
    fireEvent.click(screen.getByRole('button', { name: 'New code' }));
    await waitFor(() => expect(bridge.rotateMobilePairingCode).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('WXYZ-2345')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(bridge.forgetMobileDevice).toHaveBeenCalledWith('d1'));
    fireEvent.click(screen.getByRole('radio', { name: /Tailscale only/ }));
    await waitFor(() => expect(bridge.setMobileAccess).toHaveBeenCalledWith('tailscale'));
  });

  it('warns when Funnel would make Pandesh public, and when pairing is paused', async () => {
    view = {
      ...base(),
      secure: { state: 'funnel', url: null, detail: 'Tailscale Funnel is on for this address, which puts Pandesh on the public internet.' },
      pairingPausedUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    mount();
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((a) => a.textContent).join(' ')).toMatch(/public internet/);
    expect(alerts.map((a) => a.textContent).join(' ')).toMatch(/Pairing is paused/);
    fireEvent.click(screen.getByRole('button', { name: 'Allow pairing again' }));
    await waitFor(() => expect(bridge.resumeMobilePairing).toHaveBeenCalledTimes(1));
  });

  it('opens Tailscale pages through the host, never inside the app', async () => {
    mount();
    await screen.findByText('ABCD-EFGH');
    fireEvent.click(screen.getByRole('button', { name: 'Get Tailscale' }));
    expect(bridge.openExternalUrl).toHaveBeenCalledWith('https://tailscale.com/download');
    fireEvent.click(screen.getByRole('button', { name: 'Open the DNS page' }));
    expect(bridge.openExternalUrl).toHaveBeenCalledWith('https://login.tailscale.com/admin/dns');
  });

  it('with phone access off, shows no code and no QR', async () => {
    view = { ...base(), access: 'off', code: '', listening: false, url: '', connectedClients: 0 };
    mount();
    await waitFor(() => expect(document.querySelector('[data-state="off"]')?.textContent).toBe('Off'));
    expect((screen.getByRole('radio', { name: /^Off/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
    expect(screen.queryByText('Set up the secure link (Tailscale)')).toBeNull();
  });
});
