import type { AgentChunk, Message } from '@orkestrel/agent'
// The hermetic half of `tests/setupStore.ts`. That module serves the store the live
// browser-vocabulary proof drives, runs one model attempt over it, and reads the
// transcript the attempt leaves. The live half — that a real model drives a real Chromium
// through the toolset over this store — is `tests/service/browser.test.ts`.
//
// The attempt-isolation proof drives a real browser without a daemon. The other proofs cover
// every page's shape read with a plain `fetch`, the per-instance state the pages change,
// the whole-page reading `read` slices
// (the browser package's own `createBrowserReading` over the served HTML), and every pure
// reader the live proof asserts through.

import type { ToolCall, ToolResult } from '@orkestrel/tool'
import type {
	StoreCall,
	StoreExposure,
	StoreServerInterface,
	StoreThought,
	StoreTiming,
	StoreTurn,
} from './setupStore.js'
import { createChannel, DEFAULT_PROVIDER_TIMEOUT, ProviderError } from '@orkestrel/agent'
import {
	BROWSER_TOOL_COPY,
	BROWSER_TOOL_LIMIT,
	createBrowserReading,
	createBrowserToolset,
	scanBrowserLines,
	renderBrowserJourney,
} from '@orkestrel/browser'
import { createFileBrowserJourneyStore, createFileBrowserRunStore } from '@orkestrel/browser/server'
import { collect, createRecorder, requireValue, waitForCondition } from '@orkestrel/test'
import { createScratch, readInventory } from '@orkestrel/test/server'
import { createToolManager } from '@orkestrel/tool'
import { createOllama } from '@src/core'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	STORE_TIMED_CALLS,
	STORE_STAGGERED_CALLS,
	STORE_STAGGERED_DELAYS,
	STORE_BROKEN_CALL,
	STORE_BROKEN_CALLS,
	STORE_THOUGHT_CASES,
	createStaggeredTools,
	createRejectingTools,
	deriveTurnThinking,
	executeTimedTool,
	StoreTimer,
	STORE_REFERENCE_CALLS,
	STORE_MALFORMED_CALLS,
	STORE_EDIT_DEFINITION,
	STORE_VALID_EDITS,
	STORE_INVALID_EDITS,
	STORE_ACCEPTED_EXPOSURES,
	STORE_SEEDED_ANSWERS,
	STORE_PROMPT_TOOLS,
	STORE_ISOLATION_ATTEMPTS,
	STORE_JOURNEY_ORDERS,
	STORE_THINKING_CHUNKS,
	stemWord,
	findStoreProduct,
	buildMissingResponse,
	collectTurnThinking,
	extractPageHeader,
	readCapturedNumber,
	matchesCartClick,
	resolveTranscriptPath,
	buildRefusedCall,
	createPageBrowser,
	executeStoreCall,
	createRefusalTools,
	STORE_FIRST_SLICE,
	STORE_CONTINUED_SLICE,
	STORE_STALLED_SEARCH,
	STORE_EMPTY_RESULTS_SEARCH,
	STORE_CLICKED_SEARCH,
	STORE_COMPLETED_SEARCH,
	STORE_EDITED_JOURNEY,
	STORE_SAVED_LISTING,
	STORE_EDITS,
	STORE_JOURNEY_CALLS,
	writeJourneyFiles,
	buildJourneyTranscript,
	STORE_FEATURED,
	STORE_UNFEATURED,
	STORE_CART_CALLS,
	STORE_EXPOSURE_SCENARIOS,
	STORE_JOURNEY_ACTIONS,
	buildRefusedTranscripts,
	STORE_ORACLE_CASES,
	STORE_REFUSED_CARTS,
	STORE_REFUSED_ORDERS,
	buildExposureChanges,
	buildJourneyInvocation,
	buildLazyCalls,
	StoreContinuationWalk,
	StoreExposureTrace,
	StoreRefusals,
	StoreThinking,
	STORE_SEARCH_SEED,
	createStoreContext,
	extractWindowText,
	settleStoreRun,
	StoreActivity,
	StoreCallRecord,
	STORE_ANSWER_SCOPE,
	STORE_STALE_CONTINUATIONS,
	STORE_CONTINUATION_INTERRUPTIONS,
	STORE_INVALID_CONTINUATIONS,
	STORE_UNBATCHED_LISTINGS,
	STORE_REFUSED_RECORD,
	STORE_REFUSED_SAVE,
	STORE_FAIL_TURN,
	STORE_LOOKUP_TURN,
	STORE_MIXED_TURN,
	STORE_REFUSAL_TURNS,
	STORE_REFUSAL_TOOLS,
	STORE_THINKING_MESSAGES,
	attachThinking,
	attemptStoreTask,
	buildStoreCall,
	buildStorePrompt,
	buildStoreTranscript,
	computeRefusals,
	converseStore,
	createStoreServer,
	createTimedProvider,
	createTimedTools,
	escapeMarkup,
	parseFooterLine,
	extractJourneyEvidence,
	extractReferences,
	parseWindowLine,
	filterNamedProducts,
	filterProducts,
	filterSubmissionLines,
	findBoundParameter,
	findContinuedRead,
	findJourneyLoops,
	findMalformedCalls,
	findUnlistedReferences,
	filterPageTools,
	resolveJourneyPath,
	matchesDaemonFault,
	matchesJourneyBatch,
	matchesJourneyOracle,
	matchesJourneySequence,
	matchesNameBinding,
	matchesPagingOracle,
	matchesProducts,
	matchesShippingOracle,
	matchesCartOracle,
	matchesCheckoutOracle,
	STORE_POLICY,
	STORE_SEED_ARGUMENTS,
	STORE_PREDICATES,
	matchesRemovedCart,
	matchesSearchOracle,
	matchesStalledSearch,
	matchesStoreOracles,
	normalizeAnswer,
	parseJourneyEdits,
	parseStoreJSON,
	renderJourneyEdit,
	renderToolText,
	splitResultFooter,
	STORE_BOUNDS,
	STORE_BUYER,
	STORE_CODE,
	STORE_CODE_DELAY,
	STORE_FACT,
	STORE_JOURNEY_BOUNDS,
	STORE_JOURNEY_BUYER,
	STORE_JOURNEY_NAME,
	STORE_JOURNEY_PARAMETER,
	STORE_JOURNEY_PROMPT,
	STORE_JOURNEY_SEQUENCE,
	STORE_NAMED_PRODUCT,
	STORE_POLICY_TOKEN,
	STORE_PRODUCTS,
	STORE_QUERY,
	STORE_SYSTEM_PROMPT,
	STORE_TASKS,
	writeTranscript,
} from './setupStore.js'
import {
	buildClosingList,
	buildIteratorlessList,
	buildSparseList,
	buildTracedRecord,
	buildWatched,
	CASE_TIMEOUT,
} from './setup.js'
import {
	LOOKUP_DATUM,
	THROWING_TOOL_MESSAGE,
	createLookupTool,
	createRecordingTransport,
	createScriptedTransport,
	createThrowingTool,
	wireTools,
} from './setupServer.js'

const staging = Promise.withResolvers<StoreServerInterface>()

describe('real line projection', () => {
	it(
		'accepts the measured cart path through refused type calls',
		async () => {
			const fresh = await createStoreServer()
			const browser = await createPageBrowser()
			try {
				await browser.connect()
				const context = await browser.isolate()
				const page = await context.create()
				await page.navigate(fresh.url)
				const toolset = createBrowserToolset(page)
				try {
					await toolset.start()
					const seed = renderToolText(
						await toolset.tools.execute({
							id: 'seed',
							name: 'read',
							arguments: STORE_SEED_ARGUMENTS,
						}),
					)
					const calls: StoreCall[] = []
					for (const call of STORE_CART_CALLS) {
						calls.push(
							await executeStoreCall(
								toolset.tools,
								String(calls.length),
								call.name,
								call.arguments,
							),
						)
					}
					expect(calls.map((call) => call.success)).toEqual([true, false, true, false, true])
					for (const call of calls.filter((entry) => !entry.success))
						expect(call.text).toContain('takes no text;')
					expect(fresh.read().cart).toEqual([STORE_NAMED_PRODUCT])
					expect(findUnlistedReferences(seed, calls)).toEqual([])
					expect(
						matchesCartOracle({
							...buildStoreTranscript(calls, seed),
							state: fresh.read(),
						}),
					).toBe(true)
				} finally {
					await toolset.destroy()
				}
			} finally {
				await browser.destroy()
				await fresh.stop()
			}
		},
		CASE_TIMEOUT,
	)
	it(
		'applies the reference-exposure rule to successful reads, page changes, actions, and refusals',
		async () => {
			const fresh = await createStoreServer()
			const browser = await createPageBrowser()
			try {
				await browser.connect()
				for (const scenario of STORE_EXPOSURE_SCENARIOS) {
					const context = await browser.isolate()
					try {
						const page = await context.create()
						await page.navigate(fresh.url)
						const toolset = createBrowserToolset(page)
						try {
							await toolset.start()
							const seed = renderToolText(
								await toolset.tools.execute({
									id: 'seed',
									name: 'read',
									arguments: STORE_SEED_ARGUMENTS,
								}),
							)
							const calls: StoreCall[] = []
							if (scenario === 'changed' || scenario === 'refused')
								await page.navigate(`${fresh.url}/policy`)
							if (scenario === 'unchanged' || scenario === 'bestmatch' || scenario === 'changed') {
								const input =
									scenario === 'bestmatch'
										? { from: 46, to: 52, search: STORE_NAMED_PRODUCT }
										: { from: 46, to: 52 }
								calls.push(await executeStoreCall(toolset.tools, 'read', 'read', input))
							}
							for (const call of calls) expect(call.success).toBe(true)
							for (const call of calls.filter(
								(entry) => entry.arguments['search'] === STORE_NAMED_PRODUCT,
							)) {
								expect(call.text).toContain('the best match is line 11:')
								expect(extractReferences(call.text)).toEqual(['e7'])
								expect(parseWindowLine(call.text)).toBe(46)
							}
							// A fresh read after the out-of-band navigation invalidates the tool's own reference map.
							if (scenario === 'refused')
								await toolset.tools.execute({ id: 'refresh', name: 'read', arguments: { from: 1 } })
							const input = { ref: scenario === 'invented' ? 'e99999' : 'e7' }
							const action = await executeStoreCall(toolset.tools, 'click', 'click', input)
							calls.push(action)
							const accepted = STORE_ACCEPTED_EXPOSURES.includes(scenario)
							expect(action.success).toBe(accepted)
							expect(/not in the current view|is not on this page/.test(action.text)).toBe(
								!accepted,
							)
							expect(findUnlistedReferences(seed, calls)).toEqual(accepted ? [] : [action])
						} finally {
							await toolset.destroy()
						}
					} finally {
						await context.close()
					}
				}
			} finally {
				await browser.destroy()
				await fresh.stop()
			}
		},
		CASE_TIMEOUT,
	)
	it(
		'records a cart click and one submission, removes the click, and replays exactly one order for the other buyer',
		async () => {
			mkdirSync(resolveJourneyPath(), { recursive: true })
			const fresh = await createStoreServer()
			const root = createScratch({ parent: resolveJourneyPath(), prefix: 'journey-proof-' })
			const browser = await createPageBrowser()
			try {
				await browser.connect()
				const context = await browser.isolate()
				const page = await context.create()
				await page.navigate(fresh.url)
				const tools = createBrowserToolset(page, {
					journeys: {
						store: createFileBrowserJourneyStore({ root: root.path }),
						runs: createFileBrowserRunStore({ root: root.path }),
					},
				})
				try {
					await tools.start()
					const seed = renderToolText(
						await tools.tools.execute({ id: 'seed', name: 'read', arguments: { from: 1 } }),
					)
					const calls: StoreCall[] = []
					for (const action of STORE_JOURNEY_ACTIONS) {
						const { name, input } = buildJourneyInvocation(action, calls, seed)
						const call = await executeStoreCall(tools.tools, action, name, input)
						expect(call).toMatchObject({ success: true })
						calls.push(call)
					}
					const transcript = {
						...buildStoreTranscript(calls, seed),
						name: 'journey',
						files: readInventory(root.path, ['.'], { extensions: ['.json'] }),
						state: fresh.read(),
					}
					expect(transcript.state.orders).toEqual([STORE_BUYER, STORE_JOURNEY_BUYER])
					expect(matchesJourneyOracle(transcript)).toBe(true)
					expect(
						filterSubmissionLines(requireValue(calls.find((call) => call.name === 'save')).text),
					).toHaveLength(1)
					for (const refused of buildRefusedTranscripts(
						transcript,
						(STORE_TASKS.journey.limit ?? STORE_BOUNDS.limit) +
							STORE_TASKS.journey.followups.length * STORE_BOUNDS.limit,
					))
						expect(matchesJourneyOracle(refused)).toBe(false)
				} finally {
					await tools.destroy()
				}
			} finally {
				await browser.destroy()
				root.destroy()
				await fresh.stop()
			}
		},
		CASE_TIMEOUT,
	)

	it(
		'places the fact beyond the seed and the token in the third default window',
		async () => {
			const store = await staging.promise
			const browser = await createPageBrowser()
			try {
				await browser.connect()
				const context = await browser.isolate()
				const page = await context.create()
				await page.navigate(store.url)
				const tools = createBrowserToolset(page)
				try {
					await tools.start()

					const seed = renderToolText(
						await tools.tools.execute({
							id: 'seed',
							name: 'read',
							arguments: STORE_SEED_ARGUMENTS,
						}),
					)
					expect(seed).not.toContain(STORE_FACT)
					expect(seed).not.toContain(STORE_POLICY_TOKEN)
					const catalogueNext = requireValue(parseFooterLine(seed))
					const shipping = renderToolText(
						await tools.tools.execute({
							id: 'shipping',
							name: 'read',
							arguments: { from: 1, search: 'shipping cutoff' },
						}),
					)
					expect(shipping).toContain(STORE_FACT)
					const fact = Number(
						requireValue(shipping.split(/\r\n|\n/).find((line) => line.includes(STORE_FACT))).split(
							': ',
						)[0],
					)
					expect(fact).toBeGreaterThan(catalogueNext - 1)
					expect(fact).toBe(52)
					expect(catalogueNext).toBe(46)
					await page.navigate(`${store.url}/policy`)
					const policy = renderToolText(
						await tools.tools.execute({
							id: 'policy',
							name: 'read',
							arguments: STORE_SEED_ARGUMENTS,
						}),
					)
					const second = requireValue(parseFooterLine(policy))
					const middle = renderToolText(
						await tools.tools.execute({ id: 'middle', name: 'read', arguments: { from: second } }),
					)
					const third = requireValue(parseFooterLine(middle))
					const last = renderToolText(
						await tools.tools.execute({ id: 'last', name: 'read', arguments: { from: third } }),
					)
					expect(policy).not.toContain(STORE_POLICY_TOKEN)
					expect(middle).not.toContain(STORE_POLICY_TOKEN)
					expect(last).toContain(STORE_POLICY_TOKEN)
					const token = Number(
						requireValue(
							last.split(/\r\n|\n/).find((line) => line.includes(STORE_POLICY_TOKEN)),
						).split(': ')[0],
					)
					expect(token).toBeGreaterThan(third - 1)
					expect(token).toBe(80)
					expect(second).toBe(33)
					expect(third).toBe(61)
					expect(
						matchesPagingOracle(
							buildStoreTranscript(
								[
									buildStoreCall('read', { from: second }, middle),
									buildStoreCall('read', { from: third }, last),
								],
								policy,
							),
						),
					).toBe(true)
					expect(
						matchesPagingOracle(
							buildStoreTranscript([buildStoreCall('read', { from: second }, middle)], policy),
						),
					).toBe(false)
					for (const text of [seed, shipping, policy, middle, last])
						expect(text.length).toBeLessThanOrEqual(BROWSER_TOOL_LIMIT)
				} finally {
					await tools.destroy()
				}
			} finally {
				await browser.destroy()
			}
		},
		CASE_TIMEOUT,
	)

	it('gives the token section no prefix-rule word from the paging prompt', () => {
		const section = requireValue(STORE_POLICY.at(-1)).join(' ')
		expect(
			scanBrowserLines(
				[{ spans: [{ category: 'text', text: section }] }],
				STORE_TASKS.paging.prompt,
			),
		).toEqual([])
		expect(
			scanBrowserLines([{ spans: [{ category: 'text', text: section }] }], 'quoting version'),
		).toEqual([1])
	})
})

