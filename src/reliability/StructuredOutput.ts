import { ProviderResponseFormat, ProviderType } from '../providers/ProviderTypes';
import { ModelProfile } from './ModelProfiles';

export type StructuredOutputDeferredReason =
  | 'not_requested'
  | 'native_tools_active'
  | 'vision_request'
  | 'profile_unsupported'
  | 'provider_restriction';

/**
 * Typed structured-output decision for one model dispatch.
 *
 * `active` is true only when a response format is actually attached to the
 * provider request. When `active` is false, `deferredReason` states exactly
 * why — so the UI and evidence never claim structured output is live when it
 * is only profiled.
 */
export interface StructuredOutputDecision {
  requested: boolean;
  supported: boolean;
  active: boolean;
  deferredReason?: StructuredOutputDeferredReason;
  /** The format to attach to ProviderChatOptions when active. */
  format?: ProviderResponseFormat;
}

/**
 * Decides whether a schema-constrained response format may be attached.
 *
 * Rules:
 * - Only an explicitly requested format is ever sent; nothing is invented.
 * - Native tools and a response schema are never combined: when tool
 *   definitions are active, native tool calling is selected
 *   deterministically and the response format is deferred
 *   (`native_tools_active`). Both supported providers (Ollama and local
 *   OpenAI-compatible servers) degrade unreliably when `format` /
 *   `response_format` is combined with `tools`.
 * - Vision requests never carry a response format (`vision_request`).
 * - The profile must support structured output. For Ollama, both
 *   `ollama_format` and `json_schema` map onto the native `format` channel.
 *   For OpenAI-compatible endpoints, only profiles declaring `json_schema`
 *   receive `response_format` — a JSON schema is never blindly sent to every
 *   OpenAI-compatible server (`provider_restriction` otherwise).
 */
export function decideStructuredOutput(input: {
  profile: ModelProfile;
  providerType: ProviderType;
  toolsActive: boolean;
  hasImages: boolean;
  requestedFormat?: ProviderResponseFormat;
}): StructuredOutputDecision {
  const requested = input.requestedFormat !== undefined;
  const profileCapability = input.profile.structuredOutput;
  const supported =
    profileCapability !== 'unsupported' &&
    (input.providerType === 'ollama' || profileCapability === 'json_schema');

  if (!requested) {
    return {
      requested: false,
      supported,
      active: false,
      deferredReason: input.toolsActive ? 'native_tools_active' : 'not_requested',
    };
  }
  if (input.toolsActive) {
    return { requested: true, supported, active: false, deferredReason: 'native_tools_active' };
  }
  if (input.hasImages) {
    return { requested: true, supported, active: false, deferredReason: 'vision_request' };
  }
  if (profileCapability === 'unsupported') {
    return { requested: true, supported: false, active: false, deferredReason: 'profile_unsupported' };
  }
  if (!supported) {
    return { requested: true, supported: false, active: false, deferredReason: 'provider_restriction' };
  }
  return { requested: true, supported: true, active: true, format: input.requestedFormat };
}
