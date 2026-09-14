import type {
	AgentChunk,
	AgentResult,
	AgentStreamInterface,
	ProviderDelta,
	ProviderInterface,
	ProviderResult,
} from '@orkestrel/agent'
import type { ToolCall, ToolDefinition, ToolInterface, ToolResult } from '@orkestrel/tool'
import type { TokenUsage } from '@orkestrel/budget'
import type { RecorderInterface } from '@orkestrel/test'
import { flattenHeaders, waitForCondition } from '@orkestrel/test'
import { arrayOf, isRecord, isString, parseJSONAs } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createTool } from '@orkestrel/tool'
import { createRelay } from '@orkestrel/agent'

/** Names the fictional browser credential accepted by the relay fixture. */
export const OBFUSCATED = 'Bearer obfuscated-7f3a-token'

/** Names the fictional credential supplied only by the daemon-facing provider. */
export const UPSTREAM_KEY = 'Bearer fixture-upstream-key'

/** Defines the daemon response shared by relay composition proofs. */
export const RELAY_DAEMON_CHUNKS: readonly string[] = Object.freeze([
	'{"message":{"content":"Hello "}}\n',
	'{"message":{"thinking":"checking"}}\n',
	'{"message":{"content":"world","tool_calls":[{"id":"weather-call","function":{"name":"get_weather","arguments":{"city":"Oslo"}}}]}}\n',
	'{"done":true,"prompt_eval_count":3,"eval_count":4}\n',
])

/** Represents a captured transport request with its cancellation signal. */
export interface TransportRequest extends RecordedRequest {
	readonly signal: AbortSignal
}

/** Exposes recorded requests and response bytes around a real or canned transport. */
export interface RecordingTransportInterface {
	readonly requests: readonly TransportRequest[]
	readonly chunks: readonly string[]
	readonly fetch: typeof globalThis.fetch
}

/**
 * Records request fields and response bytes without replacing transport behavior.
 *
 * @param transport - The real fetch or canned daemon transport to drive
 * @returns The transport and its request and response observations
 */
export function createRecordingTransport(
	transport: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): RecordingTransportInterface {
	const requests: TransportRequest[] = []
	const chunks: string[] = []
	return {
		requests,
		chunks,
		async fetch(input, init) {
			const request = new Request(input, init)
			const text = await request.clone().text()
			requests.push({
				method: request.method,
				path: new URL(request.url).pathname,
				headers: flattenHeaders(request.headers),
				body: parseRequestBody(text) ?? {},
				text,
				signal: request.signal,
			})
			const response = await transport(input, init)
			if (response.body === null) return response
			const decoder = new TextDecoder()
			return new Response(
				response.body.pipeThrough(
					new TransformStream<Uint8Array, Uint8Array>({
						transform(chunk, controller) {
							chunks.push(decoder.decode(chunk, { stream: true }))
							controller.enqueue(chunk)
						},
						flush() {
							chunks.push(decoder.decode())
						},
					}),
				),
				{ status: response.status, headers: response.headers },
			)
		},
	}
}

/** Exposes an open daemon response and its explicit failure and cancellation controls. */
export interface OpenTransportInterface {
	readonly fetch: typeof globalThis.fetch
	/** Resolves when the open response body is cancelled; mirrors the `ReadableStream` `cancel` callback. */
	readonly cancelled: Promise<void>
	fail(error: Error): void
}

/**
 * Creates a single-use daemon stream that stays open after the supplied NDJSON chunk.
 *
 * @param chunk - The bytes to deliver before waiting for cancellation or failure
 * @returns The transport, explicit failure control, and observed cancellation
 */
export function createOpenTransport(chunk: string): OpenTransportInterface {
	const cancelled = Promise.withResolvers<void>()
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined
	return {
		cancelled: cancelled.promise,
		fetch() {
			return Promise.resolve(
				new Response(
					new ReadableStream<Uint8Array>({
						start(stream) {
							controller = stream
							stream.enqueue(new TextEncoder().encode(chunk))
						},
						cancel() {
							cancelled.resolve()
						},
					}),
					{ headers: { 'content-type': 'application/x-ndjson' } },
				),
			)
		},
		fail(error) {
			if (controller === undefined) throw new Error('daemon transport has not been called')
			controller.error(error)
		},
	}
}