describe('case predicates', () => {
	it('accepts each page case and rejects every shared refusal including a whole result over the limit', () => {
		for (const { predicate, transcript } of STORE_ORACLE_CASES) {
			expect(predicate(transcript)).toBe(true)
			for (const refused of buildRefusedTranscripts(transcript, STORE_BOUNDS.limit))
				expect(predicate(refused)).toBe(false)
		}
		expect(Object.keys(STORE_PREDICATES)).toEqual(Object.keys(STORE_TASKS))
	})
	it('refuses missing fact evidence, the seed fact, an incorrect cart, and duplicate or wrong orders', () => {
		const shipping = {
			...buildStoreTranscript([buildStoreCall('read', { from: 1 }, STORE_FACT)]),
			answer: STORE_FACT,
		}
		expect(matchesShippingOracle({ ...shipping, seed: STORE_FACT })).toBe(false)
		expect(matchesShippingOracle({ ...shipping, answer: '' })).toBe(false)
		expect(
			matchesShippingOracle({ ...shipping, calls: [buildStoreCall('click', {}, STORE_FACT)] }),
		).toBe(false)
		expect(
			matchesShippingOracle({
				...shipping,
				calls: [buildRefusedCall('read', { from: 1 }, STORE_FACT)],
			}),
		).toBe(false)
		for (const cart of STORE_REFUSED_CARTS)
			expect(matchesCartOracle({ ...shipping, state: { ...shipping.state, cart } })).toBe(false)
		for (const orders of STORE_REFUSED_ORDERS)
			expect(
				matchesCheckoutOracle({
					...shipping,
					answer: STORE_CODE,
					state: { ...shipping.state, orders },
				}),
			).toBe(false)
		expect(
			matchesCheckoutOracle({ ...shipping, state: { ...shipping.state, orders: [STORE_BUYER] } }),
		).toBe(false)
	})
})

describe('monotonic operation timing', () => {
	it('records successful and refused tools without freezing the advertised registry', async () => {
		const tools = createToolManager()
		tools.add(createLookupTool())
		const timer = new StoreTimer()
		const measured = createTimedTools(tools, timer)
		expect(measured.definitions()).toEqual(tools.definitions())
		tools.add(createThrowingTool())
		expect(measured.definitions()).toEqual(tools.definitions())
		const calls = STORE_TIMED_CALLS
		const result = await measured.execute(calls)
		expect(result.map((entry) => entry.success)).toEqual([true, false])
		const timings = timer.read()
		expect(timings.map((timing) => timing.name).sort()).toEqual(['lookup', 'missing'])
		for (const timing of timings) {
			expect(timing.operation).toBe('tool')
			expect(timing.end).toBeGreaterThan(timing.start)
		}
		tools.destroy()
	})

	it('records an interval that spans the real delay of each parallel call', async () => {
		const tools = createStaggeredTools()
		const timer = new StoreTimer()
		await createTimedTools(tools, timer).execute(STORE_STAGGERED_CALLS)
		const spans = new Map(timer.read().map((timing) => [timing.name, timing.end - timing.start]))
		for (const [name, delay] of STORE_STAGGERED_DELAYS) {
			const span = requireValue(spans.get(name), `the timer lost the ${name} interval`)
			expect(span).toBeGreaterThan(0)
			expect(span).toBeGreaterThanOrEqual(delay / 2)
		}
		tools.destroy()
	})

	it('records a generation and a failed stream without changing their result or error', async () => {
		const timer = new StoreTimer()
		const provider = createTimedProvider(
			createOllama({
				model: 'fixture',
				fetch: createScriptedTransport([{ content: 'Measured.' }]),
			}),
			timer,
		)
		const signal = AbortSignal.timeout(5000)
		expect(
			(await provider.generate([{ id: '1', role: 'user', content: 'Answer.' }], signal)).content,
		).toBe('Measured.')
		const stream = provider.stream([{ id: '2', role: 'user', content: 'Answer again.' }], signal)
		await expect(stream.next()).rejects.toThrow('the script holds 1 turns')
		const timings = timer.read()
		expect(timings).toHaveLength(2)
		for (const timing of timings) {
			expect(timing.operation).toBe('generation')
			expect(timing.end).toBeGreaterThan(timing.start)
		}
	})

	it('records parallel tool calls in the order they finish, not the order they were dispatched', async () => {
		const tools = createStaggeredTools()
		const timer = new StoreTimer()
		const results = await createTimedTools(tools, timer).execute(STORE_STAGGERED_CALLS)
		expect(results.map((entry) => entry.success && entry.value)).toEqual(
			STORE_STAGGERED_CALLS.map((call) => call.name),
		)
		expect(timer.read().map((timing) => timing.name)).toEqual(
			STORE_STAGGERED_DELAYS.map(([name]) => name).toReversed(),
		)
		tools.destroy()
	})

	it('records the interval of a rejected call and of the calls still pending when it rejects', async () => {
		const tools = createStaggeredTools()
		const failure = new Error('Dispatch refused')
		const timer = new StoreTimer()
		const measured = createTimedTools(
			createRejectingTools(tools, STORE_BROKEN_CALL.name, failure),
			timer,
		)
		await expect(measured.execute(STORE_BROKEN_CALLS)).rejects.toBe(failure)
		await waitForCondition(
			'every dispatched call to record its interval',
			() => timer.read().length === STORE_BROKEN_CALLS.length,
		)
		const timings = timer.read()
		expect(timings.map((timing) => timing.name)).toEqual(['broken', 'fast', 'slow'])
		for (const timing of timings) {
			expect(timing.operation).toBe('tool')
			expect(timing.end).toBeGreaterThan(timing.start)
		}
		tools.destroy()
	})

	it('records the interval of one call that rejects and returns the registry result of one that does not', async () => {
		const tools = createStaggeredTools()
		const failure = new Error('Dispatch refused')
		const timer = new StoreTimer()
		const rejecting = createRejectingTools(tools, STORE_BROKEN_CALL.name, failure)
		await expect(executeTimedTool(rejecting, STORE_BROKEN_CALL, timer)).rejects.toBe(failure)
		const accepted = requireValue(STORE_STAGGERED_CALLS.at(-1))
		const result = await executeTimedTool(rejecting, accepted, timer)
		expect(result).toMatchObject({ success: true, value: 'fast' })
		expect(timer.read().map((timing) => [timing.operation, timing.name])).toEqual([
			['tool', 'broken'],
			['tool', 'fast'],
		])
		tools.destroy()
	})
})

describe('StoreTimer', () => {
	it('reads nothing before an interval is recorded', () => {
		expect(new StoreTimer().read()).toEqual([])
	})

	it('reads the intervals in the order they were recorded with every field', () => {
		const timer = new StoreTimer()
		const later: StoreTiming = { operation: 'seed', name: 'read', start: 5, end: 9 }
		const earlier: StoreTiming = { operation: 'tool', name: 'click', start: 1, end: 12 }
		timer.record(later)
		timer.record(earlier)
		expect(timer.read()).toEqual([later, earlier])
	})

	it('reads a copy, so a later interval leaves an earlier reading unchanged', () => {
		const timer = new StoreTimer()
		const first: StoreTiming = { operation: 'generation', name: 'fixture', start: 0, end: 2 }
		const second: StoreTiming = { operation: 'reload', name: 'page', start: 3, end: 4 }
		timer.record(first)
		const reading = timer.read()
		timer.record(second)
		expect(reading).toEqual([first])
		expect(timer.read()).toEqual([first, second])
		expect(timer.read()).not.toBe(timer.read())
	})
})

beforeAll(async () => {
	staging.resolve(await createStoreServer())
})

afterAll(async () => {
	await (await staging.promise).stop()
})

describe('createStoreServer', () => {
	it('returns state snapshots that remain unchanged after later requests', async () => {
		const fresh = await createStoreServer()
		try {
			const before = fresh.read()
			await fetch(`${fresh.url}/search?q=kettle`)
			await fetch(`${fresh.url}/order`, { method: 'POST', body: STORE_BUYER })
			await fetch(`${fresh.url}/cart`, { method: 'POST', body: 'product=p3' })
			expect(before).toEqual({ cart: [], searches: [], orders: [] })
			expect(fresh.read()).toEqual({
				cart: ['Cedar Tea Tray'],
				searches: ['kettle'],
				orders: ['Ada Lovelace'],
			})
		} finally {
			await fresh.stop()
		}
	})

	it('listens on the IPv4 loopback on an ephemeral port', async () => {
		const store = await staging.promise
		expect(store.url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/)
	})

	it('serves the catalogue with the search form and every featured product with its price', async () => {
		const store = await staging.promise
		const response = await fetch(`${store.url}/`)
		const html = await response.text()
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
		expect(html).toContain('<form action="/search" method="get" role="search">')
		expect(html).toContain('<input id="q" type="search" name="q">')
		const featured = STORE_FEATURED.map((name) =>
			requireValue(STORE_PRODUCTS.find((product) => product.name === name)),
		)
		for (const product of featured) {
			expect(html).toContain(`<a href="/product/${product.id}">${product.name}</a>`)
			expect(html).toContain(product.price)
		}
		for (const name of STORE_UNFEATURED) {
			expect(html).not.toContain(name)
		}
	})

	it('lists none of the products the search task must find, so only a search names them', async () => {
		const store = await staging.promise
		const html = await (await fetch(`${store.url}/`)).text()
		const matches = filterProducts(STORE_QUERY)
		expect(matches.length).toBeGreaterThan(0)
		for (const product of matches) expect(html).not.toContain(product.name)
	})

	it('states the shipping cutoff once, after the customer notes, beyond the first read slice', async () => {
		const store = await staging.promise
		const html = await (await fetch(`${store.url}/`)).text()
		expect(html.split(STORE_FACT)).toHaveLength(2)
		expect(html.indexOf(STORE_FACT)).toBeGreaterThan(html.indexOf('</aside>'))
		const markdown = createBrowserReading({ url: `${store.url}/`, title: '', html }).markdown().text
		expect(markdown).toContain('What customers say')
		expect(markdown.split(STORE_FACT)).toHaveLength(2)
		expect(markdown.indexOf(STORE_FACT)).toBeGreaterThan(markdown.indexOf('What customers say'))
		expect(markdown.indexOf(STORE_FACT)).toBeGreaterThan(BROWSER_TOOL_LIMIT)
	})

	it('records each submitted query and lists exactly the products whose name matches it', async () => {
		const store = await staging.promise
		const before = store.read().searches.length
		const response = await fetch(`${store.url}/search?q=${STORE_QUERY}`)
		const html = await response.text()
		expect(response.status).toBe(200)
		expect(store.read().searches.slice(before)).toEqual([STORE_QUERY])
		const matches = filterProducts(STORE_QUERY)
		expect(matches.map((product) => product.name)).toEqual(['Alpine Kettle', 'Copper Kettle'])
		for (const product of STORE_PRODUCTS) {
			expect(html.includes(product.name)).toBe(matches.includes(product))
		}
	})

	it('starts with the requested products in the cart, which the journey task holds one of', async () => {
		const seeded = await createStoreServer(0, [STORE_NAMED_PRODUCT])
		try {
			expect(seeded.read().cart).toEqual([STORE_NAMED_PRODUCT])
			const html = await (await fetch(`${seeded.url}/cart`)).text()
			expect(html).toContain(STORE_NAMED_PRODUCT)
			expect(html).not.toContain('Your cart is empty.')
		} finally {
			await seeded.stop()
		}
		expect(STORE_TASKS.journey.cart).toEqual([STORE_NAMED_PRODUCT])
	})

	it('answers a query nothing matches with a page that names no product', async () => {
		const store = await staging.promise
		const html = await (await fetch(`${store.url}/search?q=anchor`)).text()
		expect(html).toContain('No products match.')
		for (const product of STORE_PRODUCTS) expect(html).not.toContain(product.name)
	})

	it('serves each product page with its add-to-cart form, and 404 for an unknown product', async () => {
		const store = await staging.promise
		for (const product of STORE_PRODUCTS) {
			const response = await fetch(`${store.url}/product/${product.id}`)
			const html = await response.text()
			expect(response.status).toBe(200)
			expect(html).toContain(`<h1>${product.name}</h1>`)
			expect(html).toContain(product.price)
			expect(html).toContain('<form action="/cart" method="post">')
			expect(html).toContain(`<input type="hidden" name="product" value="${product.id}">`)
			expect(html).toContain('<button type="submit">Add to cart</button>')
		}
		expect((await fetch(`${store.url}/product/p0`)).status).toBe(404)
	})

	it('adds a posted product to this server cart alone, redirects to the cart, and lists it there', async () => {
		const store = await staging.promise
		const other = await createStoreServer()
		try {
			const named = STORE_PRODUCTS.find((product) => product.name === STORE_NAMED_PRODUCT)
			expect(named).toBeDefined()
			const added = await fetch(`${store.url}/cart`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: `product=${named?.id ?? ''}`,
				redirect: 'manual',
			})
			expect(added.status).toBe(303)
			expect(added.headers.get('location')).toBe('/cart')
			expect(store.read().cart).toEqual([STORE_NAMED_PRODUCT])
			expect(other.read().cart).toEqual([])
			expect(await (await fetch(`${store.url}/cart`)).text()).toContain(
				`<li>${STORE_NAMED_PRODUCT}</li>`,
			)
			const refused = await fetch(`${store.url}/cart`, { method: 'POST', body: 'product=p0' })
			expect(refused.status).toBe(404)
			expect(store.read().cart).toEqual([STORE_NAMED_PRODUCT])
		} finally {
			await other.stop()
		}
	})

	it('shows an empty cart on a fresh server', async () => {
		const other = await createStoreServer()
		try {
			expect(await (await fetch(`${other.url}/cart`)).text()).toContain('Your cart is empty.')
		} finally {
			await other.stop()
		}
	})

	it('serves a checkout whose script inserts the code only after an order, and records the order', async () => {
		const store = await staging.promise
		const html = await (await fetch(`${store.url}/checkout`)).text()
		expect(html).toContain('<form id="checkout">')
		expect(html).toContain('<input id="name" type="text" name="name" autocomplete="off">')
		expect(html).toContain('<button type="submit">Place order</button>')
		expect(html).toContain(`}, ${STORE_CODE_DELAY})`)
		expect(html).not.toContain(STORE_CODE)
		const order = await fetch(`${store.url}/order`, { method: 'POST', body: 'Grace Hopper' })
		expect(await order.text()).toBe(STORE_CODE)
		expect(store.read().orders).toEqual(['Grace Hopper'])
	})

	it('states the policy token past the first 4 000 characters of the whole-page policy', async () => {
		const store = await staging.promise
		const response = await fetch(`${store.url}/policy`)
		const html = await response.text()
		expect(response.status).toBe(200)
		const markdown = createBrowserReading({
			url: `${store.url}/policy`,
			title: '',
			html,
		}).markdown().text
		expect(markdown.indexOf(STORE_POLICY_TOKEN)).toBeGreaterThan(BROWSER_TOOL_LIMIT)
	})

	it('serves the page every task starts on', async () => {
		const store = await staging.promise
		for (const task of Object.values(STORE_TASKS)) {
			expect((await fetch(`${store.url}${task.path}`)).status).toBe(200)
		}
	})
})

