import type { Message, ProviderInterface } from '@orkestrel/agent'
import type { BrowserPageInterface } from '@orkestrel/browser'
import type { BrowserInterface } from '@orkestrel/browser/server'
import type { TokenUsage } from '@orkestrel/budget'
import type { ToolResult } from '@orkestrel/tool'
import { createAgent, isProviderError } from '@orkestrel/agent'
import { BROWSER_TOOL_LIMIT, createBrowserToolset, parseBrowserReference } from '@orkestrel/browser'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createToolManager } from '@orkestrel/tool'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describeFailure, driveAgent, rootToPath, WORKSPACE_ROOT } from './setupServer.js'

/** Represents one product the store fixture sells. */
export interface StoreProduct {
	/** The path segment of the product's page, such as `p4`. */
	readonly id: string
	/** The name every page shows for the product. */
	readonly name: string
	/** The price with its currency sign, such as `$58.00`. */
	readonly price: string
	/** The sentence the catalogue and the product page show under the name. */
	readonly blurb: string
	/** True if the catalogue lists the product; false if only a search finds it. */
	readonly featured: boolean
}

/** Lists the products the store fixture sells, in catalogue order; search reaches every one. */
export const STORE_PRODUCTS: readonly StoreProduct[] = Object.freeze([
	{
		id: 'p1',
		name: 'Alpine Kettle',
		price: '$34.00',
		blurb: 'A brushed steel stovetop kettle with a whistle and a cool-touch handle.',
		featured: false,
	},
	{
		id: 'p2',
		name: 'Birch Cutting Board',
		price: '$22.50',
		blurb: 'An end-grain birch board with a juice groove on one face.',
		featured: true,
	},
	{
		id: 'p3',
		name: 'Cedar Tea Tray',
		price: '$41.00',
		blurb: 'A slatted cedar tray that drains into a hidden reservoir.',
		featured: true,
	},
	{
		id: 'p4',
		name: 'Copper Kettle',
		price: '$58.00',
		blurb: 'A hammered copper kettle lined with tin for gas and electric hobs.',
		featured: false,
	},
	{
		id: 'p5',
		name: 'Linen Apron',
		price: '$18.00',
		blurb: 'A washed linen apron with two deep pockets and cross-back straps.',
		featured: true,
	},
	{
		id: 'p6',
		name: 'Stoneware Mug',
		price: '$12.00',
		blurb: 'A speckled stoneware mug that holds 350 millilitres.',
		featured: true,
	},
	{
		id: 'p7',
		name: 'Walnut Spice Rack',
		price: '$29.00',
		blurb: 'A three-tier walnut rack that holds eighteen standard jars.',
		featured: true,
	},
	{
		id: 'p8',
		name: 'Oak Bread Bin',
		price: '$46.00',
		blurb: 'A roll-top oak bin that keeps two loaves fresh for four days.',
		featured: true,
	},
	{
		id: 'p9',
		name: 'Wool Tea Cosy',
		price: '$16.00',
		blurb: 'A felted wool cosy that keeps a six-cup pot hot for an hour.',
		featured: true,
	},
])

/** Names the shipping cutoff time the catalogue states in its body text. */
export const STORE_FACT = '2:40 PM'

/** Names the token the shipping policy page states past its first 4 000 distilled characters. */
export const STORE_POLICY_TOKEN = 'HARBOR-TIDE-7153'

/** Names the confirmation code the checkout page inserts after an order is placed. */
export const STORE_CODE = 'HG-48213'

/** Names the milliseconds the checkout page waits after an order before it shows the code. */
export const STORE_CODE_DELAY = 200

/**
 * Names the system prompt every live store run gives the model.
 *
 * @remarks The prompt states the loop the browser vocabulary expects: look first, act by
 * reference, read to answer, stop when the task is done, and never invent a reference.
 */
export const STORE_SYSTEM_PROMPT =
	'You control a web browser with tools and must call a tool before you answer. ' +
	'The first message shows the page as look returns it; references such as e4 name its elements. ' +
	'To learn a fact, call read with what set to your question; when its result ends by naming an offset, call read again with that offset. ' +
	'To search, call type with the search box reference, the words, and submit true. ' +
	'To press a button or follow a link, call click with its reference from the latest result. Never invent a reference. ' +
	'If text you expect has not appeared, call wait once. ' +
	'When the task is done, answer in one short sentence.'

/** Represents a running store fixture and the state its pages changed. */
export interface StoreServerInterface {
	/** The loopback origin the store answers on, such as `http://127.0.0.1:54321`. */
	readonly url: string
	/** Returns the names of the products added to the cart, in the order they were added. */
	readCart(): readonly string[]
	/** Returns every query the search form submitted, in submission order. */
	readSearches(): readonly string[]
	/** Returns the name every checkout submitted, in submission order. */
	readOrders(): readonly string[]
	/** Stops the server and releases its port. */
	stop(): Promise<void>
}

/**
 * Escapes the characters HTML text and attribute values treat as markup.
 *
 * @param text - The text to embed in a served page
 * @returns The text with `&`, `<`, `>`, and `"` replaced by their entities
 */
export function escapeMarkup(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
}

/**
 * Returns the products whose name carries every word of the query.
 *
 * A word matches when, lower-cased and with one trailing `s` removed, it is a prefix of some
 * name word treated the same way, so `kettles` finds `Alpine Kettle`.
 *
 * @param query - The submitted search text
 * @returns The matching products in catalogue order; empty for a blank query
 */
export function filterProducts(query: string): readonly StoreProduct[] {
	const stem = (word: string): string => word.toLowerCase().replace(/s$/, '')
	const words = query
		.split(/\s+/)
		.filter((word) => word !== '')
		.map(stem)
	if (words.length === 0) return []
	return STORE_PRODUCTS.filter((product) => {
		const nameWords = product.name.split(/\s+/).map(stem)
		return words.every((word) => nameWords.some((nameWord) => nameWord.startsWith(word)))
	})
}

