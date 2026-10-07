import type {
	StoreDraw,
	StoreProduct,
	StoreServerInterface,
	StoreCall,
	StoreTiming,
	StoreMessage,
	StoreTranscript,
	StoreRunOptions,
	StoreConversationOptions,
	StoreConversation,
	StoreTask,
	StoreAttempt,
	StoreJourneyEvidence,
} from './setupStore/types.js'
import type { AgentResult, Message, ProviderInterface, ScopeInterface } from '@orkestrel/agent'
import type { BrowserJourney, BrowserJourneyStep } from '@orkestrel/browser'
import type { BrowserInterface } from '@orkestrel/browser/server'
import type { TokenUsage } from '@orkestrel/budget'
import type {
	ToolCall,
	ToolContext,
	ToolDefinition,
	ToolManagerInterface,
	ToolResult,
} from '@orkestrel/tool'
import { createAgent, createScope, isProviderError, sumUsage } from '@orkestrel/agent'
import {
	BROWSER_JOURNEY_TOOL_NAMES,
	BROWSER_TOOL_LIMIT,
	createBrowserToolset,
	parseBrowserJourney,
	parseBrowserReference,
	parseBrowserRun,
	renderBrowserJourney,
	validateBrowserToolArguments,
} from '@orkestrel/browser'
import { createFileBrowserJourneyStore, createFileBrowserRunStore } from '@orkestrel/browser/server'
import { createContract, isRecord, schemaToShape } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createScratch } from '@orkestrel/test/server'
import { createToolManager } from '@orkestrel/tool'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { describeFailure, driveAgent, rootToPath, WORKSPACE_ROOT } from './setupServer.js'

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

/** Names the token the shipping policy page states past its first 4 000 characters. */
export const STORE_POLICY_TOKEN = 'HARBOR-TIDE-7153'

/** Names the confirmation code the checkout page inserts after an order is placed. */
export const STORE_CODE = 'HG-48213'

/** Names the milliseconds the checkout page waits after an order before it shows the code. */
export const STORE_CODE_DELAY = 200

/**
 * Names the system prompt every live store run gives the model.
 *
 * @remarks The prompt states the loop the browser vocabulary expects: read first, act by
 * reference, read to answer, stop when the task is done, and never invent a reference.
 */
export const STORE_SYSTEM_PROMPT =
	'Use the browser tools before answering. The first message is a read of the page; references such as e4 name elements. ' +
	'To learn a fact, call read with from 1 and search words from the question. ' +
	'For more text, follow the footer: call read with from set to the line it names. ' +
	'To enter text or search, call type with the reference, text, and submit true. ' +
	'To activate an element, click its reference from the latest result. Never invent references. ' +
	'If expected text has not appeared, call wait once. ' +
	'When done, answer in one short sentence.'

/**
 * Names the system prompt the journey task gives the model: {@link STORE_SYSTEM_PROMPT} followed
 * by one sentence for each journey tool.
 *
 * @remarks The store prompt stays as the five page tasks and the browser guide read it, so the
 * journey sentences extend a copy rather than the prompt those tasks run with.
 */
