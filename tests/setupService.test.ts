// The hermetic half of `tests/setupService.ts`. That module is the `service` project's
// setup file: it reads the selected daemon and model from the environment, gates the
// project on the daemon answering with that model installed, warms the model, and then
// hands the suites their live provider, live summarizer, and sampling tables.
//
// The LIVE half — that a real Ollama daemon generates usable content, that the warmed
// model answers within these prediction caps, that a live retry fits RETRY_BUDGET — is
// proven by the `service` project itself, driving a real daemon. The `setup` project has
// no daemon, so what is proven here is everything that does not need one: the
// environment normalization, the readiness verdict, the warmup recipe, the wire options
// each factory carries, the summarizer's message shaping, and the tables' invariants.
//
// The daemon those contracts are driven against is a protocol-faithful fixture this file
// starts on a loopback ephemeral port, not a stand-in for anything this workspace owns.
// It must be listening before `tests/setupService.ts` is evaluated, because that module
// runs its readiness gate at import; that is why the import is deferred until the
// environment points at the fixture.

import type { ContextFormat } from '@orkestrel/agent'
import { arrayOf, isRecord } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { waitForAbort } from '@orkestrel/test'
import { afterAll, describe, expect, it } from 'vitest'
import { service } from '../vite.config.js'
import { buildTurns, createUserMessage } from './setup.js'

/** One model entry in a fixture `/api/tags` listing. */
type TagEntry = Readonly<Record<string, unknown>>

/** One `/api/chat` request body the fixture recorded. */
type ChatBody = Record<string, unknown>

/** How the fixture answers `GET /api/tags`. */
interface TagsAnswer {
	readonly status: number
	readonly models: readonly TagEntry[]
}

/** How the fixture answers `POST /api/chat`. */
interface ChatAnswer {
	readonly status: number
	readonly content: string
	/** `true` parks the route until the call aborts, instead of answering it. */
	readonly park: boolean
}

/** A protocol-faithful Ollama daemon fixture on a loopback ephemeral port. */
interface DaemonInterface {
	/** The absolute base URL the fixture listens on. */
	readonly url: string
	/** Every route the fixture served, in call order. */
	readonly calls: readonly string[]
	/** Every `/api/chat` body the fixture received, in call order. */
	readonly chats: readonly ChatBody[]
	/** Replace the `/api/tags` answer. */
	tags(answer: TagsAnswer): void
	/** Replace the `/api/chat` answer. */
	chat(answer: ChatAnswer): void
	stop(): Promise<void>
}

/** The model the fixture advertises and the environment selects. */
const FIXTURE_MODEL = 'fixture-model:latest'

/** The assistant content the fixture returns from `/api/chat`. */
const FIXTURE_CONTENT = 'The conversation covered two small-talk topics.'

/** The fixture's ordinary answers, restored by any case that replaces one. */
const READY_TAGS: TagsAnswer = { status: 200, models: [{ model: FIXTURE_MODEL }] }
const READY_CHAT: ChatAnswer = { status: 200, content: FIXTURE_CONTENT, park: false }

/** The instruction `createLiveSummarizer` appends as the final user turn. */
const SUMMARY_INSTRUCTION = 'Summarize the conversation so far concisely in one sentence.'

/** A framing default used to prove the option reaches the built provider unchanged. */
const FRAMING: ContextFormat = {
	instructions: {
		open: '<instructions>',
		render: (one) => `<instruction>${one.content}</instruction>`,
		close: '</instructions>',
	},
}

/** Start the fixture daemon, answering `/api/tags` and `/api/chat` as Ollama does. */
async function createDaemon(): Promise<DaemonInterface> {
	const calls: string[] = []
	const chats: ChatBody[] = []
	const park = new AbortController()
	let tagsAnswer = READY_TAGS
	let chatAnswer = READY_CHAT
	let running = true
	const dispatcher = createDispatcher<Record<string, never>>()
	dispatcher.add({
		method: 'GET',
		path: '/api/tags',
		handler() {
			calls.push('/api/tags')
			return Response.json({ models: tagsAnswer.models }, { status: tagsAnswer.status })
		},
	})
	dispatcher.add({
		method: 'POST',
		path: '/api/chat',
		async handler(request) {
			calls.push('/api/chat')
			const body: unknown = JSON.parse(await request.text())
			if (isRecord(body)) chats.push(body)
			if (chatAnswer.park) {
				await waitForAbort(AbortSignal.any([request.signal, park.signal]))
				return new Response(undefined, { status: 499 })
			}
			return Response.json(
				{
					model: FIXTURE_MODEL,
					message: { role: 'assistant', content: chatAnswer.content },
					done: true,
				},
				{ status: chatAnswer.status },
			)
		},
	})
	const server = createServer({ dispatcher, state: () => ({}), host: '127.0.0.1' })
	const port = await server.start()
	return {
		url: `http://127.0.0.1:${port}`,
		get calls() {
			return calls
		},
		get chats() {
			return chats
		},
		tags(answer) {
			tagsAnswer = answer
		},
		chat(answer) {
			chatAnswer = answer
		},
		async stop() {
			if (!running) return
			running = false
			park.abort()
			await server.stop()
		},
	}
}