/**
 * Renders one complete store page around its main content.
 *
 * @param title - The document title
 * @param main - The markup inside `<main>`
 * @param script - Markup appended after `<main>`, such as a `<script>` element; defaults to none
 * @returns The HTML document
 */
export function renderStorePage(title: string, main: string, script = ''): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<title>${escapeMarkup(title)}</title>
</head>
<body>
<header>
<nav aria-label="Store">
<a href="/">Catalogue</a>
<a href="/cart">Cart</a>
<a href="/checkout">Checkout</a>
</nav>
</header>
<main>
${main}
</main>
${script}
</body>
</html>
`
}

/**
 * Renders the product rows the catalogue and the search results list.
 *
 * @param products - The products to list
 * @returns A `<ul>` whose items link each product by name and show its price
 */
export function renderProductList(products: readonly StoreProduct[]): string {
	const rows = products.map(
		(product) =>
			`<li><h3><a href="/product/${product.id}">${escapeMarkup(product.name)}</a></h3>` +
			`<p>${escapeMarkup(product.price)}. ${escapeMarkup(product.blurb)}</p></li>`,
	)
	return `<ul>\n${rows.join('\n')}\n</ul>`
}

/**
 * Lists the customer notes the catalogue's aside quotes.
 *
 * @remarks The aside sits between the product list and the story, and its text pushes the
 * shipping paragraph past the first 4 000 characters of the page's outline. The distilled
 * Markdown a `read` returns drops the aside as page furniture, so the paragraph stays inside the
 * first slice a `read` returns while a first `look` bounded at 4 000 characters stops before it.
 */
export const STORE_NOTES: readonly string[] = Object.freeze([
	'“The kettle has lived on our stove for three winters and still sings like the first morning.” — Maren, Tromsø',
	'“The board arrived oiled and ready, wrapped in paper with a note from the maker who cut it.” — Idris, Leeds',
	'“I ordered a mug for my father and the workshop wrote back to ask which glaze he would like.” — Paloma, Seville',
	'“The apron softened after one wash and the pockets hold a notebook, a pencil, and a phone.” — Kenji, Sapporo',
	'“Our cafe has used the trays for two years. Not one has warped, even on the terrace.” — Aoife, Galway',
	'“The spice rack fitted the gap beside the window exactly, and the walnut glows in the evening.” — Tomas, Brno',
	'“I asked how to restore an old board and the workshop sent a page of notes and a tin of wax.” — Lior, Haifa',
	'“Every parcel comes in paper and card, and the card goes straight into our recycling.” — Nadia, Casablanca',
	'“The kettle handle stays cool enough to hold without a cloth, which my hands appreciate.” — Rosa, Porto',
	'“The mug holds exactly one pot of tea, so nobody in our house argues about the last cup.” — Emeka, Enugu',
	'“We visited the workshop on the first Saturday and watched a kettle take shape in an hour.” — Sofie, Aarhus',
	'“The tea tray drains into its hidden reservoir, so the table stays dry through a long afternoon.” — Ravi, Pune',
	'“The board still looks new after a year of daily bread, onions, and one very sharp knife.” — Hanne, Bergen',
	'“A replacement for a chipped mug arrived within the week, and they did not ask for the old one.” — Dario, Turin',
	'“The copper has darkened to a warm brown, and I like it more each month it sits on the hob.” — Ines, Lisbon',
])

/** Lists the paragraphs of the catalogue's story section, which the shipping paragraph follows. */
export const STORE_STORY: readonly string[] = Object.freeze([
	'Harbor Goods began as a market stall on the east pier, selling kettles and boards made by three families of makers who shared one workshop behind the fish market.',
	'Every piece we sell is made in small batches. The kettles are spun and hammered by hand, the boards are cut from trees that fell in winter storms, and the mugs are thrown and glazed in a kiln that runs twice a week.',
	'We test each kettle on gas, electric, and induction hobs before it leaves the workshop, and we oil each board three times over a week so that it arrives ready for a knife.',
	'We pack every order in paper and card from the recycling yard down the road. No plastic leaves our workshop, and every box can go straight into your own recycling bin.',
	'Gift wrapping is free on every order. Choose it at checkout and we will add a handwritten card with any message you like, up to forty words.',
	'Prices include tax. We do not charge for returns, and we never add a fee at checkout that the product page did not show you first.',
	'Our workshop opens to visitors on the first Saturday of each month. Come and watch a kettle being hammered, or bring an old board and we will show you how to restore it.',
	'We donate one percent of every sale to the harbour trust, which keeps the pier, the lighthouse, and the tidal pool in repair for everyone who lives and works here.',
	'Stock is small and batches sell out. When a piece is gone, the makers start the next batch within a fortnight, and the product page shows the date the batch is due.',
	'We answer every message ourselves, usually within one working day. Tell us what you cook and how you cook it, and we will suggest the piece that suits your kitchen.',
])

/**
 * Renders the catalogue page: the search form, the product list, the customer notes, the story,
 * and the shipping paragraph that states {@link STORE_FACT}.
 *
 * @returns The catalogue document
 */
export function renderCatalogue(): string {
	const notes = STORE_NOTES.map((note) => `<p>${escapeMarkup(note)}</p>`).join('\n')
	const story = STORE_STORY.map((paragraph) => `<p>${escapeMarkup(paragraph)}</p>`).join('\n')
	return renderStorePage(
		'Harbor Goods — Catalogue',
		`<h1>Harbor Goods</h1>