describe('escapeMarkup', () => {
	it('escapes the characters HTML reads as markup and leaves the rest', () => {
		expect(escapeMarkup('Tea & "cakes" <b>')).toBe('Tea &amp; &quot;cakes&quot; &lt;b&gt;')
		expect(escapeMarkup('')).toBe('')
	})
})

describe('filterProducts', () => {
	it('compares exact product membership and order, including empty lists', () => {
		const matches = filterProducts('kettle')
		expect(matchesProducts(matches, [...matches])).toBe(true)
		expect(matchesProducts([], [])).toBe(true)
		expect(matchesProducts(matches, [])).toBe(false)
		expect(matchesProducts(matches, [...matches].reverse())).toBe(false)
	})
	it('matches a name word regardless of case and surrounding space', () => {
		expect(filterProducts(' TRAY ').map((product) => product.name)).toEqual(['Cedar Tea Tray'])
	})

	it('returns the same products for a plural and a singular word', () => {
		const plural = filterProducts('kettles').map((product) => product.name)
		expect(plural.length).toBeGreaterThan(0)
		expect(plural).toEqual(filterProducts('kettle').map((product) => product.name))
	})

	it('requires every query word to match', () => {
		expect(filterProducts('tea tray').map((product) => product.name)).toEqual(['Cedar Tea Tray'])
		expect(filterProducts('alpine kettle').map((product) => product.name)).toEqual([
			'Alpine Kettle',
		])
	})

	it('returns an empty list for a word no name carries', () => {
		expect(filterProducts('teapot')).toEqual([])
	})

	it('keeps catalogue order', () => {
		expect(filterProducts('kettles').map((product) => product.name)).toEqual([
			'Alpine Kettle',
			'Copper Kettle',
		])
	})

	it('matches nothing for a blank query', () => {
		expect(filterProducts('')).toEqual([])
		expect(filterProducts('   ')).toEqual([])
	})
})

describe('filterNamedProducts', () => {
	it('returns the products whose full name an answer contains, in catalogue order', () => {
		const named = filterNamedProducts('The copper kettle and the Alpine Kettle match.')
		expect(named.map((product) => product.name)).toEqual(['Alpine Kettle', 'Copper Kettle'])
	})

	it('ignores a partial name', () => {
		expect(filterNamedProducts('Two kettles match.')).toEqual([])
	})
})

describe('normalizeAnswer', () => {
	it('drops case, spacing, and punctuation', () => {
		expect(normalizeAnswer('2:40 p.m.')).toBe(normalizeAnswer(STORE_FACT))
		expect(normalizeAnswer('HG-48213')).toBe('hg48213')
	})
})

describe('renderToolText', () => {
	it('returns a string value as is, another value as JSON, and a failure as its message', () => {
		expect(renderToolText({ id: '1', name: 'look', success: true, value: 'page' })).toBe('page')
		expect(renderToolText({ id: '1', name: 'look', success: true, value: { rows: 2 } })).toBe(
			'{"rows":2}',
		)
		expect(renderToolText({ id: '1', name: 'click', success: false, error: 'gone' })).toBe('gone')
	})
})

describe('buildStorePrompt', () => {
	it('states the task before the seeded view', () => {
		const prompt = buildStorePrompt('Find the fixture.', 'page "Store" URL')
		expect(prompt).toBe(
			'Find the fixture.\n\nThe browser\'s first read of the page:\npage "Store" URL',
		)
		expect(prompt.startsWith('Find the fixture.')).toBe(true)
		expect(prompt.endsWith('page "Store" URL')).toBe(true)
	})
})

describe('extractReferences', () => {
	it('rejects legacy rows and prose that starts with a reference', () => {
		expect(extractReferences('1: e1 link "Catalogue"\n12: e5 is prose\ne7 button "Go"')).toEqual([])
		expect(buildStoreTranscript([]).seed).toBe('1: link "Catalogue" [ref=e1]')
	})
	it('reads every bracketed token, including a best-match row', () => {
		expect(
			extractReferences(
				'page "Store" URL (52 lines)\nNo line from 46 on matches "Tray"; the best match is line 11:\n11: ### link "Tray" [ref=e7] /tray\n46: link "Cart" [ref=e12]',
			),
		).toEqual(['e7', 'e12'])
	})
	it('reads numbered headings and replaces exposure with an empty page listing', () => {
		const seed =
			'page "Store" http://store/ (2 lines)\n1: link "Cart" [ref=e1] /cart\n2: ### link "Tray" [ref=e2] /tray'
		expect(extractReferences(seed)).toEqual(['e1', 'e2'])
		const cleared = buildStoreCall(
			'read',
			{ from: 3 },
			'page "Store" http://store/ (3 lines)\n3: Text only\n[lines 3–3 of 3; 2 above; end of page]',
		)
		const stale = buildStoreCall('click', { ref: 'e1' })
		expect(findUnlistedReferences(seed, [cleared, stale])).toEqual([stale])
	})
	it('returns the bracketed reference from each element row, in row order', () => {
		const view =
			'page "Store" URL\n1: link "Cart" [ref=e1]\n# Heading\ntext e9 inside\n2: button "Go" [ref=e12]\n(2 of 2 elements)'
		expect(extractReferences(view)).toEqual(['e1', 'e12'])
	})

	it('returns nothing for a Markdown slice', () => {
		expect(extractReferences('# Store\n\n[Cart](http://127.0.0.1/cart)')).toEqual([])
	})
})

describe('findUnlistedReferences', () => {
	it('keeps exposure after a refused type and accepts the next listed reference', () => {
		const seed =
			'page "Store" http://store/ (2 lines)\n1: button "Search" [ref=e5]\n2: searchbox "Query" [ref=e4]'
		const refused = buildRefusedCall(
			'type',
			{ ref: 'e5', text: 'kettle' },
			'Element button "Search" [ref=e5] takes no text; call click for a button.',
		)
		const next = buildStoreCall('type', { ref: 'e4', text: 'kettle', submit: true })
		expect(findUnlistedReferences(seed, [refused, next])).toEqual([])
	})
	it('keeps exposure after a timed-out wait on an unchanged page', () => {
		const seed = 'page "Store" http://store/ (1 lines)\n1: link "Cart" [ref=e1]'
		const timeout = buildRefusedCall(
			'wait',
			{ text: 'absent', timeout: 1 },
			'Timed out waiting for "absent".',
		)
		expect(findUnlistedReferences(seed, [timeout, buildStoreCall('click', { ref: 'e1' })])).toEqual(
			[],
		)
	})
	it('starts exposure with the successful wait window', () => {
		const seed = 'page "Store" http://store/ (2 lines)\n1: link "Cart" [ref=e1]'
		const waited = buildStoreCall(
			'wait',
			{ text: 'Pay' },
			'page "Store" http://store/ (2 lines)\n2: button "Pay" [ref=e2]',
		)
		const old = buildStoreCall('click', { ref: 'e1' })
		expect(findUnlistedReferences(seed, [waited, old])).toEqual([old])
		expect(findUnlistedReferences(seed, [waited, buildStoreCall('click', { ref: 'e2' })])).toEqual(
			[],
		)
	})
	it('ignores failed-call headers, change notes, and reference listings', () => {
		const seed = 'page "Store" http://store/ (1 lines)\n1: link "Cart" [ref=e1]'
		const failure = buildRefusedCall(
			'read',
			{ from: 1 },
			'page "Other" http://store/other (2 lines)\nThe page changed since the last view; line numbers might differ.\n2: button "Fake" [ref=e9]',
		)
		expect(findUnlistedReferences(seed, [failure, buildStoreCall('click', { ref: 'e1' })])).toEqual(
			[],
		)
		const unlisted = buildStoreCall('click', { ref: 'e9' })
		expect(findUnlistedReferences(seed, [failure, unlisted])).toEqual([unlisted])
	})
	it('accumulates unchanged reads, ignores refused listings, and clears on notes and tab switches', () => {
		const seed = 'page "Store" http://store/ (3 lines)\n1: link "Cart" [ref=e1]'
		const reading = buildStoreCall(
			'read',
			{ from: 2 },
			'page "Store" http://store/ (3 lines)\n2: button "Pay" [ref=e2]',
		)
		const empty = buildStoreCall(
			'read',
			{ from: 3 },
			'page "Store" http://store/ (3 lines)\n3: Text only',
		)
		const earlier = buildStoreCall('click', { ref: '[ref=e1]' })
		expect(findUnlistedReferences(seed, [reading, empty, earlier])).toEqual([])
		const refused = buildRefusedCall(reading.name, reading.arguments, reading.text)
		const invented = buildStoreCall('click', { ref: 'e2' })
		expect(findUnlistedReferences(seed, [refused, invented])).toEqual([invented])
		for (const change of buildExposureChanges(empty.text))
			expect(findUnlistedReferences(seed, [change, earlier])).toEqual([earlier])
		// Every context has its own seed and call history; exposure cannot cross transcripts.
		expect(findUnlistedReferences(empty.text, [earlier])).toEqual([earlier])
	})
	it('accepts a reference the seed listed, in any spelling the toolset reads', () => {
		const calls = STORE_REFERENCE_CALLS
		expect(findMalformedCalls(calls, [BROWSER_TOOL_COPY.read, BROWSER_TOOL_COPY.click])).toEqual([])
		expect(
			findUnlistedReferences(
				'page "Store" http://store/ (1 lines)\n1: link "Cart" [ref=e1]',
				calls,
			),
		).toEqual([])
	})

	it('flags an invented, a non-string, and an unreadable reference', () => {
		const invented = buildStoreCall('click', { ref: 'e9' })
		const numeric = buildStoreCall('click', { ref: 1 })
		const described = buildStoreCall('click', { ref: 'the search button' })
		expect(findMalformedCalls([described], [BROWSER_TOOL_COPY.click])).toEqual([])
		expect(
			findUnlistedReferences('page "Store" http://store/ (1 lines)\n1: link "Cart" [ref=e1]', [
				invented,
				numeric,
				described,
			]),
		).toEqual([invented, numeric, described])
	})

	it('clears exposure after a press without a view and restores it with a later read', () => {
		const receipt = buildStoreCall(
			'click',
			{ ref: 'e1' },
			'Clicked link "Cart" [ref=e1].\n\npage "Cart" http://store/cart (1 lines)\n1: button "Pay" [ref=e5]',
		)
		const reading = buildStoreCall(
			'read',
			{ from: 1 },
			'page "Cart" http://store/cart (2 lines)\n1: # Cart\n2: One item.\n[lines 1–2 of 2; end of page]',
		)
		expect(reading.text).toMatch(/^page .+\n1: /)
		const stale = buildStoreCall('click', { ref: 'e1' })
		const fresh = buildStoreCall('click', { ref: 'e5' })
		const notice = buildStoreCall('press', { key: 'Tab' }, 'Pressed Tab.')
		expect(findUnlistedReferences('link "Cart" [ref=e1]', [receipt, notice, fresh, stale])).toEqual(
			[fresh, stale],
		)
		const relisted = buildStoreCall(
			'read',
			{ from: 1 },
			'page "Cart" http://store/cart (1 lines)\n1: button "Pay" [ref=e5]',
		)
		expect(
			findUnlistedReferences('link "Cart" [ref=e1]', [receipt, notice, relisted, fresh]),
		).toEqual([])
		expect(
			findUnlistedReferences('link "Cart" [ref=e1]', [receipt, reading, fresh, stale]),
		).toEqual([fresh, stale])
	})

	it('flags nothing for calls that carry no reference', () => {
		expect(findUnlistedReferences('', [buildStoreCall('read', { search: 'x' })])).toEqual([])
	})

	it('applies each call before it obtains the next, so a later slot cannot rewrite an earlier call', () => {
		const read = buildStoreCall(
			'read',
			{ from: 1 },
			'page "A" http://store/a\n1: link "Cart" [ref=e1]',
		)
		const click = buildStoreCall('click', { ref: 'e1' })
		expect(
			findUnlistedReferences('', buildLazyCalls(read, click, { text: 'page "A" http://store/a' })),
		).toEqual([])
	})

	it('refuses a list that has no iterator as for…of does', () => {
		expect(() =>
			findUnlistedReferences('', buildIteratorlessList([buildStoreCall('click', { ref: 'e1' })])),
		).toThrow(TypeError)
	})
})

