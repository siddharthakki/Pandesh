import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';

const MAX_LOCATION_CHARS = 200;
const FETCH_TIMEOUT_MS = 8_000;

export interface WeatherCapabilityOptions {
  fetchImpl?: typeof fetch;
}

interface GeocodePlace {
  id?: number;
  name: string;
  country?: string;
  country_code?: string;
  admin1?: string;
  latitude: number;
  longitude: number;
}

interface GeocodeResult {
  results?: GeocodePlace[];
}

interface ForecastResult {
  current?: {
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
        return failure(`No location found matching "${cityName}"${expectedCountry ? ` in ${expectedCountry}` : ''}. Please verify the city and country name.`, 'weather_location_not_found');
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

      const summary = summaryParts.filter(Boolean).join(', ');
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