<form action="/search" method="get" role="search">
<label for="q">Search products</label>
<input id="q" type="search" name="q">
<button type="submit">Search</button>
</form>
<h2>Featured products</h2>
${renderProductList(STORE_PRODUCTS.filter((product) => product.featured))}
<p>Search to see the whole range.</p>
<aside>
<p>What customers say</p>
${notes}
</aside>
<h2>Our story</h2>
${story}
<h2>Shipping</h2>
<p>Orders placed before ${STORE_FACT} ship the same working day. Orders placed later ship the next working day.</p>`,
	)
}

/**
 * Renders the search results page for one query.
 *
 * @param query - The submitted search text
 * @returns The results document, naming every matching product or stating that none matched
 */
export function renderSearch(query: string): string {
	const matches = filterProducts(query)
	const body =
		matches.length === 0
			? '<p>No products match.</p>'
			: `<p>Products matching your search:</p>\n${renderProductList(matches)}`
	return renderStorePage(
		`Search: ${query}`,
		`<h1>Search results for “${escapeMarkup(query)}”</h1>\n${body}`,
	)
}

/**
 * Renders one product page with its add-to-cart form.
 *
 * @param product - The product the page sells
 * @returns The product document
 */
export function renderProduct(product: StoreProduct): string {
	return renderStorePage(
		product.name,
		`<h1>${escapeMarkup(product.name)}</h1>
<p>${escapeMarkup(product.price)}</p>
<p>${escapeMarkup(product.blurb)}</p>
<form action="/cart" method="post">
<input type="hidden" name="product" value="${product.id}">
<button type="submit">Add to cart</button>
</form>`,
	)
}

/**
 * Renders the cart page over the products added so far.
 *
 * @param names - The names of the added products, in the order they were added
 * @returns The cart document
 */
export function renderCart(names: readonly string[]): string {
	const body =
		names.length === 0
			? '<p>Your cart is empty.</p>'
			: `<ul>\n${names.map((name) => `<li>${escapeMarkup(name)}</li>`).join('\n')}\n</ul>`
	return renderStorePage('Your cart', `<h1>Your cart</h1>\n${body}`)
}

/**
 * Names the script the checkout page runs: it posts the name, then inserts the confirmation
 * code {@link STORE_CODE_DELAY} milliseconds after the server answers.
 */
export const STORE_CHECKOUT_SCRIPT = `<script>
const form = document.getElementById('checkout')
form.addEventListener('submit', async (event) => {
	event.preventDefault()
	const name = document.getElementById('name').value
	const response = await fetch('/order', { method: 'POST', body: name })
	const code = await response.text()
	setTimeout(() => {
		const line = document.createElement('p')
		line.id = 'confirmation'
		line.textContent = 'Order confirmed. Your confirmation code is ' + code + '.'
		document.querySelector('main').append(line)
	}, ${STORE_CODE_DELAY})
})
</script>`

/**
 * Renders the checkout page.
 *
 * @returns The checkout document, whose script inserts the code after an order
 */
export function renderCheckout(): string {
	return renderStorePage(
		'Checkout',
		`<h1>Checkout</h1>
