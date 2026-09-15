/**
 * The live page proof: a real Chromium loads the published `@orkestrel` closure from an
 * import map served on `127.0.0.1`, and an `Agent` inside that page completes a tool loop
 * against the live Ollama daemon over `createRelayProvider` → `createRelay` →
 * `OllamaProvider`, with the page's own requests recorded from the browser's request log.
 *
 * Every precondition is a hard throw naming its fix and nothing here skips: the daemon and
 * the model come from `tests/setupService.ts`, the browser from `requirePageBrowser`, this
 * workspace's built core entry from `requireBuild`, and the daemon's permission for the
 * page's origin — which only the direct-daemon case needs — from `requireDaemonOrigin`.
 *
 * Every case runs one attempt through `boundPageAttempt`, which ends that attempt within
 * `PAGE_BOUNDS.attempt + PAGE_BOUNDS.release`: the acquisition and the observation are raced
 * against the allowance, and the release after that race is raced against its own share, so
 * neither a browser still on its way back nor a release that cannot finish turns an expired
 * attempt into a hang. That is the whole bound. The installed browser surface takes a signal on
 * part of the connection — which `createPageSession` hands it, so an expiry at discovery, at the
 * port-free check, before the launch, or at `client.connect()` ends the acquisition at the
 * dependency — while the target listing that connection ends with, and every page command after
 * it, takes a per-call `timeout` and no signal, one of them issuing several separately bounded
 * CDP commands. So a sum over those per-call values states an arithmetic the dependency never
 * runs, and the race is what bounds every phase the signal does not reach. The attempt-bound
 * controls at the end of this file drive each interleaving of that bound.
 *
 * The model's choice to call a tool is the one unreliable step, so the receipt case wraps
 * each whole attempt in a bounded `retryUntil`. That retry treats a producer throw and a
 * predicate throw differently — it catches the first and spends another attempt, and rethrows
 * the second — so the split lives on that boundary. The producer never throws: it retains the
 * attempt's observations, whatever the page reported, and any acquisition, read, release, or
 * deadline failure as that attempt's `fault`. `acceptPageAttempt` is the predicate, and it
 * retries only the one reading another launch can change: a model that completed an answer
 * without dispatching the tool. A run the attempt's deadline interrupted reports no tool call
 * too, so it is read as the interruption it is rather than as a sample. The request accounting
 * then runs over every retained attempt, so an attempt that satisfied the predicate cannot hide
 * an attempt whose traffic was wrong.
 */

import {
	requireValue,
	retryUntil,
	waitForAbort,
	waitForCondition,
	waitForDelay,
} from '@orkestrel/test'
import { arrayOf, isString } from '@orkestrel/contract'
import { createOllama, OLLAMA_CHAT_PATH } from '@src/core'
import { describe, expect, it } from 'vitest'
import { PAGE_TOOL } from '../setup.js'
import type {
	PageAttempt,
	PageOutcome,
	PageReceipt,
	PageSessionInterface,
	PageSessionOptions,
} from '../setupServer.js'
import {
	acceptPageAttempt,
	boundPageAttempt,
	CONTROL_PATH,
	createPageSession,
	createRecordingTransport,
	describeFailure,
	DIST_PATH,
	isPageControl,
	isPageGeneration,
	isPageOutcome,
	isPageReceipts,
	MODULES_PATH,
	OBFUSCATED,
	PAGE_BOUNDS,
	PAGE_INTERVALS,
	readOutcome,
	wireMessages,
} from '../setupServer.js'
import {
	FAST_OPTIONS,
	OLLAMA_CONFIG,
	PAGE_BROWSER_ARGS,
	PAGE_OPTIONS,
	requireBuild,
	requireDaemonOrigin,
	requirePageBrowser,
	TOOL_LOOP_OPTIONS,
} from '../setupService.js'

const BROWSER = requirePageBrowser()
const BUILD = requireBuild()

/** Holds the session options every case that drives no relay provider acquires with. */
const SESSION: PageSessionOptions = Object.freeze({
	executable: BROWSER.executable,
	args: PAGE_BROWSER_ARGS,
})

