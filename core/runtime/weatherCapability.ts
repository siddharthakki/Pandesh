import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';

const MAX_LOCATION_CHARS = 200;
const FETCH_TIMEOUT_MS = 8_000;

export interface WeatherCapabilityOptions {
  fetchImpl?: typeof fetch;
  /** Clock for the freshness check (tests). */
  now?: () => number;
}

export interface GeocodePlace {
  id?: number;
  name: string;
  country?: string;
  country_code?: string;
  admin1?: string;
  population?: number;
  latitude: number;
  longitude: number;
}

interface GeocodeResult {
  results?: GeocodePlace[];
}

interface ForecastResult {
  /** Seconds the location's local time is ahead of UTC; `current.time` is local wall time without an offset. */
  utc_offset_seconds?: number;
  timezone_abbreviation?: string;
  current?: {
    /** When the provider's current values are for, e.g. "2026-11-10T10:45" (local to the place). */
    time?: string;
    temperature_2m?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
    weather_code?: number;
  };
  current_units?: { temperature_2m?: string; wind_speed_10m?: string };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    relative_humidity_2m?: number[];
    weather_code?: number[];
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
  };
}

// WMO weather interpretation codes (subset covering Open-Meteo's `weather_code`).
const WEATHER_CODE_LABELS: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'moderate drizzle', 55: 'dense drizzle',
  61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain',
  66: 'light freezing rain', 67: 'heavy freezing rain',
  71: 'slight snow', 73: 'moderate snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'slight rain showers', 81: 'moderate rain showers', 82: 'violent rain showers',
  85: 'slight snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with slight hail', 99: 'thunderstorm with heavy hail',
};

function failure(output: string, category: string): ToolExecutionResult {
  return { status: 'failed', exitCode: null, output, resultCategory: category };
}

/** Current values older than this are reported as old, never passed off as now. */
export const STALE_AFTER_MINUTES = 180;

/**
 * Where the numbers come from and for when, so "current" is checkable: the provider's own timestamp for its current
 * values, and a plain warning when they are old.
 */
export function observedNote(forecast: { utc_offset_seconds?: number; timezone_abbreviation?: string; current?: { time?: string } }, nowMs: number): string {
  const local = forecast.current?.time;
  if (!local || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local)) return 'Source: Open-Meteo (live request); the provider gave no time for these values.';
  const zone = forecast.timezone_abbreviation ? ` ${forecast.timezone_abbreviation}` : ' local time';
  const observedUtc = Date.parse(`${local.slice(0, 16)}:00Z`) - (forecast.utc_offset_seconds ?? 0) * 1000;
  const ageMinutes = Math.round((nowMs - observedUtc) / 60_000);
  const age = Number.isFinite(ageMinutes) && ageMinutes > STALE_AFTER_MINUTES
    ? ` These values are ${Math.round(ageMinutes / 60)} hours old; say so instead of calling them current.`
    : '';
  return `Source: Open-Meteo (live request), values for ${local.slice(0, 16).replace('T', ' ')}${zone}.${age}`;
}

/** The most extra name lookups a "no such place" answer may make, all to the same geocoder, in parallel. */
export const MAX_SOUND_ALIKE_QUERIES = 10;

