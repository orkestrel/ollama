import type {
	OllamaBytes,
	OllamaDaemonOptions,
	OllamaFixtureOptions,
	OllamaFixtureRequest,
	OllamaMaintenance,
	OllamaMetadataOptions,
	OllamaModel,
	OllamaReadoutOptions,
	OllamaReplyOptions,
} from './types.js'
import type { OllamaCounts, OllamaDurations, OllamaTiming } from '@src/core'
import { arrayOf, isRecord, isString, objectOf, parseJSONAs } from '@orkestrel/contract'
import { mergePlatformEnvironment } from '@orkestrel/process/server'
import { createHash } from 'node:crypto'
import { extractTiming } from '@src/core'
import { OLLAMA_FIXTURE_TIME, OLLAMA_METADATA_BYTES, OLLAMA_METADATA_TIMEOUT } from './constants.js'
import { isOllamaError, OllamaError } from './errors.js'
import { isOllamaOrigin } from './validators.js'

/**
 * Checks whether every key of a record is one the declaration names.
 * @param value - The record to inspect
 * @param keys - The keys the declaration names
 * @returns True if the record holds no other key; false otherwise
 * @example
 * ```ts
 * matchesDeclaredKeys({ grace: 1 }, ['grace', 'drain']) // true
 * matchesDeclaredKeys({ wait: 1 }, ['grace', 'drain']) // false
 * ```
 */
export function matchesDeclaredKeys(
	value: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): boolean {
	return Object.keys(value).every((key) => keys.includes(key))
}

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
 * Reads the version a metadata reply reports, whatever it is.
 * @remarks The reply is the readiness probe's proof that an Ollama answers; the version it names is
 * an observation the caller records and compares with nothing.
 * @param value - The parsed version reply
 * @returns The reported nonempty version
 * @throws OllamaError Thrown with code `metadata` when the reply names no nonempty string version.
 * @example
 * ```ts
 * readOllamaVersion({ version: '0.40.8' }) // '0.40.8'
 * ```
 */
export function readOllamaVersion(value: unknown): string {
	if (!isRecord(value) || !isString(value.version) || value.version.length === 0)
		throw new OllamaError('Malformed version metadata', { code: 'metadata' })
	return value.version
}

/**
 * Verifies every declared model against a complete metadata inventory.
 * @remarks
 * The reply is foreign: a real entry carries `model`, `modified_at`, `size`, and `details` beside the
 * two fields this compares, and the inventory lists models no declaration names. So each entry passes an
 * open guard on those two fields, and only a declaration meets the exact `isOllamaModel` guard.
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
	if (!isRecord(value) || !arrayOf(objectOf({ name: isString, digest: isString }))(value.models))
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

export function buildOllamaTiming(
	durations: Partial<OllamaDurations> = {},
	counts: Partial<OllamaCounts> = {},
): Readonly<Record<string, number>> {
	const fields: ReadonlyArray<readonly [string, number | undefined]> = [
		['total_duration', durations.total],
		['load_duration', durations.load],
		['prompt_eval_duration', durations.prompt],
		['eval_duration', durations.decode],
		['prompt_eval_count', counts.prompt],
		['eval_count', counts.decode],
		['prompt_eval_cached_count', counts.cached],
	]
	return Object.freeze(
		Object.fromEntries(
			fields.filter((field): field is readonly [string, number] => field[1] !== undefined),
		),
	)
}

export function buildOllamaReply(options: OllamaReplyOptions = {}): string {
	const model = options.model === undefined ? {} : { model: options.model }
	const deltas = (options.parts ?? []).map(
		(content) =>
			`${JSON.stringify({ ...model, message: { role: 'assistant', content }, done: false })}\n`,
	)
	const terminal = JSON.stringify({
		...model,
		message: {
			role: 'assistant',
			content: options.content ?? '',
			...(options.thinking === undefined ? {} : { thinking: options.thinking }),
			...(options.calls === undefined
				? {}
				: {
						tool_calls: options.calls.map((call) => ({
							id: call.id,
							function: { name: call.name, arguments: call.arguments },
						})),
					}),
		},
		done: true,
		done_reason: options.reason ?? 'stop',
		...buildOllamaTiming(options.durations, options.counts),
	})
	return [...deltas, `${terminal}\n`].join('')
}

export function buildOllamaReadout(options: OllamaReadoutOptions): string {
	const chosen = options.top.find((entry) => entry.token === options.token)
	return JSON.stringify({
		...(options.model === undefined ? {} : { model: options.model }),
		response: options.token,
		done: true,
		done_reason: 'length',
		...buildOllamaTiming(undefined, options.counts),
		logprobs: [
			{
				token: options.token,
				...(chosen === undefined ? {} : { logprob: chosen.logprob }),
				top_logprobs: options.top.map((entry) => ({ token: entry.token, logprob: entry.logprob })),
			},
		],
	})
}

export function buildOllamaInventory(models: readonly OllamaModel[]): string {
	return JSON.stringify({
		models: models.map((model) => ({
			name: model.name,
			model: model.name,
			modified_at: OLLAMA_FIXTURE_TIME,
			size: 2147483648,
			digest: model.digest,
			details: {
				parent_model: '',
				format: 'gguf',
				family: 'qwen3',
				families: ['qwen3'],
				parameter_size: '2B',
				quantization_level: 'Q4_K_M',
			},
		})),
	})
}

export function buildOllamaAnswer(
	request: OllamaFixtureRequest,
	options: Pick<OllamaFixtureOptions, 'models' | 'version' | 'context'>,
): Response {
	const route = `${request.method} ${request.path}`
	if (route === 'GET /api/version') return Response.json({ version: options.version })
	if (route === 'GET /api/tags')
		return new Response(buildOllamaInventory(options.models), {
			headers: { 'content-type': 'application/json' },
		})
	if (route === 'POST /api/chat')
		return Response.json({ error: 'no reply policy answers /api/chat' }, { status: 500 })
	if (!['POST /api/show', 'POST /api/generate'].includes(route))
		return new Response(null, { status: 404 })
	const body = parseJSONAs(request.body, isRecord)
	if (body === undefined)
		return Response.json(
			{ error: `the fixture refuses ${request.path}: its body is not a JSON object` },
			{ status: 400 },
		)
	if (
		request.path === '/api/generate' &&
		(body.keep_alive !== 0 || (body.prompt !== undefined && body.prompt !== ''))
	)
		return Response.json({ error: 'no reply policy answers /api/generate' }, { status: 500 })
	const name = body.model
	if (!isString(name))
		return Response.json(
			{ error: `the fixture refuses ${request.path}: its body names no model` },
			{ status: 400 },
		)
	const model = options.models.find((entry) => entry.name === name)
	if (model === undefined)
		return Response.json({ error: `model '${name}' not found` }, { status: 404 })
	return request.path === '/api/show'
		? Response.json({
				model_info: {
					'general.architecture': 'fixture',
					'fixture.context_length': options.context,
				},
			})
		: Response.json({
				model: model.name,
				created_at: OLLAMA_FIXTURE_TIME,
				response: '',
				done: true,
				done_reason: 'unload',
			})
}