/** Names the note the model is steered to pass to the page tool. */
const NOTE = 'kyoto'

/** Names the relay route the page dials on the fixture's own origin. */
const INFERENCE_PATH = '/inference'

/** Names the fault the page is asked to report on both of its error channels. */
const FAULT = 'deliberate-page-fault'

/** Names the city the direct daemon turn asks for, and the answer that names it. */
const CAPITAL = Object.freeze({
	prompt: 'What is the capital city of Japan? Reply with the city name only.',
	answer: /tokyo/i,
})

/** Holds the steering and bounds every in-page relay run takes. */
const RUN = Object.freeze({
	system:
		`You MUST call the ${PAGE_TOOL.name} tool with note "${NOTE}" to answer. ` +
		'After it returns, state the exact value it returned in your final reply.',
	prompt: `Call the ${PAGE_TOOL.name} tool with note "${NOTE}", then tell me exactly what it returned.`,
	timeout: PAGE_BOUNDS.run,
	limit: 4,
})

/** Names every operation the served page parks for this file, in the order it declares them. */
const OPERATIONS: readonly string[] = Object.freeze([
	'run',
	'control',
	'fault',
	'direct',
	'receipts',
	'resources',
])

describe('Agent tool loop in a real page (live) — the published closure', () => {
	it(
		'evaluates the published agent closure in a real page from an import map',
		async () => {
			await boundPageAttempt(
				PAGE_BOUNDS,
				(signal) => createPageSession({ ...SESSION, signal }),
				async (session) => {
					// No agent has run: this case reads the closure's own evaluation, so a top-level
					// side effect or an unresolved specifier surfaces as itself rather than as a
					// failure of the scenario built on top of it.
					expect(await session.page.evaluate('globalThis.ready === true', PAGE_BOUNDS.read)).toBe(
						true,
					)
					// The operation table the page actually parked, read out of the running browser
					// and compared whole. The served document is a string this process never
					// executes, so every name the other cases evaluate is bound to what the page
					// declares only by asking the page which members it holds — a reading no scan of
					// the served text can stand in for, because a member moved into a template
					// literal, emptied, or renamed changes this collection and not that text.
					expect(
						await readOutcome(
							session.page,
							'JSON.stringify(Object.keys(globalThis.page))',
							arrayOf(isString),
							PAGE_BOUNDS.read,
						),
					).toEqual(OPERATIONS)
					// The page error recorder and the console recorder are certified by the control
					// case, which makes each of them, in the same session shape, report a fault the
					// page deliberately produced.
					expect(session.errors).toEqual([])
					expect(session.messages.filter((message) => message.level === 'error')).toEqual([])
					const paths = session.requests.map((request) => new URL(request.url).pathname)
					expect(paths).toContain('/')
					expect(paths).toContain(`${MODULES_PATH}/agent/dist/src/core/index.js`)
					expect(paths).toContain(`${MODULES_PATH}/tool/dist/src/core/index.js`)
					expect(paths).toContain(`${MODULES_PATH}/ndjson/dist/src/core/index.js`)
					// The workspace's own build is served, and it is the entry `requireBuild` resolved
					// — the direct-daemon case's `@orkestrel/ollama` comes from this tree, not from an
					// installed copy of the published package.
					expect(paths).toContain(`${DIST_PATH}/src/core/index.js`)
					expect(BUILD.split(/[\\/]/).slice(-4).join('/')).toBe('dist/src/core/index.js')
					// Loading the page asked the relay for nothing.
					expect(session.fixture.requests.every((request) => request.method === 'GET')).toBe(true)
				},
			)
		},
		PAGE_BOUNDS.case,
	)
})