describe('splitResultFooter', () => {
	it('splits the bound footer from the body', () => {
		const footer = '[lines 1–30 of 80; 50 below; call read with from 31 for more]'
		expect(splitResultFooter(`# Policy\n\n${footer}`)).toEqual(['# Policy', footer])
	})

	it('returns the whole text and an empty footer when the result carries none', () => {
		expect(splitResultFooter('Clicked link "Cart" [ref=e1].')).toEqual([
			'Clicked link "Cart" [ref=e1].',
			'',
		])
	})
})

describe('matchesStoreOracles', () => {
	it('holds for a run within the call limit that uses listed references and bounded results', () => {
		expect(
			matchesStoreOracles(buildStoreTranscript([buildStoreCall('click', { ref: 'e1' })])),
		).toBe(true)
	})

	it('fails a run with no call, over the limit, with an unlisted reference, or with an oversized body', () => {
		expect(matchesStoreOracles(buildStoreTranscript([]))).toBe(false)
		const many = Array.from({ length: STORE_BOUNDS.limit + 1 }, () =>
			buildStoreCall('read', { search: 'x' }),
		)
		expect(matchesStoreOracles(buildStoreTranscript(many))).toBe(false)
		expect(
			matchesStoreOracles(buildStoreTranscript([buildStoreCall('click', { ref: 'e2' })])),
		).toBe(false)
		const oversized = buildStoreCall('read', { search: 'x' }, 'x'.repeat(BROWSER_TOOL_LIMIT + 1))
		expect(matchesStoreOracles(buildStoreTranscript([oversized]))).toBe(false)
		const bounded = buildStoreCall(
			'read',
			{ search: 'x' },
			`${'x'.repeat(BROWSER_TOOL_LIMIT)}\n\n[characters 0–4000 of 9000; call read with offset 4000 for more]`,
		)
		expect(matchesStoreOracles(buildStoreTranscript([bounded]))).toBe(false)
	})
})

describe('writeTranscript', () => {
	it('writes the transcript as JSON at the path its task and attempt name, under the root', () => {
		const scratch = createScratch({ prefix: 'store-transcript-' })
		try {
			const transcript = buildStoreTranscript([buildStoreCall('read', { search: 'x' }, '# Store')])
			const path = writeTranscript(transcript, scratch.path)
			expect(path).toBe(join(scratch.path, 'tmp', 'probes', 'logs', 'fixture-1.json'))
			expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(transcript)
		} finally {
			scratch.destroy()
		}
	})
})

describe('STORE_SYSTEM_PROMPT', () => {
	it('uses the approved type sentence and keeps the other measured sentences', () => {
		expect(STORE_SYSTEM_PROMPT).toBe(
			"Use the browser tools before answering. The first message is a read of the page; references such as e4 name elements. To learn a fact, call read with from 1 and search words from the question. For more text, follow the footer: call read with from set to the line it names. To follow a link or press a button, call click with its reference from the latest result. To fill a textbox or the site's search box, call type with its reference, the text, and submit true. Never invent references. If expected text has not appeared, call wait once. When done, answer in one short sentence.",
		)
	})
	it('stays under 120 words and names the tools the loop uses', () => {
		expect(STORE_SYSTEM_PROMPT.split(/\s+/).length).toBeLessThan(120)
		for (const answer of STORE_SEEDED_ANSWERS) expect(STORE_SYSTEM_PROMPT).not.toContain(answer)
		for (const tool of STORE_PROMPT_TOOLS) {
			expect(STORE_SYSTEM_PROMPT).toContain(tool)
		}
	})
})

describe('line continuation', () => {
	it('never awards continuation credit to a quoted best-match row', () => {
		const first = buildStoreCall('read', { from: 1 }, STORE_FIRST_SLICE)
		const quoted = buildStoreCall(
			'read',
			{ from: 31, search: 'token' },
			'page "Policy" http://store/policy (80 lines)\nThis read shows lines 40–50 of 80; lines 51–80 are not shown yet.\nNo line from 31 on matches "token"; the best match is line 31:\n31: ' +
				STORE_POLICY_TOKEN +
				'\n40: Actual window starts here.\n[lines 40–50 of 80; 39 above, 30 below; call read with from 51 for more]',
		)
		expect(findContinuedRead([first, quoted], STORE_POLICY_TOKEN)).toBeUndefined()
		const outside = {
			...quoted,
			text: quoted.text
				.replace('line 31:\n31:', 'line 20:\n20:')
				.replace('40: Actual', '31: Actual')
				.replaceAll('40–50', '31–50')
				.replace('39 above', '30 above'),
		}
		expect(findContinuedRead([first, outside], STORE_POLICY_TOKEN)).toBeUndefined()
	})
	it('reads a continuation line only from a trailing line footer', () => {
		expect(parseFooterLine(STORE_FIRST_SLICE)).toBe(31)
		expect(parseFooterLine(STORE_CONTINUED_SLICE)).toBeUndefined()
		expect(
			parseFooterLine('[characters 0–30 of 80; call read with offset 30 for more]'),
		).toBeUndefined()
	})
	it('requires a model read followed by its exact fresh continuation window', () => {
		const first = buildStoreCall('read', { from: 1 }, STORE_FIRST_SLICE)
		const continued = buildStoreCall('read', { from: 31 }, STORE_CONTINUED_SLICE)
		expect(findContinuedRead([first, continued], STORE_POLICY_TOKEN)).toBe(continued)
		expect(matchesPagingOracle(buildStoreTranscript([first, continued]))).toBe(true)
	})
	it('accepts a search that leaves the continuation window at the named line', () => {
		const first = buildStoreCall('read', { from: 1 }, STORE_FIRST_SLICE)
		const continued = buildStoreCall('read', { from: 31, search: 'token' }, STORE_CONTINUED_SLICE)
		expect(findContinuedRead([first, continued], STORE_POLICY_TOKEN)).toBe(continued)
	})
	it('accepts an earlier fresh footer across other reads on the same page', () => {
		const first = buildStoreCall('read', { from: 1 }, STORE_FIRST_SLICE)
		const other = buildStoreCall(
			'read',
			{ from: 40 },
			STORE_CONTINUED_SLICE.replace('31: ', '40: '),
		)
		const continued = buildStoreCall('read', { from: 31 }, STORE_CONTINUED_SLICE)
		expect(findContinuedRead([first, other, continued], STORE_POLICY_TOKEN)).toBe(continued)
	})
	it.each(STORE_STALE_CONTINUATIONS)(
		'refuses a stale or unearned continuation: %s',
		(_reason, calls) => {
			const continued = buildStoreCall('read', { from: 31 }, STORE_CONTINUED_SLICE)
			const transcript = buildStoreTranscript([...calls, continued], STORE_FIRST_SLICE)
			expect(matchesStoreOracles(transcript)).toBe(true)
			expect(findContinuedRead(transcript.calls, STORE_POLICY_TOKEN)).toBeUndefined()
			expect(matchesPagingOracle(transcript)).toBe(false)
		},
	)
	it.each(STORE_INVALID_CONTINUATIONS)(
		'refuses an invalid continuation: %s',
		(_reason, input, text, success) => {
			const first = buildStoreCall('read', { from: 1 }, STORE_FIRST_SLICE)
			const continued = success
				? buildStoreCall('read', input, text)
				: buildRefusedCall('read', input, text)
			const transcript = buildStoreTranscript([first, continued])
			expect(matchesStoreOracles(transcript)).toBe(true)
			expect(findContinuedRead(transcript.calls, STORE_POLICY_TOKEN)).toBeUndefined()
			expect(matchesPagingOracle(transcript)).toBe(false)
		},
	)
	it('walks 100 000 calls without a stack that grows with them', () => {
		const calls = Array.from({ length: 100_000 }, () => buildStoreCall('click', { ref: 'e1' }))
		expect(findContinuedRead(calls, STORE_POLICY_TOKEN)).toBeUndefined()
	})
	it('stops at the match and closes the iterator it opened, as for…of does', () => {
		const first = buildStoreCall('read', { from: 1 }, STORE_FIRST_SLICE)
		const continued = buildStoreCall('read', { from: 31 }, STORE_CONTINUED_SLICE)
		const closed = createRecorder<[]>()
		const calls = buildClosingList(
			[first, continued, buildStoreCall('click', { ref: 'e1' })],
			closed.handler,
		)
		expect(findContinuedRead(calls, STORE_POLICY_TOKEN)).toBe(continued)
		expect(closed.calls).toEqual([[]])
	})
	it('refuses a list that has no iterator as for…of does', () => {
		expect(() =>
			findContinuedRead(buildIteratorlessList([buildStoreCall('read', { from: 1 })]), 'token'),
		).toThrow(TypeError)
	})
})

describe('STORE_BOUNDS', () => {
	it('fits every attempt of a retried task in its budget and the budget in its case', () => {
		expect(STORE_BOUNDS.single).toBeGreaterThan(STORE_BOUNDS.run)
		expect(STORE_BOUNDS.budget).toBeGreaterThanOrEqual(STORE_BOUNDS.attempts * STORE_BOUNDS.run)
		expect(STORE_BOUNDS.retry).toBeGreaterThan(STORE_BOUNDS.budget)
	})

	it('gives every model turn a window past the daemon default and a deadline past the provider default', () => {
		expect(STORE_BOUNDS.context).toBeGreaterThan(4096)
		expect(STORE_BOUNDS.turn).toBeGreaterThan(DEFAULT_PROVIDER_TIMEOUT)
		expect(STORE_BOUNDS.turn).toBeLessThan(STORE_BOUNDS.run)
	})

	it('lets a turn retry a refused tool and still answer inside the turn limit after the refusal bound', () => {
		expect(STORE_BOUNDS.refusals).toBeGreaterThan(1)
		expect(STORE_BOUNDS.refusals).toBeLessThan(STORE_BOUNDS.limit)
	})
})

describe('matchesDaemonFault', () => {
	it('matches a provider HTTP failure with a 5xx status', () => {
		expect(
			matchesDaemonFault(new ProviderError('HTTP', 'provider error: 500', { status: 500 })),
		).toBe(true)
		expect(matchesDaemonFault(new ProviderError('HTTP', 'bad gateway', { status: 599 }))).toBe(true)
	})

	it('refuses a client status, another provider code, a plain error, and a non-error', () => {
		expect(matchesDaemonFault(new ProviderError('HTTP', 'not found', { status: 404 }))).toBe(false)
		expect(matchesDaemonFault(new ProviderError('HTTP', 'odd', { status: 600 }))).toBe(false)
		expect(matchesDaemonFault(new ProviderError('PROTOCOL', 'no body'))).toBe(false)
		expect(matchesDaemonFault(new Error('provider error: 500'))).toBe(false)
		expect(matchesDaemonFault('provider error: 500')).toBe(false)
	})
})

describe('matchesStoreOracles with a failure', () => {
	it('fails an attempt the daemon ended, however well its calls went', () => {
		const transcript = buildStoreTranscript([buildStoreCall('click', { ref: 'e1' })])
		expect(matchesStoreOracles(transcript)).toBe(true)
		expect(matchesStoreOracles({ ...transcript, failure: 'provider error: 500' })).toBe(false)
	})
})

describe('matchesSearchOracle', () => {
	it('holds for a run whose recorded search resolves to the products the query matches and whose answer names them', () => {
		expect(matchesSearchOracle(STORE_COMPLETED_SEARCH, STORE_QUERY)).toBe(true)
		const spaced = {
			...STORE_COMPLETED_SEARCH,
			state: { cart: [], searches: [' Kettle '], orders: [] },
		}
		expect(matchesSearchOracle(spaced, STORE_QUERY)).toBe(true)
		const plural = {
			...STORE_COMPLETED_SEARCH,
			state: { cart: [], searches: ['kettles'], orders: [] },
		}
		expect(matchesSearchOracle(plural, STORE_QUERY)).toBe(true)
	})

	it('fails a run that submitted no query, another query, or names too few or too many products', () => {
		expect(matchesSearchOracle(STORE_STALLED_SEARCH, STORE_QUERY)).toBe(false)
		const other = {
			...STORE_COMPLETED_SEARCH,
			state: { cart: [], searches: ['teapot'], orders: [] },
		}
		expect(matchesSearchOracle(other, STORE_QUERY)).toBe(false)
		const partial = { ...STORE_COMPLETED_SEARCH, answer: 'The Alpine Kettle matches.' }
		expect(matchesSearchOracle(partial, STORE_QUERY)).toBe(false)
		const extra = {
			...STORE_COMPLETED_SEARCH,
			answer: `${STORE_COMPLETED_SEARCH.answer} So does ${STORE_NAMED_PRODUCT}.`,
		}
		expect(matchesSearchOracle(extra, STORE_QUERY)).toBe(false)
	})
})

