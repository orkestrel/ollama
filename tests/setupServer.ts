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
import type { RouteInput } from '@orkestrel/router'
import type {
	BrowserConsoleMessage,
	BrowserPageError,
	BrowserPageInterface,
	BrowserRequest,
} from '@orkestrel/browser'
import { createBrowser } from '@orkestrel/browser/server'
import {
	createTeardown,
	flattenHeaders,
	resolveRoot,
	waitForAbort,
	waitForCondition,
} from '@orkestrel/test'
import { resolveContained } from '@orkestrel/test/server'
import {
	arrayOf,
	isBoolean,
	isError,
	isNumber,
	isRecord,
	isString,
	parseJSONAs,
} from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createTool, isToolCall } from '@orkestrel/tool'
import { createRelay } from '@orkestrel/agent'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { PAGE_TOOL } from './setup.js'

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
			requests.push({ ...(await readRequest(request)), signal: request.signal })
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
 * Builds the authenticated relay route the relay server and the page fixture both mount.
 *
 * @param provider - The real server-side provider the relay drives
 * @param requests - The sink each inbound request's recorded fields are appended to
 * @returns The `POST /inference` route registration
 * @remarks Declared here so the relay server and the page fixture mount one route rather than
 * near-duplicate copies of it, and the page proof asserts on the same recorded shape the Node
 * relay proofs do.
 */
