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
// The daemon those contracts are driven against is the protocol-faithful `FixtureDaemon`
// `tests/setupServer.ts` declares, which this file starts on a loopback ephemeral port; it
// is not a stand-in for anything this workspace owns.
// It must be listening before `tests/setupService.ts` is evaluated, because that module
// runs its readiness gate at import; that is why the import is deferred until the
// environment points at the fixture.

import { createConversation } from '@orkestrel/agent'
import { isRecord } from '@orkestrel/contract'
import { afterAll, describe, expect, it } from 'vitest'
import { service } from '../vite.config.js'
import { buildTurns, createUserMessage } from './setup.js'
import {
	FIXTURE_CONTENT,
	FIXTURE_MODEL,
	FixtureDaemon,
	isPositiveInteger,
	readChatMessages,
	readLatestChat,
	READY_CHAT,
	READY_TAGS,
	SUMMARY_INSTRUCTION,
} from './setupServer.js'

const daemon = new FixtureDaemon()
await daemon.start()
const { port } = new URL(daemon.url)

/** The host the environment selects, written without a scheme so the module must add one. */
const FIXTURE_HOST = `127.0.0.1:${port}`

process.env.OLLAMA_HOST = FIXTURE_HOST
process.env.OLLAMA_MODEL = FIXTURE_MODEL

const {
	createLiveOllama,
	requireDaemonOrigin,
	createLiveSummarizer,
	fetchDaemon,
	isOllamaReady,
	OLLAMA_CONFIG,
	RETRY_BUDGET,
	SAMPLING_EXPORTS,
	SAMPLING_TABLES,
	SEED_OPTIONS,
	seedConversation,
	warmOllama,
} = await import('./setupService.js')

afterAll(async () => {
	await daemon.stop()
})

