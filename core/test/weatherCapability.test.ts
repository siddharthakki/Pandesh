import { describe, expect, it, vi } from 'vitest';
import { createWeatherCapabilityAdapter } from '../runtime/weatherCapability';

describe('Weather governed capability', () => {
  it('is classified read_only so read-only weather questions answer without requiring approval', () => {
    const adapter = createWeatherCapabilityAdapter();
    expect(adapter.classify('get_weather')).toBe('read_only');
  });

  it('geocodes a location then reports current conditions from the forecast', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('geocoding-api')) {
        return new Response(JSON.stringify({ results: [{ name: 'Bengaluru', country: 'India', admin1: 'Karnataka', latitude: 12.97, longitude: 77.59 }] }), { status: 200 });
      }
      if (url.includes('api.open-meteo.com')) {
        return new Response(JSON.stringify({
          current: { temperature_2m: 27.4, relative_humidity_2m: 65, wind_speed_10m: 9.2, weather_code: 2 },
          current_units: { temperature_2m: '°C', wind_speed_10m: 'km/h' },
        }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });
    const adapter = createWeatherCapabilityAdapter({ fetchImpl: fetchImpl as typeof fetch });
    const result = await adapter.run({ name: 'get_weather', arguments: { location: 'Bengaluru' } }, { cwd: process.cwd() });
    expect(result.status).toBe('succeeded');
    expect(result.output).toContain('Bengaluru, Karnataka, India');
    expect(result.output).toContain('partly cloudy');
    expect(result.output).toContain('27.4°C');
    expect(result.output).toContain('humidity 65%');
  });

  it('fails honestly when no location matches, without a second forecast call', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const adapter = createWeatherCapabilityAdapter({ fetchImpl: fetchImpl as typeof fetch });
    const result = await adapter.run({ name: 'get_weather', arguments: { location: 'Nowhereville' } }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('weather_location_not_found');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty or oversized location without calling the network', async () => {
    const fetchImpl = vi.fn();
    const adapter = createWeatherCapabilityAdapter({ fetchImpl: fetchImpl as typeof fetch });
    const empty = await adapter.run({ name: 'get_weather', arguments: { location: '' } }, { cwd: process.cwd() });
    expect(empty.status).toBe('failed');
    expect(empty.resultCategory).toBe('invalid_arguments');
    const oversized = await adapter.run({ name: 'get_weather', arguments: { location: 'x'.repeat(300) } }, { cwd: process.cwd() });
    expect(oversized.status).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces a provider HTTP failure without throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    const adapter = createWeatherCapabilityAdapter({ fetchImpl: fetchImpl as typeof fetch });
    const result = await adapter.run({ name: 'get_weather', arguments: { location: 'Paris' } }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('weather_provider_error');
  });
});