<form id="checkout">
<label for="name">Full name</label>
<input id="name" type="text" name="name" autocomplete="off">
<button type="submit">Place order</button>
</form>`,
		STORE_CHECKOUT_SCRIPT,
	)
}

/**
 * Lists the sections of the shipping policy page, each a heading and its paragraphs.
 *
 * @remarks The sections run past 4 000 characters of distilled Markdown before the final
 * section that states {@link STORE_POLICY_TOKEN}, so one `read` at offset 0 stops before it.
 */
export const STORE_POLICY: ReadonlyArray<readonly [heading: string, paragraph: string]> =
	Object.freeze([
		[
			'Where we ship',
			'We ship to every address in the country, including islands and remote postcodes. Parcels to the islands travel by ferry and can take one extra working day. We do not ship to parcel lockers, because a kettle box is too large for most of them.',
		],
		[
			'How we pack',
			'Every order is packed by hand in paper and card. Kettles travel in a moulded pulp cradle, boards travel wrapped in kraft paper, and mugs travel in a honeycomb sleeve that protects the glaze. We never use plastic fill.',
		],
		[
			'Carriers',
			'Standard parcels travel with the national post. Heavy parcels, over ten kilograms, travel with a courier who books a delivery window by text message. Both carriers give you a tracking link on the day your parcel leaves the workshop.',
		],
		[
			'Delivery times',
			'Standard delivery takes two to four working days on the mainland. Express delivery takes one working day on the mainland and two to the islands. Delivery times start from the day the parcel leaves the workshop, not from the day you order.',
		],
		[
			'Delivery prices',
			'Standard delivery is free on orders over sixty dollars and costs six dollars below that. Express delivery costs fourteen dollars on every order. Heavy parcels cost the same as standard parcels; the workshop pays the difference.',
		],
		[
			'Signing for a parcel',
			'Parcels worth more than one hundred dollars need a signature. If nobody is home, the carrier leaves a card and holds the parcel at the nearest depot for ten days. You can name a neighbour at checkout who can sign on your behalf.',
		],
		[
			'Missed deliveries',
			'If a parcel returns to us after ten days at the depot, we write to you and send it again once, free of charge. A parcel that returns a second time is refunded in full, minus the delivery price of the second attempt.',
		],
		[
			'Damaged parcels',
			'Open your parcel within seven days and check every piece. If anything is damaged, photograph it with the box and write to us. We send a replacement or refund the full price, and you keep the damaged piece; we never ask for it back.',
		],
		[
			'Lost parcels',
			'If tracking shows no movement for five working days, write to us. We open a claim with the carrier and send a replacement the same day, without waiting for the claim to finish. You do not need to contact the carrier yourself.',
		],
		[
			'Changing an address',
			'You can change the delivery address until the parcel leaves the workshop. After that, the carrier can redirect it for a fee that the carrier sets. Write to us with the order number and the new address and we will arrange it.',
		],
		[
			'Gift orders',
			'A gift order ships without a price list inside the box. Add the recipient address at checkout and your own address for the receipt. The handwritten card travels inside the box, sealed in its own envelope.',
		],
		[
			'Orders from abroad',
			'We do not ship abroad yet. Visitors from abroad can collect an order at the workshop on the first Saturday of each month; choose collection at checkout and bring the order number with you.',
		],
		[
			'Collection',
			'You can collect any order at the workshop on the east pier. Collection is free and the order is ready one working day after you place it. We hold a collection order for thirty days before we refund it.',
		],
		[
			'Returns by post',
			'To return an unwanted piece, write to us within thirty days. We send a prepaid label by email. Pack the piece in its original box if you still have it, and drop the parcel at any post office. We refund the full price when it reaches us.',
		],
		[
			'Weather and holidays',
			'During storms the ferry to the islands can stop for several days, and parcels wait at the harbour depot until it runs again. Between the last week of December and the first working day of January the workshop is closed and nothing ships.',
		],
		[
			'Tracking your parcel',
			'The tracking link arrives by email on the day the parcel leaves the workshop. It shows each scan the carrier records: collection, the sorting depot, the local depot, and the delivery van. A parcel can go a day without a scan while it travels between depots.',
		],
		[
			'Delivery to a workplace',
			'You can send an order to a workplace. Add the company name on the address line and the floor or department on the second line, so the post room can find you. Most post rooms sign for parcels, so a workplace delivery rarely misses.',
		],
		[
			'Safe places',
			'At checkout you can name a safe place, such as a porch or a shed, where the carrier may leave a parcel that needs no signature. The carrier photographs the parcel where it was left, and the photograph appears on the tracking page.',
		],
		[
			'Split orders',
			'When part of an order is waiting for a new batch, we ship the pieces that are ready and send the rest when the batch is finished. You pay delivery once, and each parcel carries its own tracking link.',
		],
		[
			'Large and fragile pieces',
			'Cake stands, serving platters, and shelving travel with the courier because they need two people to carry or careful handling. The courier books a delivery window with you by text message the day before.',
		],
		[
			'Changing an order',
			'You can add or remove pieces until the order is packed. Write to us with the order number and the change. When a change lowers the price, we refund the difference; when it raises the price, we send a payment link for the difference.',
		],
		[
			'Cancelling an order',
			'You can cancel an order at any time before it leaves the workshop, and we refund the full price the same day. After it leaves, the returns section applies, and the prepaid return label is still free.',
		],
		[
			'Refund times',
			'Refunds go back to the card or account you paid with. Most banks show a refund within three working days of the day we send it; some take up to ten. We write to you on the day we send each refund.',
		],
		[
			'Customs and duties',
			'Every order ships from and to an address in this country, so no customs forms or duties apply. When we begin to ship abroad, this section will state the duties each destination charges.',
		],
		[
			'Contacting the workshop',
			'Write to the workshop by email or through the contact form. We answer every message ourselves, usually within one working day. Include the order number when you have one, so we can find your order quickly.',
		],
		[
			'Policy reference',
			`Quote the policy reference token ${STORE_POLICY_TOKEN} when you write to us about a delivery, so the workshop can match your message to this version of the policy.`,
		],
	])

/**
 * Renders the shipping policy page.
 *
 * @returns The policy document, whose final section states {@link STORE_POLICY_TOKEN}
 */
export function renderPolicy(): string {
	const sections = STORE_POLICY.map(
		([heading, paragraph]) =>
			`<h2>${escapeMarkup(heading)}</h2>\n<p>${escapeMarkup(paragraph)}</p>`,
	)
	return renderStorePage(
		'Shipping policy',
		`<article>\n<h1>Shipping policy</h1>\n${sections.join('\n')}\n</article>`,
	)
}

/**
 * Builds an HTML response that no cache keeps.
 *
 * @param html - The document to serve
 * @param status - The HTTP status; defaults to `200`
 * @returns The response
 */
export function buildPageResponse(html: string, status = 200): Response {
	return new Response(html, {
		status,
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
	})
}

/**
 * Starts the store fixture on an ephemeral loopback port.
 *
 * @returns The running store, its origin, and readers over the cart, searches, and orders
 * @remarks The store serves the catalogue at `/`, results at `GET /search?q=`, each product at
 * `/product/:id`, the cart at `/cart` (a `POST` adds the posted `product` and redirects back to
 * the cart), the checkout at `/checkout`, the order endpoint its script posts to at `POST /order`,
 * and the shipping policy at `/policy`. The cart, the searches, and the orders are state of this
 * server instance alone.
 */
export async function createStoreServer(): Promise<StoreServerInterface> {
	const cart: string[] = []
	const searches: string[] = []
	const orders: string[] = []
	const dispatcher = createDispatcher<Record<string, never>>()
	dispatcher.add({ method: 'GET', path: '/', handler: () => buildPageResponse(renderCatalogue()) })
	dispatcher.add({
		method: 'GET',
		path: '/search',
		handler(request) {
			const query = new URL(request.url).searchParams.get('q') ?? ''
			searches.push(query)
			return buildPageResponse(renderSearch(query))
		},
	})
	dispatcher.add({
		method: 'GET',
		path: '/product/:id',
		handler(_request, context) {
			const product = STORE_PRODUCTS.find((candidate) => candidate.id === context.params.id)
			if (product === undefined)
				return buildPageResponse(renderStorePage('Not found', '<h1>Not found</h1>'), 404)
			return buildPageResponse(renderProduct(product))
		},
	})
	dispatcher.add({
		method: 'GET',
		path: '/cart',
		handler: () => buildPageResponse(renderCart(cart)),
	})
	dispatcher.add({
		method: 'POST',
		path: '/cart',
		async handler(request) {
			const id = new URLSearchParams(await request.text()).get('product')
			const product = STORE_PRODUCTS.find((candidate) => candidate.id === id)
			if (product === undefined)
				return buildPageResponse(renderStorePage('Not found', '<h1>Not found</h1>'), 404)
			cart.push(product.name)
			return new Response(null, { status: 303, headers: { location: '/cart' } })
		},
	})
	dispatcher.add({
		method: 'GET',
		path: '/checkout',
		handler: () => buildPageResponse(renderCheckout()),
	})
	dispatcher.add({
		method: 'POST',
		path: '/order',
		async handler(request) {
			orders.push(await request.text())
			return new Response(STORE_CODE, {
				headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
			})
		},
	})
	dispatcher.add({
		method: 'GET',
		path: '/policy',
		handler: () => buildPageResponse(renderPolicy()),
	})
	const server = createServer({ dispatcher, state: () => ({}), host: '127.0.0.1' })
	const port = await server.start()
	return {
		url: `http://127.0.0.1:${port}`,
		readCart: () => [...cart],
		readSearches: () => [...searches],
		readOrders: () => [...orders],
		stop: () => server.stop(),
	}
}

