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

import type { BrowserJourney } from '@orkestrel/browser'
import type {
	StoreCall,
	StoreServerInterface,
	StoreTiming,
	StoreTranscript,
} from './setupStore/types.js'
import { DEFAULT_PROVIDER_TIMEOUT, ProviderError } from '@orkestrel/agent'
import {
	BROWSER_TOOL_COPY,
	BROWSER_TOOL_LIMIT,
	createBrowserReading,
	createBrowserToolset,
	scanBrowserLines,
	BROWSER_JOURNEY_TOOL_NAMES,
	renderBrowserJourney,
} from '@orkestrel/browser'
import {
	createBrowser,
	createFileBrowserJourneyStore,
	createFileBrowserRunStore,
} from '@orkestrel/browser/server'
import { requireValue } from '@orkestrel/test'
import { createScratch } from '@orkestrel/test/server'
import { createToolManager } from '@orkestrel/tool'
import { createOllama } from '@src/core'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	attachThinking,
	attemptStoreTask,
	buildStoreCall,
	buildStoreDraws,
	buildStorePrompt,
	buildStoreTranscript,
	collectStoreFiles,
	computeRefusals,
	converseStore,
	createStoreServer,
	createTimedProvider,
	createTimedTools,
	escapeMarkup,
	extractFooterLine,
	extractJourneyEvidence,
	extractReferences,
	filterNamedProducts,
	filterProducts,
	filterSubmissionLines,
	findBoundParameter,
	findContinuedRead,
	findJourneyLoops,
	findMalformedCalls,
	findUnlistedReferences,
	inferPageTools,
	journeyPath,
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
	STORE_NAMED,
	STORE_POLICY_TOKEN,
	STORE_PRODUCTS,
	STORE_QUERY,
	STORE_SYSTEM_PROMPT,
	STORE_TASKS,
	transcriptPath,
	writeTranscript,
} from './setupStore.js'
import {
	createLookupTool,
	createRecordingTransport,
	createScriptedTransport,
	createThrowingTool,
	reservePort,
	wireTools,
} from './setupServer.js'
import { PAGE_BROWSER_ARGS, requirePageBrowser } from './setupService.js'

let store: StoreServerInterface