/**
 * Starts an authenticated provider relay and records its inbound requests.
 *
 * @param provider - The real server-side provider mounted at POST /inference
 * @returns The ephemeral loopback server, recorded requests, and shutdown operation
 */
export async function createRelayServer(
	provider: ProviderInterface,
): Promise<RecordingServerInterface> {
	const requests: RecordedRequest[] = []
	const relay = createRelay({
		provider,
		authorize: (request) => request.headers.get('authorization') === OBFUSCATED,
	})
	const dispatcher = createDispatcher<Record<string, never>>()
	dispatcher.add({
		method: 'POST',
		path: '/inference',
		async handler(request) {
			const text = await request.clone().text()
			requests.push({
				method: request.method,
				path: new URL(request.url).pathname,
				headers: flattenHeaders(request.headers),
				body: parseRequestBody(text) ?? {},
				text,
			})
			return relay(request)
		},
	})
	const server = createServer({ dispatcher, state: () => ({}), host: '127.0.0.1' })
	const port = await server.start()
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		stop() {
			return server.stop()
		},
	}
}

/** Defines the weather function shared by provider wire and live tool-call tests. */
export const WEATHER_TOOL: ToolDefinition = Object.freeze({
	name: 'get_weather',
	description: 'Get the current weather for a city.',
	parameters: {
		type: 'object',
		properties: { city: { type: 'string', description: 'The city name' } },
		required: ['city'],
	},
})

/** Represents one request captured by a recording proxy. */
export interface RecordedRequest {
	readonly method: string
	readonly path: string
	readonly headers: Readonly<Record<string, string>>
	readonly body: Record<string, unknown>
	/** Holds the original JSON text captured from the request. */
	readonly text: string
}

/** Represents a running recording server. */
export interface RecordingServerInterface {
	readonly url: string
	readonly requests: readonly RecordedRequest[]
	stop(): Promise<void>
}

/** Parses a JSON request body when it is a record. */
export function parseRequestBody(text: string): Record<string, unknown> | undefined {
	return parseJSONAs(text, isRecord)
}

/** Represents the minimal message shape recorded from the provider wire. */
export interface WireMessage {
	readonly role: string
	readonly content: string
	readonly images?: readonly string[]
}

/** Narrows an unknown value to a recorded wire message. */
export function isWireMessage(value: unknown): value is WireMessage {
	if (!isRecord(value) || !isString(value.role) || !isString(value.content)) return false
	return value.images === undefined || arrayOf(isString)(value.images)
}

/** Narrows a captured request's messages, returning an empty collection when malformed. */
export function wireMessages(request: RecordedRequest): readonly WireMessage[] {
	const { messages } = request.body
	return arrayOf(isWireMessage)(messages) ? messages : []
}

/** Joins every captured message's content. */
export function wireText(request: RecordedRequest): string {
	return wireMessages(request)
		.map((message) => message.content)
		.join('\n')
}

/** Represents the minimal function tool shape recorded from the provider wire. */
export interface WireTool {
	readonly function: {
		readonly name: string
	}
}

/** Narrows an unknown value to a recorded function tool. */
export function isWireTool(value: unknown): value is WireTool {
	return isRecord(value) && isRecord(value.function) && isString(value.function.name)
}

/** Returns the function names advertised on a captured provider request. */
export function wireTools(request: RecordedRequest): readonly string[] {
	const { tools } = request.body
	return arrayOf(isWireTool)(tools) ? tools.map((tool) => tool.function.name) : []
}

/** Returns the leading system message, when present. */
export function systemText(request: RecordedRequest): string {
	const [first] = wireMessages(request)
	return first !== undefined && first.role === 'system' ? first.content : ''
}

/** Clones forwarding headers while removing connection-specific values. */
export function forwardHeaders(headers: Headers): Headers {
	const forwarded = new Headers(headers)
	forwarded.delete('host')
	forwarded.delete('content-length')
	return forwarded
}

/** Narrows a fetch rejection to an abort error. */
export function isAbortError(error: unknown): error is Error {
	return error instanceof Error && error.name === 'AbortError'
}

/** Names the rejection message a refusing transport reports in place of a network failure. */
export const REFUSED_TRANSPORT_MESSAGE = 'fetch failed'