describe('Agent tool loop in a real page (live) — a page tool through the relay', () => {
	it(
		'executes a page tool through an agent over a live Ollama relay and feeds its result into the next model turn',
		async () => {
			const attempts: PageAttempt[] = []
			let satisfied: PageAttempt | undefined
			let unsatisfied: unknown
			try {
				satisfied = await retryUntil(
					'have the model call the page tool and carry its receipt into the next turn',
					async () => {
						const daemon = createRecordingTransport()
						let session: PageSessionInterface | undefined
						let outcome: PageOutcome | undefined
						let receipts: readonly PageReceipt[] = []
						let resources: readonly string[] = []
						let mark = 0
						let fault: string | undefined
						// Nothing in this producer throws, because `retryUntil` catches a producer
						// throw and spends another launch on it. The acquisition, the reads, the
						// release, and the attempt's own deadline are retained as this attempt's
						// `fault` instead, and `acceptPageAttempt` decides from the record whether
						// another launch can change the reading.
						//
						// The whole attempt ends within its allowance plus its release share, so an
						// admissible schedule cannot reach the case bound by spending each inner
						// share in turn. The session is stashed as it is acquired because the
						// traffic is read after the release, which `boundPageAttempt` owns.
						try {
							await boundPageAttempt(
								PAGE_BOUNDS,
								(signal) =>
									createPageSession({
										...SESSION,
										provider: createOllama({
											model: OLLAMA_CONFIG.model,
											url: OLLAMA_CONFIG.host,
											options: TOOL_LOOP_OPTIONS,
											fetch: daemon.fetch,
										}),
										signal,
									}),
								async (acquired) => {
									session = acquired
									// The window opens after the driver parked its operations, so the
									// module fetches the page made while loading are outside it.
									mark = acquired.requests.length
									outcome = await readOutcome(
										acquired.page,
										`page.run(${JSON.stringify({ ...RUN, url: `${acquired.fixture.url}${INFERENCE_PATH}`, authorization: OBFUSCATED })})`,
										isPageOutcome,
										PAGE_BOUNDS.evaluate,
									)
									receipts = await readOutcome(
										acquired.page,
										'page.receipts()',
										isPageReceipts,
										PAGE_BOUNDS.read,
									)
									resources = await readOutcome(
										acquired.page,
										'page.resources()',
										arrayOf(isString),
										PAGE_BOUNDS.read,
									)
								},
							)
						} catch (failure) {
							fault = String(failure)
						}
						// Retained after the release, from recorders the release does not clear, so
						// this attempt's traffic is asserted whether it was read or not.
						const requests = session?.requests ?? []
						const attempt: PageAttempt = {
							...(outcome === undefined ? {} : { outcome }),
							receipts,
							resources,
							page: requests
								.slice(mark)
								.map((request) => `${request.method} ${new URL(request.url).pathname}`),
							relay:
								session?.fixture.requests.filter((request) => request.path === INFERENCE_PATH) ??
								[],
							daemon: [...daemon.requests],
							...(fault === undefined ? {} : { fault }),
						}
						attempts.push(attempt)
						return attempt
					},
					acceptPageAttempt,
					{
						attempts: PAGE_BOUNDS.launches,
						budget: PAGE_BOUNDS.budget,
					},
				)
			} catch (failure) {
				unsatisfied = failure
			}

			// ── The request accounting, over EVERY retained attempt ───────────────────
			// A satisfied attempt never excuses an attempt whose traffic was wrong, so the
			// invariants are asserted on each one: one page `POST /inference` per turn, one
			// relay request per turn, one daemon `/api/chat` per turn, and nothing else the
			// page asked for inside the window — which is the zero-request tool-execution
			// window stated as the whole window rather than as a timing slice. These run
			// before the retry's own failure is rethrown, so a fault reports as itself.
			for (const [index, attempt] of attempts.entries()) {
				expect(attempt.fault, `attempt ${index}`).toBeUndefined()
				const outcome = requireValue(attempt.outcome, `attempt ${index} retained no outcome`)
				const turns = outcome.turns.length
				expect(attempt.page, `attempt ${index}`).toEqual(
					Array.from({ length: turns }, () => `POST ${INFERENCE_PATH}`),
				)
				expect(attempt.relay, `attempt ${index}`).toHaveLength(turns)
				expect(
					attempt.daemon.map((request) => request.path),
					`attempt ${index}`,
				).toEqual(Array.from({ length: turns }, () => OLLAMA_CHAT_PATH))
				expect(
					attempt.relay.every((request) => request.headers.authorization === OBFUSCATED),
					`attempt ${index}`,
				).toBe(true)
			}
			if (unsatisfied !== undefined) throw unsatisfied
			const settled = requireValue(satisfied, 'the bounded retry returned no satisfied attempt')

			// ── The execution receipt ─────────────────────────────────────────────────
			const outcome = requireValue(settled.outcome, 'the satisfied attempt retained no outcome')
			const dispatched = requireValue(
				outcome.tools.find((tool) => tool.call.name === PAGE_TOOL.name),
				'the satisfied attempt reported no call to the page tool',
			)
			const written = requireValue(
				settled.receipts.at(0),
				'the satisfied attempt wrote no receipt into the page',
			)
			// The model's recorded call carries the note it chose, and the page's DOM carries
			// that same note — the argument crossed the wire and reached the handler.
			expect(dispatched.call.arguments.note).toBe(written.note)
			// The agent reported the tool's own return value, and the DOM holds the same
			// receipt: the value was minted during execution, in the page.
			expect(dispatched.result).toMatchObject({
				success: true,
				value: written.receipt,
			})
			expect(written.receipt.startsWith('receipt-')).toBe(true)
			// The receipt was absent from the prompt, so a later request carrying it can only
			// be the tool result being fed back.
			expect(RUN.system.includes(written.receipt)).toBe(false)
			expect(RUN.prompt.includes(written.receipt)).toBe(false)

			// ── The feedback, pinned to the turn after the call ────────────────────────
			// The agent issues one request per turn, so the request that asked for the call is
			// the dispatched turn's and the feedback is the next one's. Asserting the index
			// rather than "some request" is what refuses a receipt that arrived later, and
			// asserting the message's role is what refuses one that arrived as prose. The
			// dispatching turn is asserted rather than assumed, because every index below is
			// taken from it: a page reporting the wrong turn would move each pin off the request
			// it names and leave the whole block reading a neighbour.
			expect(dispatched.turn).toBe(0)
			const requested = requireValue(
				settled.relay.at(dispatched.turn),
				`the relay recorded no request for turn ${dispatched.turn}`,
			)
			expect(requested.text.includes(written.receipt)).toBe(false)
			const fed = requireValue(
				settled.relay.at(dispatched.turn + 1),
				`the relay recorded no request for the turn after the call`,
			)
			expect(
				wireMessages(fed).filter(
					(message) => message.role === 'tool' && message.content.includes(written.receipt),
				),
			).toHaveLength(1)
			// The same two pins on the daemon's own wire, at the same turns: the request that
			// asked for the call carried no receipt, and the one after it carried the receipt as
			// a tool message. Absence on one wire alone leaves a receipt that was minted before
			// the call — or fed back early — indistinguishable from this one.
			const asked = requireValue(
				settled.daemon.at(dispatched.turn),
				`the daemon recorded no request for turn ${dispatched.turn}`,
			)
			expect(asked.text.includes(written.receipt)).toBe(false)
			const upstream = requireValue(
				settled.daemon.at(dispatched.turn + 1),
				`the daemon recorded no request for the turn after the call`,
			)
			expect(
				wireMessages(upstream).filter(
					(message) => message.role === 'tool' && message.content.includes(written.receipt),
				),
			).toHaveLength(1)
			// The tool was advertised to the daemon on the first turn, by the name the shared
			// definition carries.
			expect(requireValue(settled.daemon.at(0)).text).toContain(PAGE_TOOL.name)
			// The run settled rather than exhausting or cancelling.
			const result = requireValue(
				outcome.result,
				'the satisfied attempt reported a failure instead of a result',
			)
			expect(result.partial).toBe(false)
			expect(result.content.length).toBeGreaterThan(0)
			// The page's own Resource Timing drain corroborates the browser's request log.
			expect(
				settled.resources.filter((name) => name.endsWith(INFERENCE_PATH)).length,
			).toBeGreaterThanOrEqual(1)
		},
		PAGE_BOUNDS.retry,
	)
})