describe('real line projection', () => {
	it('records a cart click and one submission, removes the click, and replays exactly one order for the other buyer', async () => {
		const fresh = await createStoreServer()
		const root = createScratch({ parent: journeyPath(), prefix: 'journey-proof-' })
		const browser = createBrowser({
			executable: requirePageBrowser().executable,
			headless: true,
			args: PAGE_BROWSER_ARGS,
			cdp: { port: await reservePort(), discover: false },
		})
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
				for (const action of [
					'record',
					'Cart',
					'Checkout',
					'Full name',
					'save',
					'journeys',
					'edit',
					'replay',
				]) {
					let name = action
					let args: Readonly<Record<string, unknown>> = {}
					if (action === 'record') args = { journey: STORE_JOURNEY_NAME }
					else if (action === 'save') args = { description: 'Open the cart and place one order.' }
					else if (action === 'journeys') args = { from: 1 }
					else if (action === 'edit') {
						const instruction = renderJourneyEdit(calls)
						args = {
							journey: STORE_JOURNEY_NAME,
							edits: parseStoreJSON(
								instruction.slice(instruction.indexOf('['), instruction.lastIndexOf(']') + 1),
							),
						}
					} else if (action === 'replay')
						args = {
							journey: STORE_JOURNEY_NAME,
							inputs: { [STORE_JOURNEY_PARAMETER]: STORE_JOURNEY_BUYER },
						}
					else {
						const text = calls.at(-1)?.text ?? seed
						const line = requireValue(
							text.split(/\r\n|\n/).find((row) => row.includes(`"${action}"`)),
						)
						const ref = requireValue(extractReferences(line)[0])
						name = action === 'Full name' ? 'type' : 'click'
						args = action === 'Full name' ? { ref, text: STORE_BUYER, submit: true } : { ref }
					}
					const result = await tools.tools.execute({ id: action, name, arguments: args })
					if (!result.success)
						writeFileSync(
							'tmp/codex/reading-journey-refusal.json',
							JSON.stringify({ action, args, result, calls }, undefined, 2),
						)
					expect(result.success).toBe(true)
					calls.push({
						name,
						arguments: args,
						success: result.success,
						text: renderToolText(result),
					})
				}
				const transcript = {
					...buildStoreTranscript(calls, seed),
					task: 'journey',
					files: collectStoreFiles(root.path),
					state: {
						cart: fresh.readCart(),
						searches: fresh.readSearches(),
						orders: fresh.readOrders(),
					},
				}
				expect(transcript.state.orders).toEqual([STORE_BUYER, STORE_JOURNEY_BUYER])
				expect(matchesJourneyOracle(transcript)).toBe(true)
				expect(
					filterSubmissionLines(requireValue(calls.find((call) => call.name === 'save')).text),
				).toHaveLength(1)
				writeFileSync('tmp/codex/reading-journey.json', JSON.stringify(transcript, undefined, 2))
				for (const refused of [
					{ ...transcript, partial: true },
					{
						...transcript,
						calls: [
							...calls,
							buildStoreCall('read', { from: 1 }, 'x'.repeat(BROWSER_TOOL_LIMIT + 1)),
						],
					},
					{ ...transcript, calls: [...calls, buildStoreCall('click', { ref: 'e999' })] },
					{
						...transcript,
						calls: [
							...calls,
							...Array.from({ length: 5 * STORE_BOUNDS.limit }, () =>
								buildStoreCall('read', { from: 1 }),
							),
						],
					},
				])
					expect(matchesJourneyOracle(refused)).toBe(false)
			} finally {
				await tools.destroy()
			}
		} finally {
			await browser.destroy()
			root.destroy()
			await fresh.stop()
		}
	}, 60_000)

	it('places the fact beyond the seed and the token in the third default window with the exact advertised tools', async () => {
		const browser = createBrowser({
			executable: requirePageBrowser().executable,
			headless: true,
			args: PAGE_BROWSER_ARGS,
			cdp: { port: await reservePort(), discover: false },
		})
		const root = createScratch({ parent: journeyPath(), prefix: 'reading-proof-' })
		try {
			await browser.connect()
			const context = await browser.isolate()
			const page = await context.create()
			await page.navigate(store.url)
			const tools = createBrowserToolset(page)
			try {
				await tools.start()
				const definitions = tools.tools.definitions()
				expect(definitions.map((definition) => definition.name)).toEqual([
					'read',
					'click',
					'type',
					'press',
					'navigate',
					'wait',
				])
				expect(
					definitions.find((definition) => definition.name === 'type')?.parameters?.['properties'],
				).toHaveProperty('secret')
				const seed = renderToolText(
					await tools.tools.execute({ id: 'seed', name: 'read', arguments: STORE_SEED_ARGUMENTS }),
				)
				expect(seed).not.toContain(STORE_FACT)
				expect(seed).not.toContain(STORE_POLICY_TOKEN)
				const catalogueNext = requireValue(extractFooterLine(seed))
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
				await page.navigate(`${store.url}/policy`)
				const policy = renderToolText(
					await tools.tools.execute({
						id: 'policy',
						name: 'read',
						arguments: STORE_SEED_ARGUMENTS,
					}),
				)
				const second = requireValue(extractFooterLine(policy))
				const middle = renderToolText(
					await tools.tools.execute({ id: 'middle', name: 'read', arguments: { from: second } }),
				)
				const third = requireValue(extractFooterLine(middle))
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
				writeFileSync(
					'tmp/codex/harness-positions.json',
					JSON.stringify(
						{ fact, token, catalogueNext, second, third, seed, shipping, policy, middle, last },
						undefined,
						2,
					),
				)
			} finally {
				await tools.destroy()
			}
			const journeys = createBrowserToolset(page, {
				journeys: {
					store: createFileBrowserJourneyStore({ root: root.path }),
					runs: createFileBrowserRunStore({ root: root.path }),
				},
			})
			try {
				await journeys.start()
				const names = journeys.tools.definitions().map((definition) => definition.name)
				for (const name of BROWSER_JOURNEY_TOOL_NAMES) expect(names).toContain(name)
				expect(BROWSER_JOURNEY_TOOL_NAMES).toHaveLength(7)
			} finally {
				await journeys.destroy()
			}
		} finally {
			await browser.destroy()
			root.destroy()
		}
	}, 60_000)

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
		const base = buildStoreTranscript([buildStoreCall('read', { from: 1 }, STORE_FACT)])
		const cases = [
			{ predicate: matchesShippingOracle, transcript: { ...base, answer: STORE_FACT } },
			{
				predicate: matchesCartOracle,
				transcript: { ...base, state: { ...base.state, cart: [STORE_NAMED] } },
			},
			{
				predicate: matchesSearchOracle,
				transcript: {
					...base,
					state: { ...base.state, searches: [STORE_QUERY] },
					answer: 'Alpine Kettle, Copper Kettle',
				},
			},
			{
				predicate: matchesCheckoutOracle,
				transcript: {
					...base,
					state: { ...base.state, orders: [STORE_BUYER] },
					answer: STORE_CODE,
				},
			},
			{
				predicate: matchesPagingOracle,
				transcript: buildStoreTranscript([
					buildStoreCall('read', { from: 1 }, FIRST_SLICE),
					buildStoreCall('read', { from: 31 }, CONTINUED_SLICE),
				]),
			},
		]
		for (const { predicate, transcript } of cases) {
			expect(predicate(transcript)).toBe(true)
			for (const refused of [
				{ ...transcript, partial: true },
				{ ...transcript, failure: 'failed' },
				{ ...transcript, calls: [] },
				{ ...transcript, seed: 'x'.repeat(BROWSER_TOOL_LIMIT + 1) },
				{
					...transcript,
					calls: [
						...transcript.calls,
						...Array.from({ length: STORE_BOUNDS.limit }, () =>
							buildStoreCall('read', { from: 1 }),
						),
					],
				},
				{ ...transcript, calls: [...transcript.calls, buildStoreCall('click', { ref: 'e999' })] },
				{
					...transcript,
					calls: [
						...transcript.calls,
						buildStoreCall(
							'read',
							{ from: 1 },
							'x'.repeat(BROWSER_TOOL_LIMIT) + '\n[lines 1–1 of 1; the whole page]',
						),
					],
				},
			])
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
				calls: [{ ...buildStoreCall('read', { from: 1 }, STORE_FACT), success: false }],
			}),
		).toBe(false)
		for (const cart of [
			[],
			[STORE_NAMED, STORE_NAMED],
			[STORE_NAMED, 'Linen Apron'],
			['Linen Apron'],
		])
			expect(matchesCartOracle({ ...shipping, state: { ...shipping.state, cart } })).toBe(false)
		for (const orders of [
			[],
			[STORE_BUYER, STORE_BUYER],
			[STORE_JOURNEY_BUYER],
			[STORE_BUYER, STORE_JOURNEY_BUYER],
		])
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
		const timings: StoreTiming[] = []
		const measured = createTimedTools(tools, timings)
		expect(measured.definitions()).toEqual(tools.definitions())
		tools.add(createThrowingTool())
		expect(measured.definitions()).toEqual(tools.definitions())
		const calls = [
			{ id: 'lookup', name: 'lookup', arguments: { query: 'kettle' } },
			{ id: 'missing', name: 'missing', arguments: {} },
		]
		const result = await measured.execute(calls)
		expect(result.map((entry) => entry.success)).toEqual([true, false])
		expect(timings.map((timing) => timing.name).sort()).toEqual(['lookup', 'missing'])
		for (const timing of timings) {
			expect(timing.operation).toBe('tool')
			expect(timing.end).toBeGreaterThanOrEqual(timing.start)
		}
		tools.destroy()
	})

	it('records a generation and a failed stream without changing their result or error', async () => {
		const timings: StoreTiming[] = []
		const provider = createTimedProvider(
			createOllama({
				model: 'fixture',
				fetch: createScriptedTransport([{ content: 'Measured.' }]),
			}),
			timings,
		)
		const signal = AbortSignal.timeout(5000)
		expect(
			(await provider.generate([{ id: '1', role: 'user', content: 'Answer.' }], signal)).content,
		).toBe('Measured.')
		const stream = provider.stream([{ id: '2', role: 'user', content: 'Answer again.' }], signal)
		await expect(stream.next()).rejects.toThrow('the script holds 1 turns')
		expect(timings).toHaveLength(2)
		for (const timing of timings) {
			expect(timing.operation).toBe('generation')
			expect(timing.end).toBeGreaterThanOrEqual(timing.start)
		}
	})
})

beforeAll(async () => {
	store = await createStoreServer()
})

afterAll(async () => {
	await store.stop()
})