const daemon = await createDaemon()
const { port } = new URL(daemon.url)

/** The host the environment selects, written without a scheme so the module must add one. */
const FIXTURE_HOST = `127.0.0.1:${port}`

process.env.OLLAMA_HOST = FIXTURE_HOST
process.env.OLLAMA_MODEL = FIXTURE_MODEL

const {
	ABORT_OPTIONS,
	createLiveOllama,
	createLiveSummarizer,
	FAST_OPTIONS,
	isOllamaReady,
	OLLAMA_CONFIG,
	RETRY_BUDGET,
	SEED_OPTIONS,
	STREAM_OPTIONS,
	THINK_OPTIONS,
	TOOL_LOOP_OPTIONS,
	TOOL_OPTIONS,
	warmOllama,
} = await import('./setupService.js')

/** One named sampling table asserted as a group. */
type NamedTable = readonly [string, Readonly<Record<string, unknown>>]

const TABLES: readonly NamedTable[] = [
	['FAST_OPTIONS', FAST_OPTIONS],
	['STREAM_OPTIONS', STREAM_OPTIONS],
	['TOOL_OPTIONS', TOOL_OPTIONS],
	['ABORT_OPTIONS', ABORT_OPTIONS],
	['SEED_OPTIONS', SEED_OPTIONS],
	['THINK_OPTIONS', THINK_OPTIONS],
	['TOOL_LOOP_OPTIONS', TOOL_LOOP_OPTIONS],
]

/** Read the newest recorded chat body, failing when the fixture recorded none. */
function latestChat(): ChatBody {
	const body = daemon.chats.at(-1)
	if (body === undefined) throw new Error('the fixture daemon recorded no chat call')
	return body
}