/** Represents a transport that refuses every request after recording the signal it rode. */
export interface RefusingTransportInterface {
	/** The abort signal each issued request carried, in call order. */
	readonly signals: readonly AbortSignal[]
	/** The transport to inject as a provider's `fetch` option. */
	readonly fetch: typeof globalThis.fetch
}

/**
 * Builds a transport that records each request's abort signal and then refuses it.
 *
 * A recorded signal is the caller-visible handle on the deadline a provider arms
 * around the request: an uncleared deadline aborts that signal when it expires, so a
 * recorded signal still unaborted after the deadline has passed reports that the
 * provider cleared it. The transport itself reaches no network, so the observation
 * never races a connection attempt.
 */
export function createRefusingTransport(): RefusingTransportInterface {
	const signals: AbortSignal[] = []
	return {
		get signals() {
			return signals
		},
		fetch(_input, init) {
			const signal = init?.signal
			if (signal !== null && signal !== undefined) signals.push(signal)
			return Promise.reject(new Error(REFUSED_TRANSPORT_MESSAGE))
		},
	}
}

/**
 * Builds a transport that answers `/api/chat` with a canned NDJSON stream.
 *
 * Each chunk is enqueued on the response body verbatim, so a caller controls where the
 * record boundaries fall: a chunk may hold several `\n`-terminated records, split one
 * record across two chunks, or end the stream on an unterminated line. The daemon is the
 * third party this stands in for; the bytes and the `Response` are real, so the
 * provider's decoder, line parser, splitter, and per-record fold all run for real.
 */
export function createStreamingTransport(chunks: readonly string[]): typeof globalThis.fetch {
	return () =>
		Promise.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						const encoder = new TextEncoder()
						for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
						controller.close()
					},
				}),
				{ headers: { 'Content-Type': 'application/x-ndjson' } },
			),
		)
}

/**
 * Starts a pass-through recording server.
 *
 * The default upstream is deliberately unreachable so request-shape tests remain
 * hermetic; live service tests pass the selected Ollama host explicitly.
 */
export async function createRecordingProxy(
	upstream = 'http://127.0.0.1:1',
): Promise<RecordingServerInterface> {
	const requests: RecordedRequest[] = []
	const upstreamAbort = new AbortController()
	const dispatcher = createDispatcher<Record<string, never>>()
	dispatcher.add({
		method: 'POST',
		path: '/api/chat',
		async handler(request) {
			const text = await request.text()
			requests.push({
				method: request.method,
				path: new URL(request.url).pathname,
				headers: flattenHeaders(request.headers),
				body: parseRequestBody(text) ?? {},
				text,
			})
			let upstreamResponse: Response
			try {
				upstreamResponse = await fetch(`${upstream}/api/chat`, {
					method: 'POST',
					headers: forwardHeaders(request.headers),
					body: text,
					signal: AbortSignal.any([request.signal, upstreamAbort.signal]),
				})
			} catch (error) {
				if (isAbortError(error)) return new Response(undefined, { status: 499 })
				throw error
			}
			return new Response(upstreamResponse.body, {
				status: upstreamResponse.status,
				headers: upstreamResponse.headers,
			})
		},
	})
	const server = createServer({ dispatcher, state: () => ({}), host: '127.0.0.1' })
	const port = await server.start()
	return {
		url: `http://127.0.0.1:${port}`,
		get requests() {
			return requests
		},
		stop() {
			upstreamAbort.abort()
			return server.stop()
		},
	}
}

/** Waits until a recording server has captured the requested number of calls. */
export async function waitForRequest(
	server: RecordingServerInterface,
	count = 1,
	timeoutMs = 10_000,
): Promise<void> {
	await waitForCondition(
		`the recording proxy to capture ${count} request(s)`,
		() => server.requests.length >= count,
		{ budget: timeoutMs },
	)
}

/** Drives a provider stream to completion and captures deltas plus its returned result. */
export async function drive(generator: AsyncGenerator<ProviderDelta, ProviderResult>): Promise<{
	readonly deltas: readonly string[]
	readonly thoughts: readonly string[]
	readonly result: ProviderResult
}> {
	const deltas: string[] = []
	const thoughts: string[] = []
	for (;;) {
		const step = await generator.next()
		if (step.done) return { deltas, thoughts, result: step.value }
		if (step.value.channel === 'content') deltas.push(step.value.text)
		else thoughts.push(step.value.text)
	}
}

