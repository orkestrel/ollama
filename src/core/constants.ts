// Ollama constants — the provider's defaults.

/**
 * Names the local Ollama daemon base URL, `'http://localhost:11434'`, assumed when
 * `OllamaOptions.url` is omitted.
 */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434'

/**
 * Names how long the model stays resident after a call — `'5m'` when
 * `OllamaOptions.keepAlive` is omitted, Ollama's own `keep_alive` default, expressed as a
 * duration string.
 *
 * @remarks
 * The name mirrors the Ollama `/api/chat` `keep_alive` field this value is sent as, so
 * the constant, the `OllamaOptions.keepAlive` key, and the wire member read as one term.
 */
export const DEFAULT_KEEP_ALIVE = '5m'

/** Names the Ollama chat endpoint appended to the configured base URL. */
export const OLLAMA_CHAT_PATH = '/api/chat'