// ── Live store runs ───────────────────────────────────────────────────────────
//
// The Node half of the live browser-vocabulary proof: one model run over the store
// through the browser toolset, the transcript it leaves, and the readings the proof
// takes from that transcript. The live half is `tests/service/browser.test.ts`.

/**
 * Cites the reading that makes the live browser-vocabulary proof inapplicable on a host.
 *
 * @remarks The proof passes it to a conditional skip whose condition is the daemon's
 * `/api/tags` reading, so the skip names the mechanism rather than the host.
 */
export const OLLAMA_ABSENT_REASON =
	'GET /api/tags on the configured Ollama daemon did not answer or did not list the configured model, so no model can drive the browser tools'

/**
 * Names the deadlines and attempt counts the live store proof takes, in milliseconds.
 *
 * @remarks `run` is the agent's wall-clock deadline for one attempt. `single` bounds a task
 * that passes on its first attempt: one run plus the browser page and the seeded `look`.
 * `attempts` runs fit in `budget`, and `retry` bounds the case that spends them, so a retry
 * ends on its attempt count rather than on its budget.
 */
export const STORE_BOUNDS = Object.freeze({
	/** The agent's deadline for one attempt. */
	run: 480_000,
	/** The deadline a single-attempt case allows. */
	single: 540_000,
	/** How many attempts a retried task spends. */
	attempts: 3,
	/** The elapsed-time budget a retried task gives `retryUntil`. */
	budget: 1_620_000,
	/** The deadline a retried case allows. */
	retry: 1_680_000,
	/** The most tool-iteration turns one attempt allows. */
	limit: 8,
	/**
	 * The Ollama `num_predict` cap each model turn takes, above `TOOL_LOOP_OPTIONS.num_predict`
	 * because a 64-token cap cut the model's narration before its tool call.
	 */
	predict: 256,
})

/** Represents one tool call a store run dispatched, as the transcript records it. */
export interface StoreCall {
	/** The called tool's name. */
	readonly name: string
	/** The arguments the model supplied. */
	readonly arguments: Readonly<Record<string, unknown>>
	/** True if the tool returned a value; false if it failed. */
	readonly success: boolean
	/** The result text the model received, or the failure's message. */
	readonly text: string
}

/** Represents one conversation message as the transcript records it: the message and its thinking. */
export interface StoreMessage extends Message {
	/** The reasoning the provider separated from the answer; absent when the turn surfaced none. */
	readonly thinking?: string
}

/** Represents the record one store run leaves, which the proof's assertions read. */
export interface StoreTranscript {
	/** The task's name, which also names the transcript file. */
	readonly task: string
	/** The attempt number, counted from 1. */
	readonly attempt: number
	/** The system prompt the agent ran with. */
	readonly system: string
	/** The `look` result the first user turn carries. */
	readonly seed: string
	/** The task the first user turn states. */
	readonly prompt: string
	/** Every conversation message after the run, in order; an assistant message carries its turn's thinking. */
	readonly messages: readonly StoreMessage[]
	/** Every tool call the run dispatched, in order, with its result text. */
	readonly calls: readonly StoreCall[]
	/** The run's final answer. */
	readonly answer: string
	/** True if a deadline or limit cut the run short; false otherwise. */
	readonly partial: boolean
	/** The token usage summed over the run's provider calls, when the provider reported it. */
	readonly usage: TokenUsage | undefined
	/** The run's wall time in milliseconds, from the seeded `look` to the final answer. */
	readonly elapsed: number
	/** What the store recorded when the run ended: the cart, the searches, and the orders. */
	readonly state: StoreState
	/** The message of the error that ended the run early, such as a provider error; absent otherwise. */
	readonly failure: string | undefined
	/**
	 * True if the final answer contains the task's `mention`, false if it does not; absent for a
	 * task with no `mention`. The proof records it and never asserts it.
	 */
	readonly mentioned: boolean | undefined
}

/** Represents what a store recorded by the end of one run. */
export interface StoreState {
	/** The names of the products in the cart, in the order they were added. */
	readonly cart: readonly string[]
	/** Every submitted query, in submission order. */
	readonly searches: readonly string[]
	/** Every name a checkout submitted, in submission order. */
	readonly orders: readonly string[]
}

/** Represents what {@link runStoreTask} takes. */
export interface StoreRunOptions {
	/** The task's name, which names the transcript file. */
	readonly task: string
	/** The text whose presence in the final answer the transcript notes; omitted ⇒ no note. */
	readonly mention?: string | undefined
	/** The attempt number, counted from 1. */
	readonly attempt: number
	/** The task the first user turn states. */
	readonly prompt: string
	/** The store path the page opens before the seeded `look`, such as `/`. */
	readonly path: string
	/** The model the agent runs. */
	readonly provider: ProviderInterface
	/** The page the toolset drives. */
	readonly page: BrowserPageInterface
	/** The store the page opens. */
	readonly store: StoreServerInterface
}

/**
 * Renders the text a tool result hands the model.
 *
 * @param result - The tool result the agent loop produced
 * @returns The returned string, the returned value as JSON, or the failure's message
 */
export function renderToolText(result: ToolResult): string {
	if (!result.success) return result.error
	return typeof result.value === 'string' ? result.value : JSON.stringify(result.value)
}

/**
 * Pairs each assistant message with the thinking its turn surfaced.
 *
 * @param messages - The conversation's messages, in order
 * @param thoughts - The thinking each provider turn surfaced, in turn order; `''` for a silent turn
 * @returns The same messages; the n-th assistant message carries the n-th turn's thinking when it
 * is not empty
 */