describe('matchesStalledSearch', () => {
	it('holds when the last call submits a search that lists a match and the answer is empty', () => {
		expect(matchesStalledSearch(STORE_STALLED_SEARCH)).toBe(true)
	})

	it('fails when the search lists no product or the last call clicks', () => {
		expect(matchesStalledSearch(STORE_EMPTY_RESULTS_SEARCH)).toBe(false)
		expect(matchesStalledSearch(STORE_CLICKED_SEARCH)).toBe(false)
	})

	it('fails a completed search, an answered or cut stall, a failed type, and a type without submit', () => {
		expect(matchesStalledSearch(STORE_COMPLETED_SEARCH)).toBe(false)
		expect(matchesStalledSearch({ ...STORE_STALLED_SEARCH, answer: 'The kettles match.' })).toBe(
			false,
		)
		expect(matchesStalledSearch({ ...STORE_STALLED_SEARCH, partial: true })).toBe(false)
		const look = requireValue(STORE_STALLED_SEARCH.calls[0], 'the stall fixture lost a call')
		const type = requireValue(STORE_STALLED_SEARCH.calls[1], 'the stall fixture lost a call')
		const failed = buildRefusedCall(type.name, type.arguments, type.text)
		expect(matchesStalledSearch({ ...STORE_STALLED_SEARCH, calls: [look, failed] })).toBe(false)
		const unsubmitted = { ...type, arguments: { ref: 'e35', text: 'kettles' } }
		expect(matchesStalledSearch({ ...STORE_STALLED_SEARCH, calls: [look, unsubmitted] })).toBe(
			false,
		)
		const reread = buildStoreCall('read', { search: 'kettle products' }, '# Harbor Goods')
		expect(matchesStalledSearch({ ...STORE_STALLED_SEARCH, calls: [look, type, reread] })).toBe(
			false,
		)
	})
})

describe('attachThinking', () => {
	it('gives the n-th assistant message the n-th turn thinking and leaves a silent turn bare', () => {
		const recorded = attachThinking(STORE_THINKING_MESSAGES, ['I will search.', ''])
		expect(recorded.map((message) => message.thinking)).toEqual([
			undefined,
			'I will search.',
			undefined,
			undefined,
		])
		expect(recorded[3]).toBe(STORE_THINKING_MESSAGES[3])
	})

	it('reads the roles in one pass, with no rescan of the earlier messages', () => {
		const reads = createRecorder<[string]>()
		const messages = STORE_THINKING_MESSAGES.map((message) =>
			buildWatched(message, 'role', () => reads.handler(message.id)),
		)
		const recorded = attachThinking(messages, ['I will search.', ''])
		// The check of each role, then the spread that copies the message when its turn has thinking.
		expect(reads.calls).toEqual([['m1'], ['m2'], ['m2'], ['m3'], ['m4']])
		expect(recorded.map((message) => message.thinking)).toEqual([
			undefined,
			'I will search.',
			undefined,
			undefined,
		])
	})
})

describe('search predicate boundaries', () => {
	it('accepts shared checks for a stalled search while refusing the search oracle', () => {
		expect(matchesStoreOracles(STORE_STALLED_SEARCH)).toBe(true)
		expect(matchesStalledSearch(STORE_STALLED_SEARCH)).toBe(true)
		expect(matchesSearchOracle(STORE_STALLED_SEARCH, STORE_QUERY)).toBe(false)
	})

	it('accepts the search oracle when the run completes the search', () => {
		expect(matchesStoreOracles(STORE_COMPLETED_SEARCH)).toBe(true)
		expect(matchesSearchOracle(STORE_COMPLETED_SEARCH, STORE_QUERY)).toBe(true)
	})

	it('reddens for a daemon fault on the shared oracles, however the run ended', () => {
		expect(matchesStalledSearch({ ...STORE_STALLED_SEARCH, failure: 'provider error: 500' })).toBe(
			true,
		)
		expect(matchesStoreOracles({ ...STORE_STALLED_SEARCH, failure: 'provider error: 500' })).toBe(
			false,
		)
	})

	it('rejects a thrown attempt with its own error rather than returning a transcript', async () => {
		const refusal = new Error('the browser refused a page')
		const provider = createOllama({ model: 'fixture', url: 'http://127.0.0.1:9' })
		await expect(
			attemptStoreTask({ isolate: () => Promise.reject(refusal) }, STORE_TASKS.search, 1, provider),
		).rejects.toBe(refusal)
	})
})

describe('filterPageTools', () => {
	it('drops every journey tool and retains type secret and keeps every other definition as advertised', () => {
		const page = filterPageTools(Object.values(BROWSER_TOOL_COPY))
		expect(page.map((definition) => definition.name)).toEqual([
			'read',
			'click',
			'type',
			'press',
			'navigate',
			'wait',
			'dialog',
			'switch',
		])
		const typed = page.find((definition) => definition.name === 'type')
		expect(Object.keys(Object(typed?.parameters?.['properties']))).toEqual([
			'ref',
			'text',
			'submit',
			'secret',
		])
		expect(typed?.parameters?.['required']).toEqual(['ref', 'text'])
		expect(page[0]).toBe(BROWSER_TOOL_COPY.read)
	})
})

describe('findMalformedCalls', () => {
	const definitions = Object.values(BROWSER_TOOL_COPY)

	it('passes calls that match the advertised parameters, the journey batch and inputs included', () => {
		expect(
			findMalformedCalls(
				[
					...STORE_JOURNEY_CALLS,
					buildStoreCall('edit', {
						journey: STORE_JOURNEY_NAME,
						edits: JSON.stringify(STORE_EDITS),
					}),
					buildStoreCall('type', { ref: 'e4', text: STORE_BUYER, submit: true, secret: false }),
					buildStoreCall('read', { from: 40, search: 'the code' }),
				],
				definitions,
			),
		).toEqual([])
	})

	it('flags an unknown tool, a missing required parameter, a wrong type, an unknown key, and a wrong item', () => {
		const malformed = STORE_MALFORMED_CALLS
		expect(findMalformedCalls(malformed, definitions)).toEqual(malformed)
	})

	it('reads a type array as the union of its members, with the items of the array checked', () => {
		const edit = STORE_EDIT_DEFINITION
		const kept = STORE_VALID_EDITS
		const malformed = STORE_INVALID_EDITS
		expect(findMalformedCalls([...kept, ...malformed], [edit])).toEqual(malformed)
	})
})

describe('parseStoreJSON', () => {
	it('parses JSON text and returns undefined for text that is not JSON', () => {
		expect(parseStoreJSON('{"revision":2}')).toEqual({ revision: 2 })
		expect(parseStoreJSON('null')).toBeNull()
		expect(parseStoreJSON('{"revision":')).toBeUndefined()
		expect(parseStoreJSON('')).toBeUndefined()
	})
})

describe('extractJourneyEvidence', () => {
	it('reads the journey, its revision, and its runs from the files the real file stores wrote', async () => {
		const files = await writeJourneyFiles('complete')
		const evidence = extractJourneyEvidence(files)
		expect(evidence?.name).toBe(STORE_JOURNEY_NAME)
		expect(evidence?.revision).toBe(1)
		expect(evidence?.journey).toEqual(STORE_EDITED_JOURNEY)
		expect(evidence?.runs.map((run) => [run.outcome, run.revision, run.inputs])).toEqual([
			['complete', 1, { [STORE_JOURNEY_PARAMETER]: STORE_JOURNEY_BUYER }],
		])
	})

	it('reads nothing from no journey, two journeys, or a journey file that does not parse', async () => {
		const files = await writeJourneyFiles('complete')
		const stored = files[`${STORE_JOURNEY_NAME}/journey.json`] ?? ''
		expect(extractJourneyEvidence({})).toBeUndefined()
		expect(extractJourneyEvidence({ ...files, 'other/journey.json': stored })).toBeUndefined()
		expect(
			extractJourneyEvidence({ [`${STORE_JOURNEY_NAME}/journey.json`]: '{"revision":1}' }),
		).toBeUndefined()
		expect(
			extractJourneyEvidence({ [`${STORE_JOURNEY_NAME}/journey.json`]: stored.slice(0, 20) }),
		).toBeUndefined()
	})
})

describe('findBoundParameter', () => {
	it('names the defaulted parameter the name step binds', () => {
		expect(findBoundParameter(STORE_EDITED_JOURNEY)).toBe(STORE_JOURNEY_PARAMETER)
	})

	it('names nothing for a parameter without a default or a binding on another field', () => {
		expect(
			findBoundParameter({
				...STORE_EDITED_JOURNEY,
				parameters: { [STORE_JOURNEY_PARAMETER]: {} },
			}),
		).toBeUndefined()
		const [first, second, third] = STORE_EDITED_JOURNEY.steps
		if (first === undefined || second === undefined || third === undefined) throw new Error('steps')
		const elsewhere = { ...second, target: { role: 'textbox', name: 'Email' } }
		expect(matchesNameBinding(second, STORE_JOURNEY_PARAMETER)).toBe(true)
		expect(matchesNameBinding(elsewhere, STORE_JOURNEY_PARAMETER)).toBe(false)
		expect(matchesNameBinding(second, 'email')).toBe(false)
		expect(
			findBoundParameter({ ...STORE_EDITED_JOURNEY, steps: [first, elsewhere, third] }),
		).toBeUndefined()
	})
})

describe('filterSubmissionLines', () => {
	it('lists the lines that type with submit, press Enter, or click the order button', () => {
		expect(
			filterSubmissionLines(
				[
					STORE_SAVED_LISTING,
					's3 press Enter',
					's5 click button "Place order"',
					's6 type "x" into textbox "Full name"',
					's7 press Tab',
				].join('\n'),
			),
		).toEqual([
			`s2 type "${STORE_BUYER}" into textbox "Full name", submit`,
			's3 press Enter',
			's5 click button "Place order"',
		])
	})

	it('reads a bound name step from the stored listing', () => {
		expect(filterSubmissionLines(renderBrowserJourney(STORE_EDITED_JOURNEY))).toEqual([
			`s2 type "${STORE_BUYER}" as ${STORE_JOURNEY_PARAMETER} into textbox "Full name", submit`,
		])
	})
})

describe('renderJourneyEdit', () => {
	it('spells the batch out with the name step and the recorded cart click the last listing shows', () => {
		const turn = renderJourneyEdit(STORE_JOURNEY_CALLS.slice(0, 4))
		const batch = parseStoreJSON(turn.slice(turn.indexOf('['), turn.lastIndexOf(']') + 1))
		expect(batch).toEqual([
			{ operation: 'declare', name: STORE_JOURNEY_PARAMETER, parameter: { default: STORE_BUYER } },
			{
				operation: 'update',
				arguments: { text: { parameter: STORE_JOURNEY_PARAMETER } },
				id: 's2',
			},
			{ operation: 'remove', id: 's3' },
		])
		expect(matchesJourneyBatch(buildStoreCall('edit', { edits: batch }))).toBe(true)
	})

	it('names both steps in words when the listing holds one submission or no listing exists', () => {
		for (const calls of STORE_UNBATCHED_LISTINGS) {
			const turn = renderJourneyEdit(calls)
			expect(turn).not.toContain('[')
			expect(turn).toContain('remove the recorded cart click')
		}
	})
})

describe('matchesJourneyBatch', () => {
	it('holds for a successful edit holding a declare, an update, and a remove', () => {
		expect(matchesJourneyBatch(buildStoreCall('edit', { edits: STORE_EDITS }))).toBe(true)
	})

	it('holds for the same batch given as the JSON string of the array the edit tool accepts', () => {
		expect(
			matchesJourneyBatch(buildStoreCall('edit', { edits: JSON.stringify(STORE_EDITS) })),
		).toBe(true)
	})

	it('fails a batch missing an operation, a refused edit, a string that is no array, and another tool', () => {
		expect(matchesJourneyBatch(buildStoreCall('edit', { edits: STORE_EDITS.slice(1) }))).toBe(false)
		expect(matchesJourneyBatch(buildRefusedCall('edit', { edits: STORE_EDITS }))).toBe(false)
		expect(
			matchesJourneyBatch(
				buildStoreCall('edit', { edits: JSON.stringify(STORE_EDITS).slice(0, -1) }),
			),
		).toBe(false)
		expect(
			matchesJourneyBatch(buildStoreCall('edit', { edits: JSON.stringify(STORE_EDITS[0]) })),
		).toBe(false)
		expect(matchesJourneyBatch(buildStoreCall('replay', { edits: STORE_EDITS }))).toBe(false)
	})
})

describe('matchesJourneySequence', () => {
	it('holds for record, save, journeys, the batch edit, and a replay with inputs, in order', () => {
		expect(STORE_JOURNEY_SEQUENCE).toEqual(['record', 'save', 'journeys', 'edit', 'replay'])
		expect(matchesJourneySequence(STORE_JOURNEY_CALLS)).toBe(true)
	})

	it('fails an edit before journeys, a replay without inputs, and a refused save', () => {
		const [record, click, save, journeys, edit, replay] = STORE_JOURNEY_CALLS
		if (
			record === undefined ||
			click === undefined ||
			save === undefined ||
			journeys === undefined ||
			edit === undefined ||
			replay === undefined
		) {
			throw new Error('calls')
		}
		expect(matchesJourneySequence([record, click, save, edit, journeys, replay])).toBe(false)
		expect(
			matchesJourneySequence([
				record,
				click,
				save,
				journeys,
				edit,
				buildStoreCall('replay', { journey: STORE_JOURNEY_NAME }),
			]),
		).toBe(false)
		expect(
			matchesJourneySequence([record, click, { ...save, success: false }, journeys, edit, replay]),
		).toBe(false)
	})
})

describe('matchesRemovedCart', () => {
	const stored = renderBrowserJourney(STORE_EDITED_JOURNEY)

	it('holds when the batch removes the second saved submission and one remains', () => {
		expect(matchesRemovedCart(STORE_JOURNEY_CALLS, stored)).toBe(true)
	})

	it('holds when that batch arrives as the JSON string of the array', () => {
		const string = STORE_JOURNEY_CALLS.map((call) =>
			call.name === 'edit'
				? buildStoreCall('edit', {
						journey: STORE_JOURNEY_NAME,
						edits: JSON.stringify(STORE_EDITS),
					})
				: call,
		)
		expect(matchesRemovedCart(string, stored)).toBe(true)
	})

	it('fails a removal of the first submission, a saved listing without a cart click, and two left', () => {
		const first = STORE_JOURNEY_CALLS.map((call) =>
			call.name === 'edit'
				? buildStoreCall('edit', {
						journey: STORE_JOURNEY_NAME,
						edits: [STORE_EDITS[0], STORE_EDITS[1], { operation: 'remove', id: 's2' }],
					})
				: call,
		)
		expect(matchesRemovedCart(first, stored)).toBe(false)
		const single = STORE_JOURNEY_CALLS.map((call) =>
			call.name === 'save'
				? buildStoreCall(
						'save',
						call.arguments,
						STORE_SAVED_LISTING.replace('s3 click link "Cart"', 's3 press Tab'),
					)
				: call,
		)
		expect(matchesRemovedCart(single, stored)).toBe(false)
		expect(matchesRemovedCart(STORE_JOURNEY_CALLS, `${stored}\ns5 press Enter`)).toBe(false)
		expect(matchesRemovedCart([], stored)).toBe(false)
	})
})