describe('createStoreServer', () => {
	it('listens on the IPv4 loopback on an ephemeral port', () => {
		expect(store.url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/)
	})

	it('serves the catalogue with the search form and every featured product with its price', async () => {
		const response = await fetch(`${store.url}/`)
		const html = await response.text()
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
		expect(html).toContain('<form action="/search" method="get" role="search">')
		expect(html).toContain('<input id="q" type="search" name="q">')
		const featured = STORE_PRODUCTS.filter((product) => product.featured)
		expect(featured.length).toBeGreaterThanOrEqual(6)
		for (const product of featured) {
			expect(html).toContain(`<a href="/product/${product.id}">${product.name}</a>`)
			expect(html).toContain(product.price)
		}
		for (const product of STORE_PRODUCTS.filter((candidate) => !candidate.featured)) {
			expect(html).not.toContain(product.name)
		}
	})

	it('lists none of the products the search task must find, so only a search names them', async () => {
		const html = await (await fetch(`${store.url}/`)).text()
		const matches = filterProducts(STORE_QUERY)
		expect(matches.length).toBeGreaterThan(0)
		for (const product of matches) expect(html).not.toContain(product.name)
	})

	it('states the shipping cutoff once, after the customer notes, beyond the first read slice', async () => {
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
		const before = store.readSearches().length
		const response = await fetch(`${store.url}/search?q=${STORE_QUERY}`)
		const html = await response.text()
		expect(response.status).toBe(200)
		expect(store.readSearches().slice(before)).toEqual([STORE_QUERY])
		const matches = filterProducts(STORE_QUERY)
		expect(matches.map((product) => product.name)).toEqual(['Alpine Kettle', 'Copper Kettle'])
		for (const product of STORE_PRODUCTS) {
			expect(html.includes(product.name)).toBe(matches.includes(product))
		}
	})

	it('answers a query nothing matches with a page that names no product', async () => {
		const html = await (await fetch(`${store.url}/search?q=anchor`)).text()
		expect(html).toContain('No products match.')
		for (const product of STORE_PRODUCTS) expect(html).not.toContain(product.name)
	})

	it('serves each product page with its add-to-cart form, and 404 for an unknown product', async () => {
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
		const other = await createStoreServer()
		try {
			const named = STORE_PRODUCTS.find((product) => product.name === STORE_NAMED)
			expect(named).toBeDefined()
			const added = await fetch(`${store.url}/cart`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: `product=${named?.id ?? ''}`,
				redirect: 'manual',
			})
			expect(added.status).toBe(303)
			expect(added.headers.get('location')).toBe('/cart')
			expect(store.readCart()).toEqual([STORE_NAMED])
			expect(other.readCart()).toEqual([])
			expect(await (await fetch(`${store.url}/cart`)).text()).toContain(`<li>${STORE_NAMED}</li>`)
			const refused = await fetch(`${store.url}/cart`, { method: 'POST', body: 'product=p0' })
			expect(refused.status).toBe(404)
			expect(store.readCart()).toEqual([STORE_NAMED])
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
		const html = await (await fetch(`${store.url}/checkout`)).text()
		expect(html).toContain('<form id="checkout">')
		expect(html).toContain('<input id="name" type="text" name="name" autocomplete="off">')
		expect(html).toContain('<button type="submit">Place order</button>')
		expect(html).toContain(`}, ${STORE_CODE_DELAY})`)
		expect(html).not.toContain(STORE_CODE)
		const order = await fetch(`${store.url}/order`, { method: 'POST', body: 'Grace Hopper' })
		expect(await order.text()).toBe(STORE_CODE)
		expect(store.readOrders()).toEqual(['Grace Hopper'])
	})

	it('states the policy token past the first 4 000 characters of the whole-page policy', async () => {
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
		expect(prompt.startsWith('Find the fixture.')).toBe(true)
		expect(prompt.endsWith('page "Store" URL')).toBe(true)
	})
})

describe('extractReferences', () => {
	it('reads numbered headings and replaces exposure with an empty page listing', () => {
		const seed =
			'page "Store" http://store/ (2 lines)\n1: e1 link "Cart" /cart\n2: ### e2 link "Tray" /tray'
		expect(extractReferences(seed)).toEqual(['e1', 'e2'])
		const cleared = buildStoreCall(
			'read',
			{ from: 3 },
			'page "Store" http://store/ (3 lines)\n3: Text only\n[lines 3–3 of 3; 2 above; end of page]',
		)
		const stale = buildStoreCall('click', { ref: 'e1' })
		expect(findUnlistedReferences(seed, [cleared, stale])).toEqual([stale])
	})
	it('returns the reference that opens each element row, in row order', () => {
		const view =
			'page "Store" URL\ne1 link "Cart"\n# Heading\ntext e9 inside\ne12 button "Go"\n(2 of 2 elements)'
		expect(extractReferences(view)).toEqual(['e1', 'e12'])
	})

	it('returns nothing for a Markdown slice', () => {
		expect(extractReferences('# Store\n\n[Cart](http://127.0.0.1/cart)')).toEqual([])
	})
})

describe('findUnlistedReferences', () => {
	it('accepts a reference the seed listed, in any spelling the toolset reads', () => {
		const calls = [
			buildStoreCall('click', { ref: 'e1' }),
			buildStoreCall(
				'read',
				{ from: 1, search: 'Cart' },
				'page "Store" http://store/ (1 lines)\n1: e1 link "Cart"\n[lines 1–1 of 1; end of page]',
			),
			buildStoreCall('click', { ref: '[e1]' }),
		]
		expect(findMalformedCalls(calls, [BROWSER_TOOL_COPY.read, BROWSER_TOOL_COPY.click])).toEqual([])
		expect(
			findUnlistedReferences('page "Store" http://store/ (1 lines)\n1: e1 link "Cart"', calls),
		).toEqual([])
	})

	it('flags an invented, a non-string, and an unreadable reference', () => {
		const invented = buildStoreCall('click', { ref: 'e9' })
		const numeric = buildStoreCall('click', { ref: 1 })
		const described = buildStoreCall('click', { ref: 'the search button' })
		expect(findMalformedCalls([described], [BROWSER_TOOL_COPY.click])).toEqual([])
		expect(
			findUnlistedReferences('page "Store" http://store/ (1 lines)\n1: e1 link "Cart"', [
				invented,
				numeric,
				described,
			]),
		).toEqual([invented, numeric, described])
	})

	it('replaces references with each read view and keeps them across receipts without a view', () => {
		const receipt = buildStoreCall(
			'click',
			{ ref: 'e1' },
			'Clicked e1 link "Cart".\n\npage "Cart" http://store/cart (1 lines)\n1: e5 button "Pay"',
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
		expect(findUnlistedReferences('e1 link "Cart"', [receipt, notice, fresh, stale])).toEqual([
			stale,
		])
		expect(findUnlistedReferences('e1 link "Cart"', [receipt, reading, fresh, stale])).toEqual([
			fresh,
			stale,
		])
	})

	it('flags nothing for calls that carry no reference', () => {
		expect(findUnlistedReferences('', [buildStoreCall('read', { search: 'x' })])).toEqual([])
	})
})

describe('splitResultFooter', () => {
	it('splits the bound footer from the body', () => {
		const footer = '[lines 1–30 of 80; 50 below; call read with from 31 for more]'
		expect(splitResultFooter(`# Policy\n\n${footer}`)).toEqual(['# Policy', footer])
	})

	it('returns the whole text and an empty footer when the result carries none', () => {
		expect(splitResultFooter('Clicked e1 link "Cart".')).toEqual(['Clicked e1 link "Cart".', ''])
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
			expect(path).toBe(transcriptPath('fixture', 1, scratch.path))
			expect(path.endsWith('fixture-1.json')).toBe(true)
			expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(transcript)
		} finally {
			scratch.destroy()
		}
	})
})

describe('STORE_SYSTEM_PROMPT', () => {
	it('stays under 120 words and names the tools the loop uses', () => {
		expect(STORE_SYSTEM_PROMPT.split(/\s+/).length).toBeLessThan(120)
		for (const answer of [STORE_FACT, STORE_CODE, STORE_POLICY_TOKEN, STORE_NAMED])
			expect(STORE_SYSTEM_PROMPT).not.toContain(answer)
		for (const tool of ['read', 'click', 'type', 'wait']) {
			expect(STORE_SYSTEM_PROMPT).toContain(tool)
		}
	})
})

const FIRST_SLICE =
	'page "Policy" http://store/policy (80 lines)\n1: # Policy\n[lines 1–30 of 80; 50 below; call read with from 31 for more]'