export function attachThinking(
	messages: readonly Message[],
	thoughts: readonly string[],
): readonly StoreMessage[] {
	let turn = 0
	return messages.map((message) => {
		if (message.role !== 'assistant') return message
		const thinking = thoughts[turn] ?? ''
		turn += 1
		return thinking === '' ? message : { ...message, thinking }
	})
}

/** Names the arguments of the `look` call a store run is seeded with. */
export const STORE_SEED_ARGUMENTS: Readonly<Record<string, unknown>> = Object.freeze({
	what: 'the page',
})

/**
 * Builds the first user turn of a store run: the task, then the view the page opened on.
 *
 * @param prompt - The task
 * @param seed - The seeded `look` result
 * @returns The user turn's content
 */
export function buildStorePrompt(prompt: string, seed: string): string {
	return `${prompt}\n\nThe browser shows this page:\n${seed}`
}

/**
 * Drives one store task with a live model through the browser toolset and writes its transcript.
 *
 * @param options - The task, the attempt, the start path, the model, the page, and the store
 * @returns The run's transcript, also written to {@link transcriptPath}
 * @remarks The page opens the start path, the toolset registers into a fresh tool manager, and
 * the first user turn carries the toolset's own `look` result. The agent runs with
 * {@link STORE_SYSTEM_PROMPT}, `STORE_BOUNDS.limit` turns, and `STORE_BOUNDS.run` as its
 * deadline. A run the agent ends with an error still writes its transcript, carrying the error's
 * message as `failure`. A daemon fault (see {@link matchesDaemonFault}) then returns that
 * transcript as a failed attempt, so an attempt loop spends it like any unmet oracle; every other
 * error is rethrown. The toolset is destroyed after the run,
 * whether or not the run succeeded; the page and the store stay the caller's.
 */
export async function runStoreTask(options: StoreRunOptions): Promise<StoreTranscript> {
	await options.page.navigate(`${options.store.url}${options.path}`)
	const toolset = createBrowserToolset(options.page, { tools: createToolManager() })
	try {
		await toolset.start()
		const started = performance.now()
		const seeded = await toolset.tools.execute({
			id: 'seed',
			name: 'look',
			arguments: STORE_SEED_ARGUMENTS,
		})
		const seed = renderToolText(seeded)
		const calls: StoreCall[] = []
		const usages: TokenUsage[] = []
		const thoughts: string[] = ['']
		const agent = createAgent(options.provider, {
			system: STORE_SYSTEM_PROMPT,
			tools: toolset.tools,
			timeout: STORE_BOUNDS.run,
			limit: STORE_BOUNDS.limit,
			on: {
				tool: (call, result) =>
					void calls.push({
						name: call.name,
						arguments: call.arguments,
						success: result.success,
						text: renderToolText(result),
					}),
				usage: (usage) => void usages.push(usage),
			},
		})
		agent.context.messages.add({ role: 'user', content: buildStorePrompt(options.prompt, seed) })
		let failure: unknown
		let driven: Awaited<ReturnType<typeof driveAgent>> | undefined
		try {
			const stream = agent.stream()
			// The usage chunk closes a provider turn, so the thinking between two of them is one turn's.
			const tapped: typeof stream = {
				events: (async function* () {
					for await (const chunk of stream.events) {
						if (chunk.category === 'think') thoughts[thoughts.length - 1] += chunk.content
						else if (chunk.category === 'usage') thoughts.push('')
						yield chunk
					}
				})(),
				result: stream.result,
				abort: (reason) => stream.abort(reason),
			}
			driven = await driveAgent(tapped)
		} catch (error) {
			failure = error
		}
		const transcript: StoreTranscript = {
			task: options.task,
			attempt: options.attempt,
			system: STORE_SYSTEM_PROMPT,
			seed,
			prompt: options.prompt,
			messages: attachThinking(agent.context.messages.messages(), thoughts),
			calls,
			answer: driven?.result.content ?? '',
			partial: driven?.result.partial ?? true,
			usage: sumUsage(usages),
			elapsed: performance.now() - started,
			state: {
				cart: options.store.readCart(),
				searches: options.store.readSearches(),
				orders: options.store.readOrders(),
			},
			failure: driven === undefined ? describeFailure(failure) : undefined,
			mentioned:
				options.mention === undefined
					? undefined
					: (driven?.result.content ?? '').includes(options.mention),
		}
		writeTranscript(transcript)
		if (driven === undefined && !matchesDaemonFault(failure)) throw failure
		return transcript
	} finally {
		await toolset.destroy()
	}
}

/**
 * Returns the path a store run's transcript is written to.
 *
 * @param task - The task's name
 * @param attempt - The attempt number
 * @param root - The workspace root; defaults to {@link WORKSPACE_ROOT}
 * @returns `tmp/probes/logs/<task>-<attempt>.json` under the root
 */
export function transcriptPath(
	task: string,
	attempt: number,
	root: URL | string = WORKSPACE_ROOT,
): string {
	return join(rootToPath(root), 'tmp', 'probes', 'logs', `${task}-${attempt}.json`)
}

/**
 * Writes a store run's transcript as indented JSON, creating its folder.
 *
 * @param transcript - The transcript to write
 * @param root - The workspace root; defaults to {@link WORKSPACE_ROOT}
 * @returns The path written
 */
export function writeTranscript(
	transcript: StoreTranscript,
	root: URL | string = WORKSPACE_ROOT,
): string {
	const path = transcriptPath(transcript.task, transcript.attempt, root)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `${JSON.stringify(transcript, undefined, '\t')}\n`)
	return path
}

/**
 * Extracts the element references a view lists.
 *
 * @param text - A `look` result or an action receipt
 * @returns The reference that opens each element row, such as `e12`, in row order; empty for a
 * result that lists no element, such as a `read` slice
 */
export function extractReferences(text: string): readonly string[] {
	return [...text.matchAll(/^(e[1-9]\d*) /gm)].map((match) => match[1] ?? '')
}