describe('Agent tool loop in a real page (live) — the recorders report a known fault', () => {
	it(
		'records a deliberate page request and a deliberate page fault outside the agent operation',
		async () => {
			await boundPageAttempt(
				PAGE_BOUNDS,
				(signal) => createPageSession({ ...SESSION, signal }),
				async (session, signal) => {
					const mark = session.requests.length
					const control = await readOutcome(
						session.page,
						'page.control()',
						isPageControl,
						PAGE_BOUNDS.read,
					)
					expect(control).toEqual({ status: 200, text: 'control' })
					// The positive control for the preceding case's empty-window assertion: the same
					// slice, over the same recorders, reports a request the page deliberately made.
					expect(
						session.requests.slice(mark).map((request) => new URL(request.url).pathname),
					).toEqual([CONTROL_PATH])
					const resources = await readOutcome(
						session.page,
						'page.resources()',
						arrayOf(isString),
						PAGE_BOUNDS.read,
					)
					expect(resources.some((name) => name.endsWith(CONTROL_PATH))).toBe(true)
					expect(session.fixture.requests.map((request) => request.path)).toContain(CONTROL_PATH)

					// The positive control for the closure case's two empty-channel assertions: the
					// page writes one console error and throws one uncaught error, and both recorders
					// report it. Without this, an unsubscribed channel and a silent page read alike.
					expect(session.errors).toEqual([])
					expect(
						await readOutcome(
							session.page,
							`page.fault(${JSON.stringify(FAULT)})`,
							isString,
							PAGE_BOUNDS.read,
						),
					).toBe(FAULT)
					// The wait takes the attempt's own signal beside its budget, so a page that never
					// reports the fault ends at the attempt's deadline rather than outlasting it.
					await waitForCondition(
						'the page error and console recorders to report the deliberate fault',
						() =>
							session.errors.some((error) => error.message.includes(FAULT)) &&
							session.messages.some(
								(message) => message.level === 'error' && message.text.includes(FAULT),
							),
						{ budget: PAGE_BOUNDS.ready, signal },
					)
				},
			)
		},
		PAGE_BOUNDS.case,
	)
})

