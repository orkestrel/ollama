import type { ProviderDelta, ProviderResult, ToolDefinition, ToolInterface } from '@orkestrel/agent'
import type { TestRecorderInterface } from './setup.js'
import { createTool } from '@orkestrel/agent'
import { arrayOf, isRecord, isString } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'

/** Weather function definition shared by provider wire and live tool-call tests. */
export const WEATHER_TOOL: ToolDefinition = Object.freeze({
	name: 'get_weather',
	description: 'Get the current weather for a city.',
	parameters: {
		type: 'object',
		properties: { city: { type: 'string', description: 'The city name' } },
		required: ['city'],
	},
})

/** Flatten fetch headers into a lowercase readonly record. */
export function flattenHeaders(headers: Headers): Readonly<Record<string, string>> {
	const result: Record<string, string> = {}
	headers.forEach((value, key) => {
		result[key.toLowerCase()] = value
	})
	return result
}

/** One request captured by a recording proxy. */
export interface RecordedRequest {
	readonly method: string
	readonly path: string
	readonly headers: Readonly<Record<string, string>>
	readonly body: Record<string, unknown>
}

/** A running recording proxy. */
export interface RecordingProxyInterface {
	readonly url: string
	readonly requests: readonly RecordedRequest[]
	stop(): Promise<void>
}

/** Parse a JSON request body when it is a record. */
export function parseRequestBody(text: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(text)
		return isRecord(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

/** Minimal message shape recorded from the provider wire. */
export interface WireMessage {
	readonly role: string
	readonly content: string
}

/** Narrow an unknown value to a recorded wire message. */
export function isWireMessage(value: unknown): value is WireMessage {
	return isRecord(value) && isString(value.role) && isString(value.content)
}

/** Narrow a captured request's messages, returning an empty collection when malformed. */
export function wireMessages(request: RecordedRequest): readonly WireMessage[] {
	const { messages } = request.body
	return arrayOf(isWireMessage)(messages) ? messages : []
}

/** Join every captured message's content. */
export function wireText(request: RecordedRequest): string {
	return wireMessages(request)
		.map((message) => message.content)
		.join('\n')
}

/** Return the leading system message, when present. */
export function systemText(request: RecordedRequest): string {
	const [first] = wireMessages(request)
	return first !== undefined && first.role === 'system' ? first.content : ''
}

/** Clone forwarding headers while removing connection-specific values. */
export function forwardHeaders(headers: Headers): Headers {
	const forwarded = new Headers(headers)
	forwarded.delete('host')
	forwarded.delete('content-length')
	return forwarded
}

/** Narrow a fetch rejection to an abort error. */
export function isAbortError(error: unknown): error is Error {
	return error instanceof Error && error.name === 'AbortError'
}

/**
 * Start a pass-through recording server.
 *
 * The default upstream is deliberately unreachable so request-shape tests remain
 * hermetic; live service tests pass the selected Ollama host explicitly.
 */
export async function createRecordingProxy(
	upstream = 'http://127.0.0.1:1',
): Promise<RecordingProxyInterface> {
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

/** Wait until a recording proxy has captured the requested number of calls. */
export async function waitForRequest(
	proxy: RecordingProxyInterface,
	count = 1,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (proxy.requests.length < count) {
		if (Date.now() >= deadline) {
			throw new Error(
				`waitForRequest: expected ${count} recorded request(s), got ${proxy.requests.length} after ${timeoutMs}ms`,
			)
		}
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

/** Drive a provider stream to completion and capture deltas plus its returned result. */
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
		if (step.value.type === 'content') deltas.push(step.value.text)
		else thoughts.push(step.value.text)
	}
}

/** Distinctive datum returned by the lookup tool fixture. */
export const LOOKUP_DATUM = 'drizzle-42'

/** Build the deterministic lookup tool shared by service and wire-shape tests. */
export function createLookupTool(
	recorder?: TestRecorderInterface<[Readonly<Record<string, unknown>>]>,
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

/** Error message thrown by the failing tool fixture. */
export const THROWING_TOOL_MESSAGE = 'throwing-tool-always-fails'

/** Build a tool that records its call and then fails. */
export function createThrowingTool(
	recorder?: TestRecorderInterface<[Readonly<Record<string, unknown>>]>,
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

/** Number of chunks exposed by the sustained-pressure tool fixture. */
export const INSATIABLE_TOOL_CHUNKS = 12

/** Build the progress text returned by a sustained-pressure tool call. */
export function insatiableResult(n: number): string {
	return `Chunk ${n} of ${INSATIABLE_TOOL_CHUNKS} received. The data is incomplete. You MUST call the more tool again now to get chunk ${n + 1}.`
}

/** Build a stateful tool that keeps requesting another tool turn. */
export function createInsatiableTool(
	recorder?: TestRecorderInterface<[Readonly<Record<string, unknown>>]>,
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
