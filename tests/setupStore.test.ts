// The hermetic half of `tests/setupStore.ts`. That module serves the store the live
// browser-vocabulary proof drives, runs one model attempt over it, and reads the
// transcript the attempt leaves. The live half — that a real model drives a real Chromium
// through the toolset over this store — is `tests/service/browser.test.ts`.
//
// What is proven here needs no browser and no daemon: every page's shape read with a plain
// `fetch`, the per-instance state the pages change, the distilled reading `read` slices
// (the browser package's own `createBrowserReading` over the served HTML), and every pure
// reader the live proof asserts through.

import type { StoreServerInterface, StoreTranscript } from './setupStore.js'
import { ProviderError } from '@orkestrel/agent'
import { BROWSER_TOOL_LIMIT, createBrowserReading } from '@orkestrel/browser'
import { createScratch } from '@orkestrel/test/server'
import { createOllama } from '@src/core'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	attemptStoreTask,
	buildStoreCall,
	buildStorePrompt,
	buildStoreTranscript,
	createStoreServer,
	escapeMarkup,
	extractFooterOffset,
	extractReferences,
	filterNamedProducts,
	filterProducts,
	findContinuedRead,
	findUnlistedReferences,
	matchesDaemonFault,
	matchesPagingOracle,
	matchesSearchOracle,
	matchesStalledSearch,
	matchesStoreOracles,
	normalizeAnswer,
	renderToolText,
	splitResultFooter,
	STORE_BOUNDS,
	STORE_CODE,
	STORE_CODE_DELAY,
	STORE_FACT,
	STORE_NAMED,
	STORE_POLICY_TOKEN,
	STORE_PRODUCTS,
	STORE_QUERY,
	STORE_SYSTEM_PROMPT,
	STORE_TASKS,
	sumUsage,
	transcriptPath,
	writeTranscript,
} from './setupStore.js'

let store: StoreServerInterface

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

	it('states the shipping cutoff once, after the customer notes, inside the first read slice', async () => {
		const html = await (await fetch(`${store.url}/`)).text()
		expect(html.split(STORE_FACT)).toHaveLength(2)
		expect(html.indexOf(STORE_FACT)).toBeGreaterThan(html.indexOf('</aside>'))
		const markdown = createBrowserReading({ url: `${store.url}/`, title: '', html }).markdown().text
		expect(markdown).not.toContain('What customers say')
		expect(markdown.indexOf(STORE_FACT)).toBeGreaterThan(0)
		expect(markdown.indexOf(STORE_FACT) + STORE_FACT.length).toBeLessThanOrEqual(BROWSER_TOOL_LIMIT)
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

	it('states the policy token past the first 4 000 characters of the distilled policy', async () => {
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
			buildStoreCall('look', { what: 'x', ref: '[e1]' }),
		]
		expect(findUnlistedReferences('e1 link "Cart"', calls)).toEqual([])
	})

	it('flags an invented, a non-string, and an unreadable reference', () => {
		const invented = buildStoreCall('click', { ref: 'e9' })
		const numeric = buildStoreCall('click', { ref: 1 })
		const described = buildStoreCall('look', { what: 'x', ref: 'the search button' })
		expect(findUnlistedReferences('e1 link "Cart"', [invented, numeric, described])).toEqual([
			invented,
			numeric,
			described,
		])
	})

	it('replaces the listed view with a result that lists elements and keeps it past one that lists none', () => {
		const receipt = buildStoreCall(
			'click',
			{ ref: 'e1' },
			'Clicked e1 link "Cart".\n\ne5 button "Pay"',
		)
		const reading = buildStoreCall('read', { what: 'x' }, '# Cart\n\nOne item.')
		const stale = buildStoreCall('click', { ref: 'e1' })
		const fresh = buildStoreCall('click', { ref: 'e5' })
		expect(findUnlistedReferences('e1 link "Cart"', [receipt, reading, fresh, stale])).toEqual([
			stale,
		])
	})

	it('flags nothing for calls that carry no reference', () => {
		expect(findUnlistedReferences('', [buildStoreCall('read', { what: 'x' })])).toEqual([])
	})
})