describe('Agent tool loop in a real page (live) — a refused page credential', () => {
	it(
		'rejects a page relay credential before contacting Ollama',
		async () => {
			const daemon = createRecordingTransport()
			const options = {
				...SESSION,
				provider: createOllama({
					model: OLLAMA_CONFIG.model,
					url: OLLAMA_CONFIG.host,
					options: FAST_OPTIONS,
					fetch: daemon.fetch,
				}),
			}
			await boundPageAttempt(
				PAGE_BOUNDS,
				(signal) => createPageSession({ ...options, signal }),
				async (session) => {
					const outcome = await readOutcome(
						session.page,
						`page.run(${JSON.stringify({ ...RUN, url: `${session.fixture.url}${INFERENCE_PATH}`, authorization: `${OBFUSCATED}-wrong` })})`,
						isPageOutcome,
						PAGE_BOUNDS.evaluate,
					)
					// The refusal's own identity, not merely that something failed: the guide names
					// `ProviderError` beside the code and the status, so all three are asserted.
					expect(outcome.failure).toContain('ProviderError')
					expect(outcome.status).toBe(401)
					expect(outcome.code).toBe('HTTP')
					expect(outcome.tools).toEqual([])
					// The relay refused before entering the provider, so the daemon transport was
					// never called and no `/api/chat` request exists to have been refused later.
					expect(daemon.requests).toEqual([])
					expect(
						session.fixture.requests.filter((request) => request.path === INFERENCE_PATH),
					).toHaveLength(1)
				},
			)
		},
		PAGE_BOUNDS.case,
	)
})