// The cases share one fixture daemon and one evaluation of the service module, and the last group takes
// the daemon down, so the order of the cases is part of what this file proves. The suite names that order
// by turning shuffling off for itself; every other file keeps the runner's order.
describe('the service setup against a fixture daemon', { shuffle: false }, () => {
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

	describe('fetchDaemon', () => {
		it('answers the daemon response of a reachable route, whatever its status', async () => {
			daemon.tags({ status: 503, models: [] })
			try {
				const response = await fetchDaemon(`${daemon.url}/api/tags`, {}, 5000, (reason) => reason)

				expect(response.status).toBe(503)
				expect(await response.json()).toEqual({ models: [] })
			} finally {
				daemon.tags(READY_TAGS)
			}
		})

		it('reports a deadline it cannot arm as the built message, carrying the failure as its cause', async () => {
			const failure = await fetchDaemon(
				`${daemon.url}/api/tags`,
				{},
				-1,
				(reason) => `could not arm (${reason})`,
			).then(
				() => undefined,
				(error: unknown) => error,
			)

			if (!(failure instanceof Error)) throw new Error('fetchDaemon did not reject with an Error')
			expect(failure.message).toMatch(/^could not arm \(RangeError.*"delay" is out of range/)
			expect(failure.cause).toBeInstanceOf(RangeError)
		})
	})

	describe('warmOllama', () => {
		it('posts a one-token non-streaming turn that pins the model resident', async () => {
			await warmOllama()

			const warmup = readLatestChat(daemon)
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

			const body = readLatestChat(daemon)
			expect(body.model).toBe(FIXTURE_MODEL)
			expect(body.options).toEqual({ num_predict: 32, temperature: 0 })
		})

		it('carries a requested prediction cap and temperature to the wire', async () => {
			const provider = createLiveOllama({ predict: 7, temperature: 0.5 })

			await provider.generate([createUserMessage('hi')], AbortSignal.timeout(5000))

			expect(readLatestChat(daemon).options).toEqual({ num_predict: 7, temperature: 0.5 })
		})

		it('carries a requested context window to the wire as num_ctx', async () => {
			const provider = createLiveOllama({ predict: 7, context: 16_384 })

			await provider.generate([createUserMessage('hi')], AbortSignal.timeout(5000))

			expect(readLatestChat(daemon).options).toEqual({
				num_predict: 7,
				temperature: 0,
				num_ctx: 16_384,
			})
		})

		it('carries a requested think flag to the wire and sends the provider default without one', async () => {
			await createLiveOllama({ think: true }).generate(
				[createUserMessage('hi')],
				AbortSignal.timeout(5000),
			)
			expect(readLatestChat(daemon).think).toBe(true)

			await createLiveOllama().generate([createUserMessage('hi')], AbortSignal.timeout(5000))
			expect(readLatestChat(daemon).think).toBe(false)
		})

		it('ends a turn the daemon never answers at the requested deadline, before the caller signal', async () => {
			daemon.chat({ status: 200, content: FIXTURE_CONTENT, park: true })
			try {
				const provider = createLiveOllama({ turn: 30 })
				const started = performance.now()

				await expect(
					provider.generate([createUserMessage('hi')], AbortSignal.timeout(3000)),
				).rejects.toThrow(Error)

				expect(performance.now() - started).toBeLessThan(1500)
			} finally {
				daemon.chat(READY_CHAT)
			}
		})
	})

	describe('createLiveSummarizer', () => {
		it('appends the fixed instruction after the conversation as a final user turn', async () => {
			const turns = buildTurns(2)

			const digest = await createLiveSummarizer(5000)(turns)

			expect(digest).toBe(FIXTURE_CONTENT)
			const messages = readChatMessages(readLatestChat(daemon))
			expect(messages.length).toBe(turns.length + 1)
			expect(messages.slice(0, turns.length)).toEqual(
				turns.map((turn) => ({ role: turn.role, content: turn.content })),
			)
			expect(messages.at(-1)).toEqual({ role: 'user', content: SUMMARY_INSTRUCTION })
		})

		it('caps the digest at 64 tokens by default and at the requested cap when given', async () => {
			await createLiveSummarizer(5000)(buildTurns(2))
			expect(readLatestChat(daemon).options).toEqual({ num_predict: 64, temperature: 0 })

			await createLiveSummarizer(5000, 16)(buildTurns(2))
			expect(readLatestChat(daemon).options).toEqual({ num_predict: 16, temperature: 0 })
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

	describe('seedConversation', () => {
		it('adds the fixed trip-planning exchange, alternating user and assistant turns', () => {
			const conversation = createConversation()

			seedConversation(conversation)

			const view = conversation.view()
			expect(view.map((message) => message.role)).toEqual([
				'user',
				'assistant',
				'user',
				'assistant',
			])
			expect(view[0]?.content).toContain('Kyoto')
			expect(new Set(view.map((message) => message.content)).size).toBe(view.length)
		})
	})

	describe('the sampling tables', () => {
		it('list every table under its own export name, each entry holding that export itself', () => {
			// Identity, not equality: FAST_OPTIONS and THINK_OPTIONS hold equal values, so only the
			// reference tells a swapped entry from the right one.
			expect(
				SAMPLING_TABLES.map(([name, table], index) => [
					name,
					table === SAMPLING_EXPORTS[index]?.[1],
				]),
			).toEqual(SAMPLING_EXPORTS.map(([name]) => [name, true]))
			expect(SAMPLING_TABLES.map(([name]) => name)).toEqual(SAMPLING_EXPORTS.map(([name]) => name))
			expect(Object.isFrozen(SAMPLING_TABLES)).toBe(true)
			expect(Object.isFrozen(SAMPLING_EXPORTS)).toBe(true)
		})

		it('freeze a positive prediction cap at temperature 0, seeding only the seeded recipe', () => {
			if (SAMPLING_TABLES.length === 0) throw new Error('the sampling table population is empty')

			const read = SAMPLING_TABLES.map(([name, table]) => ({
				name,
				frozen: Object.isFrozen(table),
				temperature: table.temperature,
				capped: isPositiveInteger(table.num_predict),
			}))

			expect(read).toEqual(
				SAMPLING_TABLES.map(([name]) => ({ name, frozen: true, temperature: 0, capped: true })),
			)

			const seeded = SAMPLING_TABLES.filter(([, table]) => Object.hasOwn(table, 'seed')).map(
				([name]) => name,
			)
			expect(seeded).toEqual(['SEED_OPTIONS'])
			expect(SEED_OPTIONS.seed).toBe(42)
		})

		it('bound a live retry by the same deadline the service project gives a test', () => {
			const declared: unknown = service().test
			if (!isRecord(declared)) throw new Error('the service project declares no test configuration')

			expect(RETRY_BUDGET).toBe(declared.testTimeout)
		})
	})

	// The live page proof's daemon gate. It resolves on call, so the hermetic half asserted here
	// is its refusal against the fixture; the live half — the real daemon's answer — is the
	// `service` project's. The gates that need no daemon are proved in `tests/setupServer.test.ts`.

	describe('requireDaemonOrigin', () => {
		it('accepts an origin the daemon permits and throws naming OLLAMA_ORIGINS for one it refuses', async () => {
			const permitted = 'http://127.0.0.1:54321'
			const refused = 'http://refused.example.com'
			daemon.origins([permitted])
			const seen = daemon.preflights.length

			await expect(requireDaemonOrigin(permitted)).resolves.toBeUndefined()
			await expect(requireDaemonOrigin(refused)).rejects.toThrow(
				`refuses the page origin ${refused}`,
			)
			await expect(requireDaemonOrigin(refused)).rejects.toThrow(
				'set OLLAMA_ORIGINS to include that origin',
			)

			expect(daemon.preflights.slice(seen)).toEqual([permitted, refused, refused])
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

		it('reports an unreachable daemon as the built message, carrying the failure as its cause', async () => {
			const failure = await fetchDaemon(
				`http://${FIXTURE_HOST}/api/tags`,
				{},
				5000,
				(reason) => `no daemon (${reason})`,
			).then(
				() => undefined,
				(error: unknown) => error,
			)

			if (!(failure instanceof Error)) throw new Error('fetchDaemon did not reject with an Error')
			expect(failure.message).toMatch(/^no daemon \(TypeError: fetch failed\)$/)
			expect(failure.cause).toBeInstanceOf(TypeError)
		})
	})
})
