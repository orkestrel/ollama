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

/** Names the Ollama raw generation endpoint. */
export const OLLAMA_GENERATE_PATH = '/api/generate'

/** Bounds the top logprob list to Ollama's limit of 20 tokens. */
export const TOP_LOGPROBS = 20

/** Bounds a Mica score question to 10 levels. */
export const MAX_MICA_LEVELS = 10

/** Identifies the Mica prompt render revision used in judge identities. */
export const MICA_RENDER_REVISION = 'mica-native-2026-10-07-v1'

/** Lists Mica's letter labels in codebook order. */
export const MICA_OPTION_LABELS: readonly string[] = Object.freeze(
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split(''),
)

/** Lists Mica's false and true labels in readout order. */
export const MICA_NOUL_LABELS: readonly string[] = Object.freeze(['No', 'Yes'])

/** Lists the control tokens escaped by Mica's native renderer. */
export const MICA_SPECIAL_TOKENS: readonly string[] = Object.freeze([
	'<|im_start|>',
	'<|im_end|>',
	'<|endoftext|>',
	'<|vision_start|>',
	'<|vision_end|>',
	'<|image_pad|>',
	'<|video_pad|>',
	'<think>',
	'</think>',
	'<tool_call>',
	'</tool_call>',
	'<tool_response>',
	'</tool_response>',
])