/** Reads a non-empty environment variable, or returns its fallback. */
export function env(name: string, fallback: string): string {
	const value = process.env[name]
	return value !== undefined && value.length > 0 ? value : fallback
}

/**
 * Normalizes an Ollama-style host value to an absolute HTTP URL.
 *
 * @param value - The host value, with or without an HTTP scheme
 * @returns The absolute HTTP URL
 * @example
 * ```ts
 * withScheme('127.0.0.1:11434') // 'http://127.0.0.1:11434'
 * ```
 */
export function withScheme(value: string): string {
	return value.startsWith('http://') || value.startsWith('https://') ? value : `http://${value}`
}

/** Represents a driven tool-call chunk paired with its execution result. */
export interface DrivenTool {
	readonly call: ToolCall
	readonly result: ToolResult
}

/** Drains an agent stream and buckets every observable chunk. */
export async function driveAgent(stream: AgentStreamInterface): Promise<{
	readonly tokens: readonly string[]
	readonly thoughts: readonly string[]
	readonly tools: readonly DrivenTool[]
	readonly usages: readonly TokenUsage[]
	readonly result: AgentResult
}> {
	const tokens: string[] = []
	const thoughts: string[] = []
	const tools: DrivenTool[] = []
	const usages: TokenUsage[] = []
	for await (const chunk of stream.events) {
		if (chunk.category === 'token') tokens.push(chunk.content)
		else if (chunk.category === 'think') thoughts.push(chunk.content)
		else if (chunk.category === 'tool') tools.push({ call: chunk.call, result: chunk.result })
		else usages.push(chunk.usage)
	}
	const result = await stream.result
	return { tokens, thoughts, tools, usages, result }
}

/** Builds an in-process agent stream over deterministic chunks. */
export function createScriptedAgentStream(
	chunks: readonly AgentChunk[],
	result: AgentResult,
): AgentStreamInterface {
	return {
		events: (async function* () {
			for (const chunk of chunks) yield chunk
		})(),
		result: Promise.resolve(result),
		abort() {},
	}
}

/** Names the distinctive datum the lookup tool fixture returns. */
export const LOOKUP_DATUM = 'drizzle-42'

/** Builds the deterministic lookup tool shared by service and wire-shape tests. */
export function createLookupTool(
	recorder?: RecorderInterface<[Readonly<Record<string, unknown>>]>,
): ToolInterface {
	return createTool({
		name: 'lookup',
		description: 'Look up a fixed reference datum for a query string.',
		parameters: {
			type: 'object',
			properties: { query: { type: 'string' } },
			required: ['query'],
		},
		execute: (args) => {
			recorder?.handler(args)
			return LOOKUP_DATUM
		},
	})
}

/** Names the error message the failing tool fixture throws. */
export const THROWING_TOOL_MESSAGE = 'throwing-tool-always-fails'

/** Builds a tool that records its call and then fails. */
export function createThrowingTool(
	recorder?: RecorderInterface<[Readonly<Record<string, unknown>>]>,
): ToolInterface {
	return createTool({
		name: 'fail',
		description: 'A tool that always fails, for error-isolation round-trips.',
		parameters: { type: 'object', properties: {} },
		execute: (args) => {
			recorder?.handler(args)
			throw new Error(THROWING_TOOL_MESSAGE)
		},
	})
}

/** Names how many chunks the sustained-pressure tool fixture exposes. */
export const INSATIABLE_TOOL_CHUNKS = 12

/** Builds the progress text a sustained-pressure tool call returns. */
export function insatiableResult(n: number): string {
	return `Chunk ${n} of ${INSATIABLE_TOOL_CHUNKS} received. The data is incomplete. You MUST call the more tool again now to get chunk ${n + 1}.`
}

/** Builds a stateful tool that keeps requesting another tool turn. */
export function createInsatiableTool(
	recorder?: RecorderInterface<[Readonly<Record<string, unknown>>]>,
): ToolInterface {
	let n = 0
	return createTool({
		name: 'more',
		description:
			'Returns the next chunk of the requested data, reporting which chunk this is out of 12. Call again after every result until all chunks arrive.',
		parameters: {
			type: 'object',
			properties: { cursor: { type: 'string' } },
		},
		execute: (args) => {
			recorder?.handler(args)
			n += 1
			return insatiableResult(n)
		},
	})
}