/**
 * Returns every call that names a reference the latest view did not list.
 *
 * @param seed - The seeded `look` result, which is the view before the first call
 * @param calls - The run's calls, in order
 * @returns The calls whose `ref` argument, read the way the toolset reads it, is not among the
 * references the latest view listed; a result that lists elements replaces that view, and one
 * that lists none keeps it
 */
export function findUnlistedReferences(
	seed: string,
	calls: readonly StoreCall[],
): readonly StoreCall[] {
	let listed = new Set(extractReferences(seed))
	const unlisted: StoreCall[] = []
	for (const call of calls) {
		const argument = call.arguments['ref']
		if (argument !== undefined) {
			const reference = typeof argument === 'string' ? parseBrowserReference(argument) : undefined
			if (reference === undefined || !listed.has(reference)) unlisted.push(call)
		}
		const references = extractReferences(call.text)
		if (references.length > 0) listed = new Set(references)
	}
	return unlisted
}

/**
 * Splits a tool result into its body and the footer the toolset's bound appends.
 *
 * @param text - A tool result
 * @returns The body and the trailing `[characters …]` footer line; the footer is `''` when the
 * result carries none
 */
export function splitResultFooter(text: string): readonly [body: string, footer: string] {
	const match = /\n+(\[characters [^\n]*\])$/.exec(text)
	if (match === null) return [text, '']
	return [text.slice(0, match.index), match[1] ?? '']
}

/**
 * Normalizes text for a containment check that ignores case, spacing, and punctuation.
 *
 * @param text - The text to normalize
 * @returns The text lowercased with every character other than a letter or a digit removed
 * @example
 * ```ts
 * normalizeAnswer('2:40 p.m.') // '240pm'
 * ```
 */
export function normalizeAnswer(text: string): string {
	return text.toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, '')
}

/**
 * Returns the products an answer names.
 *
 * @param answer - The model's answer
 * @returns The products whose full name the answer contains, ignoring case, in catalogue order
 */
export function filterNamedProducts(answer: string): readonly StoreProduct[] {
	const text = answer.toLowerCase()
	return STORE_PRODUCTS.filter((product) => text.includes(product.name.toLowerCase()))
}

/** Names the product the click task asks the model to add to the cart. */
export const STORE_NAMED = 'Cedar Tea Tray'

/** Names the query the search task asks the model to submit. */
export const STORE_QUERY = 'kettle'

/** Names the buyer the form task asks the model to check out as. */
export const STORE_BUYER = 'Ada Lovelace'

/** Represents one live store task: the transcript name, the prompt, and the start path. */
export interface StoreTask {
	/** The name the transcript files carry. */
	readonly task: string
	/** The task the first user turn states. */
	readonly prompt: string
	/** The store path the page opens first. */
	readonly path: string
	/** The text whose presence in the final answer the transcript notes; omitted ⇒ no note. */
	readonly mention?: string | undefined
}

/** Lists the live store tasks the browser-vocabulary proof runs, keyed by task name. */
export const STORE_TASKS = Object.freeze({
	read: { task: 'read', prompt: 'What is the shipping cutoff time?', path: '/' },
	click: { task: 'click', prompt: `Add the ${STORE_NAMED} to the cart.`, path: '/' },
	search: {
		task: 'search',
		prompt: `Search for ${STORE_QUERY} and tell me which products match.`,
		path: '/',
	},
	form: {
		task: 'form',
		prompt: `Complete checkout with the name ${STORE_BUYER} and report the confirmation code.`,
		path: '/',
	},
	paging: {
		task: 'paging',
		prompt: 'Find the policy token on the shipping policy page.',
		path: '/policy',
		mention: STORE_POLICY_TOKEN,
	},
} satisfies Readonly<Record<string, StoreTask>>)

/** Represents one finished attempt: its transcript and the store it ran against, stopped. */
export interface StoreAttempt {
	/** The attempt's transcript. */
	readonly transcript: StoreTranscript
	/** The store the attempt ran against, whose readers still answer after it stopped. */
	readonly store: StoreServerInterface
}

/**
 * Runs one attempt of a store task on a fresh page over a fresh store, then releases both.
 *
 * @param browser - The connected browser's `create` member, which opens the attempt's page
 * @param task - The task to run
 * @param attempt - The attempt number, counted from 1
 * @param provider - The model the agent runs
 * @returns The transcript and the stopped store, whose cart, searches, and orders stay readable
 * @throws Rethrown from the page's creation or from {@link runStoreTask}, after the store stops
 */
export async function attemptStoreTask(
	browser: Pick<BrowserInterface, 'create'>,
	task: StoreTask,
	attempt: number,
	provider: ProviderInterface,
): Promise<StoreAttempt> {
	const store = await createStoreServer()
	try {
		const page = await browser.create()
		try {
			const transcript = await runStoreTask({ ...task, attempt, provider, page, store })
			return { transcript, store }
		} finally {
			await page.close()
		}
	} finally {
		await store.stop()
	}
}

/**
 * Checks whether a thrown value is the daemon failing a model turn.
 *
 * @param failure - The value a store run's agent threw
 * @returns True if it is a `ProviderError` carrying an HTTP status from 500 through 599, such as
 * Ollama's 500 for a tool call it cannot parse; false otherwise
 */
export function matchesDaemonFault(failure: unknown): boolean {
	return (
		isProviderError(failure) &&
		failure.code === 'HTTP' &&
		failure.status !== undefined &&
		failure.status >= 500 &&
		failure.status <= 599
	)
}

/**
 * Checks whether a transcript holds the oracles every store task shares.
 *
 * @param transcript - The run's transcript
 * @returns True if the run ended without a failure, made at least one and at most
 * `STORE_BOUNDS.limit` tool calls, named no reference its latest view did not list, and received
 * no result body over `BROWSER_TOOL_LIMIT` characters; false otherwise
 */
export function matchesStoreOracles(transcript: StoreTranscript): boolean {
	return (
		transcript.failure === undefined &&
		transcript.calls.length >= 1 &&
		transcript.calls.length <= STORE_BOUNDS.limit &&
		findUnlistedReferences(transcript.seed, transcript.calls).length === 0 &&
		transcript.calls.every((call) => splitResultFooter(call.text)[0].length <= BROWSER_TOOL_LIMIT)
	)
}