const CONTINUED_SLICE =
	'page "Policy" http://store/policy (80 lines)\n31: Quote ' +
	STORE_POLICY_TOKEN +
	'\n[lines 31–80 of 80; 30 above; end of page]'

describe('instrument draws', () => {
	it('balances every count prefix across tasks and preserves port attempts', () => {
		const tasks = [
			STORE_TASKS.shipping,
			STORE_TASKS.cart,
			STORE_TASKS.search,
			STORE_TASKS.checkout,
			STORE_TASKS.paging,
		]
		const draws = buildStoreDraws(tasks, [49171, 49173])
		expect(draws.map((draw) => draw.task.task)).toEqual(
			[...tasks, ...tasks].map((task) => task.task),
		)
		for (let count = 1; count <= draws.length; count += 1) {
			const tallies = tasks.map(
				(task) => draws.slice(0, count).filter((draw) => draw.task === task).length,
			)
			expect(Math.max(...tallies) - Math.min(...tallies)).toBeLessThanOrEqual(1)
		}
		expect(draws.map((draw) => [draw.port, draw.attempt, draw.arm])).toEqual([
			...tasks.map(() => [49171, 1, 'page']),
			...tasks.map(() => [49173, 2, 'page']),
		])
		expect(buildStoreDraws([], [49171])).toEqual([])
		expect(buildStoreDraws(tasks, [])).toEqual([])
	})
})