describe('Ollama in a real page (live) — the daemon driven directly', () => {
	it(
		'drives the daemon directly from the page behind its origin gate',
		async () => {
			await boundPageAttempt(
				PAGE_BOUNDS,
				(signal) => createPageSession({ ...SESSION, signal }),
				async (session) => {
					// The page dials the daemon from its own ephemeral loopback origin, so the daemon
					// decides a preflight first. A host that refuses it is a host where the guide's
					// direct-daemon claim is false, and this throws naming OLLAMA_ORIGINS.
					await requireDaemonOrigin(new URL(session.fixture.url).origin)
					const mark = session.requests.length
					const direct = await readOutcome(
						session.page,
						`page.direct(${JSON.stringify({ model: OLLAMA_CONFIG.model, url: OLLAMA_CONFIG.host, options: PAGE_OPTIONS, prompt: CAPITAL.prompt, timeout: PAGE_BOUNDS.run })})`,
						isPageGeneration,
						PAGE_BOUNDS.evaluate,
					)
					expect(direct.name).toBe('ollama')
					// A property of an answer, not its length: the daemon answered the question the
					// page asked. A turn the daemon could not read reports its confusion instead.
					expect(direct.content).toMatch(CAPITAL.answer)
					// Asserted by filtering, never by a total: the browser sends its own preflight to
					// the daemon origin and that preflight is its own recorded request.
					const daemonOrigin = new URL(OLLAMA_CONFIG.host).origin
					const chats = session.requests
						.slice(mark)
						.filter(
							(request) =>
								request.method === 'POST' &&
								new URL(request.url).origin === daemonOrigin &&
								new URL(request.url).pathname === OLLAMA_CHAT_PATH,
						)
					expect(chats.length).toBeGreaterThanOrEqual(1)
					// The prompt the page passed is what left the page: the recorded POST body carries
					// it, so the turn exercised the question rather than an empty user message.
					expect(
						chats.filter((request) => (request.post ?? '').includes(CAPITAL.prompt)),
					).toHaveLength(1)
					// Nothing reached the relay: this page talked to the daemon itself.
					expect(
						session.fixture.requests.filter((request) => request.path === INFERENCE_PATH),
					).toEqual([])
				},
			)
		},
		PAGE_BOUNDS.case,
	)
})