export const STORE_JOURNEY_PROMPT =
	`${STORE_SYSTEM_PROMPT} ` +
	'To record a journey, call record with its name before you act; each action after it is a step. ' +
	'When the recorded task is done, call save with one sentence that describes it. ' +
	'To see the saved journeys and their step ids, call journeys. ' +
	'To change a journey, call edit once with every change in edits, such as [{"operation": "declare", "name": "email", "parameter": {"default": "sam@example.test"}}, {"operation": "update", "arguments": {"text": {"parameter": "email"}}, "id": "s4"}, {"operation": "remove", "id": "s5"}]. ' +
	"To run a journey again, call replay with its name and each parameter's value under inputs."

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
	const words = query
		.split(/\s+/)
		.filter((word) => word !== '')
		.map((word) => word.toLowerCase().replace(/s$/, ''))
	if (words.length === 0) return []
	return STORE_PRODUCTS.filter((product) => {
		const nameWords = product.name.split(/\s+/).map((word) => word.toLowerCase().replace(/s$/, ''))
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
 * shipping paragraph beyond the initial projection window. Reaching it requires a search
 * or a continued window.
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

/** Names the label of the checkout's name field, which is the field's accessible name. */
export const STORE_NAME_FIELD = 'Full name'

/** Names the checkout's submit button. */
export const STORE_ORDER_BUTTON = 'Place order'

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
<label for="name">${STORE_NAME_FIELD}</label>
<input id="name" type="text" name="name" autocomplete="off">
<button type="submit">${STORE_ORDER_BUTTON}</button>
</form>`,
		STORE_CHECKOUT_SCRIPT,
	)
}

/**
 * Lists the sections of the shipping policy page, each a heading and its paragraphs.
 *
 * @remarks The final section lies beyond the seed and the next default projection window.
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
			'Packing inspection',
			'Before a parcel leaves the bench, a second packer checks the piece against the packing slip. They inspect handles, lids, edges, and glaze, and replace any wrapping that has shifted. The signed slip travels inside the box so a recipient can see who checked the contents.',
		],
		[
			'Reused cartons',
			'A clean carton from an incoming supply can carry an outgoing parcel when its walls remain firm. Old address labels are removed and seams receive fresh paper tape. A reused carton receives the same inspection and protection as a carton cut for the first time.',
		],
		[
			'Combining parcels',
			'Orders placed close together can travel in one box when their destinations agree. Write before packing begins and include both order numbers. Each piece stays on its own packing slip, and any delivery charge saved by combining the parcels goes back to the original payment.',
		],
		[
			'Access instructions',
			'A carrier needs a clear route to the entrance. Include gate instructions and a working contact number when you order. If a road closes after dispatch, contact the carrier through the tracking link to agree on an accessible meeting place or a later delivery day.',
		],
		[
			'Opening the box',
			'Set a parcel on a firm table before cutting the tape. Lift the paper layers apart instead of pulling on handles or rims. Keep the cradle until every piece has been checked, because the shaped supports make a return trip less likely to damage the contents.',
		],
		[
			'Caring for wrapping',
			'Paper sleeves can be flattened and kept for storing pieces between uses. Keep them dry and away from a cooker. Pulp cradles fit in paper recycling where that service accepts moulded paper, and the workshop can take clean cradles back during collection hours.',
		],
		[
			'Parcel weights',
			'The label states the packed weight, which includes the carton and its protective supports. It may differ from the weight listed for an individual piece. Heavy cartons carry a handling mark and remain within the limits agreed with the carrier for a safe lift.',
		],
		[
			'Receipt copies',
			'Keep the receipt until every piece has arrived and been checked. If an email goes missing, send the order number and the address used at checkout. The workshop can send another copy to that address without changing the contents or the date of the original receipt.',
		],
		[
			'Seasonal packaging',
			'During wet months each carton receives an extra folded paper liner. During hot months waxed boards are wrapped only after cooling on the shelf. These changes protect the pieces in transit and do not change the delivery price or the return period.',
		],
		[
			'Handing over gifts',
			'A recipient can request care notes without seeing the price paid for a gift. The packing slip names the piece and its maker. If a gift needs a replacement, either the sender or the recipient can contact the workshop with the number printed on that slip.',
		],
		[
			'Depot collection documents',
			'Take the delivery card and the identification the carrier requests when collecting from a depot. A person collecting on your behalf may need a signed note. Check the opening hours on the carrier notice before travelling, because depot hours differ from post office hours.',
		],
		[
			'Parcel enquiries',
			'Keep photographs and tracking notices together while an enquiry is open. The workshop records each reply with the order, so a later message can continue the same conversation. Tell the workshop when a delayed parcel arrives so the carrier can close its enquiry.',
		],
		[
			'Quoting this version',
			`Quote ${STORE_POLICY_TOKEN} when you write to us, so our workshop can match a message to this version of these terms.`,
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
 * @param port - The fixed instrument port; defaults to an ephemeral port
 * @returns The running store, its origin, and readers over the cart, searches, and orders
 * @remarks The store serves the catalogue at `/`, results at `GET /search?q=`, each product at
 * `/product/:id`, the cart at `/cart` (a `POST` adds the posted `product` and redirects back to
 * the cart), the checkout at `/checkout`, the order endpoint its script posts to at `POST /order`,
 * and the shipping policy at `/policy`. The cart, the searches, and the orders are state of this
 * server instance alone.
 */
export async function createStoreServer(port = 0): Promise<StoreServerInterface> {
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
	const server = createServer({ dispatcher, state: () => ({}), host: '127.0.0.1', port })
	const bound = await server.start()
	return {
		url: `http://127.0.0.1:${bound}`,
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
 * Names the deadlines, attempt counts, and model settings the live store proof takes; deadlines
 * in milliseconds.
 *
 * @remarks `run` is the agent's wall-clock deadline for one attempt. `single` bounds a task
 * that passes on its first attempt: one run plus the browser page and the seeded `read`.
 * `attempts` runs fit in `budget`, and `retry` bounds the case that spends them, so a retry
 * ends on its attempt count rather than on its budget. Journey tasks advertise the expanded
 * vocabulary; `context` is
 * the window every attempt's model takes instead. `turn` bounds one model turn, above the
 * provider's 120 s default because a turn over the grown prompt outlasts it on a contended host.
 * `refusals` ends a turn whose model keeps calling a tool the toolset refuses: one refusal can be an
 * argument the model corrects and a second a retry, and a third shows the model is not acting on
 * the refusal's text, which names the call to make instead.
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
	/** The Ollama `num_ctx` window each attempt's model takes, in tokens. */
	context: 16_384,
	/** The provider's deadline for one model turn. */
	turn: 300_000,
	/**
	 * The refusals of one tool, with no successful call between them, after which the rest of the
	 * user turn advertises no tool (see {@link converseStore}).
	 */
	refusals: 3,
})

/**
 * Names the deadlines the journey task takes in place of the page tasks' own, in milliseconds.
 * The task spends `STORE_BOUNDS.attempts` attempts and takes every other setting from
 * {@link STORE_BOUNDS}.
 *
 * @remarks The journey task sends five user turns in one conversation, recording the form task's
 * flow, then saving, listing, editing, and replaying it, and each user turn runs under
 * `STORE_BOUNDS.run` and `STORE_BOUNDS.limit`, so one attempt takes at most `run`.
 */
export const STORE_JOURNEY_BOUNDS = Object.freeze({
	/** The longest one attempt takes: five user turns at `STORE_BOUNDS.run` each. */
	run: 2_400_000,
	/** The elapsed-time budget the retried task gives `retryUntil`. */
	budget: 7_200_000,
	/** The deadline the retried case allows. */
	retry: 7_260_000,
})

/**
 * Records provider intervals without changing generated content or advertised definitions.
 * @param provider - The provider to drive
 * @param timings - The owned interval recorder
 * @returns A provider that records each completed or failed generation
 */
