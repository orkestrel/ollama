import type {
	OllamaBytes,
	OllamaDaemonOptions,
	OllamaMaintenance,
	OllamaMetadataOptions,
	OllamaModel,
} from './types.js'
import type { OllamaTiming } from '@src/core'
import { arrayOf, isRecord, isString, parseJSONAs } from '@orkestrel/contract'
import { mergePlatformEnvironment } from '@orkestrel/process/server'
import { createHash } from 'node:crypto'
import { extractTiming } from '@src/core'
import { OLLAMA_METADATA_BYTES, OLLAMA_METADATA_TIMEOUT } from './constants.js'
import { isOllamaError, OllamaError } from './errors.js'
import { isOllamaModel, isOllamaOrigin } from './validators.js'

/**
 * Builds the environment with dedicated values overriding every inherited or caller casing.
 * @param inherited - The inherited environment
 * @param environment - Caller overrides and removals
 * @param url - The dedicated HTTP origin
 * @param store - The optional absolute model directory
 * @returns The merged environment with case-folded names on every host
 * @remarks Selects the process package's case-folded merge semantics deliberately on every host.
 * @example
 * ```ts
 * buildOllamaEnvironment({}, undefined, 'http://127.0.0.1:31111')
 * // { OLLAMA_HOST: '127.0.0.1:31111' }
 * ```
 */