describe('line continuation', () => {
	it('reads a continuation line only from a trailing line footer', () => {
		expect(extractFooterLine(FIRST_SLICE)).toBe(31)
		expect(extractFooterLine(CONTINUED_SLICE)).toBeUndefined()
		expect(
			extractFooterLine('[characters 0–30 of 80; call read with offset 30 for more]'),
		).toBeUndefined()
	})
	it('requires a model read followed by its exact fresh continuation window', () => {
		const first = buildStoreCall('read', { from: 1 }, FIRST_SLICE)
		const continued = buildStoreCall('read', { from: 31 }, CONTINUED_SLICE)
		expect(findContinuedRead([first, continued], STORE_POLICY_TOKEN)).toBe(continued)
		expect(matchesPagingOracle(buildStoreTranscript([first, continued]))).toBe(true)
	})
	it('accepts a search that leaves the continuation window at the named line', () => {
		const first = buildStoreCall('read', { from: 1 }, FIRST_SLICE)
		const continued = buildStoreCall('read', { from: 31, search: 'token' }, CONTINUED_SLICE)
		expect(findContinuedRead([first, continued], STORE_POLICY_TOKEN)).toBe(continued)
	})
	it('accepts an earlier fresh footer across other reads on the same page', () => {
		const first = buildStoreCall('read', { from: 1 }, FIRST_SLICE)
		const other = buildStoreCall('read', { from: 40 }, CONTINUED_SLICE.replace('31: ', '40: '))
		const continued = buildStoreCall('read', { from: 31 }, CONTINUED_SLICE)
		expect(findContinuedRead([first, other, continued], STORE_POLICY_TOKEN)).toBe(continued)
	})
	it.each([
		['seed footer', []],
		[
			'failed footer call',
			[{ ...buildStoreCall('read', { from: 1 }, FIRST_SLICE), success: false }],
		],
		[
			'action',
			[buildStoreCall('read', { from: 1 }, FIRST_SLICE), buildStoreCall('press', { key: 'Tab' })],
		],
		[
			'failed action',
			[
				buildStoreCall('read', { from: 1 }, FIRST_SLICE),
				{ ...buildStoreCall('press', { key: 'Tab' }), success: false },
			],
		],
		[
			'intervening change note',
			[
				buildStoreCall('read', { from: 1 }, FIRST_SLICE),
				buildStoreCall(
					'read',
					{ from: 40 },
					'The page changed since the last view; line numbers might differ.\n' +
						CONTINUED_SLICE.replace('31: ', '40: '),
				),
			],
		],
		[
			'changed page then return',
			[
				buildStoreCall('read', { from: 1 }, FIRST_SLICE),
				buildStoreCall(
					'read',
					{ from: 40 },
					CONTINUED_SLICE.replace('http://store/policy', 'http://store/other').replace(
						'31: ',
						'40: ',
					),
				),
			],
		],
	])('refuses a stale or unearned continuation: %s', (_reason, calls) => {
		const continued = buildStoreCall('read', { from: 31 }, CONTINUED_SLICE)
		const transcript = buildStoreTranscript([...calls, continued], FIRST_SLICE)
		expect(matchesStoreOracles(transcript)).toBe(true)
		expect(findContinuedRead(transcript.calls, STORE_POLICY_TOKEN)).toBeUndefined()
		expect(matchesPagingOracle(transcript)).toBe(false)
	})
	it.each([
		['guessed line', { from: 30 }, CONTINUED_SLICE.replace('31: ', '30: '), true],
		['non-numeric line', { from: '31' }, CONTINUED_SLICE, true],
		['shifted window', { from: 31 }, CONTINUED_SLICE.replace('31: ', '32: '), true],
		[
			'shifted search window',
			{ from: 31, search: 'token' },
			CONTINUED_SLICE.replace('31: ', '32: '),
			true,
		],
		[
			'changed page',
			{ from: 31 },
			CONTINUED_SLICE.replace('http://store/policy', 'http://store/other'),
			true,
		],
		['failed continuation', { from: 31 }, CONTINUED_SLICE, false],
		[
			'change note',
			{ from: 31 },
			'The page changed since the last view; line numbers might differ.\n' + CONTINUED_SLICE,
			true,
		],
		['missing token', { from: 31 }, CONTINUED_SLICE.replace(STORE_POLICY_TOKEN, 'absent'), true],
	])('refuses an invalid continuation: %s', (_reason, args, text, success) => {
		const first = buildStoreCall('read', { from: 1 }, FIRST_SLICE)
		const continued = { ...buildStoreCall('read', args, text), success }
		const transcript = buildStoreTranscript([first, continued])
		expect(matchesStoreOracles(transcript)).toBe(true)
		expect(findContinuedRead(transcript.calls, STORE_POLICY_TOKEN)).toBeUndefined()
		expect(matchesPagingOracle(transcript)).toBe(false)
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

/** Names the seeded catalogue view the search fixtures open on. */
const SEARCH_SEED =
	'page "Harbor Goods — Catalogue" http://127.0.0.1/\ne35 searchbox "Search products"\ne36 button "Search"'

/** Holds the result text of a submitted search that lists the two kettles. */
const KETTLE_RESULTS = `Typed "kettles" into e35 searchbox "Search products" and submitted the form.

page "Search: kettles" http://127.0.0.1/search?q=kettles
e47 link "Alpine Kettle"
e48 link "Copper Kettle"`

/** Holds a search run that ends as run v7 ended: the kettles listed, then an empty final turn. */
const STALLED_SEARCH: StoreTranscript = {
	...buildStoreTranscript(
		[
			buildStoreCall('look', { search: 'kettle products' }, SEARCH_SEED),
			buildStoreCall('type', { ref: 'e35', text: 'kettles', submit: true }, KETTLE_RESULTS),
		],
		SEARCH_SEED,
	),
	state: { cart: [], searches: ['kettles'], orders: [] },
}

/** Holds the run v6 ended as: the query submitted, no product listed, then an empty final turn. */
const EMPTY_RESULTS_SEARCH: StoreTranscript = {
	...STALLED_SEARCH,
	calls: [
		buildStoreCall(
			'type',
			{ ref: 'e35', text: 'kettles', submit: true },
			'Typed "kettles" into e35 searchbox "Search products" and submitted the form.\n\n# Search results for “kettles”\nNo products match.',
		),
	],
}

/** Holds the run v5 and c5 ended as: a click receipt naming `type`, then an empty final turn. */
const CLICKED_SEARCH: StoreTranscript = {
	...STALLED_SEARCH,
	calls: [
		buildStoreCall(
			'click',
			{ ref: 'e35' },
			`Clicked e35 searchbox "Search products"; call type with e35 to enter text.\n\n${SEARCH_SEED}`,
		),
	],
	state: { cart: [], searches: [], orders: [] },
}

/** Holds a search run that submitted the query and named every matching product. */
const COMPLETED_SEARCH: StoreTranscript = {
	...buildStoreTranscript(
		[
			buildStoreCall(
				'type',
				{ ref: 'e35', text: STORE_QUERY, submit: true },
				'Typed into e35 searchbox "Search products".\n\npage "Search: kettle" http://127.0.0.1/search?q=kettle\ne40 link "Alpine Kettle"\ne41 link "Copper Kettle"',
			),
		],
		SEARCH_SEED,
	),
	answer: 'The Alpine Kettle and the Copper Kettle match.',
	state: { cart: [], searches: [STORE_QUERY], orders: [] },
}

describe('matchesSearchOracle', () => {
	it('holds for a run whose recorded search resolves to the products the query matches and whose answer names them', () => {
		expect(matchesSearchOracle(COMPLETED_SEARCH, STORE_QUERY)).toBe(true)
		const spaced = { ...COMPLETED_SEARCH, state: { cart: [], searches: [' Kettle '], orders: [] } }
		expect(matchesSearchOracle(spaced, STORE_QUERY)).toBe(true)
		const plural = { ...COMPLETED_SEARCH, state: { cart: [], searches: ['kettles'], orders: [] } }
		expect(matchesSearchOracle(plural, STORE_QUERY)).toBe(true)
	})

	it('fails a run that submitted no query, another query, or names too few or too many products', () => {
		expect(matchesSearchOracle(STALLED_SEARCH, STORE_QUERY)).toBe(false)
		const other = { ...COMPLETED_SEARCH, state: { cart: [], searches: ['teapot'], orders: [] } }
		expect(matchesSearchOracle(other, STORE_QUERY)).toBe(false)
		const partial = { ...COMPLETED_SEARCH, answer: 'The Alpine Kettle matches.' }
		expect(matchesSearchOracle(partial, STORE_QUERY)).toBe(false)
		const extra = {
			...COMPLETED_SEARCH,
			answer: `${COMPLETED_SEARCH.answer} So does ${STORE_NAMED}.`,
		}
		expect(matchesSearchOracle(extra, STORE_QUERY)).toBe(false)
	})
})

describe('matchesStalledSearch', () => {
	it('holds for run v7: the last call a submitting type that lists a match, the answer empty', () => {
		expect(matchesStalledSearch(STALLED_SEARCH)).toBe(true)
	})

	it('fails run v6, which listed no product, and runs v5 and c5, whose last call was a click', () => {
		expect(matchesStalledSearch(EMPTY_RESULTS_SEARCH)).toBe(false)
		expect(matchesStalledSearch(CLICKED_SEARCH)).toBe(false)
	})

	it('fails a completed search, an answered or cut stall, a failed type, and a type without submit', () => {
		expect(matchesStalledSearch(COMPLETED_SEARCH)).toBe(false)
		expect(matchesStalledSearch({ ...STALLED_SEARCH, answer: 'The kettles match.' })).toBe(false)
		expect(matchesStalledSearch({ ...STALLED_SEARCH, partial: true })).toBe(false)
		const [look, type] = STALLED_SEARCH.calls
		if (look === undefined || type === undefined) throw new Error('the stall fixture lost a call')
		const failed = { ...type, success: false }
		expect(matchesStalledSearch({ ...STALLED_SEARCH, calls: [look, failed] })).toBe(false)
		const unsubmitted = { ...type, arguments: { ref: 'e35', text: 'kettles' } }
		expect(matchesStalledSearch({ ...STALLED_SEARCH, calls: [look, unsubmitted] })).toBe(false)
		const reread = buildStoreCall('read', { search: 'kettle products' }, '# Harbor Goods')
		expect(matchesStalledSearch({ ...STALLED_SEARCH, calls: [look, type, reread] })).toBe(false)
	})
})

describe('attachThinking', () => {
	it('gives the n-th assistant message the n-th turn thinking and leaves a silent turn bare', () => {
		const messages = [
			{ id: 'm1', role: 'user', content: 'Search for kettle.' },
			{ id: 'm2', role: 'assistant', content: '' },
			{ id: 'm3', role: 'tool', content: 'results' },
			{ id: 'm4', role: 'assistant', content: '' },
		] as const
		const recorded = attachThinking(messages, ['I will search.', ''])
		expect(recorded.map((message) => message.thinking)).toEqual([
			undefined,
			'I will search.',
			undefined,
			undefined,
		])
		expect(recorded[3]).toBe(messages[3])
	})
})

describe('the search pin in tests/service/browser.test.ts', () => {
	it('holds for the recorded v7 stall: the shared oracles and the stall hold, the search oracle fails', () => {
		expect(matchesStoreOracles(STALLED_SEARCH)).toBe(true)
		expect(matchesStalledSearch(STALLED_SEARCH)).toBe(true)
		expect(matchesSearchOracle(STALLED_SEARCH, STORE_QUERY)).toBe(false)
	})

	it('reddens for a run that completes the search, on the search oracle the pin expects to fail', () => {
		expect(matchesStoreOracles(COMPLETED_SEARCH)).toBe(true)
		expect(matchesSearchOracle(COMPLETED_SEARCH, STORE_QUERY)).toBe(true)
	})

	it('reddens for a daemon fault on the shared oracles, however the run ended', () => {
		expect(matchesStalledSearch({ ...STALLED_SEARCH, failure: 'provider error: 500' })).toBe(true)
		expect(matchesStoreOracles({ ...STALLED_SEARCH, failure: 'provider error: 500' })).toBe(false)
	})

	it('rejects a thrown attempt with its own error rather than returning a transcript', async () => {
		const refusal = new Error('the browser refused a page')
		const provider = createOllama({ model: 'fixture', url: 'http://127.0.0.1:9' })
		await expect(
			attemptStoreTask({ isolate: () => Promise.reject(refusal) }, STORE_TASKS.search, 1, provider),
		).rejects.toBe(refusal)
	})
})

/** Holds the checkout journey as the journey task's edit leaves it: s3, the recorded cart click, removed. */
const EDITED_JOURNEY: BrowserJourney = {
	format: 1,
	name: STORE_JOURNEY_NAME,
	description: 'Place an order at checkout.',
	parameters: { [STORE_JOURNEY_PARAMETER]: { default: STORE_BUYER } },
	next: 5,
	steps: [
		{ id: 's1', action: 'click', arguments: {}, target: { role: 'link', name: 'Checkout' } },
		{
			id: 's2',
			action: 'type',
			arguments: { text: { parameter: STORE_JOURNEY_PARAMETER }, submit: true },
			target: { role: 'textbox', name: 'Full name' },
		},
		{ id: 's4', action: 'wait', arguments: { text: 'HG-48213' } },
	],
}

/** Holds the `save` result the journey task's recording returns: one submission and a cart click. */
const SAVED_LISTING = [
	`Saved ${STORE_JOURNEY_NAME} with 4 steps.`,
	'',
	`${STORE_JOURNEY_NAME} "Place an order at checkout."`,
	's1 click link "Checkout"',
	`s2 type "${STORE_BUYER}" into textbox "Full name", submit`,
	's3 click link "Cart"',
	's4 wait "HG-48213"',
].join('\n')

/** Holds the edit batch the journey task asks for. */
const EDITS = [
	{
		operation: 'declare',
		name: STORE_JOURNEY_PARAMETER,
		parameter: { default: STORE_BUYER },
	},
	{ operation: 'update', id: 's2', arguments: { text: { parameter: STORE_JOURNEY_PARAMETER } } },
	{ operation: 'remove', id: 's3' },
]

/** Holds the journey task's calls in order, each successful. */
const JOURNEY_CALLS = [
	buildStoreCall('record', { journey: STORE_JOURNEY_NAME }),
	buildStoreCall('click', { ref: 'e1' }),
	buildStoreCall('save', { description: 'Place an order at checkout.' }, SAVED_LISTING),
	buildStoreCall(
		'journeys',
		{ from: 1 },
		SAVED_LISTING.split(/\r\n|\n/)
			.slice(2)
			.join('\n'),
	),
	buildStoreCall('edit', { journey: STORE_JOURNEY_NAME, edits: EDITS }),
	buildStoreCall('replay', {
		journey: STORE_JOURNEY_NAME,
		inputs: { [STORE_JOURNEY_PARAMETER]: STORE_JOURNEY_BUYER },
	}),
]

/**
 * Writes the edited journey and one run of it through the real file stores, and returns the
 * files the journey task's transcript would carry.
 */
async function writeJourneyFiles(
	outcome: 'complete' | 'stopped',
): Promise<Readonly<Record<string, string>>> {
	const scratch = createScratch({ prefix: 'store-journey-' })
	try {
		const saved = await createFileBrowserJourneyStore({ root: scratch.path }).set(EDITED_JOURNEY)
		const runs = createFileBrowserRunStore({ root: scratch.path })
		const slot = await runs.create(STORE_JOURNEY_NAME)
		await runs.set({
			format: 1,
			id: slot.id,
			journey: saved.journey,
			...(saved.revision === undefined ? {} : { revision: saved.revision }),
			inputs: { [STORE_JOURNEY_PARAMETER]: STORE_JOURNEY_BUYER },
			steps: EDITED_JOURNEY.steps
				.slice(0, outcome === 'complete' ? EDITED_JOURNEY.steps.length : 2)
				.map((step, index) => ({
					id: step.id,
					action: step.action,
					trigger: step.target?.role ?? step.action,
					arguments: {},
					outcome: outcome === 'complete' || index === 0 ? 'done' : 'refused',
					result: `${step.id} ${step.action}`,
					elapsed: 1,
				})),
			outcome,
			elapsed: 1,
		})
		return collectStoreFiles(scratch.path)
	} finally {
		scratch.destroy()
	}
}

/** Builds the journey task's transcript over the given files and orders. */
function buildJourneyTranscript(
	files: Readonly<Record<string, string>>,
	orders: readonly string[],
): StoreTranscript {
	return {
		...buildStoreTranscript(JOURNEY_CALLS),
		files,
		state: { cart: [], searches: [], orders },
	}
}

describe('inferPageTools', () => {
	it('drops every journey tool and retains type secret and keeps every other definition as advertised', () => {
		const page = inferPageTools(Object.values(BROWSER_TOOL_COPY))
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
		expect(Object.keys(Object(BROWSER_TOOL_COPY.type.parameters?.['properties']))).toContain(
			'secret',
		)
	})
})

describe('findMalformedCalls', () => {
	const definitions = Object.values(BROWSER_TOOL_COPY)

	it('passes calls that match the advertised parameters, the journey batch and inputs included', () => {
		expect(
			findMalformedCalls(
				[
					...JOURNEY_CALLS,
					buildStoreCall('edit', { journey: STORE_JOURNEY_NAME, edits: JSON.stringify(EDITS) }),
					buildStoreCall('type', { ref: 'e4', text: STORE_BUYER, submit: true, secret: false }),
					buildStoreCall('read', { from: 40, search: 'the code' }),
				],
				definitions,
			),
		).toEqual([])
	})

	it('flags an unknown tool, a missing required parameter, a wrong type, an unknown key, and a wrong item', () => {
		const malformed = [
			buildStoreCall('checkout', { name: STORE_BUYER }),
			buildStoreCall('look', {}),
			buildStoreCall('type', { ref: 'e4', text: STORE_BUYER, submit: 'true' }),
			buildStoreCall('look', { search: 'the page', ref: 'e4' }),
			buildStoreCall('edit', { journey: STORE_JOURNEY_NAME, edits: 3 }),
			buildStoreCall('edit', { journey: STORE_JOURNEY_NAME, edits: [{ id: 's3' }] }),
			buildStoreCall('replay', { journey: STORE_JOURNEY_NAME, inputs: STORE_JOURNEY_BUYER }),
			buildStoreCall('read', { search: 'the code', offset: 1.5 }),
		]
		expect(findMalformedCalls(malformed, definitions)).toEqual(malformed)
	})

	it('reads a type array as the union of its members, with the items of the array checked', () => {
		const edit = {
			name: 'edit',
			parameters: {
				type: 'object',
				properties: {
					edits: {
						type: ['array', 'string'],
						items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
					},
				},
				required: ['edits'],
			},
		}
		const kept = [
			buildStoreCall('edit', { edits: '[]' }),
			buildStoreCall('edit', { edits: [{ id: 's3' }] }),
		]
		const malformed = [
			buildStoreCall('edit', { edits: 3 }),
			buildStoreCall('edit', { edits: [{ id: 3 }] }),
			buildStoreCall('edit', { edits: null }),
		]
		expect(findMalformedCalls([...kept, ...malformed], [edit])).toEqual(malformed)
	})
})

describe('collectStoreFiles', () => {
	it('reads every JSON file under the root by its /-separated path, sorted, and nothing else', () => {
		const scratch = createScratch({ prefix: 'store-files-' })
		try {
			scratch.write('b/runs/r1/run.json', '{"run":1}')
			scratch.write('a/journey.json', '{"journey":1}')
			scratch.write('a/revision', '1')
			scratch.write('b/runs/r1/s1.png', 'png')
			expect(Object.entries(collectStoreFiles(scratch.path))).toEqual([
				['a/journey.json', '{"journey":1}'],
				['b/runs/r1/run.json', '{"run":1}'],
			])
		} finally {
			scratch.destroy()
		}
	})

	it('returns nothing for an empty root', () => {
		const scratch = createScratch({ prefix: 'store-files-' })
		try {
			expect(collectStoreFiles(scratch.path)).toEqual({})
		} finally {
			scratch.destroy()
		}
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
		expect(evidence?.journey).toEqual(EDITED_JOURNEY)
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
		expect(findBoundParameter(EDITED_JOURNEY)).toBe(STORE_JOURNEY_PARAMETER)
	})

	it('names nothing for a parameter without a default or a binding on another field', () => {
		expect(
			findBoundParameter({ ...EDITED_JOURNEY, parameters: { [STORE_JOURNEY_PARAMETER]: {} } }),
		).toBeUndefined()
		const [first, second, third] = EDITED_JOURNEY.steps
		if (first === undefined || second === undefined || third === undefined) throw new Error('steps')
		const elsewhere = { ...second, target: { role: 'textbox', name: 'Email' } }
		expect(matchesNameBinding(second, STORE_JOURNEY_PARAMETER)).toBe(true)
		expect(matchesNameBinding(elsewhere, STORE_JOURNEY_PARAMETER)).toBe(false)
		expect(matchesNameBinding(second, 'email')).toBe(false)
		expect(
			findBoundParameter({ ...EDITED_JOURNEY, steps: [first, elsewhere, third] }),
		).toBeUndefined()
	})
})

describe('filterSubmissionLines', () => {
	it('lists the lines that type with submit, press Enter, or click the order button', () => {
		expect(
			filterSubmissionLines(
				[
					SAVED_LISTING,
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
		expect(filterSubmissionLines(renderBrowserJourney(EDITED_JOURNEY))).toEqual([
			`s2 type "${STORE_BUYER}" as ${STORE_JOURNEY_PARAMETER} into textbox "Full name", submit`,
		])
	})
})

describe('renderJourneyEdit', () => {
	it('spells the batch out with the name step and the recorded cart click the last listing shows', () => {
		const turn = renderJourneyEdit(JOURNEY_CALLS.slice(0, 4))
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
		const single = buildStoreCall(
			'save',
			{ description: 'Place an order at checkout.' },
			SAVED_LISTING.replace('s3 click link "Cart"', 's3 press Tab'),
		)
		for (const calls of [
			[single],
			[],
			[{ ...buildStoreCall('save', {}, SAVED_LISTING), success: false }],
		]) {
			const turn = renderJourneyEdit(calls)
			expect(turn).not.toContain('[')
			expect(turn).toContain('remove the recorded cart click')
		}
	})
})

describe('matchesJourneyBatch', () => {
	it('holds for a successful edit holding a declare, an update, and a remove', () => {
		expect(matchesJourneyBatch(buildStoreCall('edit', { edits: EDITS }))).toBe(true)
	})

	it('holds for the same batch given as the JSON string of the array the edit tool accepts', () => {
		expect(matchesJourneyBatch(buildStoreCall('edit', { edits: JSON.stringify(EDITS) }))).toBe(true)
	})

	it('fails a batch missing an operation, a refused edit, a string that is no array, and another tool', () => {
		expect(matchesJourneyBatch(buildStoreCall('edit', { edits: EDITS.slice(1) }))).toBe(false)
		expect(
			matchesJourneyBatch({ ...buildStoreCall('edit', { edits: EDITS }), success: false }),
		).toBe(false)
		expect(
			matchesJourneyBatch(buildStoreCall('edit', { edits: JSON.stringify(EDITS).slice(0, -1) })),
		).toBe(false)
		expect(matchesJourneyBatch(buildStoreCall('edit', { edits: JSON.stringify(EDITS[0]) }))).toBe(
			false,
		)
		expect(matchesJourneyBatch(buildStoreCall('replay', { edits: EDITS }))).toBe(false)
	})
})

describe('matchesJourneySequence', () => {
	it('holds for record, save, journeys, the batch edit, and a replay with inputs, in order', () => {
		expect(STORE_JOURNEY_SEQUENCE).toEqual(['record', 'save', 'journeys', 'edit', 'replay'])
		expect(matchesJourneySequence(JOURNEY_CALLS)).toBe(true)
	})

	it('fails an edit before journeys, a replay without inputs, and a refused save', () => {
		const [record, click, save, journeys, edit, replay] = JOURNEY_CALLS
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
	const stored = renderBrowserJourney(EDITED_JOURNEY)

	it('holds when the batch removes the second saved submission and one remains', () => {
		expect(matchesRemovedCart(JOURNEY_CALLS, stored)).toBe(true)
	})

	it('holds when that batch arrives as the JSON string of the array', () => {
		const string = JOURNEY_CALLS.map((call) =>
			call.name === 'edit'
				? buildStoreCall('edit', { journey: STORE_JOURNEY_NAME, edits: JSON.stringify(EDITS) })
				: call,
		)
		expect(matchesRemovedCart(string, stored)).toBe(true)
	})

	it('fails a removal of the first submission, a saved listing without a cart click, and two left', () => {
		const first = JOURNEY_CALLS.map((call) =>
			call.name === 'edit'
				? buildStoreCall('edit', {
						journey: STORE_JOURNEY_NAME,
						edits: [EDITS[0], EDITS[1], { operation: 'remove', id: 's2' }],
					})
				: call,
		)
		expect(matchesRemovedCart(first, stored)).toBe(false)
		const single = JOURNEY_CALLS.map((call) =>
			call.name === 'save'
				? buildStoreCall(
						'save',
						call.arguments,
						SAVED_LISTING.replace('s3 click link "Cart"', 's3 press Tab'),
					)
				: call,
		)
		expect(matchesRemovedCart(single, stored)).toBe(false)
		expect(matchesRemovedCart(JOURNEY_CALLS, `${stored}\ns5 press Enter`)).toBe(false)
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
		const orders = [STORE_BUYER, STORE_JOURNEY_BUYER]
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
		expect(parseJourneyEdits(EDITS)).toBe(EDITS)
		expect(parseJourneyEdits(JSON.stringify(EDITS))).toEqual(EDITS)
		expect(parseJourneyEdits('[]')).toEqual([])
	})

	it('returns undefined for a string that is not JSON, JSON that is no array, and any other value', () => {
		expect(parseJourneyEdits(JSON.stringify(EDITS).slice(0, -1))).toBeUndefined()
		expect(parseJourneyEdits(JSON.stringify(EDITS[0]))).toBeUndefined()
		expect(parseJourneyEdits('')).toBeUndefined()
		expect(parseJourneyEdits(undefined)).toBeUndefined()
		expect(parseJourneyEdits({ 0: EDITS[0] })).toBeUndefined()
	})
})

describe('findJourneyLoops', () => {
	const record = {
		...buildStoreCall(
			'record',
			{ journey: STORE_JOURNEY_NAME },
			`Journey "${STORE_JOURNEY_NAME}" is saved already and nothing is recording; call journeys to list it, edit to change it, or replay to run it.`,
		),
		success: false,
	}
	const save = {
		...buildStoreCall(
			'save',
			{ description: 'Place an order at checkout.' },
			`Nothing is recording; "${STORE_JOURNEY_NAME}" was saved. Call journeys, edit, or replay.`,
		),
		success: false,
	}

	it('returns every refused record and save after the first successful save, in order', () => {
		const edit = {
			...buildStoreCall(
				'edit',
				{ journey: 'checkout', edits: [] },
				'No journey is named "checkout"; call journeys.',
			),
			success: false,
		}
		expect(
			findJourneyLoops([
				...JOURNEY_CALLS.slice(0, 3),
				record,
				...JOURNEY_CALLS.slice(3, 4),
				save,
				edit,
				...JOURNEY_CALLS.slice(4, 5),
				record,
				...JOURNEY_CALLS.slice(5),
			]),
		).toEqual([record, save, record])
	})

	it('returns nothing for a run without a refusal, without a successful save, or refused before its save', () => {
		const idle = {
			...buildStoreCall(
				'save',
				{ description: 'Place an order at checkout.' },
				'No journey is recording; call record first.',
			),
			success: false,
		}
		const empty = {
			...buildStoreCall(
				'save',
				{ description: 'Place an order at checkout.' },
				`Nothing is recorded for ${STORE_JOURNEY_NAME}; perform an action, then call save.`,
			),
			success: false,
		}
		expect(findJourneyLoops(JOURNEY_CALLS)).toEqual([])
		expect(findJourneyLoops([])).toEqual([])
		expect(findJourneyLoops([idle, empty, record, save])).toEqual([])
		expect(findJourneyLoops([idle, ...JOURNEY_CALLS])).toEqual([])
	})
})

describe('computeRefusals', () => {
	const refused = (name: string) => ({ ...buildStoreCall(name, {}), success: false })

	it('counts the most refused tool since the last success, with alternating tools counted apart', () => {
		expect(computeRefusals([refused('save'), refused('save'), refused('save')])).toBe(3)
		expect(
			computeRefusals([
				refused('record'),
				refused('save'),
				refused('record'),
				refused('save'),
				refused('record'),
			]),
		).toBe(3)
		expect(
			computeRefusals([
				refused('save'),
				refused('save'),
				buildStoreCall('look', {}),
				refused('save'),
			]),
		).toBe(1)
	})

	it('returns 0 for a turn with no call and for a turn whose last call succeeded', () => {
		expect(computeRefusals([])).toBe(0)
		expect(computeRefusals([refused('save'), buildStoreCall('look', {})])).toBe(0)
	})
})

describe('converseStore', () => {
	const fail = { content: '', tool_calls: [{ function: { name: 'fail', arguments: {} } }] }
	const lookup = {
		content: '',
		tool_calls: [{ function: { name: 'lookup', arguments: { query: 'kettle' } } }],
	}
	const bound = Array.from({ length: STORE_BOUNDS.refusals }, () => fail)
	const advertised = ['lookup', 'fail']

	it('advertises no tool after the refusal bound until the next user turn advertises every tool again', async () => {
		const daemon = createRecordingTransport(
			createScriptedTransport([
				...bound,
				{ content: 'The tool refused.' },
				lookup,
				{ content: 'Found.' },
			]),
		)
		const tools = createToolManager()
		tools.add([createLookupTool(), createThrowingTool()])
		const conversation = await converseStore({
			provider: createOllama({ model: 'fixture-model', fetch: daemon.fetch }),
			system: STORE_SYSTEM_PROMPT,
			tools,
			turns: ['Call the fail tool.', 'Look up the kettle.'],
		})
		expect(daemon.requests.map(wireTools)).toEqual([
			...bound.map(() => advertised),
			[],
			advertised,
			advertised,
		])
		expect(conversation.ended).toBe(1)
		expect(conversation.failure).toBeUndefined()
		expect(conversation.result).toMatchObject({ content: 'Found.', partial: false })
		expect(conversation.partial).toBe(false)
		expect(conversation.calls.map((call) => [call.name, call.success])).toEqual([
			...bound.map(() => ['fail', false]),
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
				{ content: '', tool_calls: bound.flatMap((turn) => turn.tool_calls) },
				{ content: 'The tool refused.' },
			]),
		)
		const tools = createToolManager()
		tools.add([createLookupTool(), createThrowingTool()])
		const conversation = await converseStore({
			provider: createOllama({ model: 'fixture-model', fetch: daemon.fetch }),
			system: STORE_SYSTEM_PROMPT,
			tools,
			turns: ['Call the fail tool.'],
		})
		expect(daemon.requests.map(wireTools)).toEqual([advertised, []])
		expect(conversation.ended).toBe(1)
		expect(conversation.result).toMatchObject({ content: 'The tool refused.', partial: false })
	})

	it('keeps advertising every tool while a success breaks the refusals', async () => {
		const short = bound.slice(1)
		const daemon = createRecordingTransport(
			createScriptedTransport([...short, lookup, ...short, { content: 'Found.' }]),
		)
		const tools = createToolManager()
		tools.add([createLookupTool(), createThrowingTool()])
		const conversation = await converseStore({
			provider: createOllama({ model: 'fixture-model', fetch: daemon.fetch }),
			system: STORE_SYSTEM_PROMPT,
			tools,
			turns: ['Call the fail tool, then look up the kettle.'],
		})
		expect(daemon.requests.map(wireTools)).toEqual(
			[...short, lookup, ...short, undefined].map(() => advertised),
		)
		expect(conversation.ended).toBe(0)
		expect(conversation.result).toMatchObject({ content: 'Found.', partial: false })
	})

	it('returns the error that ended a user turn with the calls made before it', async () => {
		const tools = createToolManager()
		tools.add([createLookupTool(), createThrowingTool()])
		const conversation = await converseStore({
			provider: createOllama({ model: 'fixture-model', fetch: createScriptedTransport([lookup]) }),
			system: STORE_SYSTEM_PROMPT,
			tools,
			turns: ['Look up the kettle.'],
		})
		expect(conversation.result).toBeUndefined()
		expect(String(conversation.failure)).toContain('the script holds 1 turns')
		expect(conversation.calls.map((call) => [call.name, call.success])).toEqual([['lookup', true]])
	})
})

describe('attemptStoreTask with a journey root', () => {
	it('starts consecutive attempts at e1 in a real browser', async () => {
		const browser = createBrowser({
			executable: requirePageBrowser().executable,
			headless: true,
			args: PAGE_BROWSER_ARGS,
			cdp: { port: await reservePort(), discover: false },
		})
		try {
			await browser.connect()
			const contexts = browser.contexts()
			const seeds: string[] = []
			for (const attempt of [1, 2]) {
				const result = await attemptStoreTask(
					browser,
					{ ...STORE_TASKS.shipping, task: 'isolation' },
					attempt,
					createOllama({
						model: 'fixture-model',
						fetch: createScriptedTransport([{ content: 'Finished.' }]),
					}),
				)
				seeds.push(extractReferences(result.transcript.seed)[0] ?? '')
				expect(result.store.readCart()).toEqual([])
				expect(browser.contexts()).toEqual(contexts)
			}
			expect(seeds).toEqual(['e1', 'e1'])
			await expect(
				attemptStoreTask(
					browser,
					{ ...STORE_TASKS.shipping, task: 'isolation-failure' },
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
		expect(readdirSync(journeyPath()).filter((name) => name.startsWith('journey-7-'))).toEqual([])
	})
})