export function createTimedProvider(
	provider: ProviderInterface,
	timings: StoreTiming[],
): ProviderInterface {
	return {
		id: provider.id,
		name: provider.name,
		format: provider.format,
		async generate(messages, signal, tools, options) {
			const start = performance.now()
			try {
				return await provider.generate(messages, signal, tools, options)
			} finally {
				timings.push({ operation: 'generation', name: provider.id, start, end: performance.now() })
			}
		},
		async *stream(messages, signal, tools, options) {
			const start = performance.now()
			try {
				return yield* provider.stream(messages, signal, tools, options)
			} finally {
				timings.push({ operation: 'generation', name: provider.id, start, end: performance.now() })
			}
		},
	}
}

/**
 * Records each dispatched tool interval while preserving its definition and execution context.
 * @param tools - The registered browser tools
 * @param timings - The owned interval recorder
 * @returns A live registry view that times every dispatch
 */
export function createTimedTools(
	tools: ToolManagerInterface,
	timings: StoreTiming[],
): ToolManagerInterface {
	return new Proxy(tools, {
		get(target, key) {
			if (key === 'execute')
				return (calls: ToolCall | readonly ToolCall[], context?: ToolContext) => {
					if ('name' in calls) return executeTimedTool(target, calls, timings, context)
					return Promise.all(calls.map((call) => executeTimedTool(target, call, timings, context)))
				}
			const value: unknown = Reflect.get(target, key, target)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
}

/**
 * Records one registry dispatch, including a refusal or a thrown call.
 * @param tools - The live registry
 * @param call - The model's call
 * @param timings - The owned recorder
 * @param context - The execution context
 * @returns The unchanged tool result
 */
export async function executeTimedTool(
	tools: ToolManagerInterface,
	call: ToolCall,
	timings: StoreTiming[],
	context?: ToolContext,
): Promise<ToolResult> {
	const start = performance.now()
	try {
		return await tools.execute(call, context)
	} finally {
		timings.push({ operation: 'tool', name: call.name, start, end: performance.now() })
	}
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

/** Names the arguments of the `read` call a store run is seeded with. */
export const STORE_SEED_ARGUMENTS: Readonly<Record<string, unknown>> = Object.freeze({
	from: 1,
})

/**
 * Builds the first user turn of a store run: the task, then the view the page opened on.
 *
 * @param prompt - The task
 * @param seed - The seeded `read` result
 * @returns The user turn's content
 */
export function buildStorePrompt(prompt: string, seed: string): string {
	return `${prompt}\n\nThe browser shows this page:\n${seed}`
}

/** Names the scope a user turn takes after `STORE_BOUNDS.refusals`: it advertises no tool. */
export const STORE_ANSWER_SCOPE: ScopeInterface = createScope({ name: 'answer', tools: [] })

/**
 * Computes how many refusals the most refused tool has had since the last successful call.
 *
 * @param calls - The calls of one user turn, in order
 * @returns The largest number of calls one tool name has among the calls after the last
 * successful one; `0` when the last call succeeded or no call was made
 * @remarks A refusal of another tool keeps the count, so a model alternating two refused tools
 * reaches the bound as a model repeating one does.
 */
export function computeRefusals(calls: readonly StoreCall[]): number {
	const counts = new Map<string, number>()
	for (const call of calls.slice(calls.findLastIndex((candidate) => candidate.success) + 1)) {
		counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
	}
	return Math.max(0, ...counts.values())
}

/**
 * Drives a store conversation's user turns through one agent.
 *
 * @param options - The model, the system prompt, the tools, and the user turns
 * @returns The messages, the calls, the usage, the last turn's result, and the error a turn
 * ended with
 * @remarks The agent runs `STORE_BOUNDS.limit` tool turns under `STORE_BOUNDS.run` per user turn.
 * When one tool's refusals since the turn's last successful call reach `STORE_BOUNDS.refusals`
 * (see {@link computeRefusals}), the agent's context takes {@link STORE_ANSWER_SCOPE}, so the
 * next provider turn advertises no tool and the model answers after the refusal it last read;
 * every user turn starts with no scope and its own count. An error ends the conversation and is
 * returned rather than thrown.
 */
export async function converseStore(options: StoreConversationOptions): Promise<StoreConversation> {
	const calls: StoreCall[] = []
	const timings: StoreTiming[] = []
	const usages: TokenUsage[] = []
	const thoughts: string[] = ['']
	let start = 0
	let ended = 0
	const agent = createAgent(createTimedProvider(options.provider, timings), {
		system: options.system,
		tools: createTimedTools(options.tools, timings),
		timeout: STORE_BOUNDS.run,
		limit: STORE_BOUNDS.limit,
		on: {
			tool: (call, result) => {
				calls.push({
					name: call.name,
					arguments: call.arguments,
					success: result.success,
					text: renderToolText(result),
				})
				if (
					agent.context.scope !== STORE_ANSWER_SCOPE &&
					computeRefusals(calls.slice(start)) >= STORE_BOUNDS.refusals
				) {
					agent.context.apply(STORE_ANSWER_SCOPE)
					ended += 1
				}
			},
			usage: (usage) => void usages.push(usage),
		},
	})
	let result: AgentResult | undefined
	let partial = false
	let failure: unknown
	try {
		for (const turn of options.turns) {
			start = calls.length
			agent.context.apply(undefined)
			agent.context.messages.add({
				role: 'user',
				content: typeof turn === 'string' ? turn : turn(calls),
			})
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
			result = (await driveAgent(tapped)).result
			partial ||= result.partial
		}
	} catch (error) {
		result = undefined
		failure = error
	}
	return {
		timings,
		messages: attachThinking(agent.context.messages.messages(), thoughts),
		calls,
		usages,
		result,
		partial,
		ended,
		failure,
	}
}

/**
 * Drives one store task with a live model through the browser toolset and writes its transcript.
 *
 * @param options - The task, the attempt, the start path, the model, the page, the store, and
 * the journey root
 * @returns The run's transcript, also written to {@link transcriptPath}
 * @remarks The page opens the start path, the toolset registers into a fresh tool manager with
 * optional journey tools over file stores under `options.root`, and the first user turn carries the
 * toolset's own `read` result. Journey tools are registered only when requested.
 * The transcript records monotonic seed, generation, and tool intervals and the JSON files
 * under the root. The answer is the last user turn's.
 * A run the agent ends with an error still writes its transcript, carrying the error's message
 * as `failure`. A daemon fault (see {@link matchesDaemonFault}) then returns
 * that transcript as a failed attempt, so an attempt loop spends it like any unmet oracle; every
 * other error is rethrown. The toolset is destroyed after the run, whether or not the run
 * succeeded; the page, the store, and the root stay the caller's.
 */
export async function runStoreTask(options: StoreRunOptions): Promise<StoreTranscript> {
	await options.page.navigate(`${options.store.url}${options.path}`)
	const toolset = createBrowserToolset(options.page, {
		tools: createToolManager(),
		...(options.journeys
			? {
					journeys: {
						store: createFileBrowserJourneyStore({ root: options.root }),
						runs: createFileBrowserRunStore({ root: options.root }),
					},
				}
			: {}),
	})
	const system = options.system ?? STORE_SYSTEM_PROMPT
	try {
		await toolset.start()
		const started = performance.now()
		const seeded = await toolset.tools.execute({
			id: 'seed',
			name: 'read',
			arguments: STORE_SEED_ARGUMENTS,
		})
		const timing: StoreTiming = {
			operation: 'seed',
			name: 'read',
			start: started,
			end: performance.now(),
		}
		const seed = renderToolText(seeded)
		const prompt = buildStorePrompt(options.prompt, seed)
		const conversation = await converseStore({
			provider: options.provider,
			system,
			tools: toolset.tools,
			turns: [prompt, ...(options.followups ?? [])],
		})
		const { calls, result } = conversation
		const elapsed = performance.now() - started
		const definitions = toolset.tools.definitions()
		const transcript: StoreTranscript = {
			task: options.task,
			attempt: options.attempt,
			system,
			seed,
			prompt: options.prompt,
			messages: conversation.messages,
			calls,
			answer: result?.content ?? '',
			partial: result === undefined || conversation.partial,
			usage: conversation.usages.reduce<TokenUsage | undefined>(
				(sum, turn) => sumUsage(sum, turn),
				undefined,
			),
			turns: conversation.usages,
			elapsed,
			state: {
				cart: options.store.readCart(),
				searches: options.store.readSearches(),
				orders: options.store.readOrders(),
			},
			failure: result === undefined ? describeFailure(conversation.failure) : undefined,
			mentioned:
				options.mention === undefined
					? undefined
					: (result?.content ?? '').includes(options.mention),
			timings: [timing, ...conversation.timings],
			violations: findMalformedCalls(calls, definitions).length,
			loops: findJourneyLoops(calls).length,
			ended: conversation.ended,
			files: collectStoreFiles(options.root),
		}
		writeTranscript(transcript)
		if (result === undefined && !matchesDaemonFault(conversation.failure)) {
			throw conversation.failure
		}
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
 * @param text - A `read` result or an action receipt
 * @returns The reference that opens each element row, such as `e12`, in row order; empty for a
 * result that lists no element
 */
export function extractReferences(text: string): readonly string[] {
	return [...text.matchAll(/^(?:\d+: (?:#{1,6} |[-] )?)?(e[1-9]\d*) /gm)].map(
		(match) => match[1] ?? '',
	)
}

/**
 * Returns every call that names a reference the latest view did not list.
 *
 * @param seed - The seeded `read` result, which is the view before the first call
 * @param calls - The run's calls, in order
 * @returns The calls whose `ref` argument, read the way the toolset reads it, is not among the
 * references the latest view listed; a result that lists elements replaces that view, and one
 * page listing with no reference clears it
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
		if (references.length > 0 || /^page "/m.test(call.text)) listed = new Set(references)
	}
	return unlisted
}

/**
 * Splits a tool result into its body and the footer the toolset's bound appends.
 *
 * @param text - A tool result
 * @returns The body and the trailing `[lines …]` footer line; the footer is `''` when the
 * result carries none
 */
export function splitResultFooter(text: string): readonly [body: string, footer: string] {
	const match = /\n+(\[lines [^\n]*\])$/.exec(text)
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

/** Names the journey the journey task asks the model to record. */
export const STORE_JOURNEY_NAME = 'place-order'

/** Names the parameter the journey task asks the model to declare and bind to the name step. */
export const STORE_JOURNEY_PARAMETER = 'buyer'

/** Names the buyer the journey task asks the model to replay the journey with. */
export const STORE_JOURNEY_BUYER = 'Grace Hopper'

/** Lists the live store tasks the browser-vocabulary proof runs, keyed by task name. */
export const STORE_TASKS = Object.freeze({
	shipping: { task: 'shipping', prompt: 'What is the shipping cutoff time?', path: '/' },
	cart: { task: 'cart', prompt: `Add the ${STORE_NAMED} to the cart.`, path: '/' },
	search: {
		task: 'search',
		prompt: `Search for ${STORE_QUERY} and tell me which products match.`,
		path: '/',
	},
	checkout: {
		task: 'checkout',
		prompt: `Complete checkout with the name ${STORE_BUYER} and report the confirmation code.`,
		path: '/',
	},
	paging: {
		task: 'paging',
		prompt: 'Find the policy token on the shipping policy page.',
		path: '/policy',
		mention: STORE_POLICY_TOKEN,
	},
	journey: {
		journeys: true,
		task: 'journey',
		prompt: `Record a journey named ${STORE_JOURNEY_NAME}, then open the cart before you complete checkout with the name ${STORE_BUYER} and report the confirmation code.`,
		followups: [
			'Save the journey.',
			'List the saved journeys.',
			renderJourneyEdit,
			`Replay ${STORE_JOURNEY_NAME} with the input ${STORE_JOURNEY_PARAMETER} set to ${STORE_JOURNEY_BUYER}.`,
		],
		path: '/',
		system: STORE_JOURNEY_PROMPT,
	},
} satisfies Readonly<Record<string, StoreTask>>)

/**
 * Returns the directory every store attempt allocates its journey root under.
 *
 * @param root - The workspace root; defaults to {@link WORKSPACE_ROOT}
 * @returns `tmp/browsers` under the root
 */
export function journeyPath(root: URL | string = WORKSPACE_ROOT): string {
	return join(rootToPath(root), 'tmp', 'browsers')
}

/**
 * Runs one attempt of a store task in an isolated browser context over a fresh store and
 * a fresh journey root, then releases the context, store, and root.
 *
 * @param browser - The connected browser's `isolate` member, which creates the attempt's context
 * @param task - The task to run
 * @param attempt - The attempt number, counted from 1
 * @param provider - The model the agent runs
 * @param port - The fixed instrument port; defaults to an ephemeral port
 * @returns The transcript and the stopped store, whose cart, searches, and orders stay readable
 * @throws Rethrown from the page's creation or from {@link runStoreTask}, after the store stops
 * @remarks The journey root is a scratch directory under {@link journeyPath}, removed after the
 * run; the transcript keeps the JSON files the run wrote there.
 */
export async function attemptStoreTask(
	browser: Pick<BrowserInterface, 'isolate'>,
	task: StoreTask,
	attempt: number,
	provider: ProviderInterface,
	port = 0,
): Promise<StoreAttempt> {
	const parent = journeyPath()
	mkdirSync(parent, { recursive: true })
	const root = createScratch({ parent, prefix: `${task.task}-${attempt}-` })
	try {
		const store = await createStoreServer(port)
		try {
			const context = await browser.isolate()
			try {
				const page = await context.create()
				const transcript = await runStoreTask({
					...task,
					attempt,
					provider,
					page,
					store,
					root: root.path,
				})
				return { transcript, store }
			} finally {
				await context.close()
			}
		} finally {
			await store.stop()
		}
	} finally {
		root.destroy()
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
 * no whole result over `BROWSER_TOOL_LIMIT` characters; false otherwise
 */
export function matchesStoreOracles(
	transcript: StoreTranscript,
	limit: number = STORE_BOUNDS.limit,
): boolean {
	return (
		transcript.failure === undefined &&
		!transcript.partial &&
		transcript.seed.length <= BROWSER_TOOL_LIMIT &&
		transcript.calls.length >= 1 &&
		transcript.calls.length <= limit &&
		findUnlistedReferences(transcript.seed, transcript.calls).length === 0 &&
		transcript.calls.every((call) => call.text.length <= BROWSER_TOOL_LIMIT)
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
		turns: [],
		elapsed: 0,
		state: { cart: [], searches: [], orders: [] },
		failure: undefined,
		mentioned: undefined,
		timings: [],
		violations: 0,
		loops: 0,
		ended: 0,
		files: {},
	}
}

/**
 * Builds instrument draws over the tasks and ports.
 *
 * @param tasks - The tasks each port runs
 * @param ports - The fixture ports in attempt order
 * @returns Draws carrying the page arm and each port's attempt number
 */
export function buildStoreDraws(
	tasks: readonly StoreTask[],
	ports: readonly number[],
): readonly StoreDraw[] {
	return ports.flatMap((port, index) =>
		tasks.map((task) => ({ task, port, attempt: index + 1, arm: 'page' })),
	)
}

/**
 * Reads the line a cut `read` result's footer names for the next slice.
 *
 * @param text - A tool result
 * @returns The line in a trailing `[lines …; call read with from N for more]` footer;
 * `undefined` when the result carries no such footer
 */
export function extractFooterLine(text: string): number | undefined {
	const match = /\[lines [^\n]*; call read with from (\d+) for more\]$/.exec(text)
	return match?.[1] === undefined ? undefined : Number(match[1])
}

/**
 * Finds the first `read` that continued at the line an earlier `read` footer named and whose
 * slice contains the given text.
 *
 * @param calls - The run's calls, in order
 * @param text - The text the continued slice must contain
 * @returns The first successful `read` whose numeric `from` equals both its first row and a
 * line an earlier successful model `read` footer named under the same page header, and whose
 * result contains the text. An action, changed page, or change note invalidates earlier footers;
 * `undefined` when no call qualifies
 */
export function findContinuedRead(
	calls: readonly StoreCall[],
	text: string,
): StoreCall | undefined {
	const lines = new Set<number>()
	let header: string | undefined
	for (const call of calls) {
		if (call.name !== 'read') {
			lines.clear()
			header = undefined
			continue
		}
		if (call.text.includes('The page changed since the last view')) lines.clear()
		if (!call.success) continue
		const from = call.arguments['from']
		const first = /^([1-9]\d*): /m.exec(call.text)?.[1]
		const page = /^page .+$/m.exec(call.text)?.[0]
		if (page !== header) lines.clear()
		header = page
		if (
			typeof from === 'number' &&
			lines.has(from) &&
			Number(first) === from &&
			page !== undefined &&
			call.text.includes(text)
		)
			return call
		const line = extractFooterLine(call.text)
		if (page !== undefined && line !== undefined) lines.add(line)
	}
	return undefined
}

/**
 * Checks whether a paging run holds its oracle: the shared oracles and a continued `read`.
 *
 * @param transcript - The run's transcript
 * @param token - The text the continued slice must contain
 * @returns True if {@link matchesStoreOracles} holds and {@link findContinuedRead} finds a
 * `read` continued at a footer's line whose slice contains the token; false otherwise. The
 * final answer is not read: whether it names the token is the transcript's `mentioned` note.
 */
export function matchesPagingOracle(
	transcript: StoreTranscript,
	token = STORE_POLICY_TOKEN,
): boolean {
	return matchesStoreOracles(transcript) && findContinuedRead(transcript.calls, token) !== undefined
}

/**
 * Checks whether a model read learned and answered the shipping fact absent from the seed.
 * @param transcript - The completed attempt
 * @returns True if the shared checks, read evidence, and answer hold; false otherwise
 */
export function matchesShippingOracle(transcript: StoreTranscript): boolean {
	const fact = normalizeAnswer(STORE_FACT)
	return (
		matchesStoreOracles(transcript) &&
		!normalizeAnswer(transcript.seed).includes(fact) &&
		transcript.calls.some(
			(call) => call.name === 'read' && call.success && normalizeAnswer(call.text).includes(fact),
		) &&
		normalizeAnswer(transcript.answer).includes(fact)
	)
}

/**
 * Checks whether the cart holds exactly the requested product.
 * @param transcript - The completed attempt
 * @returns True if the shared checks and exact cart hold; false otherwise
 */
export function matchesCartOracle(transcript: StoreTranscript): boolean {
	return (
		matchesStoreOracles(transcript) &&
		transcript.state.cart.length === 1 &&
		transcript.state.cart[0] === STORE_NAMED
	)
}

/**
 * Checks whether checkout placed exactly one order and answered with its code.
 * @param transcript - The completed attempt
 * @returns True if the shared checks, buyer, order count, and code hold; false otherwise
 */
export function matchesCheckoutOracle(transcript: StoreTranscript): boolean {
	return (
		matchesStoreOracles(transcript) &&
		transcript.state.orders.length === 1 &&
		transcript.state.orders[0] === STORE_BUYER &&
		normalizeAnswer(transcript.answer).includes(normalizeAnswer(STORE_CODE))
	)
}

/**
 * Checks whether two product lists hold the same products in the same order.
 *
 * @param left - One list
 * @param right - The other list
 * @returns True if both hold the same products in the same order; false otherwise
 */
export function matchesProducts(
	left: readonly StoreProduct[],
	right: readonly StoreProduct[],
): boolean {
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
export function matchesSearchOracle(transcript: StoreTranscript, query = STORE_QUERY): boolean {
	const matched = filterProducts(query)
	const named = filterNamedProducts(transcript.answer)
	return (
		matchesStoreOracles(transcript) &&
		transcript.state.searches.some((search) => matchesProducts(filterProducts(search), matched)) &&
		matchesProducts(named, matched)
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

// ── The journey task ──────────────────────────────────────────────────────────
//
// The readers the journey task's oracle takes: the malformed
// calls, the files the journey stores wrote, and the record, list, edit, and replay
// sequence those files and the store must show.

/**
 * Returns the page vocabulary a toolset without journeys advertises.
 *
 * @param definitions - The tool definitions a toolset with journeys advertises
 * @returns The definitions without journey tools, retaining every page parameter
 */
export function inferPageTools(definitions: readonly ToolDefinition[]): readonly ToolDefinition[] {
	return definitions.filter(
		(definition) => !BROWSER_JOURNEY_TOOL_NAMES.some((name) => name === definition.name),
	)
}

/**
 * Returns every call that names no advertised tool or breaks the tool's parameters.
 *
 * @param calls - The run's calls, in order
 * @param definitions - The tools the run advertised
 * @returns The calls whose name no definition carries, whose arguments fail the definition's JSON
 * Schema read through `@orkestrel/contract`, or that carry a parameter the definition does not
 * advertise, as `validateBrowserToolArguments` refuses it
 */
export function findMalformedCalls(
	calls: readonly StoreCall[],
	definitions: readonly ToolDefinition[],
): readonly StoreCall[] {
	return calls.filter((call) => {
		const definition = definitions.find((candidate) => candidate.name === call.name)
		if (definition === undefined) return true
		if (
			definition.parameters !== undefined &&
			!createContract(schemaToShape(definition.parameters)).is(call.arguments)
		) {
			return true
		}
		try {
			validateBrowserToolArguments(definition, call.arguments)
			return false
		} catch {
			return true
		}
	})
}

/**
 * Reads every JSON file under a directory.
 *
 * @param root - The directory to walk
 * @returns Each `.json` file's text by its path under the root, `/`-separated and sorted
 */
export function collectStoreFiles(root: string): Readonly<Record<string, string>> {
	const paths = readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
		.map((entry) => join(entry.parentPath, entry.name))
	return Object.fromEntries(
		paths
			.map((path): readonly [string, string] => [
				relative(root, path).split(sep).join('/'),
				readFileSync(path, 'utf8'),
			])
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
	)
}

/**
 * Parses JSON text.
 *
 * @param text - The text to parse
 * @returns The parsed value; `undefined` for text that is not JSON
 */
export function parseStoreJSON(text: string): unknown {
	try {
		const value: unknown = JSON.parse(text)
		return value
	} catch {
		return undefined
	}
}

/**
 * Extracts the one saved journey and its runs from the files a run left.
 *
 * @param files - A transcript's files, by path under the journey root
 * @returns The journey, its revision, and its runs; `undefined` when the files hold no
 * `journey.json`, more than one, or one that does not parse as a stored journey
 */
export function extractJourneyEvidence(
	files: Readonly<Record<string, string>>,
): StoreJourneyEvidence | undefined {
	const saved = Object.keys(files).filter((path) => /^[^/]+\/journey\.json$/.test(path))
	const path = saved[0]
	if (saved.length !== 1 || path === undefined) return undefined
	const stored = parseStoreJSON(files[path] ?? '')
	if (!isRecord(stored)) return undefined
	const journey = parseBrowserJourney(stored['journey'])
	if (journey === undefined) return undefined
	const name = path.slice(0, path.indexOf('/'))
	const revision = stored['revision']
	return {
		name,
		revision: typeof revision === 'number' ? revision : undefined,
		journey,
		runs: Object.entries(files)
			.filter(([run]) => run.startsWith(`${name}/runs/`) && run.endsWith('/run.json'))
			.flatMap(([, text]) => {
				const run = parseBrowserRun(parseStoreJSON(text))
				return run === undefined ? [] : [run]
			}),
	}
}

/**
 * Finds the parameter the checkout's name step binds.
 *
 * @param journey - The journey to read
 * @returns The name of the declared parameter that carries a default and that the `text` of a
 * `type` step into {@link STORE_NAME_FIELD} binds; `undefined` when none does
 */
export function findBoundParameter(journey: BrowserJourney): string | undefined {
	return Object.keys(journey.parameters).find(
		(name) =>
			journey.parameters[name]?.default !== undefined &&
			journey.steps.some((step) => matchesNameBinding(step, name)),
	)
}

/**
 * Checks whether a step types a parameter into the checkout's name field.
 *
 * @param step - The step to read
 * @param parameter - The parameter's name
 * @returns True if the step is a `type` into {@link STORE_NAME_FIELD} whose `text` binds the
 * parameter; false otherwise
 */
export function matchesNameBinding(step: BrowserJourneyStep, parameter: string): boolean {
	const text = step.arguments['text']
	return (
		step.action === 'type' &&
		step.target?.name === STORE_NAME_FIELD &&
		isRecord(text) &&
		text['parameter'] === parameter
	)
}

/**
 * Lists the step lines of a journey listing that submit the checkout.
 *
 * @param listing - A `save`, `journeys`, or `edit` result, or a `renderBrowserJourney` listing
 * @returns Each line, in order, that types with `submit`, presses Enter, or clicks
 * {@link STORE_ORDER_BUTTON}
 */
export function filterSubmissionLines(listing: string): readonly string[] {
	return extractJourneyLines(listing).filter(
		(line) =>
			/^s[1-9]\d* type .*, submit$/.test(line) ||
			/^s[1-9]\d* press Enter$/.test(line) ||
			line.endsWith(` click button "${STORE_ORDER_BUTTON}"`),
	)
}

/**
 * Removes document line addresses from journey step rows.
 * @param listing - A numbered tool listing or a stored journey rendering
 * @returns The rows with their stable step ids intact
 */
export function extractJourneyLines(listing: string): readonly string[] {
	return listing.split(/\r\n|\n/).map((line) => line.replace(/^\d+: /, ''))
}

/**
 * Renders the journey task's edit turn from the listing the run's calls last returned.
 *
 * @param calls - The run's calls so far, in order
 * @returns The batch with the ids of the name step and cart click from the last successful
 * listing; a prose instruction when either step is absent
 */
export function renderJourneyEdit(calls: readonly StoreCall[]): string {
	const listing =
		calls.findLast((call) => call.success && (call.name === 'save' || call.name === 'journeys'))
			?.text ?? ''
	const name = extractJourneyLines(listing).find(
		(line) => /^s[1-9]\d* type /.test(line) && line.includes(` into textbox "${STORE_NAME_FIELD}"`),
	)
	const second = extractJourneyLines(listing).find((line) =>
		/^s[1-9]\d* click link "Cart"$/.test(line),
	)
	if (name === undefined || second === undefined) {
		return (
			`Edit ${STORE_JOURNEY_NAME} in one call: declare the parameter ${STORE_JOURNEY_PARAMETER} with the default ${STORE_BUYER}, ` +
			`update the step that types the name so its text is {"parameter": "${STORE_JOURNEY_PARAMETER}"}, ` +
			'and remove the recorded cart click.'
		)
	}
	return (
		`Edit ${STORE_JOURNEY_NAME} in one call with the edits ` +
		`[{"operation": "declare", "name": "${STORE_JOURNEY_PARAMETER}", "parameter": {"default": "${STORE_BUYER}"}}, ` +
		`{"operation": "update", "arguments": {"text": {"parameter": "${STORE_JOURNEY_PARAMETER}"}}, "id": "${name.slice(0, name.indexOf(' '))}"}, ` +
		`{"operation": "remove", "id": "${second.slice(0, second.indexOf(' '))}"}].`
	)
}

/**
 * Parses an `edit` call's `edits` argument the way the `edit` tool reads it.
 *
 * @param value - The argument as the model sent it
 * @returns The array as given, or the array a JSON string carries; `undefined` for a string that
 * is not JSON, JSON that is not an array, and any other value
 */
export function parseJourneyEdits(value: unknown): readonly unknown[] | undefined {
	const edits = typeof value === 'string' ? parseStoreJSON(value) : value
	return Array.isArray(edits) ? edits : undefined
}

/**
 * Checks whether a call is a successful `edit` holding a `declare`, an `update`, and a `remove`.
 *
 * @param call - The call to read
 * @returns True if the call is a successful `edit` whose `edits`, read through
 * {@link parseJourneyEdits}, hold all three operations; false otherwise
 */
export function matchesJourneyBatch(call: StoreCall): boolean {
	const edits = parseJourneyEdits(call.arguments['edits'])
	if (!call.success || call.name !== 'edit' || edits === undefined) return false
	const operations = new Set(edits.map((edit) => (isRecord(edit) ? edit['operation'] : undefined)))
	return operations.has('declare') && operations.has('update') && operations.has('remove')
}

/**
 * Returns the refused `record` and `save` calls that follow a run's first successful `save`.
 *
 * @param calls - The run's calls, in order
 * @returns Each unsuccessful `record` or `save` call after the first successful `save`, in order;
 * empty when no `save` succeeded
 * @remarks After a save, the toolset's refusals of `record` and `save` name `journeys`, `edit`,
 * and `replay` as the next call, so the count is how often the model looped past them.
 */
export function findJourneyLoops(calls: readonly StoreCall[]): readonly StoreCall[] {
	const saved = calls.findIndex((call) => call.success && call.name === 'save')
	if (saved === -1) return []
	return calls
		.slice(saved + 1)
		.filter((call) => !call.success && (call.name === 'record' || call.name === 'save'))
}

/** Lists the journey tools in the order the journey task calls them. */
export const STORE_JOURNEY_SEQUENCE: readonly string[] = Object.freeze([
	'record',
	'save',
	'journeys',
	'edit',
	'replay',
])

/**
 * Checks whether a run called the journey tools in the journey task's order.
 *
 * @param calls - The run's calls, in order
 * @returns True if a successful call of each {@link STORE_JOURNEY_SEQUENCE} tool follows the
 * previous one, the `edit` one {@link matchesJourneyBatch} holds for and the `replay` one carrying
 * `inputs`; false otherwise
 */
export function matchesJourneySequence(calls: readonly StoreCall[]): boolean {
	let index = -1
	for (const name of STORE_JOURNEY_SEQUENCE) {
		index = calls.findIndex(
			(call, position) =>
				position > index &&
				call.success &&
				call.name === name &&
				(name !== 'edit' || matchesJourneyBatch(call)) &&
				(name !== 'replay' || isRecord(call.arguments['inputs'])),
		)
		if (index === -1) return false
	}
	return true
}

/**
 * Checks whether the edit removed the recorded cart click and retained one submission.
 *
 * @param calls - The run's calls, in order
 * @param listing - The listing of the journey as stored after the run
 * @returns True if the listing the last successful `save` before the first
 * {@link matchesJourneyBatch} edit holds one submission and a cart click, the edit removes
 * that click, and the stored listing has one submission and no cart click; false otherwise
 */
export function matchesRemovedCart(calls: readonly StoreCall[], listing: string): boolean {
	const index = calls.findIndex(matchesJourneyBatch)
	const edits = parseJourneyEdits(calls[index]?.arguments['edits'])
	const saved = calls
		.slice(0, Math.max(index, 0))
		.findLast((call) => call.success && call.name === 'save')
	if (saved === undefined || edits === undefined) return false
	const later = extractJourneyLines(saved.text).filter((line) =>
		/^s[1-9]\d* click link "Cart"$/.test(line),
	)
	return (
		filterSubmissionLines(saved.text).length === 1 &&
		filterSubmissionLines(listing).length === 1 &&
		!extractJourneyLines(listing).some((line) => /^s[1-9]\d* click link "Cart"$/.test(line)) &&
		edits.some(
			(edit) =>
				isRecord(edit) &&
				edit['operation'] === 'remove' &&
				later.some((line) => line.startsWith(`${String(edit['id'])} `)),
		)
	)
}

/**
 * Checks whether a journey run holds its oracle.
 *
 * @param transcript - The run's transcript
 * @param buyer - The input the replay must carry
 * @returns True if the run ended without a failure, {@link matchesJourneySequence} holds, the files
 * hold one saved journey whose name step binds a defaulted parameter, {@link matchesRemovedCart}
 * holds for it, a run of its stored revision completed with the buyer as that parameter's input,
 * and the store recorded exactly the original buyer followed by the replay buyer; false otherwise
 */
export function matchesJourneyOracle(
	transcript: StoreTranscript,
	buyer = STORE_JOURNEY_BUYER,
): boolean {
	if (
		!matchesStoreOracles(
			transcript,
			(1 + STORE_TASKS.journey.followups.length) * STORE_BOUNDS.limit,
		) ||
		!matchesJourneySequence(transcript.calls)
	)
		return false
	const evidence = extractJourneyEvidence(transcript.files)
	if (evidence === undefined) return false
	const parameter = findBoundParameter(evidence.journey)
	return (
		parameter !== undefined &&
		matchesRemovedCart(transcript.calls, renderBrowserJourney(evidence.journey)) &&
		evidence.runs.some(
			(run) =>
				run.outcome === 'complete' &&
				run.revision === evidence.revision &&
				run.inputs[parameter] === buyer,
		) &&
		transcript.state.orders.length === 2 &&
		transcript.state.orders[0] === STORE_BUYER &&
		transcript.state.orders[1] === buyer
	)
}

/** Maps each task to the predicate shared by retries, assertions, and measurement. */
export const STORE_PREDICATES: Readonly<Record<string, (transcript: StoreTranscript) => boolean>> =
	Object.freeze({
		shipping: matchesShippingOracle,
		cart: matchesCartOracle,
		search: matchesSearchOracle,
		checkout: matchesCheckoutOracle,
		paging: matchesPagingOracle,
		journey: matchesJourneyOracle,
	})