describe('matchesJourneyOracle', () => {
	it('holds for the journey task completed: the files, the sequence, and one order carrying the buyer', async () => {
		const files = await writeJourneyFiles('complete')
		expect(
			matchesJourneyOracle(
				buildJourneyTranscript(files, [STORE_BUYER, STORE_JOURNEY_BUYER]),
				STORE_JOURNEY_BUYER,
			),
		).toBe(true)
	})

	it('fails two orders carrying the buyer, none, a stopped run, another input, a failure, and no files', async () => {
		const complete = await writeJourneyFiles('complete')
		const stopped = await writeJourneyFiles('stopped')
		const orders = STORE_JOURNEY_ORDERS
		expect(
			matchesJourneyOracle(
				buildJourneyTranscript(complete, [...orders, STORE_JOURNEY_BUYER]),
				STORE_JOURNEY_BUYER,
			),
		).toBe(false)
		expect(
			matchesJourneyOracle(buildJourneyTranscript(complete, [STORE_BUYER]), STORE_JOURNEY_BUYER),
		).toBe(false)
		expect(matchesJourneyOracle(buildJourneyTranscript(stopped, orders), STORE_JOURNEY_BUYER)).toBe(
			false,
		)
		expect(matchesJourneyOracle(buildJourneyTranscript(complete, orders), STORE_BUYER)).toBe(false)
		expect(
			matchesJourneyOracle(
				{ ...buildJourneyTranscript(complete, orders), failure: 'provider error: 500' },
				STORE_JOURNEY_BUYER,
			),
		).toBe(false)
		expect(matchesJourneyOracle(buildJourneyTranscript({}, orders), STORE_JOURNEY_BUYER)).toBe(
			false,
		)
	})
})

describe('STORE_JOURNEY_PROMPT', () => {
	it('extends the store prompt with at most one sentence per journey tool, each naming its tool', () => {
		expect(STORE_JOURNEY_PROMPT.startsWith(`${STORE_SYSTEM_PROMPT} `)).toBe(true)
		const sentences = STORE_JOURNEY_PROMPT.slice(STORE_SYSTEM_PROMPT.length + 1).split(/(?<=\.) /)
		expect(sentences.length).toBeLessThanOrEqual(STORE_JOURNEY_SEQUENCE.length)
		for (const tool of STORE_JOURNEY_SEQUENCE) {
			expect(sentences.filter((sentence) => sentence.includes(`call ${tool}`))).toHaveLength(1)
		}
	})
})

describe('STORE_JOURNEY_BOUNDS', () => {
	it('fits every user turn of an attempt in its run, every attempt in its budget, and the budget in its case', () => {
		const turns = 1 + STORE_TASKS.journey.followups.length
		expect(turns).toBe(5)
		expect(STORE_JOURNEY_BOUNDS.run).toBeGreaterThanOrEqual(turns * STORE_BOUNDS.run)
		expect(STORE_JOURNEY_BOUNDS.budget).toBeGreaterThanOrEqual(
			STORE_BOUNDS.attempts * STORE_JOURNEY_BOUNDS.run,
		)
		expect(STORE_JOURNEY_BOUNDS.retry).toBeGreaterThan(STORE_JOURNEY_BOUNDS.budget)
		expect(STORE_TASKS.journey.system).toBe(STORE_JOURNEY_PROMPT)
		expect(STORE_TASKS.journey.prompt).toContain(
			STORE_TASKS.checkout.prompt.replace('Complete', 'complete'),
		)
	})
})

describe('STORE_JOURNEY_BOUNDS against STORE_BOUNDS', () => {
	it('carries only the settings the journey task does not share with the page tasks', () => {
		const shared = new Map<string, unknown>(Object.entries(STORE_BOUNDS))
		expect(Object.keys(STORE_JOURNEY_BOUNDS).length).toBeGreaterThan(0)
		for (const [key, value] of Object.entries(STORE_JOURNEY_BOUNDS)) {
			expect(shared.get(key)).not.toBe(value)
		}
		expect(STORE_JOURNEY_BOUNDS).not.toHaveProperty('context')
		expect(STORE_JOURNEY_BOUNDS).not.toHaveProperty('turn')
		expect(STORE_JOURNEY_BOUNDS).not.toHaveProperty('predict')
	})
})

describe('parseJourneyEdits', () => {
	it('returns an array as given and the array a JSON string carries', () => {
		expect(parseJourneyEdits(STORE_EDITS)).toBe(STORE_EDITS)
		expect(parseJourneyEdits(JSON.stringify(STORE_EDITS))).toEqual(STORE_EDITS)
		expect(parseJourneyEdits('[]')).toEqual([])
	})

	it('returns undefined for a string that is not JSON, JSON that is no array, and any other value', () => {
		expect(parseJourneyEdits(JSON.stringify(STORE_EDITS).slice(0, -1))).toBeUndefined()
		expect(parseJourneyEdits(JSON.stringify(STORE_EDITS[0]))).toBeUndefined()
		expect(parseJourneyEdits('')).toBeUndefined()
		expect(parseJourneyEdits(undefined)).toBeUndefined()
		expect(parseJourneyEdits({ 0: STORE_EDITS[0] })).toBeUndefined()
	})
})

describe('findJourneyLoops', () => {
	it('returns every refused record and save after the first successful STORE_REFUSED_SAVE, in order', () => {
		const edit = buildRefusedCall(
			'edit',
			{ journey: 'checkout', edits: [] },
			'No journey is named "checkout"; call journeys.',
		)
		expect(
			findJourneyLoops([
				...STORE_JOURNEY_CALLS.slice(0, 3),
				STORE_REFUSED_RECORD,
				...STORE_JOURNEY_CALLS.slice(3, 4),
				STORE_REFUSED_SAVE,
				edit,
				...STORE_JOURNEY_CALLS.slice(4, 5),
				STORE_REFUSED_RECORD,
				...STORE_JOURNEY_CALLS.slice(5),
			]),
		).toEqual([STORE_REFUSED_RECORD, STORE_REFUSED_SAVE, STORE_REFUSED_RECORD])
	})

	it('returns nothing for a run without a refusal, without a successful STORE_REFUSED_SAVE, or refused before its save', () => {
		const idle = buildRefusedCall(
			'save',
			{ description: 'Place an order at checkout.' },
			'No journey is recording; call record first.',
		)
		const empty = buildRefusedCall(
			'save',
			{ description: 'Place an order at checkout.' },
			`Nothing is recorded for ${STORE_JOURNEY_NAME}; perform an action, then call save.`,
		)
		expect(findJourneyLoops(STORE_JOURNEY_CALLS)).toEqual([])
		expect(findJourneyLoops([])).toEqual([])
		expect(findJourneyLoops([idle, empty, STORE_REFUSED_RECORD, STORE_REFUSED_SAVE])).toEqual([])
		expect(findJourneyLoops([idle, ...STORE_JOURNEY_CALLS])).toEqual([])
	})
})

describe('computeRefusals', () => {
	it('counts the most refused tool across the turn, with other tools counted apart', () => {
		expect(
			computeRefusals([
				buildRefusedCall('save'),
				buildRefusedCall('save'),
				buildRefusedCall('save'),
			]),
		).toBe(3)
		expect(
			computeRefusals([
				buildRefusedCall('record'),
				buildRefusedCall('save'),
				buildRefusedCall('record'),
				buildRefusedCall('save'),
				buildRefusedCall('record'),
			]),
		).toBe(3)
	})

	it('keeps the count across a successful call of any tool between two refusals', () => {
		expect(
			computeRefusals([
				buildRefusedCall('save'),
				buildRefusedCall('save'),
				buildStoreCall('look', {}),
				buildRefusedCall('save'),
			]),
		).toBe(3)
		expect(
			computeRefusals([
				buildStoreCall('journeys', {}),
				buildRefusedCall('save'),
				buildStoreCall('journeys', {}),
				buildRefusedCall('save'),
			]),
		).toBe(2)
	})

	it('returns 0 for a turn with no call and for a turn whose calls all succeeded', () => {
		expect(computeRefusals([])).toBe(0)
		expect(computeRefusals([buildStoreCall('look', {}), buildStoreCall('look', {})])).toBe(0)
	})

	it('reads each call a bounded number of times, so the work stays linear in the calls', () => {
		const reads = createRecorder<[number]>()
		const refused = Array.from({ length: 50 }, (_, index) =>
			buildWatched(buildRefusedCall('save'), 'name', () => reads.handler(index)),
		)
		expect(computeRefusals(refused)).toBe(50)
		// The key of the count, then the read of the earlier count, for each call in turn.
		expect(reads.calls).toEqual(refused.flatMap((_, index) => [[index], [index]]))
	})

	it('counts a call before it obtains the next one', () => {
		const calls = buildLazyCalls(buildRefusedCall('save'), buildRefusedCall('save'), {
			success: true,
		})
		expect(computeRefusals(calls)).toBe(2)
	})

	it('refuses a list that has no iterator as for…of does', () => {
		expect(() => computeRefusals(buildIteratorlessList([buildRefusedCall('save')]))).toThrow(
			TypeError,
		)
	})
})

describe('StoreRefusals', () => {
	it('tallies refused calls by tool name, counts a success as nothing, and starts at zero', () => {
		const tally = new StoreRefusals()
		expect(tally.largest).toBe(0)
		tally.count(buildStoreCall('save', {}))
		expect(tally.largest).toBe(0)
		tally.count(buildRefusedCall('save'))
		tally.count(buildRefusedCall('record'))
		tally.count(buildRefusedCall('save'))
		expect(tally.largest).toBe(2)
	})
})

describe('converseStore', () => {
	it('advertises no tool after the refusal bound until the next user turn advertises every tool again', async () => {
		const daemon = createRecordingTransport(
			createScriptedTransport([
				...STORE_REFUSAL_TURNS,
				{ content: 'The tool refused.' },
				STORE_LOOKUP_TURN,
				{ content: 'Found.' },
			]),
		)
		const tools = createRefusalTools()
		const conversation = await converseStore({
			provider: createOllama({ model: 'fixture-model', fetch: daemon.fetch }),
			system: STORE_SYSTEM_PROMPT,
			tools,
			turns: ['Call the fail tool.', 'Look up the kettle.'],
		})
		expect(daemon.requests.map(wireTools)).toEqual([
			...STORE_REFUSAL_TURNS.map(() => STORE_REFUSAL_TOOLS),
			[],
			STORE_REFUSAL_TOOLS,
			[],
		])
		expect(conversation.ended).toBe(2)
		expect(conversation.failure).toBeUndefined()
		expect(conversation.result).toMatchObject({ content: 'Found.', partial: false })
		expect(conversation.partial).toBe(false)
		expect(conversation.calls.map((call) => [call.name, call.success])).toEqual([
			...STORE_REFUSAL_TURNS.map(() => ['fail', false]),
			['lookup', true],
		])
		expect(
			conversation.messages
				.filter((message) => message.role === 'assistant')
				.map((message) => message.content),
		).toContain('The tool refused.')
	})

	it('advertises no tool after one provider turn whose parallel calls reach the bound', async () => {
		const daemon = createRecordingTransport(
			createScriptedTransport([
				{ content: '', tool_calls: STORE_REFUSAL_TURNS.flatMap((turn) => turn.tool_calls) },
				{ content: 'The tool refused.' },
			]),
		)
		const tools = createRefusalTools()
		const conversation = await converseStore({
			provider: createOllama({ model: 'fixture-model', fetch: daemon.fetch }),
			system: STORE_SYSTEM_PROMPT,
			tools,
			turns: ['Call the fail tool.'],
		})
		expect(daemon.requests.map(wireTools)).toEqual([STORE_REFUSAL_TOOLS, []])
		expect(conversation.ended).toBe(1)
		expect(conversation.result).toMatchObject({ content: 'The tool refused.', partial: false })
	})

	it("advertises no tool after a later turn's first successful call, while the opening turn keeps every tool", async () => {
		const daemon = createRecordingTransport(
			createScriptedTransport([
				STORE_LOOKUP_TURN,
				STORE_LOOKUP_TURN,
				{ content: 'Found twice.' },
				STORE_LOOKUP_TURN,
				STORE_FAIL_TURN,
				{ content: 'Found once.' },
			]),
		)
		const tools = createRefusalTools()
		const conversation = await converseStore({
			provider: createOllama({ model: 'fixture-model', fetch: daemon.fetch }),
			system: STORE_SYSTEM_PROMPT,
			tools,
			turns: ['Look up the kettle twice.', 'Look up the kettle once more.'],
		})
		expect(daemon.requests.map(wireTools)).toEqual([
			STORE_REFUSAL_TOOLS,
			STORE_REFUSAL_TOOLS,
			STORE_REFUSAL_TOOLS,
			STORE_REFUSAL_TOOLS,
			[],
		])
		expect(conversation.calls.map((call) => [call.name, call.success])).toEqual([
			['lookup', true],
			['lookup', true],
			['lookup', true],
		])
		expect(conversation.ended).toBe(1)
		expect(conversation.result).toMatchObject({ partial: false })
	})

	it('reaches the bound across a success between the refusals of one tool', async () => {
		const short = STORE_REFUSAL_TURNS.slice(1)
		const daemon = createRecordingTransport(
			createScriptedTransport([
				...short,
				STORE_LOOKUP_TURN,
				STORE_FAIL_TURN,
				{ content: 'The tool refused.' },
			]),
		)
		const tools = createRefusalTools()
		const conversation = await converseStore({
			provider: createOllama({ model: 'fixture-model', fetch: daemon.fetch }),
			system: STORE_SYSTEM_PROMPT,
			tools,
			turns: ['Call the fail tool, then look up the kettle.'],
		})
		expect(daemon.requests.map(wireTools)).toEqual([
			...[...short, STORE_LOOKUP_TURN, STORE_FAIL_TURN].map(() => STORE_REFUSAL_TOOLS),
			[],
		])
		expect(conversation.ended).toBe(1)
		expect(conversation.result).toMatchObject({ content: 'The tool refused.', partial: false })
	})

	it('returns the error that ended a user turn with the calls made before it', async () => {
		const tools = createRefusalTools()
		const conversation = await converseStore({
			provider: createOllama({
				model: 'fixture-model',
				fetch: createScriptedTransport([STORE_LOOKUP_TURN]),
			}),
			system: STORE_SYSTEM_PROMPT,
			tools,
			turns: ['Look up the kettle.'],
		})
		expect(conversation.result).toBeUndefined()
		expect(String(conversation.failure)).toContain('the script holds 1 turns')
		expect(conversation.calls.map((call) => [call.name, call.success])).toEqual([['lookup', true]])
	})

	it('returns the timings, the usages, and the partial flag over a history whose turns differ', async () => {
		const provider = createOllama({
			model: 'fixture-model',
			fetch: createScriptedTransport([STORE_LOOKUP_TURN, STORE_LOOKUP_TURN, { content: 'Done.' }]),
		})
		const conversation = await converseStore({
			provider,
			system: STORE_SYSTEM_PROMPT,
			tools: createRefusalTools(),
			turns: ['Look up the kettle.', 'Say that you are done.'],
			limit: 1,
		})
		// The opening turn stops at its limit, so it is partial; the later turn answers whole.
		expect(conversation.partial).toBe(true)
		expect(conversation.result).toMatchObject({ content: 'Done.', partial: false })
		expect(conversation.timings.map((timing) => [timing.operation, timing.name])).toEqual([
			['generation', provider.id],
			['tool', 'lookup'],
			['generation', provider.id],
			['tool', 'lookup'],
			['generation', provider.id],
		])
		expect(conversation.timings.every((timing) => timing.end >= timing.start)).toBe(true)
		const ends = conversation.timings.map((timing) => timing.end)
		expect(ends).toEqual([...ends].sort((left, right) => left - right))
		expect(conversation.usages).toEqual(
			Array.from({ length: 3 }, () => ({ prompt: 3, completion: 4, total: 7 })),
		)
	})

	it('records the thinking the turn streamed, not the text the agent joined, when native and inline reasoning mix', async () => {
		const conversation = await converseStore({
			provider: createOllama({
				model: 'fixture-model',
				fetch: createScriptedTransport([STORE_MIXED_TURN]),
			}),
			system: STORE_SYSTEM_PROMPT,
			tools: createRefusalTools(),
			turns: ['Say hello.'],
		})
		// The agent's own record of this turn holds the inline span ahead of the native text.
		expect(conversation.failure).toBeUndefined()
		expect(
			conversation.messages
				.filter((message) => message.role === 'assistant')
				.map((message) => [message.content, message.thinking]),
		).toEqual([['Answer.', 'native ']])
	})
})

