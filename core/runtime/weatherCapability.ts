import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionContext, ToolExecutionResult } from './toolRunner';

const MAX_LOCATION_CHARS = 200;
const FETCH_TIMEOUT_MS = 8_000;

export interface WeatherCapabilityOptions {
  fetchImpl?: typeof fetch;
}

interface GeocodeResult {
  results?: Array<{ name: string; country?: string; admin1?: string; latitude: number; longitude: number }>;
}

interface ForecastResult {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
    weather_code?: number;
  };
  current_units?: { temperature_2m?: string; wind_speed_10m?: string };
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

  async function run(call: ModelToolCall): Promise<ToolExecutionResult> {
    const location = typeof call.arguments.location === 'string' ? call.arguments.location.trim() : '';
    if (!location || location.length > MAX_LOCATION_CHARS) {
      return failure('location must be 1-200 characters', 'invalid_arguments');
    }
    try {
      const geocode = await json(
        `https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(location)}`,
      ) as GeocodeResult;
      const place = geocode.results?.[0];
      if (!place) return failure(`No location found matching "${location}"`, 'weather_location_not_found');

      const forecast = await json(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}`
        + '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code',
      ) as ForecastResult;
      const current = forecast.current;
      if (!current || current.temperature_2m == null) {
        return failure('Weather provider returned no current conditions', 'weather_provider_incomplete');
      }
      const label = current.weather_code != null ? WEATHER_CODE_LABELS[current.weather_code] ?? 'unknown conditions' : 'unknown conditions';
      const placeName = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
      const tempUnit = forecast.current_units?.temperature_2m ?? '°C';
      const windUnit = forecast.current_units?.wind_speed_10m ?? 'km/h';
      const summary = [
        `${placeName}: ${label}, ${current.temperature_2m}${tempUnit}`,
        current.relative_humidity_2m != null ? `humidity ${current.relative_humidity_2m}%` : null,
        current.wind_speed_10m != null ? `wind ${current.wind_speed_10m} ${windUnit}` : null,
      ].filter(Boolean).join(', ');
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