export function buildOllamaEnvironment(
	inherited: Readonly<Record<string, string | undefined>>,
	environment: Readonly<Record<string, string | undefined>> | undefined,
	url: string,
	store?: string,
): Readonly<Record<string, string | undefined>> {
	return mergePlatformEnvironment('win32', inherited, false, environment, {
		OLLAMA_HOST: url.replace(/^http:\/\//, '').replace(/\/$/, ''),
		...(store === undefined ? {} : { OLLAMA_MODELS: store }),
	})
}

/**
 * Checks whether stderr announces the dedicated loopback listener.
 * @param line - A complete stderr line with optional surrounding log fields
 * @param url - The declared origin
 * @returns True if the announcement names exactly that loopback address and port; false otherwise
 * @example
 * ```ts
 * matchesOllamaAnnouncement('Listening on 127.0.0.1:31111 (version 0.40.8)', 'http://127.0.0.1:31111') // true
 * ```
 */
export function matchesOllamaAnnouncement(line: string, url: string): boolean {
	const pattern = /(?:^|[\s"'])Listening on 127\.0\.0\.1:([0-9]+) \(version [^\s()]+\)(?=$|[\s"'])/
	return Number(pattern.exec(line)?.[1]) === Number(url.match(/:([0-9]+)\/?$/)?.[1])
}

/**
 * Retains exact body bytes with an independently reproducible digest.
 * @param bytes - The retained body or prefix
 * @param complete - If true, the body ended within its bound; if false, only a prefix was observed
 * @returns An immutable base64 body receipt
 * @example
 * ```ts
 * retainOllamaBytes(new Uint8Array([65]), true).content // 'QQ=='
 * ```
 */
export function retainOllamaBytes(bytes: Uint8Array, complete: boolean): OllamaBytes {
	return Object.freeze({
		content: Buffer.from(bytes).toString('base64'),
		size: bytes.byteLength,
		digest: createHash('sha256').update(bytes).digest('hex'),
		complete,
	})
}

/**
 * Verifies a metadata reply against the declared executable version.
 * @param value - The parsed version reply
 * @param expected - The offline expected version
 * @returns Nothing after the version matches
 * @throws OllamaError Thrown when the metadata or version differs.
 * @example
 * ```ts
 * verifyOllamaVersion({ version: '0.40.8' }, '0.40.8')
 * ```
 */
export function verifyOllamaVersion(value: unknown, expected: string): void {
	if (!isRecord(value) || !isString(value.version) || value.version.length === 0)
		throw new OllamaError('Malformed version metadata', { code: 'metadata' })
	if (value.version !== expected)
		throw new OllamaError('Executable version differs', {
			code: 'version',
			context: { expected, received: value.version },
		})
}

/**
 * Verifies every declared model against a complete metadata inventory.
 * @param value - The parsed tags reply
 * @param models - The caller's exact model identities
 * @returns Nothing after every declared digest matches
 * @throws OllamaError Thrown when the inventory is malformed, missing a model, or reports another digest.
 * @example
 * ```ts
 * verifyOllamaModels({ models: [{ name: 'cedar', digest: 'declared' }] }, [{ name: 'cedar', digest: 'declared' }])
 * ```
 */
export function verifyOllamaModels(value: unknown, models: readonly OllamaModel[]): void {
	if (!isRecord(value) || !arrayOf(isOllamaModel)(value.models))
		throw new OllamaError('Malformed model metadata', { code: 'metadata' })
	const inventory = value.models
	for (const model of models) {
		const matches = inventory.filter((entry) => entry.name === model.name)
		if (matches.length !== 1 || matches[0]?.digest !== model.digest)
			throw new OllamaError('Declared model differs from inventory', {
				code: 'model',
				context: {
					model: model.name,
					expected: model.digest,
					received: matches.map((entry) => entry.digest),
				},
			})
	}
}

/**
 * Reads a complete retained JSON metadata body without reserializing it.
 * @param bytes - The original retained response
 * @returns The parsed record
 * @throws OllamaError Thrown when the body is incomplete or malformed JSON.
 * @example
 * ```ts
 * readOllamaJSON(retainOllamaBytes(Buffer.from('{"version":"0.40.8"}'), true)).version // '0.40.8'
 * ```
 */
export function readOllamaJSON(bytes: OllamaBytes): Readonly<Record<string, unknown>> {
	const value = bytes.complete
		? parseJSONAs(Buffer.from(bytes.content, 'base64').toString('utf8'), isRecord)
		: undefined
	if (value === undefined)
		throw new OllamaError('Incomplete or malformed metadata body', { code: 'metadata' })
	return value
}

/**
 * Reads unload timing only after a complete terminal reply names the declared model.
 * @param bytes - The retained JSON or NDJSON response
 * @param model - The declared maintenance identity
 * @returns The terminal timing observation
 * @throws OllamaError Thrown when a record is malformed, incomplete, refused, or names another model.
 * @example
 * ```ts
 * readOllamaTerminal(retainOllamaBytes(Buffer.from('{"model":"cedar","done":true}'), true), { name: 'cedar', digest: 'declared' })
 * ```
 */
export function readOllamaTerminal(
	bytes: OllamaBytes,
	model: OllamaModel,
): OllamaTiming | undefined {
	const records = Buffer.from(bytes.content, 'base64')
		.toString('utf8')
		.split(/\r\n|\n/)
		.filter((line) => line.trim().length > 0)
		.map((line) => parseJSONAs(line, isRecord))
	const terminal = records.at(-1)
	if (
		!bytes.complete ||
		terminal === undefined ||
		terminal.done !== true ||
		terminal.model !== model.name ||
		records.some(
			(record) =>
				record === undefined ||
				record.error !== undefined ||
				(record.model !== undefined && record.model !== model.name),
		)
	) {
		throw new OllamaError('Unload reply does not confirm the declared model', {
			code: 'unload',
			context: { model: model.name },
		})
	}
	const timing = extractTiming(terminal)
	return timing === undefined
		? undefined
		: Object.freeze({
				durations: Object.freeze({ ...timing.durations }),
				counts: Object.freeze({ ...timing.counts }),
				invalid: Object.freeze([...timing.invalid]),
			})
}

/**
 * Reads a bounded response and preserves its partial bytes on a transport refusal.
 * @param response - The received HTTP headers and body
 * @param limit - The maximum retained bytes
 * @returns The status, retained body, and optional refusal
 * @example
 * ```ts
 * await readOllamaBody(new Response('ready'), 64)
 * ```
 */
export async function readOllamaBody(
	response: Response,
	limit: number,
): Promise<Pick<OllamaMaintenance, 'response' | 'status' | 'error'>> {
	const chunks: Uint8Array[] = []
	const reader = response.body?.getReader()
	try {
		if (reader !== undefined) {
			for (;;) {
				const step = await reader.read()
				if (step.done) break
				const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
				chunks.push(step.value.subarray(0, Math.max(0, limit - size)))
				if (size + step.value.byteLength > limit)
					throw new OllamaError('Metadata response exceeds its byte bound', { code: 'metadata' })
			}
		}
		const bytes = retainOllamaBytes(Buffer.concat(chunks), true)
		return Object.freeze({
			status: response.status,
			response: bytes,
			...(response.ok
				? {}
				: {
						error: new OllamaError('Metadata status or redirect refused', {
							code: 'metadata',
							context: { received: response.status },
						}),
					}),
		})
	} catch (cause) {
		return Object.freeze({
			status: response.status,
			response: retainOllamaBytes(Buffer.concat(chunks), false),
			error: new OllamaError('Metadata body refused', { code: 'metadata', cause }),
		})
	} finally {
		await reader?.cancel().catch(() => undefined)
		reader?.releaseLock()
	}
}

/**
 * Exchanges metadata or unload bytes with a dedicated origin under one complete-request deadline.
 * @param origin - The dedicated loopback HTTP origin
 * @param path - The metadata or generate route
 * @param options - Per-request byte and timer bounds
 * @param signal - Cancellation shared with startup or stop
 * @param request - The exact unload body, omitted for metadata GETs
 * @param transport - The fetch collaborator; defaults to the global fetch bound to globalThis
 * @returns The retained response observations, including any refusal
 * @example
 * ```ts
 * await readOllamaReply('http://127.0.0.1:31111', '/api/version', { timeout: 5000 })
 * ```
 */
export async function readOllamaReply(
	origin: string,
	path: string,
	options: OllamaMetadataOptions = {},
	signal?: AbortSignal,
	request?: OllamaBytes,
	transport?: OllamaDaemonOptions['fetch'],
): Promise<Pick<OllamaMaintenance, 'response' | 'status' | 'error'>> {
	const controller = new AbortController()
	const timeout = options.timeout ?? OLLAMA_METADATA_TIMEOUT
	const limit = options.bytes ?? OLLAMA_METADATA_BYTES
	const timer = setTimeout(
		() => controller.abort(new OllamaError('Metadata deadline elapsed', { code: 'metadata' })),
		timeout,
	)
	try {
		if (
			!isOllamaOrigin(origin) ||
			!['/api/version', '/api/tags', '/api/generate'].includes(path) ||
			!Number.isSafeInteger(limit) ||
			limit <= 0 ||
			!Number.isInteger(timeout) ||
			timeout <= 0 ||
			timeout > 2_147_483_647
		)
			throw new OllamaError('Invalid dedicated metadata request', { code: 'invalid' })
		const response = await (transport ?? globalThis.fetch.bind(globalThis))(new URL(path, origin), {
			method: request === undefined ? 'GET' : 'POST',
			redirect: 'manual',
			signal:
				signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
			...(request === undefined
				? {}
				: {
						headers: { 'content-type': 'application/json' },
						body: Buffer.from(request.content, 'base64'),
					}),
		})
		const reply = await readOllamaBody(response, limit)
		return signal?.aborted
			? Object.freeze({
					...reply,
					error: isOllamaError(signal.reason)
						? signal.reason
						: new OllamaError('Metadata request was aborted', {
								code: 'aborted',
								cause: signal.reason,
							}),
				})
			: reply
	} catch (cause) {
		if (signal?.aborted)
			return Object.freeze({
				error: isOllamaError(signal.reason)
					? signal.reason
					: new OllamaError('Metadata request was aborted', {
							code: 'aborted',
							cause: signal.reason,
						}),
			})
		return Object.freeze({
			error: new OllamaError('Metadata request refused', {
				code: 'metadata',
				context: { url: origin, operation: path },
				cause,
			}),
		})
	} finally {
		clearTimeout(timer)
	}
}
