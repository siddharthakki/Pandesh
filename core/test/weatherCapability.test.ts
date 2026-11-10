import { describe, expect, it, vi } from 'vitest';
import { MAX_SOUND_ALIKE_QUERIES, closestPlaceNames, createWeatherCapabilityAdapter, observedNote, placeSoundKey, soundAlikeQueries } from '../runtime/weatherCapability';

describe('Weather governed capability', () => {
  it('says which provider answered and for which time, so "current" can be checked', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('geocoding-api')) return new Response(JSON.stringify({ results: [{ name: 'Austin', admin1: 'Texas', country: 'United States', latitude: 30.27, longitude: -97.74 }] }), { status: 200 });
      return new Response(JSON.stringify({
        utc_offset_seconds: -21600, timezone_abbreviation: 'CST',
        current: { time: '2026-11-10T03:45', temperature_2m: 14.2, relative_humidity_2m: 70, wind_speed_10m: 6, weather_code: 0 },
        current_units: { temperature_2m: '°C', wind_speed_10m: 'km/h' },
      }), { status: 200 });
    });
    // 03:45 CST is 09:45 UTC; the clock says 10:00 UTC, so the values are 15 minutes old.
    const adapter = createWeatherCapabilityAdapter({ fetchImpl: fetchImpl as typeof fetch, now: () => Date.parse('2026-11-10T10:00:00Z') });
    const result = await adapter.run({ name: 'get_weather', arguments: { location: 'Austin' } }, { cwd: process.cwd() });
    expect(result.output).toBe('Austin, Texas, United States: clear sky, 14.2°C, humidity 70%, wind 6 km/h. Source: Open-Meteo (live request), values for 2026-11-10 03:45 CST.');
  });

  it('never passes old values off as current', () => {
    const forecast = { utc_offset_seconds: 3600, timezone_abbreviation: 'CET', current: { time: '2026-11-10T04:00' } };
    expect(observedNote(forecast, Date.parse('2026-11-10T03:30:00Z'))).toBe('Source: Open-Meteo (live request), values for 2026-11-10 04:00 CET.');
    expect(observedNote(forecast, Date.parse('2026-11-10T09:00:00Z'))).toMatch(/These values are 6 hours old; say so instead of calling them current\.$/);
    expect(observedNote({}, Date.now())).toMatch(/the provider gave no time for these values/);
  });

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

  it('fails honestly when no location matches, without a forecast call', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const adapter = createWeatherCapabilityAdapter({ fetchImpl: fetchImpl as typeof fetch });
    const result = await adapter.run({ name: 'get_weather', arguments: { location: 'Nowhereville' } }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('weather_location_not_found');
    expect(result.output).toBe('No place called "Nowhereville" was found, and no similar-sounding place either. Please spell the place name, or name a nearby larger town.');
    const urls = fetchImpl.mock.calls.map(([u]) => String(u));
    expect(urls.every((u) => u.startsWith('https://geocoding-api.open-meteo.com/v1/search'))).toBe(true);
    expect(urls.length).toBeLessThanOrEqual(1 + MAX_SOUND_ALIKE_QUERIES);
  });

  it('offers the closest place names when a spoken or misspelt name finds nothing', async () => {
    const places: Record<string, unknown[]> = {
      Austin: [
        { name: 'Austin', admin1: 'Texas', country: 'United States', country_code: 'US', population: 961855, latitude: 30.27, longitude: -97.74 },
        { name: 'Austin', admin1: 'Minnesota', country: 'United States', country_code: 'US', population: 24718, latitude: 43.67, longitude: -92.97 },
        { name: 'Austinmer', admin1: 'New South Wales', country: 'Australia', country_code: 'AU', population: 2000, latitude: -34.3, longitude: 150.93 },
      ],
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const name = new URL(String(input)).searchParams.get('name') ?? '';
      return new Response(JSON.stringify({ results: places[name] ?? [] }), { status: 200 });
    });
    const adapter = createWeatherCapabilityAdapter({ fetchImpl: fetchImpl as typeof fetch });
    const result = await adapter.run({ name: 'get_weather', arguments: { location: 'Ostin' } }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('weather_location_not_found');
    // Worded for the person, because the desktop shows it as it is when it answers a weather question itself.
    expect(result.output).toBe('No place called "Ostin" was found. Did you mean Austin, Texas, United States or Austin, Minnesota, United States? Say which one, and the weather is looked up for it.');
    expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('/v1/forecast'))).toBe(false);
  });

  it('builds a few sound-alike spellings and a sound key that survives a misheard vowel', () => {
    expect(soundAlikeQueries('Ostin')).toContain('Austin');
    expect(soundAlikeQueries('Ellum')).toEqual(expect.arrayContaining(['Alm', 'Elm', 'Olm']));
    expect(soundAlikeQueries('Ostin')).not.toContain('Ostin');
    expect(soundAlikeQueries('Nowhereville').length).toBeLessThanOrEqual(MAX_SOUND_ALIKE_QUERIES);
    expect(soundAlikeQueries('Xy')).toEqual([]);
    expect(placeSoundKey('Ostin')).toBe(placeSoundKey('Austin'));
    expect(placeSoundKey('Ellum')).toBe(placeSoundKey('Olm'));
    expect(placeSoundKey('New Olm')).not.toBe(placeSoundKey('Olm'));
    expect(closestPlaceNames('Ellum', [
      { name: 'Olm', country: 'Luxembourg', population: 1763, latitude: 0, longitude: 0 },
      { name: 'Elm', admin1: 'Glarus', country: 'Switzerland', population: 700, latitude: 0, longitude: 0 },
      { name: 'Olympia', country: 'United States', population: 55733, latitude: 0, longitude: 0 },
    ])).toEqual(['Olm, Luxembourg', 'Elm, Glarus, Switzerland']);
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