/**
 * Builds a recorded store call with inert defaults.
 *
 * @param name - The called tool's name
 * @param args - The call's arguments
 * @param text - The result text; defaults to `''`
 * @returns A successful call carrying the text
 */
export function buildStoreCall(
	name: string,
	args: Readonly<Record<string, unknown>>,
	text = '',
): StoreCall {
	return { name, arguments: args, success: true, text }
}

/**
 * Builds a store transcript with inert defaults around the given calls.
 *
 * @param calls - The run's calls
 * @param seed - The seeded view; defaults to one row listing `e1`
 * @returns A finished, complete transcript of the `fixture` task's first attempt
 */
export function buildStoreTranscript(
	calls: readonly StoreCall[],
	seed = 'e1 link "Catalogue"',
): StoreTranscript {
	return {
		task: 'fixture',
		attempt: 1,
		system: STORE_SYSTEM_PROMPT,
		seed,
		prompt: 'Find the fixture.',
		messages: [],
		calls,
		answer: '',
		partial: false,
		usage: undefined,
		elapsed: 0,
		state: { cart: [], searches: [], orders: [] },
		failure: undefined,
		mentioned: undefined,
	}
}

/**
 * Reads the offset a cut `read` result's footer names for the next slice.
 *
 * @param text - A tool result
 * @returns The offset in a trailing `[characters …; call read with offset N for more]` footer;
 * `undefined` when the result carries no such footer
 */
export function extractFooterOffset(text: string): number | undefined {
	const match = /\[characters [^\n]*; call read with offset (\d+) for more\]$/.exec(text)
	return match?.[1] === undefined ? undefined : Number(match[1])
}

/**
 * Finds the first `read` that continued at the offset an earlier `read` footer named and whose
 * slice contains the given text.
 *
 * @param calls - The run's calls, in order
 * @param text - The text the continued slice must contain
 * @returns The first successful `read` call whose `offset` argument reads as a number equal to the
 * offset an earlier successful `read` result's footer named, and whose result contains the text;
 * `undefined` when no call qualifies
 */
export function findContinuedRead(
	calls: readonly StoreCall[],
	text: string,
): StoreCall | undefined {
	const named = new Set<number>()
	for (const call of calls) {
		if (call.name !== 'read' || !call.success) continue
		if (named.has(Number(call.arguments['offset'] ?? 0)) && call.text.includes(text)) return call
		const offset = extractFooterOffset(call.text)
		if (offset !== undefined) named.add(offset)
	}
	return undefined
}

/**
 * Checks whether a paging run holds its oracle: the shared oracles and a continued `read`.
 *
 * @param transcript - The run's transcript
 * @param token - The text the continued slice must contain
 * @returns True if {@link matchesStoreOracles} holds and {@link findContinuedRead} finds a
 * `read` continued at a footer's offset whose slice contains the token; false otherwise. The
 * final answer is not read: whether it names the token is the transcript's `mentioned` note.
 */
export function matchesPagingOracle(transcript: StoreTranscript, token: string): boolean {
	return matchesStoreOracles(transcript) && findContinuedRead(transcript.calls, token) !== undefined
}

/**
 * Checks whether two product lists hold the same products in the same order.
 *
 * @param left - One list
 * @param right - The other list
 * @returns True if both hold the same products in the same order; false otherwise
 */
function sameProducts(left: readonly StoreProduct[], right: readonly StoreProduct[]): boolean {
	return left.length === right.length && left.every((product, index) => product === right[index])
}

/**
 * Checks whether a search run completed the search: the store recorded a query that matches the
 * task's products and the answer names exactly those products.
 *
 * @param transcript - The run's transcript
 * @param query - The query the task asks the model to submit
 * @returns True if a recorded search resolves through {@link filterProducts} to the same products
 * as the query (so `kettles` counts for `kettle`), and {@link filterNamedProducts} reads from the
 * answer exactly the products {@link filterProducts} matches for the query; false otherwise
 */
export function matchesSearchOracle(transcript: StoreTranscript, query: string): boolean {
	const matched = filterProducts(query)
	const named = filterNamedProducts(transcript.answer)
	return (
		transcript.state.searches.some((search) => sameProducts(filterProducts(search), matched)) &&
		sameProducts(named, matched)
	)
}

/**
 * Names a diagnosed stall for a failure message: the model completes the search and stops before
 * answering.
 *
 * @param transcript - The run's transcript
 * @returns True if the last call is a successful `type` with `submit` whose result lists at least
 * one product {@link filterProducts} matches for the typed text, and the run settled with an
 * empty answer; false otherwise
 * @remarks Run v7 typed `kettles`, received the two kettles, and ended with an empty turn. Run v6
 * typed the same query, received no products, and ended empty too, so it does not hold. Runs v5
 * and c5 ended empty after a `click` receipt naming `type`; that earlier stall is deleted because
 * U14c and C7 let the model reach `type`.
 */
export function matchesStalledSearch(transcript: StoreTranscript): boolean {
	const last = transcript.calls.at(-1)
	if (last === undefined || last.name !== 'type' || !last.success) return false
	if (last.arguments['submit'] !== true) return false
	const typed = last.arguments['text']
	const listed =
		typeof typed === 'string' &&
		filterProducts(typed).some((product) => last.text.includes(product.name))
	return listed && transcript.answer.trim() === '' && !transcript.partial
}

/**
 * Sums the token usage a run's provider calls reported.
 *
 * @param usages - Each reported usage, in order
 * @returns The field-wise sum; `undefined` when no call reported usage
 */
export function sumUsage(usages: readonly TokenUsage[]): TokenUsage | undefined {
	if (usages.length === 0) return undefined
	return usages.reduce((sum, usage) => ({
		prompt: sum.prompt + usage.prompt,
		completion: sum.completion + usage.completion,
		total: sum.total + usage.total,
	}))
}