function lettersOf(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * A rough sound key for a place name: the leading vowels become one "*", later vowels drop out, similar letters merge
 * and doubles collapse. A misheard or misspelt name usually keeps its consonants: "Ostin" and "Austin" share a key.
 */
export function placeSoundKey(name: string): string {
  const w = lettersOf(name).replace(/ph/g, 'f').replace(/[ckq]/g, 'k').replace(/z/g, 's').replace(/w/g, 'v');
  const m = /^([^aeiouy]*)([aeiouy]*)(.*)$/.exec(w);
  if (!m) return w;
  return `${m[1]}${m[2] ? '*' : ''}${m[3].replace(/[aeiouyh]/g, '')}`.replace(/(.)\1+/g, '$1');
}

/**
 * Other spellings to look up when a name finds nothing, because the geocoder's own fuzzy match keeps the first letters:
 * the first vowel sound swapped ("Ostin" → "Austin"), and for a short name its consonants alone with each vowel
 * ("Ellum" → "Alm", "Olm", …). Bounded, never the original spelling.
 */
export function soundAlikeQueries(name: string, max = MAX_SOUND_ALIKE_QUERIES): string[] {
  const word = lettersOf(name);
  const m = /^([^aeiouy]*)([aeiouy]+)(.*)$/.exec(word);
  if (word.length < 3 || !m) return [];
  const [, lead, , rest] = m;
  const out = new Set<string>();
  const skeleton = rest.replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');
  if (skeleton.length >= 1 && skeleton.length <= 2) for (const v of ['a', 'e', 'i', 'o', 'u']) out.add(lead + v + skeleton);
  for (const v of ['a', 'e', 'i', 'o', 'u', 'au']) out.add(lead + v + rest);
  out.add(word.replace(/(.)\1+/g, '$1'));
  out.delete(word);
  return [...out].slice(0, max).map((q) => q.charAt(0).toUpperCase() + q.slice(1));
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diagonal : 1 + Math.min(diagonal, prev[j], prev[j - 1]);
      diagonal = saved;
    }
  }
  return prev[b.length];
}

/** The places that sound most like the name, best first: same sound key, then the larger place. */
export function closestPlaceNames(heard: string, candidates: GeocodePlace[], limit = 3): string[] {
  const key = placeSoundKey(heard);
  // A short key ("*lm") matches only exactly; a longer one may differ by one sound.
  const allowed = key.length <= 3 ? 0 : 1;
  const seen = new Set<string>();
  return candidates
    .map((c) => ({ c, distance: editDistance(key, placeSoundKey(c.name)) }))
    .filter(({ distance }) => distance <= allowed)
    .sort((a, b) => a.distance - b.distance || (b.c.population ?? 0) - (a.c.population ?? 0))
    .map(({ c }) => [c.name, c.admin1, c.country].filter(Boolean).join(', '))
    .filter((label) => (seen.has(label) ? false : (seen.add(label), true)))
    .slice(0, limit);
}

function matchesCountry(result: GeocodePlace, exp: string): boolean {
  const normExp = exp.toLowerCase().trim();
  const cName = (result.country ?? '').toLowerCase().trim();
  const cCode = (result.country_code ?? '').toLowerCase().trim();
  if (cName === normExp || cCode === normExp) return true;
  if (normExp === 'germany' && (cCode === 'de' || cName === 'deutschland')) return true;
  if (normExp === 'spain' && (cCode === 'es' || cName === 'españa' || cName === 'espana')) return true;
  if ((normExp === 'usa' || normExp === 'united states' || normExp === 'us') && (cCode === 'us' || cName.includes('united states'))) return true;
  if ((normExp === 'uk' || normExp === 'united kingdom') && (cCode === 'gb' || cName.includes('united kingdom'))) return true;
  if (normExp === 'france' && (cCode === 'fr' || cName === 'france')) return true;
  if (normExp === 'india' && (cCode === 'in' || cName === 'bharat')) return true;
  return cName.includes(normExp) || normExp.includes(cName);
}

/** Governed weather lookup via Open-Meteo (no API key). Consequential
 * because it is an external network call, matching the existing "network
 * access always requires approval" pattern already used by the research
 * capability — never treated as read-only just because the data itself is
 * harmless. */