describe('Agent tool loop in a real page (live) — the attempt bound', () => {
	it(
		'ends an over-long attempt on its own allowance and leaves no browser behind',
		async () => {
			// An allowance no browser acquisition fits. The failure names the attempt's own
			// allowance rather than whichever CDP command timed out first, which is the reading
			// the installed browser surface produces by itself for every phase its own signal
			// does not reach: those calls take a per-call `timeout` and no signal, so one call's
			// deadline never bounds the call that contains it. The elapsed time is asserted beside
			// the message, because the message alone is also what an attempt that reported its
			// bound and then waited past it would produce.
			const launched = performance.now()
			const outran = await boundPageAttempt(
				{ attempt: PAGE_INTERVALS.launch, release: PAGE_BOUNDS.release },
				(signal) => createPageSession({ ...SESSION, signal }),
				() => Promise.resolve(),
			).then(
				() => undefined,
				(thrown: unknown) => thrown,
			)
			expect(describeFailure(outran)).toContain(
				`the page attempt exceeded its ${PAGE_INTERVALS.launch} ms allowance`,
			)
			expect(performance.now() - launched).toBeLessThanOrEqual(
				PAGE_INTERVALS.launch + PAGE_BOUNDS.release,
			)

			// An allowance the acquisition fits and the observation does not. The observation
			// parks on a signal of its own rather than the attempt's, because a wait on the
			// attempt's signal would end at the same instant the deadline fires and leave
			// nothing in flight for the bound to cut.
			let acquired: PageSessionInterface | undefined
			const observed = performance.now()
			const interrupted = await boundPageAttempt(
				{ attempt: PAGE_INTERVALS.observe, release: PAGE_BOUNDS.release },
				(signal) => createPageSession({ ...SESSION, signal }),
				async (session) => {
					acquired = session
					await waitForAbort(new AbortController().signal)
				},
			).then(
				() => undefined,
				(thrown: unknown) => thrown,
			)
			expect(describeFailure(interrupted)).toContain(
				`the page attempt exceeded its ${PAGE_INTERVALS.observe} ms allowance`,
			)
			expect(performance.now() - observed).toBeLessThanOrEqual(
				PAGE_INTERVALS.observe + PAGE_BOUNDS.release,
			)

			// The session that attempt acquired is released before the rejection reaches here, so
			// the page refuses the next call it is given. A browser left running would answer it.
			const released = requireValue(
				acquired,
				`the attempt acquired no session within ${PAGE_INTERVALS.observe} ms`,
			)
			const refused = await released.page.evaluate('1', PAGE_BOUNDS.read).then(
				() => undefined,
				(thrown: unknown) => thrown,
			)
			expect(refused).toBeInstanceOf(Error)
		},
		PAGE_BOUNDS.case,
	)

	it(
		'releases the acquisition its deadline outran instead of waiting on it',
		async () => {
			// A real acquisition that settles after the allowance is gone. The held step is a
			// deliberate delay rather than a wait on anything the host produces: the interleaving
			// this case exists for is the one where the attempt has already rejected and a live
			// browser is still on its way back, which is the reading A13d executed against the
			// installed `BrowserContext` and found unbounded.
			let delayed: PageSessionInterface | undefined
			const started = performance.now()
			const outran = await boundPageAttempt(
				{ attempt: PAGE_INTERVALS.late, release: PAGE_BOUNDS.release },
				(signal) =>
					createPageSession({ ...SESSION, signal }).then(async (session) => {
						delayed = session
						await waitForDelay(PAGE_INTERVALS.hold)
						return session
					}),
				() => Promise.resolve(),
			).then(
				() => undefined,
				(thrown: unknown) => thrown,
			)
			expect(describeFailure(outran)).toContain(
				`the page attempt exceeded its ${PAGE_INTERVALS.late} ms allowance`,
			)
			// Inside the share the losing acquisition settled, so the attempt reports its own
			// allowance alone and never names a stranded browser.
			expect(describeFailure(outran)).not.toContain('stranding the browser')
			expect(performance.now() - started).toBeLessThanOrEqual(
				PAGE_INTERVALS.late + PAGE_BOUNDS.release,
			)

			// The browser that acquisition was still holding is released, so the page refuses the
			// next call it is given. An attempt that abandoned its losing acquisition would leave
			// this one answering.
			const released = requireValue(
				delayed,
				`the acquisition took no session within ${PAGE_INTERVALS.late + PAGE_INTERVALS.hold} ms`,
			)
			const refused = await released.page.evaluate('1', PAGE_BOUNDS.read).then(
				() => undefined,
				(thrown: unknown) => thrown,
			)
			expect(refused).toBeInstanceOf(Error)
		},
		PAGE_BOUNDS.case,
	)

	it(
		'refuses an attempt whose release crossed its allowance',
		async () => {
			// The observation completes while the allowance holds and the release crosses it. The
			// attempt's elapsed total is what the allowance is about, so this is a failure naming
			// the release rather than the success the observation on its own would report.
			let crossed: PageSessionInterface | undefined
			const started = performance.now()
			const late = await boundPageAttempt(
				{ attempt: PAGE_INTERVALS.late, release: PAGE_BOUNDS.release },
				(signal) =>
					createPageSession({ ...SESSION, signal }).then((session) => {
						crossed = session
						return {
							...session,
							async destroy() {
								await waitForDelay(PAGE_INTERVALS.hold)
								await session.destroy()
							},
						}
					}),
				() => Promise.resolve('the observation settled'),
			).then(
				() => undefined,
				(thrown: unknown) => thrown,
			)
			expect(describeFailure(late)).toBe(
				`the page attempt released its browser after its ${PAGE_INTERVALS.late} ms allowance had expired`,
			)
			expect(performance.now() - started).toBeLessThanOrEqual(
				PAGE_INTERVALS.late + PAGE_BOUNDS.release,
			)

			// The release the attempt waited for still ran, so the failure reports a crossed
			// allowance rather than a browser nobody released.
			const released = requireValue(
				crossed,
				`the acquisition took no session within ${PAGE_INTERVALS.late} ms`,
			)
			const refused = await released.page.evaluate('1', PAGE_BOUNDS.read).then(
				() => undefined,
				(thrown: unknown) => thrown,
			)
			expect(refused).toBeInstanceOf(Error)
		},
		PAGE_BOUNDS.case,
	)
})