describe('attemptStoreTask with a journey root', () => {
	it('starts consecutive attempts at e1 in a real browser', async () => {
		const browser = await createPageBrowser()
		try {
			await browser.connect()
			const contexts = browser.contexts()
			const seeds: string[] = []
			for (const attempt of STORE_ISOLATION_ATTEMPTS) {
				const result = await attemptStoreTask(
					browser,
					{ ...STORE_TASKS.shipping, name: 'isolation' },
					attempt,
					createOllama({
						model: 'fixture-model',
						fetch: createScriptedTransport([{ content: 'Finished.' }]),
					}),
				)
				seeds.push(extractReferences(result.transcript.seed)[0] ?? '')
				expect(result.store.read().cart).toEqual([])
				expect(browser.contexts()).toEqual(contexts)
			}
			expect(seeds).toEqual(['e1', 'e1'])
			await expect(
				attemptStoreTask(
					browser,
					{ ...STORE_TASKS.shipping, name: 'isolation-failure' },
					1,
					createOllama({
						model: 'fixture-model',
						fetch: async () => new Response('Refused', { status: 401 }),
					}),
				),
			).rejects.toBeInstanceOf(ProviderError)
			expect(browser.contexts()).toEqual(contexts)
		} finally {
			await browser.destroy()
		}
	})

	it('removes the root it allocated under tmp/browsers when the page cannot open', async () => {
		const refusal = new Error('the browser refused a page')
		const provider = createOllama({ model: 'fixture', url: 'http://127.0.0.1:9' })
		await expect(
			attemptStoreTask(
				{ isolate: () => Promise.reject(refusal) },
				STORE_TASKS.journey,
				7,
				provider,
			),
		).rejects.toBe(refusal)
		expect(
			readdirSync(resolveJourneyPath()).filter((name) => name.startsWith('journey-7-')),
		).toEqual([])
	})
})

describe('store helper boundaries', () => {
	it('stems words without discarding more than one trailing letter', () => {
		expect(stemWord('KETTLES')).toBe('kettle')
		expect(stemWord('glass')).toBe('glas')
		expect(stemWord('')).toBe('')
	})

	it('finds products by identifier and refuses absent or unknown identifiers', () => {
		expect(findStoreProduct('p4')).toMatchObject({ name: 'Copper Kettle', price: '$58.00' })
		expect(findStoreProduct(undefined)).toBeUndefined()
		expect(findStoreProduct(null)).toBeUndefined()
		expect(findStoreProduct('')).toBeUndefined()
		expect(findStoreProduct('missing')).toBeUndefined()
	})

	it('builds an uncached not-found HTML response', async () => {
		const response = buildMissingResponse()
		expect(response.status).toBe(404)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
		expect(await response.text()).toContain('<h1>Not found</h1>')
	})

	it('extracts headers and numeric captures without inventing absent values', () => {
		expect(extractPageHeader('Receipt\npage "Cart" http://store/cart\n1: Cart')).toBe(
			'page "Cart" http://store/cart',
		)
		expect(extractPageHeader('Receipt\r\npage "Cart" http://store/cart\r\n1: Cart')).toBe(
			'page "Cart" http://store/cart',
		)
		expect(extractPageHeader('No page header')).toBeUndefined()
		expect(readCapturedNumber(/(31)/.exec('31'))).toBe(31)
		expect(readCapturedNumber(/(0)/.exec('0'))).toBe(0)
		expect(readCapturedNumber(null)).toBeUndefined()
		expect(readCapturedNumber(/31/.exec('31'))).toBeUndefined()
	})

	it('matches only identified cart-click rows', () => {
		expect(matchesCartClick('s12 click link "Cart"')).toBe(true)
		expect(matchesCartClick('s0 click link "Cart"')).toBe(false)
		expect(matchesCartClick('s12 click link "Checkout"')).toBe(false)
		expect(matchesCartClick('s12 click button "Cart"')).toBe(false)
		expect(matchesCartClick('')).toBe(false)
	})

	it('builds refused calls with default or supplied arguments and text', () => {
		expect(buildRefusedCall('save')).toEqual({
			name: 'save',
			arguments: {},
			success: false,
			text: '',
		})
		expect(buildRefusedCall('click', { ref: 'e99' }, 'Not in view.')).toEqual({
			name: 'click',
			arguments: { ref: 'e99' },
			success: false,
			text: 'Not in view.',
		})
	})

	it('creates the refusal registry and records successful and failed calls', async () => {
		const tools = createRefusalTools()
		try {
			expect(tools.definitions().map((definition) => definition.name)).toEqual(['lookup', 'fail'])
			expect(await executeStoreCall(tools, 'lookup-test', 'lookup', { query: 'kettle' })).toEqual({
				name: 'lookup',
				arguments: { query: 'kettle' },
				success: true,
				text: LOOKUP_DATUM,
			})
			expect(await executeStoreCall(tools, 'fail-test', 'fail', {})).toEqual({
				name: 'fail',
				arguments: {},
				success: false,
				text: THROWING_TOOL_MESSAGE,
			})
		} finally {
			tools.destroy()
		}
	})

	it('resolves transcript paths against the supplied root', () => {
		const scratch = createScratch({ prefix: 'store-path-' })
		try {
			expect(resolveTranscriptPath('checkout', 2, scratch.path)).toBe(
				join(scratch.path, 'tmp', 'probes', 'logs', 'checkout-2.json'),
			)
		} finally {
			scratch.destroy()
		}
	})
})

describe('collectTurnThinking', () => {
	it('forwards every chunk and separates reasoning at usage boundaries', async () => {
		const channel = createChannel<AgentChunk>()
		for (const chunk of STORE_THINKING_CHUNKS) channel.push(chunk)
		channel.close()
		const thoughts: StoreThought[] = []
		const chunks = await collect(collectTurnThinking(channel.drain(), thoughts))
		expect(chunks).toEqual(STORE_THINKING_CHUNKS)
		expect(chunks[0]).toBe(STORE_THINKING_CHUNKS[0])
		expect(deriveTurnThinking(thoughts)).toEqual(['Check the cart.', '', 'Confirm.'])
	})

	it('preserves an empty stream and propagates a stream failure', async () => {
		const empty = createChannel<AgentChunk>()
		empty.close()
		const thoughts: StoreThought[] = []
		expect(await collect(collectTurnThinking(empty.drain(), thoughts))).toEqual([])
		expect(deriveTurnThinking(thoughts)).toEqual([''])
		const failed = createChannel<AgentChunk>()
		const failure = new Error('Stream refused')
		failed.fail(failure)
		await expect(collect(collectTurnThinking(failed.drain(), thoughts))).rejects.toBe(failure)
		expect(deriveTurnThinking(thoughts)).toEqual([''])
	})

	it('logs each reasoning and usage chunk unchanged in emission order and no answer chunk', async () => {
		const channel = createChannel<AgentChunk>()
		for (const chunk of STORE_THINKING_CHUNKS) channel.push(chunk)
		channel.close()
		const thoughts: StoreThought[] = []
		await collect(collectTurnThinking(channel.drain(), thoughts))
		expect(thoughts).toEqual([
			{ category: 'think', content: 'Check ' },
			{ category: 'think', content: 'the cart.' },
			{ category: 'usage' },
			{ category: 'usage' },
			{ category: 'think', content: 'Confirm.' },
		])
	})

	it('reads only the category of each chunk and the content of a think chunk, as the category check did', async () => {
		const reads: string[] = []
		const channel = createChannel<AgentChunk>()
		for (const chunk of STORE_THINKING_CHUNKS.slice(0, 4)) {
			channel.push(
				buildTracedRecord(chunk, (key) => {
					reads.push(`${chunk.category}:${key}`)
				}),
			)
		}
		channel.close()
		const thoughts: StoreThought[] = []
		await collect(collectTurnThinking(channel.drain(), thoughts))
		expect(reads).toEqual([
			'think:category',
			'think:content',
			'token:category',
			'token:category',
			'think:category',
			'think:content',
			'usage:category',
			'usage:category',
		])
		expect(deriveTurnThinking(thoughts)).toEqual(['Check the cart.', ''])
	})

	it('captures each chunk at emission, so a consumer that changes a chunk later changes nothing the log holds', async () => {
		const channel = createChannel<AgentChunk>()
		channel.push({ category: 'think', content: 'Plan.' })
		channel.push({ category: 'usage', usage: { prompt: 1, completion: 1, total: 2 }, estimate: 1 })
		channel.push({ category: 'think', content: 'Answer.' })
		channel.close()
		const thoughts: StoreThought[] = []
		for await (const chunk of collectTurnThinking(channel.drain(), thoughts)) {
			Object.defineProperty(chunk, chunk.category === 'usage' ? 'category' : 'content', {
				value: 'changed',
			})
		}
		expect(deriveTurnThinking(thoughts)).toEqual(['Plan.', 'Answer.'])
	})

	it('keeps the log of a stream the consumer leaves early up to the last chunk it received', async () => {
		const channel = createChannel<AgentChunk>()
		for (const chunk of STORE_THINKING_CHUNKS) channel.push(chunk)
		channel.close()
		const thoughts: StoreThought[] = []
		for await (const chunk of collectTurnThinking(channel.drain(), thoughts)) {
			if (chunk.category === 'usage') break
		}
		expect(deriveTurnThinking(thoughts)).toEqual(['Check the cart.', ''])
	})
})

describe('deriveTurnThinking', () => {
	for (const scenario of STORE_THOUGHT_CASES) {
		it(`derives one text per provider turn from ${scenario.label}`, () => {
			expect(deriveTurnThinking(scenario.log)).toEqual(scenario.turns)
		})
	}
})

describe('StoreActivity', () => {
	it('records the cart, searches, and orders in submission order and reads copies of them', () => {
		const activity = new StoreActivity([STORE_NAMED_PRODUCT])
		activity.add('Linen Apron')
		activity.search('kettle')
		activity.search('mug')
		activity.order(STORE_BUYER)
		const reading = activity.read()
		expect(reading).toEqual({
			cart: [STORE_NAMED_PRODUCT, 'Linen Apron'],
			searches: ['kettle', 'mug'],
			orders: [STORE_BUYER],
		})
		activity.add('Stoneware Mug')
		expect(reading.cart).toEqual([STORE_NAMED_PRODUCT, 'Linen Apron'])
		expect(activity.read().cart).toEqual([STORE_NAMED_PRODUCT, 'Linen Apron', 'Stoneware Mug'])
	})

	it('starts empty by default and copies the cart it starts with', () => {
		const initial = [STORE_NAMED_PRODUCT]
		const seeded = new StoreActivity(initial)
		seeded.add('Linen Apron')
		expect(initial).toEqual([STORE_NAMED_PRODUCT])
		expect(new StoreActivity().read()).toEqual({ cart: [], searches: [], orders: [] })
	})

	it('keeps the state of two records apart', () => {
		const first = new StoreActivity()
		const second = new StoreActivity()
		first.order(STORE_BUYER)
		expect(first.read().orders).toEqual([STORE_BUYER])
		expect(second.read().orders).toEqual([])
	})
})