export function createWeatherCapabilityAdapter(options: WeatherCapabilityOptions = {}): GovernedCapabilityAdapter {
  const fetcher = options.fetchImpl ?? fetch;
  const nowMs = options.now ?? Date.now;

  async function json(url: string): Promise<unknown> {
    const response = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`weather provider request failed (${response.status})`);
    return response.json();
  }

  async function runSingleLocation(call: ModelToolCall): Promise<ToolExecutionResult> {
    const location = typeof call.arguments.location === 'string' ? call.arguments.location.trim() : '';
    if (!location || location.length > MAX_LOCATION_CHARS) {
      return failure('location must be 1-200 characters', 'invalid_arguments');
    }

    let cityName = location;
    let expectedCountry: string | null = typeof call.arguments.country === 'string' ? call.arguments.country.trim() : null;
    const commaMatch = location.match(/^(.+?),\s*([A-Za-z\s]+)$/);
    const inMatch = location.match(/^(.+?)\s+in\s+([A-Za-z\s]+)$/i);
    if (!expectedCountry) {
      if (commaMatch) {
        cityName = commaMatch[1].trim();
        expectedCountry = commaMatch[2].trim();
      } else if (inMatch) {
        cityName = inMatch[1].trim();
        expectedCountry = inMatch[2].trim();
      }
    }

    try {
      let geocode = await json(
        `https://geocoding-api.open-meteo.com/v1/search?count=10&name=${encodeURIComponent(cityName)}`,
      ) as GeocodeResult;
      let candidates = geocode.results ?? [];

      if (expectedCountry && (!candidates.some((c) => matchesCountry(c, expectedCountry!)))) {
        const cityGeocode = await json(
          `https://geocoding-api.open-meteo.com/v1/search?count=10&name=${encodeURIComponent(cityName)}`,
        ) as GeocodeResult;
        if (cityGeocode.results?.length) {
          candidates = cityGeocode.results;
        }
      }

      const matchedCandidates = expectedCountry
        ? candidates.filter((c) => matchesCountry(c, expectedCountry!))
        : candidates;

      if (matchedCandidates.length === 0) {
        // Not a dead end: a spoken or misspelt name ("Ostin") usually sounds like the place meant ("Austin").
        const lookups = await Promise.allSettled(soundAlikeQueries(cityName).map((q) => json(
          `https://geocoding-api.open-meteo.com/v1/search?count=10&name=${encodeURIComponent(q)}`,
        ) as Promise<GeocodeResult>));
        const pool = [...candidates, ...lookups.flatMap((r) => (r.status === 'fulfilled' ? r.value.results ?? [] : []))];
        const inCountry = expectedCountry ? pool.filter((c) => matchesCountry(c, expectedCountry!)) : pool;
        const closest = closestPlaceNames(cityName, inCountry.length ? inCountry : pool);
        const where = `"${cityName}"${expectedCountry ? ` in ${expectedCountry}` : ''}`;
        // Worded for the person: the desktop shows this text as it is when it answers a weather question itself.
        const options = closest.length > 1 ? `${closest.slice(0, -1).join('; ')} or ${closest[closest.length - 1]}` : closest[0];
        return failure(
          closest.length
            ? `No place called ${where} was found. Did you mean ${options}? Say which one, and the weather is looked up for it.`
            : `No place called ${where} was found, and no similar-sounding place either. Please spell the place name, or name a nearby larger town.`,
          'weather_location_not_found',
        );
      }

      // Check for exact match on city name (case-insensitive)
      const normCity = cityName.trim().toLowerCase();
      const exactMatch = matchedCandidates.find((c) => c.name.trim().toLowerCase() === normCity);

      let place: GeocodePlace;
      if (exactMatch) {
        place = exactMatch;
      } else {
        // No exact match. The name is ambiguous or an approximate spelling (e.g. "Ull" matching "Ulla").
        // DO NOT silently pick the first fuzzy candidate and do NOT silently assume an unrelated place.
        const suggestions = matchedCandidates.slice(0, 3).map((c) => [c.name, c.admin1, c.country].filter(Boolean).join(', '));
        return failure(
          `The location "${cityName}"${expectedCountry ? ` in ${expectedCountry}` : ''} is ambiguous or an approximate spelling. Did you mean ${suggestions.join(' or ')}? Please clarify the location.`,
          'weather_location_ambiguous',
        );
      }

      const forecast = await json(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}`
        + '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code'
        + '&hourly=temperature_2m,relative_humidity_2m,weather_code'
        + '&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto',
      ) as ForecastResult;
      const current = forecast.current;
      if (!current || current.temperature_2m == null) {
        return failure('Weather provider returned no current conditions', 'weather_provider_incomplete');
      }
      const label = current.weather_code != null ? WEATHER_CODE_LABELS[current.weather_code] ?? 'unknown conditions' : 'unknown conditions';
      const placeName = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
      const tempUnit = forecast.current_units?.temperature_2m ?? '°C';
      const windUnit = forecast.current_units?.wind_speed_10m ?? 'km/h';
      const summaryParts = [
        `${placeName}: ${label}, ${current.temperature_2m}${tempUnit}`,
        current.relative_humidity_2m != null ? `humidity ${current.relative_humidity_2m}%` : null,
        current.wind_speed_10m != null ? `wind ${current.wind_speed_10m} ${windUnit}` : null,
      ];

      // Format tomorrow/evening forecast based on local forecast date, not UTC
      if (forecast.hourly?.time?.length && forecast.hourly?.temperature_2m?.length) {
        const firstTime = forecast.hourly.time[0]; // e.g. "2026-11-06T00:00"
        const localDateStr = firstTime.slice(0, 10);
        const [y, m, d] = localDateStr.split('-').map(Number);
        const tomorrowDate = new Date(Date.UTC(y, m - 1, d + 1));
        const tomorrowIso = tomorrowDate.toISOString().slice(0, 10);

        const eveningIdx = forecast.hourly.time.findIndex((t) => t.startsWith(`${tomorrowIso}T18:`) || t.startsWith(`${tomorrowIso}T20:`));
        if (eveningIdx !== -1) {
          const tEve = forecast.hourly.temperature_2m[eveningIdx];
          const cEve = forecast.hourly.weather_code?.[eveningIdx];
          const lEve = cEve != null ? WEATHER_CODE_LABELS[cEve] ?? 'clear' : 'clear';
          summaryParts.push(`tomorrow evening (${tomorrowIso} 18:00 local): ${lEve}, ${tEve}${tempUnit}`);
        } else if (forecast.daily?.temperature_2m_max?.[1] != null) {
          const dMax = forecast.daily.temperature_2m_max[1];
          const dMin = forecast.daily.temperature_2m_min?.[1];
          summaryParts.push(`tomorrow (${tomorrowIso}): max ${dMax}${tempUnit}, min ${dMin ?? dMax}${tempUnit}`);
        }
      }

      const summary = `${summaryParts.filter(Boolean).join(', ')}. ${observedNote(forecast, nowMs())}`;
      return {
        status: 'succeeded',
        exitCode: 0,
        output: summary,
        resultCategory: 'weather_fetched',
        normalizedArguments: { location: placeName },
      };
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 'weather_provider_error');
    }
  }

  async function run(call: ModelToolCall): Promise<ToolExecutionResult> {
    const rawLoc = typeof call.arguments.location === 'string' ? call.arguments.location.trim() : '';
    // Check for comparison: "Ulm Germany and Ullà Spain" or "Ulm and Munich"
    const compareMatch = rawLoc.split(/\s+(?:and|vs\.?|versus)\s+/i);
    if (compareMatch.length === 2 && compareMatch[0].trim() && compareMatch[1].trim()) {
      const callA: ModelToolCall = { ...call, arguments: { ...call.arguments, location: compareMatch[0].trim() } };
      const callB: ModelToolCall = { ...call, arguments: { ...call.arguments, location: compareMatch[1].trim() } };
      const [resA, resB] = await Promise.all([runSingleLocation(callA), runSingleLocation(callB)]);
      if (resA.status === 'succeeded' && resB.status === 'succeeded') {
        return {
          status: 'succeeded',
          exitCode: 0,
          output: `Weather comparison:\n• ${resA.output}\n• ${resB.output}`,
          resultCategory: 'weather_fetched',
          normalizedArguments: { location: rawLoc },
        };
      }
      if (resA.status === 'succeeded') return resA;
      if (resB.status === 'succeeded') return resB;
      return failure(`Comparison failed: ${resA.output}; ${resB.output}`, 'weather_comparison_failed');
    }

    return runSingleLocation(call);
  }

  return {
    id: 'weather',
    definitions: () => [{
      name: 'get_weather',
      description: 'Look up current weather conditions for a named location (city, region, or place name). Read-only: queries current forecast and conditions without modifying system or account state.',
      parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
    }],
    classify: () => 'read_only',
    health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run,
  };
}