export function buildRelayRoute(
	provider: ProviderInterface,
	requests: RecordedRequest[],
): RouteInput<'/inference', Record<string, never>> {
	const relay = createRelay({
		provider,
		authorize: (request) => request.headers.get('authorization') === OBFUSCATED,
	})
	return {
		method: 'POST',
		path: '/inference',
		async handler(request) {
			requests.push(await readRequest(request))
			return relay(request)
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
	const dispatcher = createDispatcher<Record<string, never>>()
	dispatcher.add(buildRelayRoute(provider, requests))
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

/**
 * Reads one request's recorded fields without consuming the request itself.
 *
 * @param request - The request to record
 * @returns The method, path, headers, parsed body, and original body text
 * @remarks The body is read from a clone, so the caller can still hand the original request
 * to a relay, a proxy, or a transport afterwards. A body that is not a JSON record records as
 * an empty `body` with its `text` intact, which is what a `GET` route records.
 */
export async function readRequest(request: Request): Promise<RecordedRequest> {
	const text = await request.clone().text()
	return {
		method: request.method,
		path: new URL(request.url).pathname,
		headers: flattenHeaders(request.headers),
		body: parseRequestBody(text) ?? {},
		text,
	}
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
export function isFetchAbort(error: unknown): error is Error {
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
			const record = await readRequest(request)
			requests.push(record)
			const { text } = record
			let upstreamResponse: Response
			try {
				upstreamResponse = await fetch(`${upstream}/api/chat`, {
					method: 'POST',
					headers: forwardHeaders(request.headers),
					body: text,
					signal: AbortSignal.any([request.signal, upstreamAbort.signal]),
				})
			} catch (error) {
				if (isFetchAbort(error)) return new Response(undefined, { status: 499 })
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

// ── Live page fixture ─────────────────────────────────────────────────────────
//
// The Node half of the live page proof: the workspace anchor its loaders read from,
// the import map derived from the installed `@orkestrel` tree, the served document
// carrying the in-page driver, the fixture that serves all three beside the relay
// route, and the browser session that drives them. The live half — that a real
// Chromium loads the served closure and runs an agent in it — is proven by the
// `service` project, which is the only project this workspace gives a browser.

/** Names the workspace root every Node-side loader in this module anchors against. */
export const WORKSPACE_ROOT = resolveRoot(import.meta)

/** Names the fixture path prefix the served `@orkestrel` module tree answers under. */
export const MODULES_PATH = '/modules'

/** Names the fixture path prefix this workspace's own built output answers under. */
export const DIST_PATH = '/dist'

/** Names the fixture route a page requests to prove its request log reports a request. */
export const CONTROL_PATH = '/control'

/**
 * Names every deadline the live page proof takes, in milliseconds, and the launches it allows.
 *
 * @remarks An attempt ends within `attempt + release`, and {@link boundPageAttempt} is what
 * enforces it. `attempt` is the allowance the acquisition and the observation are raced
 * against. `release` is the share the release after that race is raced against, so a browser
 * this process can no longer reach is reported as stranded rather than awaited.
 *
 * No sum over the inner values bounds an attempt, and none is offered. The installed
 * `@orkestrel/browser` surface takes a signal on part of the connection — `BrowserOptions.signal`
 * races discovery, the port-free check, the launch, and `client.connect()`, which is why
 * {@link createPageSession} hands the attempt's signal to `createBrowser` — while the target
 * listing that connection ends with, and every page command after it, takes a per-call `timeout`
 * and no signal. One of those calls issues several separately bounded CDP commands:
 * `browser.create()` alone awaits `Target.createTarget`, `Target.attachToTarget`, `Page.enable`,
 * `Runtime.enable`, `Page.getFrameTree`, `Target.setAutoAttach`,
 * `Page.setInterceptFileChooserDialog`, `Browser.setDownloadBehavior`, and `Network.enable`. A
 * table that counted that call as one `command` would state an arithmetic the dependency does
 * not run, so `command`, `ready`, `read`, and `evaluate` are shares spent inside the allowance
 * rather than terms of it.
 *
 * `case` contains `attempt + release`, and `budget` contains `launches × (attempt + release)`,
 * so `retryUntil` ends on its attempt count rather than expiring mid-attempt and reporting a
 * bound as a product defect. Inside one observation the innermost bound still fires first: `run`
 * is the in-page deadline, shorter than the `evaluate` around it. `tests/setupServer.test.ts`
 * asserts that membership and every containment.
 */
export const PAGE_BOUNDS = Object.freeze({
	/** The deadline one browser CDP command allows, and the client-wide default a launch takes. */
	command: 10_000,
	/** The deadline the wait for the page driver's parked operations allows. */
	ready: 5_000,
	/** The deadline one instant page read allows. */
	read: 5_000,
	/** The deadline one in-page agent run or direct generation allows. */
	run: 30_000,
	/** The deadline the evaluate carrying an in-page run allows. */
	evaluate: 35_000,
	/** The acquisition-and-observation allowance one attempt is raced against. */
	attempt: 85_000,
	/** The share the release following that allowance is raced against. */
	release: 10_000,
	/** The deadline a single-attempt case allows. */
	case: 110_000,
	/** How many browser launches the bounded model-selection retry spends, one per attempt. */
	launches: 3,
	/** The elapsed-time budget the bounded model-selection retry takes. */
	budget: 290_000,
	/** The deadline the bounded-retry case allows. */
	retry: 300_000,
})

/**
 * Names every interval the live page proof's attempt-bound controls spend, in milliseconds.
 *
 * @remarks None of these is a bound the proof takes. Each is an input chosen to expire at a
 * named point of a real attempt, so a control drives one interleaving of {@link boundPageAttempt}
 * against a real browser rather than describing it. `launch` is shorter than any browser
 * acquisition, so the deadline fires while the session is still being taken. `observe` is several
 * times the acquisition a host measures — the closure case in `tests/service/page.test.ts`
 * completes its whole lifecycle in well under a second — so the session is acquired and the
 * deadline fires during the observation instead. `late` sits between `launch` and `observe`: every
 * acquisition a host measures fits it, and the `hold` each control adds to one step outlasts it,
 * so the deadline fires while a real browser is still on its way back or still being released.
 *
 * The containments those readings depend on are what `tests/setupServer.test.ts` asserts:
 * `launch` under `late` under `observe`, `hold` past `late` so the deadline is crossed, and
 * `hold` inside `PAGE_BOUNDS.release` so the step it delays still finishes inside the release
 * share and reports the crossing rather than a stranded browser. A host slow enough to break
 * those margins fails a control on its own assertion rather than passing it vacuously.
 */
export const PAGE_INTERVALS = Object.freeze({
	/** The allowance no browser acquisition fits, spent while the session is still being taken. */
	launch: 50,
	/** The allowance every acquisition fits and no parked observation does. */
	observe: 5_000,
	/** The allowance an acquisition fits and the `hold` added to one of its steps outlasts. */
	late: 2_000,
	/** The delay a control adds to one step, to keep it in flight past `late`. */
	hold: 3_000,
})

/**
 * Derives the page's import map from the `@orkestrel` packages installed under a root.
 *
 * @param root - The workspace root holding `node_modules/@orkestrel`
 * @returns Each installed package's bare specifier mapped to its declared ESM root entry,
 * served under {@link MODULES_PATH}
 * @remarks The map is derived rather than written down so it cannot drift from what is
 * installed: a written map omits a closure member silently, and the browser then fails to
 * resolve that member mid-run. A package whose manifest declares no
 * `exports['.'].import.default` entry is left out, because it publishes no ESM root entry to
 * serve. An entry the page never imports costs nothing, because an import map resolves
 * specifiers rather than loading them.
 */
export function buildImportMap(root: URL | string): Readonly<Record<string, string>> {
	const path = rootToPath(root)
	const base = join(path, 'node_modules', '@orkestrel')
	const imports: Record<string, string> = {}
	for (const name of readdirSync(base)) {
		const entry = readModuleEntry(
			parseRequestBody(readFileSync(join(base, name, 'package.json'), 'utf8')),
		)
		if (entry === undefined) continue
		imports[`@orkestrel/${name}`] = `${MODULES_PATH}/${name}/${entry}`
	}
	const manifest = parseRequestBody(readFileSync(join(path, 'package.json'), 'utf8'))
	const own = readModuleEntry(manifest)
	if (manifest !== undefined && isString(manifest.name) && own !== undefined) {
		imports[manifest.name] = `${DIST_PATH}/${own.replace(/^dist\//, '')}`
	}
	return Object.freeze(imports)
}

/**
 * Reads one package manifest's declared ESM root entry, relative to the package directory.
 *
 * @param manifest - The parsed `package.json` record, or `undefined` when it failed to parse
 * @returns The entry path without its leading `./`, or `undefined` when the manifest declares
 * no `exports['.'].import.default` entry
 */
export function readModuleEntry(manifest: unknown): string | undefined {
	if (!isRecord(manifest)) return undefined
	const { exports } = manifest
	if (!isRecord(exports)) return undefined
	const entry = exports['.']
	if (!isRecord(entry)) return undefined
	const esm = entry.import
	if (!isRecord(esm)) return undefined
	const file = esm.default
	return isString(file) ? file.replace(/^\.\//, '') : undefined
}

/**
 * Projects a workspace anchor given as a `file:` URL or an absolute path onto its host path.
 *
 * @param root - The anchor to project
 * @returns The host path the anchor names
 * @throws Rethrown from `fileURLToPath` when the URL carries no `file:` scheme.
 */
export function rootToPath(root: URL | string): string {
	return typeof root === 'string' ? root : fileURLToPath(root)
}

/**
 * Holds the page body and the in-page driver the live page proof serves.
 *
 * @remarks
 * The driver is a module script, so it imports the published entries the import map
 * resolves and parks its operations on `globalThis` for `page.evaluate` to call by
 * expression. Every decision and every assertion stays in the test file; this side
 * constructs, runs, and reports. {@link PAGE_TOOL} is serialized into the script, so the
 * definition the model is advertised and the definition the test asserts against are one
 * declaration across the string boundary.
 *
 * `run` mints its receipt inside the tool handler and writes it into a real element, so a
 * receipt that reaches the wire can only have come from the page executing the tool, and it
 * records the turn index each call was dispatched in so the test can pin the tool result to
 * the request that follows it. `control` issues one uncached request every recorder must
 * report. `fault` is the same certification for the other two channels: it writes one console
 * error and throws one uncaught error, so a test can read both recorders reporting a fault the
 * page deliberately produced. `direct` drives the daemon from the page with no relay and no
 * agent, on the prompt its caller supplies.
 */
export const PAGE_DOCUMENT = `<ul id="receipts"></ul>
<script type="module">
	import { createAgent, createRelayProvider } from '@orkestrel/agent'
	import { createNDJSONParser } from '@orkestrel/ndjson'
	import { createOllama } from '@orkestrel/ollama'
	import { createTool, createToolManager } from '@orkestrel/tool'

	const definition = ${JSON.stringify(PAGE_TOOL)}
	const list = document.getElementById('receipts')

	globalThis.page = {
		async run(options) {
			list.replaceChildren()
			const turns = []
			const tools = []
			const manager = createToolManager()
			manager.add(
				createTool({
					...definition,
					execute: (args) => {
						const receipt = 'receipt-' + crypto.randomUUID()
						const item = document.createElement('li')
						item.dataset.note = String(args.note ?? '')
						item.textContent = receipt
						list.append(item)
						return receipt
					},
				}),
			)
			const agent = createAgent(
				createRelayProvider({
					url: options.url,
					parser: createNDJSONParser,
					headers: () => ({ authorization: options.authorization }),
				}),
				{
					system: options.system,
					tools: manager,
					timeout: options.timeout,
					limit: options.limit,
					on: {
						turn: (index) => void turns.push(index),
						tool: (call, result) => void tools.push({ turn: turns.at(-1), call, result }),
					},
				},
			)
			agent.context.messages.add({ role: 'user', content: options.prompt })
			try {
				return JSON.stringify({ turns, tools, result: await agent.generate() })
			} catch (failure) {
				return JSON.stringify({
					turns,
					tools,
					failure: String(failure),
					code: failure?.code,
					status: failure?.status,
				})
			}
		},
		async control() {
			const response = await fetch('${CONTROL_PATH}', { cache: 'no-store' })
			return JSON.stringify({ status: response.status, text: await response.text() })
		},
		fault(message) {
			console.error(message)
			setTimeout(() => {
				throw new Error(message)
			}, 0)
			return JSON.stringify(message)
		},
		async direct(options) {
			const provider = createOllama({
				model: options.model,
				url: options.url,
				options: options.options,
			})
			const result = await provider.generate(
				[{ id: 'direct', role: 'user', content: options.prompt }],
				AbortSignal.timeout(options.timeout),
			)
			return JSON.stringify({ name: provider.name, content: result.content })
		},
		receipts() {
			return JSON.stringify(
				[...list.querySelectorAll('li')].map((item) => ({
					note: item.dataset.note ?? '',
					receipt: item.textContent ?? '',
				})),
			)
		},
		resources() {
			return JSON.stringify(performance.getEntriesByType('resource').map((entry) => entry.name))
		},
	}
	globalThis.ready = true
</script>`

/**
 * Reads one text file below a served root, answering `404` for a miss or a containment escape.
 *
 * @param root - The absolute directory the request is contained to
 * @param target - The requested path below that directory
 * @returns The file's text, or a `404` response
 * @remarks Every file this fixture serves is a UTF-8 JavaScript module, so it reads text
 * rather than bytes. A request that escapes the root answers `404` rather than throwing,
 * which is what a served root does with a path outside itself.
 */
export function serveFile(root: string, target: string): Response {
	const path = resolveContained(root, target)
	if (path === undefined) return new Response('outside the served root', { status: 404 })
	let text: string
	try {
		text = readFileSync(path, 'utf8')
	} catch {
		return new Response('no such file', { status: 404 })
	}
	const type = path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8'
	return new Response(text, { headers: { 'content-type': type } })
}

/** Represents the tuning {@link createPageFixture} accepts. */
export interface PageFixtureOptions {
	/** The page body and in-page driver served at `/`, normally {@link PAGE_DOCUMENT}. */
	readonly document: string
	/** The server-side provider the authenticated relay route drives; omitted ⇒ no relay route. */
	readonly provider?: ProviderInterface
}

/**
 * Starts the live page proof's fixture on an ephemeral loopback port.
 *
 * @param options - The document to serve and the optional relay provider
 * @returns The ephemeral loopback server, every request it served, and its shutdown operation
 * @remarks The fixture serves the page, the installed `@orkestrel` module tree, this
 * workspace's own built output, the control route, and — when a provider is supplied — the
 * same authenticated relay route {@link createRelayServer} mounts, all from one origin.
 * Serving the page from the relay's own origin keeps CORS out of the relay proof, which is
 * the arrangement the guide instructs a reader to use. Every served request is recorded, so
 * the fixture's own reading of what the page asked for sits beside the browser's.
 */
export async function createPageFixture(
	options: PageFixtureOptions,
): Promise<RecordingServerInterface> {
	const requests: RecordedRequest[] = []
	const imports = buildImportMap(WORKSPACE_ROOT)
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<title>Ollama page proof</title>
<script type="importmap">${JSON.stringify({ imports })}</script>
</head>
<body>
${options.document}
</body>
</html>
`
	const modules = join(rootToPath(WORKSPACE_ROOT), 'node_modules', '@orkestrel')
	const built = join(rootToPath(WORKSPACE_ROOT), 'dist')
	const dispatcher = createDispatcher<Record<string, never>>()
	dispatcher.add({
		method: 'GET',
		path: '/',
		async handler(request) {
			requests.push(await readRequest(request))
			return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
		},
	})
	dispatcher.add({
		method: 'GET',
		path: `${MODULES_PATH}/*rest`,
		async handler(request, context) {
			requests.push(await readRequest(request))
			return serveFile(modules, context.params.rest)
		},
	})
	dispatcher.add({
		method: 'GET',
		path: `${DIST_PATH}/*rest`,
		async handler(request, context) {
			requests.push(await readRequest(request))
			return serveFile(built, context.params.rest)
		},
	})
	dispatcher.add({
		method: 'GET',
		path: CONTROL_PATH,
		async handler(request) {
			requests.push(await readRequest(request))
			return new Response('control', {
				headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
			})
		},
	})
	if (options.provider !== undefined) dispatcher.add(buildRelayRoute(options.provider, requests))
	const server = createServer({ dispatcher, state: () => ({}), host: '127.0.0.1' })
	const port = await server.start()
	return {
		url: `http://127.0.0.1:${port}`,
		get requests() {
			return requests
		},
		stop() {
			return server.stop()
		},
	}
}

/**
 * Reserves an ephemeral loopback TCP port by binding it and releasing it again.
 *
 * @returns The port number the host assigned
 * @remarks A launched browser binds the CDP port itself and is handed the number, so the
 * number is chosen before the process starts and the host cannot assign it. The window
 * between this release and that bind is a race another process on the host can win, and
 * `cdp.discover: false` is what keeps the loss loud: a browser that finds the port occupied
 * fails its launch rather than attaching to the occupant.
 */
export async function reservePort(): Promise<number> {
	const probe = createNetServer()
	const port = await new Promise<number>((resolve, reject) => {
		probe.on('error', reject)
		probe.listen(0, '127.0.0.1', () => {
			const address: AddressInfo | string | null = probe.address()
			if (typeof address !== 'object' || address === null) {
				reject(new Error('the port probe bound no TCP address'))
				return
			}
			resolve(address.port)
		})
	})
	await new Promise<void>((resolve) => probe.close(() => resolve()))
	return port
}

/** Represents the tuning {@link createPageSession} accepts. */
export interface PageSessionOptions {
	/** The absolute browser executable path, normally from `requirePageBrowser`. */
	readonly executable: string
	/** The launch flags the browser takes, normally `PAGE_BROWSER_ARGS`. */
	readonly args: readonly string[]
	/** The server-side provider the fixture's relay route drives; omitted ⇒ no relay route. */
	readonly provider?: ProviderInterface
	/** The attempt deadline the acquisition observes, normally `boundPageAttempt`'s own. */
	readonly signal?: AbortSignal
}

/** Represents the two shares one bounded page attempt spends, in milliseconds. */
export interface PageAttemptBounds {
	/** The allowance the acquisition and the observation are raced against. */
	readonly attempt: number
	/** The share the release following that allowance is raced against. */
	readonly release: number
}

/** Represents one live page session — its fixture, its owned browser, and its navigated page. */
export interface PageSessionInterface {
	/** The fixture serving the page, the modules, the control route, and the relay. */
	readonly fixture: RecordingServerInterface
	/** The navigated page, with its network domain started and its observers armed. */
	readonly page: BrowserPageInterface
	/** Every request the page issued, in observed order. */
	readonly requests: readonly BrowserRequest[]
	/** Every uncaught page error, in observed order. */
	readonly errors: readonly BrowserPageError[]
	/** Every console message the page emitted, in observed order. */
	readonly messages: readonly BrowserConsoleMessage[]
	/** Releases the browser and then the fixture. */
	destroy(): Promise<void>
}

/**
 * Launches an isolated browser, starts the page fixture, and navigates a page at it.
 *
 * @param options - The resolved executable, its launch flags, and the optional relay provider
 * @returns The started fixture, the navigated page, its observations, and their teardown
 * @throws Rethrown from the launch or the navigation, after releasing whatever was acquired
 * @remarks The browser is launched rather than attached, on a port reserved moments earlier
 * with `cdp.discover` off, so a browser already listening on the default port is never
 * adopted. The profile is the library's own temporary one, which it removes when the browser
 * is destroyed. Observers are armed at page creation and the network domain is started
 * before navigation, so no request the page makes escapes the log.
 *
 * Cleanup is registered as each resource is acquired rather than assembled at the end, so a
 * rejection between two acquisitions still releases what was already taken: the fixture's
 * listener is registered the moment it is listening, before the port reservation that follows
 * it, and the browser's release the moment it is constructed, before the connection it then
 * makes. `createTeardown` runs every registered handler newest-first and rethrows what failed,
 * so a browser that rejects its own release cannot leave the fixture's port bound. The
 * installed `@orkestrel/browser` declaration states `destroy()` releases local resources and is
 * idempotent, so registering it before `connect()` is safe: a browser that never connected
 * holds nothing to release and its `destroy()` resolves.
 *
 * Each CDP step here spends a named share of {@link PAGE_BOUNDS}: the connection, the page
 * creation, the network start, and the navigation take `command` as the deadline each CDP request
 * they issue allows, and the readiness wait takes `ready` with `read` on its own probe. The
 * fixture start and the port reservation take no share of their own and observe no signal, and
 * the race {@link boundPageAttempt} runs is their only bound. Every share here bounds one request
 * rather than the acquisition, which is what `options.signal` is for.
 *
 * The signal reaches the launch, the readiness wait, and the entry. `createBrowser` takes it as
 * the `BrowserOptions.signal` the installed declaration documents as "external AbortSignal for
 * cancelling the connection attempt", and the installed implementation races it at discovery, at
 * the port-free check, before the launch, and at each `client.connect()` — so an expiry in any of
 * those ends the connection at the dependency, and an already-aborted signal makes `connect()`
 * reject with `Connection aborted` and launches no process. The target listing that connection
 * ends with is not raced against it: `#syncContexts` sends `Target.getTargets` under the client's
 * per-request `timeout` alone, so a connection held there can still resolve after the signal
 * aborted, and the attempt race is what bounds it. The readiness wait observes the signal, so a
 * page that never parks ends at the attempt's deadline rather than at its own budget. An
 * acquisition that starts after the signal aborted throws its reason before taking anything.
 * Every page command after the connection takes a per-call `timeout` and no signal, so
 * {@link boundPageAttempt} races those too.
 */
export async function createPageSession(
	options: PageSessionOptions,
): Promise<PageSessionInterface> {
	options.signal?.throwIfAborted()
	const requests: BrowserRequest[] = []
	const errors: BrowserPageError[] = []
	const messages: BrowserConsoleMessage[] = []
	const teardown = createTeardown()
	const fixture = await createPageFixture({
		document: PAGE_DOCUMENT,
		...(options.provider === undefined ? {} : { provider: options.provider }),
	})
	teardown.add(() => fixture.stop())
	try {
		const port = await reservePort()
		const browser = createBrowser({
			executable: options.executable,
			headless: true,
			args: options.args,
			cdp: { port, discover: false },
			timeout: PAGE_BOUNDS.command,
			...(options.signal === undefined ? {} : { signal: options.signal }),
		})
		teardown.add(() => browser.destroy())
		await browser.connect()
		const page = await browser.create({
			on: {
				request: (request) => void requests.push(request),
				error: (error) => void errors.push(error),
				console: (message) => void messages.push(message),
			},
		})
		await page.network.start()
		await page.navigate(fixture.url, { timeout: PAGE_BOUNDS.command })
		try {
			await waitForCondition(
				'the page driver to park its operations',
				async () => (await page.evaluate('globalThis.ready === true', PAGE_BOUNDS.read)) === true,
				{
					budget: PAGE_BOUNDS.ready,
					...(options.signal === undefined ? {} : { signal: options.signal }),
				},
			)
		} catch (failure) {
			throw new Error(
				`the page driver never parked its operations; page errors ${JSON.stringify(errors.map((one) => one.message))}, console ${JSON.stringify(messages.map((one) => `${one.level}: ${one.text}`))}`,
				{ cause: failure },
			)
		}
		return {
			fixture,
			page,
			requests,
			errors,
			messages,
			destroy() {
				return teardown.destroy()
			},
		}
	} catch (failure) {
		// The acquisition failure is the one worth reporting, so a release that also fails
		// cannot replace it; every registered handler still runs.
		await Promise.allSettled([teardown.destroy()])
		throw failure
	}
}

/**
 * Waits for one page attempt's deadline and rejects with the attempt's own expiry error.
 *
 * @param signal - The attempt's deadline signal, armed for `allowance` milliseconds
 * @param allowance - The allowance that signal was armed for, named in the error
 * @returns Never; this promise only rejects
 * @throws An `Error` naming the allowance the attempt exceeded, carrying the signal's abort
 * reason as its cause.
 * @remarks This is the losing side of the race {@link boundPageAttempt} runs, and the
 * translation is its whole job. The installed `@orkestrel/browser` surface takes a signal on part
 * of the connection and nowhere else; the target listing that connection ends with, and every
 * page command after it, accepts a per-call `timeout` number and no signal, so an over-long
 * observation reports as whichever inner CDP call happened to time out first — a reading that
 * names a browser command rather than the bound it broke. Racing this promise against the attempt
 * makes the caller read the allowance instead, carrying the signal's abort reason as the cause;
 * an inner CDP failure reaches the caller unchanged only when that command's own `timeout`
 * fires before the allowance does.
 *
 * While the allowance holds, this promise stays pending, so the work wins the race on its own
 * result. `waitForAbort` parks on a one-shot abort listener without a timer or a poll, and an
 * already-aborted signal resolves it immediately.
 */
export async function expirePageAttempt(signal: AbortSignal, allowance: number): Promise<never> {
	await waitForAbort(signal)
	throw new Error(`the page attempt exceeded its ${allowance} ms allowance`, {
		cause: signal.reason,
	})
}

/**
 * Describes one thrown value as the message that names it.
 *
 * @param failure - The thrown value, which is an `Error` on every path this module produces
 * @returns The `Error` message, or the value's own string form when it is not an `Error`
 * @remarks {@link boundPageAttempt} composes two failures into one message when an attempt both
 * failed and stranded its browser, and a thrown value is `unknown` at that boundary.
 */
export function describeFailure(failure: unknown): string {
	return isError(failure) ? failure.message : String(failure)
}

/**
 * Releases what one page attempt acquired, inside its own share and never past it.
 *
 * @param acquisition - The acquisition promise, settled or still in flight
 * @param share - The share the settlement and the release together are allowed, in milliseconds,
 * normally `PAGE_BOUNDS.release`
 * @returns A promise that resolves when the release has run
 * @throws The release's own failure, or an `Error` naming the stranded browser when the share ran
 * out before the acquisition settled and released.
 * @remarks An acquisition the attempt's deadline outran owns a browser no other reference can
 * reach, so it is settled and released here rather than abandoned. It is not awaited without a
 * bound, though: a page command in flight takes no signal, so an acquisition can outlast any
 * deadline the caller holds, and awaiting it turns an expired attempt into a hang. The share is
 * what separates the two readings — inside it the browser is released, past it the browser is
 * named as stranded and the caller is handed back its own failure.
 *
 * An acquisition that rejected released whatever it had taken on its own way out, so there is
 * nothing left here to release and its failure is the caller's to report.
 */
export async function releasePageAttempt(
	acquisition: Promise<Pick<PageSessionInterface, 'destroy'>>,
	share: number,
): Promise<void> {
	const released = await Promise.race([
		acquisition
			.then(
				(session) => session.destroy(),
				() => undefined,
			)
			.then(() => true),
		waitForAbort(AbortSignal.timeout(share)).then(() => false),
	])
	if (released) return
	throw new Error(
		`the page attempt's release outlasted its ${share} ms share, stranding the browser`,
	)
}

/**
 * Runs one page attempt — its acquisition, its observation, and its release — under its bounds.
 *
 * @param bounds - The `attempt` allowance and the `release` share the attempt spends, normally
 * {@link PAGE_BOUNDS}
 * @param acquire - The acquisition to take, given the attempt's signal
 * @param observe - The observation to take on the acquired session, given the attempt's signal
 * @returns What the observation returned
 * @throws The observation's own failure, the acquisition's, the release's, an `Error` naming the
 * exceeded allowance when the deadline won, or an `Error` naming the stranded browser when the
 * release outlasted its share.
 * @remarks An attempt ends within `attempt + release`, whatever it is waiting on. `attempt` is
 * the allowance the acquisition and the observation are raced against; `release` is the share the
 * release after that race is raced against. Neither is a sum of the inner per-call shares,
 * because no such sum bounds a call the dependency makes: `browser.create()` alone awaits a run
 * of separately bounded CDP commands, so a table of per-call values states an arithmetic that
 * never runs.
 *
 * The signal reaches the acquisition and the observation, and cancels part of what they do. The
 * installed `BrowserOptions.signal` races discovery, the port-free check, the launch, and
 * `client.connect()`, so an expiry in any of those ends the acquisition at the dependency rather
 * than abandoning it. It reaches nothing after that: the target listing the connection ends with
 * takes the client's per-request `timeout`, every page command takes a per-call `timeout` and no
 * signal, and a `page.evaluate` in flight cannot be cancelled at all. So the race is what releases
 * the caller on every phase the signal does not cover, and the release is what stops the browser
 * outliving it.
 *
 * Nothing is awaited without a bound after the allowance expires. The acquisition that lost the
 * race and the `session.destroy()` release both run inside the `release` share, and an attempt
 * that outlasts it rejects naming the browser it stranded instead of waiting: a stranded browser
 * is a residue reading the host can take, and a hang is not.
 *
 * The signal is read again after the observation and after the release, because a race can be
 * won in the same dispatch the deadline fires in, and because the release is inside the attempt's
 * own total. An attempt whose release crossed the allowance is a failure naming the release, not
 * a success.
 *
 * Neither deadline signal is cleared, and neither needs to be. `AbortSignal.timeout` arms an
 * unref'd timer, so an attempt that returned inside its allowance leaves a signal that holds
 * neither the Vitest worker nor the process open — measured on Node 24, where a process left with
 * a 60 000 ms signal armed and nothing else pending exited at once. An armed deadline is
 * collected with the signal it belongs to.
 */
export async function boundPageAttempt<
	TSession extends Pick<PageSessionInterface, 'destroy'>,
	TResult,
>(
	bounds: PageAttemptBounds,
	acquire: (signal: AbortSignal) => Promise<TSession>,
	observe: (session: TSession, signal: AbortSignal) => Promise<TResult>,
): Promise<TResult> {
	const signal = AbortSignal.timeout(bounds.attempt)
	const acquisition = acquire(signal)
	let observed: TResult
	try {
		const session = await Promise.race([acquisition, expirePageAttempt(signal, bounds.attempt)])
		observed = await Promise.race([
			observe(session, signal),
			expirePageAttempt(signal, bounds.attempt),
		])
		if (signal.aborted) await expirePageAttempt(signal, bounds.attempt)
	} catch (failure) {
		// The attempt's own failure is the one worth reporting, so a release that also fails
		// cannot replace it. A release that outlasted its share is the exception worth naming
		// beside it: the browser it could not reach is still running, and no reference here can
		// end it.
		const stranded = await releasePageAttempt(acquisition, bounds.release).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		if (stranded === undefined) throw failure
		throw new Error(`${describeFailure(failure)}, and ${describeFailure(stranded)}`, {
			cause: failure,
		})
	}
	await releasePageAttempt(acquisition, bounds.release)
	if (signal.aborted) {
		throw new Error(
			`the page attempt released its browser after its ${bounds.attempt} ms allowance had expired`,
			{ cause: signal.reason },
		)
	}
	return observed
}

/** Represents one tool call the page's agent dispatched, paired with its result. */
export interface PageTool {
	/** The zero-based index of the turn the call was dispatched in. */
	readonly turn: number
	readonly call: ToolCall
	readonly result: ToolResult
}

/** Represents the outcome the page's relay run reports back through `evaluate`. */
export interface PageOutcome {
	/** The zero-based index of each turn the agent's loop reported, in order. */
	readonly turns: readonly number[]
	/** Each dispatched call paired with its result, in order. */
	readonly tools: readonly PageTool[]
	/** The settled agent result; absent when the run failed instead. */
	readonly result?: AgentResult
	/** The stringified failure; absent when the run settled. */
	readonly failure?: string
	/** The failure's provider error code, when the failure carried one. */
	readonly code?: string
	/** The failure's HTTP status, when the failure carried one. */
	readonly status?: number
}

/** Represents one receipt the page's tool wrote into the document. */
export interface PageReceipt {
	/** The note argument the model chose, as the element's `data-note`. */
	readonly note: string
	/** The receipt the tool minted, as the element's text. */
	readonly receipt: string
}

/** Narrows an unknown value to one executed tool result. */
export function isToolOutcome(value: unknown): value is ToolResult {
	if (!isRecord(value) || !isString(value.id) || !isString(value.name)) return false
	return value.success === true || (value.success === false && isString(value.error))
}

/** Narrows an unknown value to one dispatched page tool call and its result. */
export function isPageTool(value: unknown): value is PageTool {
	if (!isRecord(value) || !isNumber(value.turn)) return false
	return isToolCall(value.call) && isToolOutcome(value.result)
}

/** Narrows an unknown value to a settled agent result. */
export function isAgentOutcome(value: unknown): value is AgentResult {
	return isRecord(value) && isString(value.content) && isBoolean(value.partial)
}

/** Narrows an unknown value to the outcome the page's relay run reports. */
export function isPageOutcome(value: unknown): value is PageOutcome {
	if (!isRecord(value)) return false
	if (!arrayOf(isNumber)(value.turns) || !arrayOf(isPageTool)(value.tools)) return false
	if (value.result !== undefined && !isAgentOutcome(value.result)) return false
	if (value.failure !== undefined && !isString(value.failure)) return false
	if (value.code !== undefined && !isString(value.code)) return false
	return value.status === undefined || isNumber(value.status)
}

/** Represents the reading the page's control request reports. */
export interface PageControl {
	/** The response status the control route answered with. */
	readonly status: number
	/** The response body the control route answered with. */
	readonly text: string
}

/** Narrows an unknown value to the reading the page's control request reports. */
export function isPageControl(value: unknown): value is PageControl {
	return isRecord(value) && isNumber(value.status) && isString(value.text)
}

/** Represents the reading the page's direct daemon generation reports. */
export interface PageGeneration {
	/** The provider name the page's own provider reports. */
	readonly name: string
	/** The content the daemon generated. */
	readonly content: string
}

/** Narrows an unknown value to the reading the page's direct daemon generation reports. */
export function isPageGeneration(value: unknown): value is PageGeneration {
	return isRecord(value) && isString(value.name) && isString(value.content)
}

/** Narrows an unknown value to the receipts the page's tool wrote into the document. */
export function isPageReceipts(value: unknown): value is readonly PageReceipt[] {
	return arrayOf(
		(one: unknown): one is PageReceipt =>
			isRecord(one) && isString(one.note) && isString(one.receipt),
	)(value)
}

/**
 * Evaluates one page expression and narrows the JSON string it returns.
 *
 * @param page - The evaluate boundary to run the expression through, normally a navigated page
 * @param expression - The expression to evaluate, which must resolve to a JSON string
 * @param guard - The guard the parsed value must satisfy
 * @param timeout - The deadline this one evaluate allows, in milliseconds
 * @returns The parsed, narrowed value
 * @throws Thrown when the expression returns no string, or its JSON fails the guard.
 * @remarks The page driver parks its operations on `globalThis` and reports through JSON
 * because `evaluate` takes an expression and returns a serialized result, so this is the one
 * place the string boundary is crossed and the one place an unnarrowed page value exists. The
 * parameter is the page's `evaluate` member alone, which is the whole boundary this crosses,
 * so the narrowing is provable against a minimal boundary stub without a browser.
 *
 * The deadline is the caller's because an attempt's allowances differ by expression: an
 * in-page agent run takes {@link PAGE_BOUNDS.evaluate}, and an instant read of what the page
 * already holds takes {@link PAGE_BOUNDS.read}. Spending the run's deadline on every read would
 * put an attempt's admissible cost far outside the case bound that contains it.
 */
export async function readOutcome<T>(
	page: Pick<BrowserPageInterface, 'evaluate'>,
	expression: string,
	guard: (value: unknown) => value is T,
	timeout: number,
): Promise<T> {
	const returned = await page.evaluate(expression, timeout)
	if (!isString(returned)) {
		throw new Error(`the page expression ${expression} returned ${String(returned)}, not a string`)
	}
	const parsed = parseJSONAs(returned, guard)
	if (parsed === undefined) {
		throw new Error(`the page expression ${expression} returned an unexpected shape: ${returned}`)
	}
	return parsed
}

/** Represents one retained attempt of the live page proof's bounded model-selection retry. */
export interface PageAttempt {
	/** The outcome the page reported; absent when the attempt could not be observed. */
	readonly outcome?: PageOutcome
	/** Every receipt the page's tool wrote into the document during the attempt. */
	readonly receipts: readonly PageReceipt[]
	/** Every resource name the page's own Resource Timing drain reported. */
	readonly resources: readonly string[]
	/** Every path the page requested inside the operation window, in order. */
	readonly page: readonly string[]
	/** Every inference request the relay route received, in turn order. */
	readonly relay: readonly RecordedRequest[]
	/** Every request the daemon transport issued, in turn order. */
	readonly daemon: readonly RecordedRequest[]
	/** The acquisition, evaluate, or release failure that stopped the attempt being observed. */
	readonly fault?: string
}

/**
 * Decides what the live page proof's bounded retry does with one retained attempt.
 *
 * @param attempt - The retained attempt, whose reads and release have already settled
 * @returns `true` when the model dispatched the page tool, `false` when it completed an answer
 * without dispatching it
 * @throws An `Error` naming the acquisition, release, evaluate, or run failure the attempt
 * carried, or the interruption that stopped its run settling.
 * @remarks This is the retry's predicate, and the split it makes is the reason it exists.
 * `retryUntil` catches what its producer throws and counts it as an unsatisfied attempt, and
 * rethrows what its predicate throws, so a failure classified inside the producer is retried and
 * a failure classified here ends the retry. Only one reading is worth another browser launch: a
 * model that completed an answer without dispatching the tool, which a different sample can
 * change. Every other reading is infrastructure — a session that never came up, a read or a
 * release that threw, a refused credential, a relay fault, a daemon error — and retrying it
 * spends the remaining attempts to report the exhaustion as the model never choosing the tool. A
 * run failure arrives as {@link PageOutcome.failure} rather than as a thrown value, because the
 * page serializes what its agent threw, which is why an attempt that reported a failure escapes
 * here instead of answering `false`.
 *
 * An interrupted run is read before tool selection is read at all, because the two are
 * indistinguishable by tool selection: a run the deadline cut short reports `partial: true` with
 * no tool call, exactly as a model that answered without choosing the tool reports no tool call.
 * The deadline that cut it is the attempt's own, which another launch cannot clear, so the
 * interruption escapes rather than spending the remaining attempts.
 */
export function acceptPageAttempt(attempt: PageAttempt): boolean {
	if (attempt.fault !== undefined) {
		throw new Error(`the page attempt could not be observed: ${attempt.fault}`)
	}
	if (attempt.outcome === undefined) {
		throw new Error('the page attempt retained no outcome and no fault')
	}
	if (attempt.outcome.failure !== undefined) {
		throw new Error(`the page run failed: ${attempt.outcome.failure}`)
	}
	if (attempt.outcome.result === undefined) {
		throw new Error('the page attempt reported neither a result nor a failure')
	}
	if (attempt.outcome.result.partial) {
		throw new Error(
			`the page run was interrupted before it settled: ${attempt.outcome.result.content}`,
		)
	}
	return attempt.outcome.tools.some((tool) => tool.call.name === PAGE_TOOL.name)
}
