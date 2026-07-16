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

/**
 * The cap, in characters, on how much of a non-OK response body is
 * incorporated into a thrown {@link OllamaHTTPError}'s message.
 *
 * @remarks
 * Bounds the excerpt so a defensive proxy or a misbehaving daemon handing
 * back an unbounded response body cannot inflate the thrown error's message
 * without limit (§14). `2048` characters is generous enough to carry a
 * useful diagnostic snippet while staying well short of any practical size
 * concern.
 */
export const MAX_ERROR_BODY_LENGTH = 2048
