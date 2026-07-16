// Ollama constants — the provider's defaults (AGENTS §5).

/** The local Ollama daemon base URL assumed when `OllamaOptions.url` is omitted. */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434'

/**
 * How long the model stays resident after a call when `OllamaOptions.keepAlive` is
 * omitted — Ollama's own `keep_alive` default, expressed as a duration string.
 */
export const DEFAULT_KEEP_ALIVE = '5m'

/**
 * The per-call deadline in milliseconds when `OllamaOptions.timeout` is omitted —
 * generous enough that a cold model load does not trip it.
 */
export const DEFAULT_PROVIDER_TIMEOUT = 120_000
