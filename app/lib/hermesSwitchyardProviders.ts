/**
 * Approved fixed hosted provider profiles accepted by NemoClaw Switchyard onboarding
 * (NemoClaw src/lib/inference/native-provider/hosted.ts, v0.0.141).
 * Client-safe: no Node.js imports.
 */
export const HERMES_SWITCHYARD_PROVIDERS = [
  { id: "nvidia-prod", label: "NVIDIA (build.nvidia.com)", credentialEnv: "NVIDIA_API_KEY" },
  { id: "openai-api", label: "OpenAI", credentialEnv: "OPENAI_API_KEY" },
  { id: "anthropic-prod", label: "Anthropic", credentialEnv: "ANTHROPIC_API_KEY" },
  { id: "gemini-api", label: "Google Gemini", credentialEnv: "GEMINI_API_KEY" },
  { id: "openrouter-api", label: "OpenRouter", credentialEnv: "OPENROUTER_API_KEY" },
] as const

export type HermesSwitchyardProviderId = (typeof HERMES_SWITCHYARD_PROVIDERS)[number]["id"]