describe('StoreCallRecord', () => {
	const refused: ToolResult = { id: '1', name: 'fail', success: false, error: 'gone' }
	const succeeded: ToolResult = { id: '2', name: 'lookup', success: true, value: 'found' }
	const failing: ToolCall = { id: '1', name: 'fail', arguments: {} }
	const looking: ToolCall = { id: '2', name: 'lookup', arguments: { query: 'kettle' } }

	it('records each call with its rendered result and ends the opening turn at the refusal bound', () => {
		const record = new StoreCallRecord()
		const context = createStoreContext()
		record.begin(0)
		for (const _ of Array.from({ length: STORE_BOUNDS.refusals - 1 }))
			record.observe(failing, refused, context)
		expect(context.scope).toBeUndefined()
		expect(record.ended).toBe(0)
		record.observe(failing, refused, context)
		expect(context.scope).toBe(STORE_ANSWER_SCOPE)
		expect(record.ended).toBe(1)
		record.observe(failing, refused, context)
		expect(record.ended).toBe(1)
		expect(record.calls).toEqual(
			Array.from({ length: STORE_BOUNDS.refusals + 1 }, () => ({
				name: 'fail',
				arguments: {},
				success: false,
				text: 'gone',
			})),
		)
	})

	it('ends a later turn at its first successful call and the opening turn at no success', () => {
		const record = new StoreCallRecord()
		const opening = createStoreContext()
		record.begin(0)
		record.observe(looking, succeeded, opening)
		expect(opening.scope).toBeUndefined()
		expect(record.ended).toBe(0)
		const later = createStoreContext()
		record.end()
		record.begin(1)
		record.observe(failing, refused, later)
		expect(later.scope).toBeUndefined()
		record.observe(looking, succeeded, later)
		expect(later.scope).toBe(STORE_ANSWER_SCOPE)
		expect(record.ended).toBe(1)
		expect(record.calls.map((call) => [call.name, call.success, call.text])).toEqual([
			['lookup', true, 'found'],
			['fail', false, 'gone'],
			['lookup', true, 'found'],
		])
	})

	it('counts refusals from the calls the turn began after', () => {
		const record = new StoreCallRecord()
		const context = createStoreContext()
		record.begin(0)
		record.observe(failing, refused, context)
		record.observe(failing, refused, context)
		record.end()
		record.begin(0)
		record.observe(failing, refused, context)
		record.observe(failing, refused, context)
		expect(context.scope).toBeUndefined()
		expect(record.ended).toBe(0)
		record.observe(failing, refused, context)
		expect(context.scope).toBe(STORE_ANSWER_SCOPE)
		expect(record.ended).toBe(1)
	})

	it('refuses to bind a second turn while one is bound and to observe a call with none bound', () => {
		const record = new StoreCallRecord()
		const context = createStoreContext()
		expect(() => record.observe(failing, refused, context)).toThrow('No user turn is bound')
		record.begin(0)
		expect(() => record.begin(1)).toThrow('A user turn is still bound')
		record.end()
		expect(() => record.observe(failing, refused, context)).toThrow('No user turn is bound')
		record.begin(1)
		record.observe(looking, succeeded, context)
		expect(record.calls).toHaveLength(1)
	})
})

describe('settleStoreRun', () => {
	it('reports a settled run without a failure', async () => {
		expect(await settleStoreRun(async () => {})).toEqual({ failed: false, failure: undefined })
	})

	it('captures a thrown value, including a thrown undefined value, instead of letting it escape', async () => {
		const refusal = new Error('step refused')
		expect(
			await settleStoreRun(async () => {
				await Promise.resolve()
				throw refusal
			}),
		).toEqual({ failed: true, failure: refusal })
		expect(
			await settleStoreRun(async () => {
				throw undefined
			}),
		).toEqual({ failed: true, failure: undefined })
	})
})

describe('StoreExposureTrace', () => {
	const start: StoreExposure = {
		listed: new Set(['e1']),
		header: 'page "A" http://store/a',
		unlisted: [],
	}

	it('adds the references of a successful result and clears them when the page header changes', () => {
		const trace = new StoreExposureTrace(start)
		trace.visit(buildStoreCall('read', {}, 'page "A" http://store/a\n2: button "Y" [ref=e2]'))
		const same = trace.exposure
		expect([...same.listed]).toEqual(['e1', 'e2'])
		trace.visit(buildStoreCall('read', {}, 'page "B" http://store/b\n3: link "Z" [ref=e3]'))
		const moved = trace.exposure
		expect([...moved.listed]).toEqual(['e3'])
		expect(moved.header).toBe('page "B" http://store/b')
		expect([...start.listed]).toEqual(['e1'])
		expect([...same.listed]).toEqual(['e1', 'e2'])
	})

	it('records an unlisted reference apart from the earlier exposure and ignores a failed result', () => {
		const invented = buildRefusedCall('click', { ref: 'e9' }, 'Not in the current view.')
		const trace = new StoreExposureTrace(start)
		trace.visit(invented)
		const flagged = trace.exposure
		expect(flagged.unlisted).toEqual([invented])
		expect([...flagged.listed]).toEqual(['e1'])
		expect(start.unlisted).toEqual([])
		trace.visit(buildRefusedCall('read', {}, 'page "C" http://store/c\n4: link "W" [ref=e4]'))
		const failed = trace.exposure
		expect([...failed.listed]).toEqual(['e1'])
		expect(failed.header).toBe('page "A" http://store/a')
		expect(failed.unlisted).toEqual([invented])
	})

	it('reads out copies that its later calls cannot change', () => {
		const trace = new StoreExposureTrace(start)
		const before = trace.exposure
		trace.visit(buildStoreCall('read', {}, 'page "B" http://store/b\n3: link "Z" [ref=e3]'))
		trace.visit(buildStoreCall('click', { ref: 'e9' }))
		expect([...before.listed]).toEqual(['e1'])
		expect(before.header).toBe('page "A" http://store/a')
		expect(before.unlisted).toEqual([])
	})
})

describe('StoreContinuationWalk', () => {
	const first = buildStoreCall('read', { from: 1 }, STORE_FIRST_SLICE)
	const continued = buildStoreCall('read', { from: 31 }, STORE_CONTINUED_SLICE)

	it('returns the call that continued at a line an earlier footer named, and nothing before it', () => {
		const walk = new StoreContinuationWalk(STORE_POLICY_TOKEN)
		expect(walk.visit(first)).toBeUndefined()
		expect(walk.visit(continued)).toBe(continued)
	})

	it.each(STORE_CONTINUATION_INTERRUPTIONS)(
		'forgets the named lines at %s',
		(_reason, interruption) => {
			const walk = new StoreContinuationWalk(STORE_POLICY_TOKEN)
			walk.visit(first)
			walk.visit(interruption)
			expect(walk.visit(continued)).toBeUndefined()
		},
	)

	it('names each interruption the walk forgets at, every one a successful call', () => {
		expect(
			STORE_CONTINUATION_INTERRUPTIONS.map(([reason, call]) => [reason, call.success]),
		).toEqual([
			['an action', true],
			['a change note', true],
			['another page', true],
		])
		expect(STORE_CONTINUATION_INTERRUPTIONS.map(([, call]) => call.name)).toEqual([
			'click',
			'read',
			'read',
		])
	})

	it('keeps the named lines across a refused read', () => {
		const walk = new StoreContinuationWalk(STORE_POLICY_TOKEN)
		walk.visit(first)
		walk.visit(buildRefusedCall('read', { from: 2 }, 'Refused.'))
		expect(walk.visit(continued)).toBe(continued)
	})
})

describe('StoreThinking', () => {
	it('gives the n-th assistant message the n-th turn thinking and passes the others through', () => {
		const user: Message = { id: 'u', role: 'user', content: '' }
		const assistant: Message = { id: 'a', role: 'assistant', content: '' }
		const thinking = new StoreThinking(['first', ''])
		expect(thinking.attach(user)).toBe(user)
		expect(thinking.attach(assistant)).toEqual({ ...assistant, thinking: 'first' })
		expect(thinking.attach(assistant)).toBe(assistant)
		expect(thinking.attach(assistant)).toBe(assistant)
	})

	it('advances past a silent turn, so a later turn keeps its own thinking', () => {
		const assistant: Message = { id: 'a', role: 'assistant', content: '' }
		const thinking = new StoreThinking(['', 'second', '', 'fourth'])
		expect(thinking.attach(assistant)).toBe(assistant)
		expect(thinking.attach(assistant)).toEqual({ ...assistant, thinking: 'second' })
		expect(thinking.attach(assistant)).toBe(assistant)
		expect(thinking.attach(assistant)).toEqual({ ...assistant, thinking: 'fourth' })
	})
})

describe('STORE_SEARCH_SEED', () => {
	it('opens the catalogue with the search box and its button, and seeds the stalled search', () => {
		expect(extractReferences(STORE_SEARCH_SEED)).toEqual(['e35', 'e36'])
		expect(STORE_SEARCH_SEED).toMatch(/^page "Harbor Goods — Catalogue" /)
		expect(STORE_STALLED_SEARCH.seed).toBe(STORE_SEARCH_SEED)
		expect(STORE_COMPLETED_SEARCH.seed).toBe(STORE_SEARCH_SEED)
	})
})

describe('hole handling of the call readers', () => {
	const first = buildStoreCall('read', { from: 1 }, STORE_FIRST_SLICE)
	const continued = buildStoreCall('read', { from: 31 }, STORE_CONTINUED_SLICE)

	it('visits a hole in the calls as undefined, so findUnlistedReferences and computeRefusals throw on it', () => {
		const calls = buildSparseList([buildStoreCall('click', { ref: 'e1' }), undefined])
		expect(() => findUnlistedReferences('1: link "Cart" [ref=e1]', calls)).toThrow(TypeError)
		expect(() => computeRefusals(buildSparseList([buildRefusedCall('save'), undefined]))).toThrow(
			TypeError,
		)
	})

	it('reads findContinuedRead only as far as the match, so a hole after it is never visited and one before it throws', () => {
		expect(
			findContinuedRead(buildSparseList([first, continued, undefined]), STORE_POLICY_TOKEN),
		).toBe(continued)
		expect(() =>
			findContinuedRead(buildSparseList([first, undefined, continued]), STORE_POLICY_TOKEN),
		).toThrow(TypeError)
	})

	it('reads matchesJourneySequence only as far as the sequence, so a hole after it is never visited and one before it throws', () => {
		expect(matchesJourneySequence(buildSparseList([...STORE_JOURNEY_CALLS, undefined]))).toBe(true)
		expect(() =>
			matchesJourneySequence(buildSparseList([undefined, ...STORE_JOURNEY_CALLS])),
		).toThrow(TypeError)
	})

	it('counts only assistant messages as turns, however many tool messages lie between them', () => {
		const user: Message = { id: 'u', role: 'user', content: '' }
		const assistant: Message = { id: 'a', role: 'assistant', content: '' }
		const tool: Message = { id: 't', role: 'tool', content: 'results' }
		const recorded = attachThinking([user, assistant, tool, tool, assistant], ['first', 'second'])
		expect(recorded.map((message) => message.thinking)).toEqual([
			undefined,
			'first',
			undefined,
			undefined,
			'second',
		])
	})

	it('keeps a hole in the messages a hole and counts assistant turns across it', () => {
		const user: Message = { id: 'u', role: 'user', content: '' }
		const assistant: Message = { id: 'a', role: 'assistant', content: '' }
		const recorded = attachThinking(buildSparseList([user, undefined, assistant, assistant]), [
			'first',
			'second',
		])
		expect(Object.keys(recorded)).toEqual(['0', '2', '3'])
		expect(recorded.map((message) => message.thinking)).toEqual([
			undefined,
			undefined,
			'first',
			'second',
		])
	})

	it('reads a quoted best-match row once, even when the row before it announced another', () => {
		const text = [
			'No line from 3 on matches "a"; the best match is line 1:',
			'No line from 3 on matches "a"; the best match is line 2:',
			'5: x',
			'6: y',
		].join('\n')
		expect(extractWindowText(text)).toBe('5: x\n6: y')
	})
})

describe('buildJourneyInvocation', () => {
	it('names each journey tool with the arguments the proof supplies', () => {
		expect(buildJourneyInvocation('record', [], '')).toEqual({
			name: 'record',
			input: { journey: STORE_JOURNEY_NAME },
		})
		expect(buildJourneyInvocation('save', [], '')).toEqual({
			name: 'save',
			input: { description: 'Open the cart and place one order.' },
		})
		expect(buildJourneyInvocation('journeys', [], '')).toEqual({
			name: 'journeys',
			input: { from: 1 },
		})
		expect(buildJourneyInvocation('replay', [], '')).toEqual({
			name: 'replay',
			input: {
				journey: STORE_JOURNEY_NAME,
				inputs: { [STORE_JOURNEY_PARAMETER]: STORE_JOURNEY_BUYER },
			},
		})
	})

	it('reads the batch the edit turn spells out from the last listing', () => {
		const { name, input } = buildJourneyInvocation('edit', STORE_JOURNEY_CALLS.slice(0, 4), '')
		expect(name).toBe('edit')
		expect(input['journey']).toBe(STORE_JOURNEY_NAME)
		expect(matchesJourneyBatch(buildStoreCall('edit', input))).toBe(true)
	})

	it('acts on an element through the reference its row lists in the last result, or in the seed', () => {
		const seed = 'page "Store" http://store/ (2 lines)\n1: link "Cart" [ref=e1]'
		expect(buildJourneyInvocation('Cart', [], seed)).toEqual({
			name: 'click',
			input: { ref: 'e1' },
		})
		const listing = buildStoreCall('click', {}, '3: textbox "Full name" [ref=e4]')
		expect(buildJourneyInvocation('Full name', [listing], seed)).toEqual({
			name: 'type',
			input: { ref: 'e4', text: STORE_BUYER, submit: true },
		})
		expect(() => buildJourneyInvocation('Checkout', [listing], seed)).toThrow(
			'The last result lists no row for "Checkout"',
		)
	})
})

describe('converseStore with a failing user turn', () => {
	it('keeps the partial flag of a settled turn when a later turn fails', async () => {
		const conversation = await converseStore({
			provider: createOllama({
				model: 'fixture-model',
				fetch: createScriptedTransport([STORE_LOOKUP_TURN]),
			}),
			system: STORE_SYSTEM_PROMPT,
			tools: createRefusalTools(),
			turns: ['Look up the kettle.', 'Look up the kettle again.'],
			limit: 1,
		})
		expect(conversation.result).toBeUndefined()
		expect(conversation.partial).toBe(true)
		expect(String(conversation.failure)).toContain('the script holds 1 turns')
		expect(conversation.calls.map((call) => [call.name, call.success])).toEqual([['lookup', true]])
	})

	it('ends the conversation with the error a hole in the turns raises, after the turns before it', async () => {
		const conversation = await converseStore({
			provider: createOllama({
				model: 'fixture-model',
				fetch: createScriptedTransport([{ content: 'One.' }, { content: 'Two.' }]),
			}),
			system: STORE_SYSTEM_PROMPT,
			tools: createRefusalTools(),
			turns: buildSparseList<StoreTurn>(['First.', undefined, 'Third.']),
		})
		expect(conversation.result).toBeUndefined()
		expect(conversation.failure).toBeInstanceOf(TypeError)
		expect(conversation.messages.map((message) => message.content)).toEqual(['First.', 'One.'])
	})
})