/** Whether a wire value is a prediction cap: a whole number of tokens above zero. */
function isPositiveInteger(value: unknown): boolean {
	return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** Narrow a recorded body's `messages` to records, failing when the shape is wrong. */
function chatMessages(body: ChatBody): readonly TagEntry[] {
	const { messages } = body
	if (!arrayOf(isRecord)(messages)) throw new Error('the recorded chat carries no messages array')
	return messages
}

afterAll(async () => {
	await daemon.stop()
})

describe('the module load gate', () => {
	it('lists the daemon and then warms the selected model, before any suite runs', () => {
		expect(daemon.calls.slice(0, 2)).toEqual(['/api/tags', '/api/chat'])

		const warmup = daemon.chats[0]
		if (warmup === undefined) throw new Error('the fixture daemon recorded no warmup call')
		expect(warmup.model).toBe(FIXTURE_MODEL)
		expect(warmup.stream).toBe(false)
		expect(warmup.think).toBe(false)
		expect(warmup.keep_alive).toBe('30m')
		expect(warmup.options).toEqual({ num_predict: 1 })
		expect(warmup.messages).toEqual([{ role: 'user', content: 'hi' }])
	})
})

describe('OLLAMA_CONFIG', () => {
	it('normalizes a scheme-less host to an absolute HTTP URL and is frozen', () => {
		expect(OLLAMA_CONFIG.host).toBe(`http://${FIXTURE_HOST}`)
		expect(OLLAMA_CONFIG.model).toBe(FIXTURE_MODEL)
		expect(Object.isFrozen(OLLAMA_CONFIG)).toBe(true)
	})
})

describe('isOllamaReady', () => {
	it('reports ready when the listing names the model, under either wire field', async () => {
		daemon.tags({ status: 200, models: [{ model: FIXTURE_MODEL }] })
		expect(await isOllamaReady()).toBe(true)

		daemon.tags({ status: 200, models: [{ name: FIXTURE_MODEL }] })
		expect(await isOllamaReady()).toBe(true)

		daemon.tags(READY_TAGS)
	})

	it('reports not ready when the listing omits the model', async () => {
		daemon.tags({ status: 200, models: [{ model: 'some-other-model:latest' }] })
		try {
			expect(await isOllamaReady()).toBe(false)
		} finally {
			daemon.tags(READY_TAGS)
		}
	})

	it('reports not ready when the listing answers a non-OK status', async () => {
		daemon.tags({ status: 503, models: [{ model: FIXTURE_MODEL }] })
		try {
			expect(await isOllamaReady()).toBe(false)
		} finally {
			daemon.tags(READY_TAGS)
		}
	})
})

describe('warmOllama', () => {
	it('posts a one-token non-streaming turn that pins the model resident', async () => {
		await warmOllama()

		const warmup = latestChat()
		expect(warmup.model).toBe(FIXTURE_MODEL)
		expect(warmup.stream).toBe(false)
		expect(warmup.options).toEqual({ num_predict: 1 })
		expect(warmup.keep_alive).toBe('30m')
	})

	it('throws naming the status, the model, and the host when the daemon rejects it', async () => {
		daemon.chat({ status: 503, content: FIXTURE_CONTENT, park: false })
		try {
			await expect(warmOllama()).rejects.toThrow(
				`Ollama warmup failed (503) for model ${FIXTURE_MODEL} at http://${FIXTURE_HOST}`,
			)
		} finally {
			daemon.chat(READY_CHAT)
		}
	})
})

describe('createLiveOllama', () => {
	it('targets the selected daemon and model, capping prediction at 32 with temperature 0', async () => {
		const provider = createLiveOllama()

		await provider.generate([createUserMessage('hi')], AbortSignal.timeout(5000))

		const body = latestChat()
		expect(body.model).toBe(FIXTURE_MODEL)
		expect(body.options).toEqual({ num_predict: 32, temperature: 0 })
	})

	it('carries a requested prediction cap and temperature to the wire', async () => {
		const provider = createLiveOllama({ predict: 7, temperature: 0.5 })

		await provider.generate([createUserMessage('hi')], AbortSignal.timeout(5000))

		expect(latestChat().options).toEqual({ num_predict: 7, temperature: 0.5 })
	})

	it('exposes a requested framing default and leaves it undefined when omitted', () => {
		expect(createLiveOllama({ format: FRAMING }).format).toBe(FRAMING)
		expect(createLiveOllama().format).toBeUndefined()
	})
})

describe('createLiveSummarizer', () => {
	it('appends the fixed instruction after the conversation as a final user turn', async () => {
		const turns = buildTurns(2)

		const digest = await createLiveSummarizer(5000)(turns)

		expect(digest).toBe(FIXTURE_CONTENT)
		const messages = chatMessages(latestChat())
		expect(messages.length).toBe(turns.length + 1)
		expect(messages.slice(0, turns.length)).toEqual(
			turns.map((turn) => ({ role: turn.role, content: turn.content })),
		)
		expect(messages.at(-1)).toEqual({ role: 'user', content: SUMMARY_INSTRUCTION })
	})

	it('caps the digest at 64 tokens by default and at the requested cap when given', async () => {
		await createLiveSummarizer(5000)(buildTurns(2))
		expect(latestChat().options).toEqual({ num_predict: 64, temperature: 0 })

		await createLiveSummarizer(5000, 16)(buildTurns(2))
		expect(latestChat().options).toEqual({ num_predict: 16, temperature: 0 })
	})

	it('bounds the generation by the deadline it was built with', async () => {
		daemon.chat({ status: 200, content: FIXTURE_CONTENT, park: true })
		try {
			await expect(createLiveSummarizer(50)(buildTurns(2))).rejects.toThrow(Error)
		} finally {
			daemon.chat(READY_CHAT)
		}
	})
})

describe('the sampling tables', () => {
	it('freeze a positive prediction cap at temperature 0, seeding only the seeded recipe', () => {
		if (TABLES.length === 0) throw new Error('the sampling table population is empty')

		const read = TABLES.map(([name, table]) => ({
			name,
			frozen: Object.isFrozen(table),
			temperature: table.temperature,
			capped: isPositiveInteger(table.num_predict),
		}))

		expect(read).toEqual(
			TABLES.map(([name]) => ({ name, frozen: true, temperature: 0, capped: true })),
		)

		const seeded = TABLES.filter(([, table]) => Object.hasOwn(table, 'seed')).map(([name]) => name)
		expect(seeded).toEqual(['SEED_OPTIONS'])
		expect(SEED_OPTIONS.seed).toBe(42)
	})

	it('bound a live retry by the same deadline the service project gives a test', () => {
		const declared: unknown = service().test
		if (!isRecord(declared)) throw new Error('the service project declares no test configuration')

		expect(RETRY_BUDGET).toBe(declared.testTimeout)
	})
})

// Last, because it takes the fixture daemon down and nothing can reach it afterwards.
describe('warmOllama (daemon down)', () => {
	it('throws naming the host and the model when the daemon cannot be reached', async () => {
		await daemon.stop()

		await expect(warmOllama()).rejects.toThrow(
			`Ollama warmup could not reach http://${FIXTURE_HOST} for model ${FIXTURE_MODEL}`,
		)
	})
})
