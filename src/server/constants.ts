/** Bounds startup through version and model verification to 60000 milliseconds by default. */
export const OLLAMA_READINESS = 60_000

/** Bounds each metadata or unload request and body read to 10000 milliseconds by default. */
export const OLLAMA_METADATA_TIMEOUT = 10_000

/** Bounds each retained metadata or unload response to 1048576 bytes by default. */
export const OLLAMA_METADATA_BYTES = 1_048_576

/** Identifies daemon errors across installations and module formats through the global symbol registry. */
export const OLLAMA_ERROR_BRAND = Symbol.for('@orkestrel/ollama.OllamaError')

/**
 * Lists every machine-readable daemon refusal category.
 *
 * @remarks
 * `invalid` refuses a declaration; `occupied` refuses a bound endpoint; `digest` reports
 * executable mismatch or unreadable identity; `spawn` reports child creation failure;
 * `readiness` reports the startup deadline; `version` and `model` report mismatched
 * declarations; `owner` reports missing child listen or liveness evidence; `metadata`
 * refuses HTTP status, redirects, malformed metadata, size, or request bounds; `unload`
 * refuses a maintenance terminal reply; `cleanup` reports unconfirmed termination;
 * `aborted` reports caller cancellation; `state` refuses an invalid lifecycle operation.
 */
export const OLLAMA_ERROR_CODES = Object.freeze([
	'invalid',
	'occupied',
	'digest',
	'spawn',
	'readiness',
	'version',
	'model',
	'owner',
	'metadata',
	'unload',
	'cleanup',
	'aborted',
	'state',
] as const)
