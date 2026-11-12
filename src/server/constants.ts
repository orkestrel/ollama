/** Bounds startup through the version probe and model verification to 60000 milliseconds by default. */
export const OLLAMA_READINESS = 60_000

/** Bounds each metadata or unload request and body read to 10000 milliseconds by default. */
export const OLLAMA_METADATA_TIMEOUT = 10_000

/** Bounds each retained metadata or unload response to 1048576 bytes by default. */
export const OLLAMA_METADATA_BYTES = 1_048_576

/** Bounds a daemon duration to 2147483647 milliseconds, the longest a Node timer holds. */
export const OLLAMA_TIMER_LIMIT = 2_147_483_647

/** Lists the keys of a daemon declaration that hold live values, which no shape declares. */
export const OLLAMA_DAEMON_LIVE: readonly string[] = Object.freeze([
	'on',
	'error',
	'fetch',
	'signal',
])

/** Lists the keys each record of a daemon declaration admits, live values included. */
export const OLLAMA_DAEMON_KEYS = Object.freeze({
	daemon: Object.freeze([
		...OLLAMA_DAEMON_LIVE,
		'executable',
		'url',
		'models',
		'workspace',
		'environment',
		'store',
		'readiness',
		'metadata',
		'termination',
	]),
	executable: Object.freeze(['path', 'digest', 'arguments']),
	model: Object.freeze(['name', 'digest']),
	metadata: Object.freeze(['timeout', 'bytes']),
	termination: Object.freeze(['grace', 'drain']),
})

/** Identifies daemon errors across installations and module formats through the global symbol registry. */
export const OLLAMA_ERROR_BRAND = Symbol.for('@orkestrel/ollama.OllamaError')

/**
 * Lists every machine-readable daemon refusal category.
 *
 * @remarks
 * `invalid` refuses a declaration; `occupied` refuses a bound endpoint; `digest` reports
 * executable mismatch or unreadable identity; `spawn` reports child creation failure;
 * `readiness` reports the startup deadline; `model` reports a mismatched model declaration;
 * `owner` reports missing child listen or liveness evidence; `metadata` refuses HTTP status,
 * redirects, malformed metadata such as a version reply with no version, size, or request
 * bounds; `unload` refuses a maintenance terminal reply; `cleanup` reports unconfirmed
 * termination; `aborted` reports caller cancellation; `state` refuses an invalid lifecycle
 * operation.
 */
export const OLLAMA_ERROR_CODES = Object.freeze([
	'invalid',
	'occupied',
	'digest',
	'spawn',
	'readiness',
	'model',
	'owner',
	'metadata',
	'unload',
	'cleanup',
	'aborted',
	'state',
] as const)