describe('splitResultFooter', () => {
	it('splits the bound footer from the body', () => {
		const footer = '[characters 0–3998 of 6250; call read with offset 3998 for more]'
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
			buildStoreCall('read', { what: 'x' }),
		)
		expect(matchesStoreOracles(buildStoreTranscript(many))).toBe(false)
		expect(
			matchesStoreOracles(buildStoreTranscript([buildStoreCall('click', { ref: 'e2' })])),
		).toBe(false)
		const oversized = buildStoreCall('read', { what: 'x' }, 'x'.repeat(BROWSER_TOOL_LIMIT + 1))
		expect(matchesStoreOracles(buildStoreTranscript([oversized]))).toBe(false)
		const bounded = buildStoreCall(
			'read',
			{ what: 'x' },
			`${'x'.repeat(BROWSER_TOOL_LIMIT)}\n\n[characters 0–4000 of 9000; call read with offset 4000 for more]`,
		)
		expect(matchesStoreOracles(buildStoreTranscript([bounded]))).toBe(true)
	})
})

describe('writeTranscript', () => {
	it('writes the transcript as JSON at the path its task and attempt name, under the root', () => {
		const scratch = createScratch({ prefix: 'store-transcript-' })
		try {
			const transcript = buildStoreTranscript([buildStoreCall('read', { what: 'x' }, '# Store')])
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
		for (const tool of ['look', 'read', 'click', 'type', 'wait']) {
			expect(STORE_SYSTEM_PROMPT).toContain(tool)
		}
	})
})

describe('extractFooterOffset', () => {
	it('reads the offset a cut read footer names', () => {
		const footer = '[characters 0–3998 of 6250; call read with offset 3998 for more]'
		expect(extractFooterOffset(`# Policy\n\n${footer}`)).toBe(3998)
	})

	it('reads nothing from a final slice, a cut look, or a result with no footer', () => {
		expect(extractFooterOffset('\n\n[characters 6250–6250 of 6250]')).toBeUndefined()
		expect(
			extractFooterOffset(
				'e1 link "Cart"\n[characters 0–4000 of 4466; the rest was cut; call read for the page\'s text]',
			),
		).toBeUndefined()
		expect(extractFooterOffset('Clicked e1 link "Cart".')).toBeUndefined()
	})
})

/** Names the footer the first slice of the fixture policy reading carries. */
const FIRST_SLICE = '# Policy\n\n[characters 0–3998 of 6250; call read with offset 3998 for more]'

describe('findContinuedRead', () => {
	it('finds the read continued at the offset an earlier footer named whose slice holds the text', () => {
		const first = buildStoreCall('read', { what: 'x' }, FIRST_SLICE)
		const miss = buildStoreCall('read', { what: 'x', offset: 3998 }, '# Returns')
		const failed = {
			...buildStoreCall('read', { what: 'x', offset: 3998 }, STORE_POLICY_TOKEN),
			success: false,
		}
		const hit = buildStoreCall(
			'read',
			{ what: 'x', offset: '3998' },
			`Quote ${STORE_POLICY_TOKEN}.`,
		)
		expect(findContinuedRead([first, miss, failed, hit], STORE_POLICY_TOKEN)).toBe(hit)
		expect(findContinuedRead([first, miss, failed], STORE_POLICY_TOKEN)).toBeUndefined()
	})

	it('refuses an offset no earlier footer named, and a look carrying the text', () => {
		const first = buildStoreCall('read', { what: 'x' }, FIRST_SLICE)
		const guessed = buildStoreCall('read', { what: 'x', offset: 4000 }, STORE_POLICY_TOKEN)
		const early = buildStoreCall('read', { what: 'x', offset: 3998 }, STORE_POLICY_TOKEN)
		const look = buildStoreCall('look', { what: 'x', offset: 3998 }, STORE_POLICY_TOKEN)
		expect(findContinuedRead([first, guessed, look], STORE_POLICY_TOKEN)).toBeUndefined()
		expect(findContinuedRead([early, first], STORE_POLICY_TOKEN)).toBeUndefined()
	})
})

describe('matchesPagingOracle', () => {
	it('fails a run whose continued read lacks the token', () => {
		const transcript = buildStoreTranscript([
			buildStoreCall('read', { what: 'x' }, FIRST_SLICE),
			buildStoreCall('read', { what: 'x', offset: 3998 }, '# Returns'),
		])
		expect(
			matchesPagingOracle({ ...transcript, answer: STORE_POLICY_TOKEN }, STORE_POLICY_TOKEN),
		).toBe(false)
	})

	it('holds for a run whose continued read has the token though its answer omits it', () => {
		const transcript = buildStoreTranscript([
			buildStoreCall('read', { what: 'x' }, FIRST_SLICE),
			buildStoreCall('read', { what: 'x', offset: 3998 }, `Quote ${STORE_POLICY_TOKEN}.`),
		])
		expect(
			matchesPagingOracle(
				{ ...transcript, answer: 'The policy covers delivery.', mentioned: false },
				STORE_POLICY_TOKEN,
			),
		).toBe(true)
	})

	it('fails a run that breaks a shared oracle', () => {
		const transcript = buildStoreTranscript([
			buildStoreCall('read', { what: 'x' }, FIRST_SLICE),
			buildStoreCall('read', { what: 'x', offset: 3998 }, STORE_POLICY_TOKEN),
		])
		expect(
			matchesPagingOracle({ ...transcript, failure: 'provider error: 500' }, STORE_POLICY_TOKEN),
		).toBe(false)
	})
})

describe('STORE_BOUNDS', () => {
	it('fits every attempt of a retried task in its budget and the budget in its case', () => {
		expect(STORE_BOUNDS.single).toBeGreaterThan(STORE_BOUNDS.run)
		expect(STORE_BOUNDS.budget).toBeGreaterThanOrEqual(STORE_BOUNDS.attempts * STORE_BOUNDS.run)
		expect(STORE_BOUNDS.retry).toBeGreaterThan(STORE_BOUNDS.budget)
	})
})

describe('sumUsage', () => {
	it('sums every reported usage field by field', () => {
		expect(
			sumUsage([
				{ prompt: 2000, completion: 40, total: 2040 },
				{ prompt: 2300, completion: 12, total: 2312 },
			]),
		).toEqual({ prompt: 4300, completion: 52, total: 4352 })
	})

	it('returns undefined when no provider call reported usage', () => {
		expect(sumUsage([])).toBeUndefined()
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

/** Holds a search run that ends as the pinned failure ends: a click naming `type`, then no answer. */
const STALLED_SEARCH: StoreTranscript = buildStoreTranscript(
	[
		buildStoreCall('look', { what: 'kettle products' }, SEARCH_SEED),
		buildStoreCall(
			'click',
			{ ref: 'e35' },
			`Clicked e35 searchbox "Search products"; call type with e35 to enter text.\n\n${SEARCH_SEED}`,
		),
	],
	SEARCH_SEED,
)

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
	it('holds for a run that submitted the query and names exactly the products it matches', () => {
		expect(matchesSearchOracle(COMPLETED_SEARCH, STORE_QUERY)).toBe(true)
		const spaced = { ...COMPLETED_SEARCH, state: { cart: [], searches: [' Kettle '], orders: [] } }
		expect(matchesSearchOracle(spaced, STORE_QUERY)).toBe(true)
	})

	it('fails a run that submitted no query, another query, or names too few or too many products', () => {
		expect(matchesSearchOracle(STALLED_SEARCH, STORE_QUERY)).toBe(false)
		const other = { ...COMPLETED_SEARCH, state: { cart: [], searches: ['anchor'], orders: [] } }
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
	it('holds for a run whose last call is a click receipt naming type and whose answer is empty', () => {
		expect(matchesStalledSearch(STALLED_SEARCH)).toBe(true)
	})

	it('fails a completed search, an answered or cut stall, and a click receipt that names no type', () => {
		expect(matchesStalledSearch(COMPLETED_SEARCH)).toBe(false)
		expect(matchesStalledSearch({ ...STALLED_SEARCH, answer: 'The search box is ready.' })).toBe(
			false,
		)
		expect(matchesStalledSearch({ ...STALLED_SEARCH, partial: true })).toBe(false)
		const [look, click] = STALLED_SEARCH.calls
		if (look === undefined || click === undefined) throw new Error('the stall fixture lost a call')
		const plain = buildStoreCall(
			'click',
			{ ref: 'e35' },
			`Clicked e35 searchbox.\n\n${SEARCH_SEED}`,
		)
		expect(matchesStalledSearch({ ...STALLED_SEARCH, calls: [look, plain] })).toBe(false)
		const failed = { ...click, success: false }
		expect(matchesStalledSearch({ ...STALLED_SEARCH, calls: [look, failed] })).toBe(false)
		const reread = buildStoreCall('read', { what: 'kettle products' }, '# Harbor Goods')
		expect(matchesStalledSearch({ ...STALLED_SEARCH, calls: [look, click, reread] })).toBe(false)
	})
})

describe('the search pin in tests/service/browser.test.ts', () => {
	it('holds for the recorded stall: the shared oracles and the stall hold, the search oracle fails', () => {
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
			attemptStoreTask({ create: () => Promise.reject(refusal) }, STORE_TASKS.search, 1, provider),
		).rejects.toBe(refusal)
	})
})
