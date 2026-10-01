/**
 * The live browser-vocabulary proof: `qwen3.5:2b-q4_K_M` at temperature 0 drives the store
 * fixture through `createBrowserToolset` and `@orkestrel/agent`, and every assertion reads the
 * run's transcript and the store's own state rather than the model's words alone.
 *
 * Each of the five tasks spends at most `STORE_BOUNDS.attempts` attempts through `retryUntil`,
 * because the model's first choice of a link, a wait, or a `read` continuation is the step they
 * measure. Every attempt writes
 * `tmp/probes/logs/<task>-<attempt>.json`, the failing ones included. A daemon 5xx on a model
 * turn is the daemon's fault rather than the toolset's, so it ends that attempt as a failed one,
 * with its message in the transcript's `failure`, and spends the same attempt budget.
 *
 * The search task runs as the others do. Its history at temperature 0 with 256 predicted tokens:
 * runs `v4`, `c5`, and `v5` clicked the search box and ended an empty turn after a click receipt
 * naming `type`; run `v6` submitted a search the fixture's substring match answered with no
 * result, then ended empty; run `v7` completed the search, listed the kettles, and ended empty;
 * run `v8` completed on the first attempt, typing `kettles` with submit and answering with both
 * kettles. The store proof's transcripts sit under `tmp/probes/logs/v4/`, `tmp/probes/logs/c5/`,
 * `tmp/probes/logs/v5/`, `tmp/probes/logs/v6/`, `tmp/probes/logs/v7/`, and `tmp/probes/logs/v8/`.
 * Run `v9` failed the click task's single attempt: the model clicked the Cart link, then typed into
 * a reference no view listed (`tmp/probes/logs/v9/click-1.json`).
 *
 * The paging task's oracle is the reading, not the answer: a `read` continued at the offset an
 * earlier footer named, whose slice contains the token. Paging is what the toolset controls;
 * whether the model then names the token rather than summarising the page is its own choice, so
 * the transcript records that as `mentioned` and the proof does not assert it, as it does not
 * assert the click task's answer.
 *
 * Every toolset carries the journey tools over file stores under a scratch directory in
 * `tmp/browsers`, so the five page tasks run with `record`, `save`, `journeys`, `edit`, `replay`,
 * and `type`'s `secret` advertised beside the page vocabulary. Each transcript records the prompt
 * tokens the first turn spends with no tool, the page vocabulary, and every tool, how many calls
 * broke the advertised parameters, and how many `record` and `save` calls the toolset refused
 * after a save (`loops`). A user turn whose model reaches `STORE_BOUNDS.refusals` refusals of one
 * tool with no successful call between them goes on with no tool advertised, so the model answers
 * (`converseStore`); the transcript counts those turns as `ended`. The journey task sends five user turns in one conversation: record the
 * form task's flow, save it, list it, edit it in one batch, and replay it with an input; the edit
 * turn spells the batch out with the step ids the last listing shows (`renderJourneyEdit`). Its
 * oracle is one order in the store carrying the input and the journey and run files under the
 * root. Every attempt's model takes `STORE_BOUNDS.context` as the Ollama `num_ctx`, because the
 * daemon's default 4 096-token window cuts a prompt past it to about half, and with the journey
 * tools advertised a page task's third turn passes it.
 *
 * The WebMCP task is not run: the Chromium 141.0.7390.37 on this host answers `WebMCP.enable` with
 * CDP error -32601 and `Schema.getDomains` lists no `WebMCP` domain, so no page registers a tool
 * the toolset could adopt.
 *
 * The daemon and the model are the one skipped precondition, cited through
 * `OLLAMA_ABSENT_REASON`; a missing Chromium is a throw from `requirePageBrowser` naming its fix.
 * The skip is reached only when `tests/setupService.ts` loads without throwing, because that
 * setup file refuses an absent daemon or model at import, before this file runs.
 *
 * Each model turn takes `STORE_BOUNDS.predict` (256) tokens rather than
 * `TOOL_LOOP_OPTIONS.num_predict` (64): the model narrates before it calls a tool, and 64 tokens
 * cut that narration before the call. The agent's deadline for each user turn is
 * `STORE_BOUNDS.run`, and the provider's for each model turn is `STORE_BOUNDS.turn`.
 */

import type { BrowserInterface } from '@orkestrel/browser/server'
import type { StoreAttempt, StoreTask, StoreTranscript } from '../setupStore.js'
import { BROWSER_TOOL_LIMIT, renderBrowserJourney } from '@orkestrel/browser'
import { createBrowser } from '@orkestrel/browser/server'
import { requireValue, retryUntil } from '@orkestrel/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { reservePort } from '../setupServer.js'
import {
	attemptStoreTask,
	extractJourneyEvidence,
	filterSubmissionLines,
	findBoundParameter,
	findContinuedRead,
	findUnlistedReferences,
	matchesJourneyOracle,
	matchesJourneySequence,
	matchesPagingOracle,
	matchesRemovedSubmission,
	matchesSearchOracle,
	matchesStalledSearch,
	matchesStoreOracles,
	normalizeAnswer,
	OLLAMA_ABSENT_REASON,
	splitResultFooter,
	STORE_BOUNDS,
	STORE_BUYER,
	STORE_CODE,
	STORE_FACT,
	STORE_JOURNEY_BOUNDS,
	STORE_JOURNEY_BUYER,
	STORE_NAMED,
	STORE_POLICY_TOKEN,
	STORE_QUERY,
	STORE_TASKS,
} from '../setupStore.js'
import {
	createLiveOllama,
	isOllamaReady,
	PAGE_BROWSER_ARGS,
	requirePageBrowser,
} from '../setupService.js'

const READY = await isOllamaReady()
const EXECUTABLE = requirePageBrowser().executable

let browser: BrowserInterface | undefined

/**
 * Runs one attempt of a task in the browser this file launched, with the store model at
 * `STORE_BOUNDS.context` and `STORE_BOUNDS.turn`; a one-token meter at the same window measures
 * its tool lists.
 */
function attempt(task: StoreTask, number: number): Promise<StoreAttempt> {
	if (browser === undefined) throw new Error('the store proof launched no browser')
	const settings = { temperature: 0, context: STORE_BOUNDS.context, turn: STORE_BOUNDS.turn }
	return attemptStoreTask(
		browser,
		task,
		number,
		createLiveOllama({ ...settings, predict: STORE_BOUNDS.predict }),
		createLiveOllama({ ...settings, predict: 1 }),
	)
}

/** Asserts the oracles every task shares: the call count, the references, and the result bound. */
function expectSharedOracles(transcript: StoreTranscript): void {
	expect(transcript.failure).toBeUndefined()
	expect(transcript.calls.length).toBeGreaterThanOrEqual(1)
	expect(transcript.calls.length).toBeLessThanOrEqual(STORE_BOUNDS.limit)
	expect(findUnlistedReferences(transcript.seed, transcript.calls)).toEqual([])
	for (const call of transcript.calls) {
		expect(splitResultFooter(call.text)[0].length).toBeLessThanOrEqual(BROWSER_TOOL_LIMIT)
	}
}

beforeAll(async () => {
	if (!READY) return
	browser = createBrowser({
		executable: EXECUTABLE,
		headless: true,
		args: PAGE_BROWSER_ARGS,
		cdp: { port: await reservePort(), discover: false },
	})
	await browser.connect()
})

afterAll(async () => {
	await browser?.destroy()
})

describe('Browser vocabulary (live) — the store tasks', () => {
	beforeEach((context) => {
		context.skip(!READY, OLLAMA_ABSENT_REASON)
	})

	it(
		'answers the shipping cutoff from a read the seeded view did not carry',
		async () => {
			const fact = normalizeAnswer(STORE_FACT)
			const read = (transcript: StoreTranscript) =>
				transcript.calls.find(
					(call) =>
						(call.name === 'read' || call.name === 'look') &&
						normalizeAnswer(call.text).includes(fact),
				)
			let count = 0
			const { transcript } = await retryUntil(
				'find the shipping cutoff in a read the seeded view did not carry',
				() => attempt(STORE_TASKS.read, (count += 1)),
				(run) =>
					!normalizeAnswer(run.transcript.seed).includes(fact) &&
					read(run.transcript) !== undefined &&
					normalizeAnswer(run.transcript.answer).includes(fact) &&
					matchesStoreOracles(run.transcript),
				{ attempts: STORE_BOUNDS.attempts, budget: STORE_BOUNDS.budget },
			)
			expect(normalizeAnswer(transcript.seed)).not.toContain(fact)
			expect(read(transcript)).toBeDefined()
			expect(normalizeAnswer(transcript.answer)).toContain(fact)
			expectSharedOracles(transcript)
		},
		STORE_BOUNDS.retry,
	)

	it(
		'adds the named product to the cart and no other',
		async () => {
			let count = 0
			const { transcript, store } = await retryUntil(
				'add the named product to the cart and no other',
				() => attempt(STORE_TASKS.click, (count += 1)),
				(run) =>
					JSON.stringify(run.store.readCart()) === JSON.stringify([STORE_NAMED]) &&
					matchesStoreOracles(run.transcript),
				{ attempts: STORE_BOUNDS.attempts, budget: STORE_BOUNDS.budget },
			)
			expect(store.readCart()).toEqual([STORE_NAMED])
			expectSharedOracles(transcript)
		},
		STORE_BOUNDS.retry,
	)

	it(
		'answers the search by naming the products the submitted query lists',
		async () => {
			let count = 0
			let last: StoreTranscript | undefined
			try {
				const { transcript } = await retryUntil(
					'complete the search and name the listed products',
					async () => {
						const run = await attempt(STORE_TASKS.search, (count += 1))
						last = run.transcript
						return run
					},
					(run) => matchesSearchOracle(run.transcript, STORE_QUERY),
					{ attempts: STORE_BOUNDS.attempts, budget: STORE_BOUNDS.budget },
				)
				expect(matchesSearchOracle(transcript, STORE_QUERY)).toBe(true)
				expectSharedOracles(transcript)
			} catch (error) {
				if (last !== undefined && matchesStalledSearch(last)) {
					throw new Error(
						'the last search attempt stalled: it listed the products and ended empty',
						{
							cause: error,
						},
					)
				}
				throw error
			}
		},
		STORE_BOUNDS.retry,
	)

	it(
		'reports the confirmation code the checkout shows after submit',
		async () => {
			let count = 0
			const { transcript, store } = await retryUntil(
				'complete checkout and report the confirmation code',
				() => attempt(STORE_TASKS.form, (count += 1)),
				(run) =>
					run.store.readOrders().includes(STORE_BUYER) &&
					normalizeAnswer(run.transcript.answer).includes(normalizeAnswer(STORE_CODE)) &&
					matchesStoreOracles(run.transcript),
				{ attempts: STORE_BOUNDS.attempts, budget: STORE_BOUNDS.budget },
			)
			expect(store.readOrders()).toContain(STORE_BUYER)
			expect(normalizeAnswer(transcript.answer)).toContain(normalizeAnswer(STORE_CODE))
			expectSharedOracles(transcript)
		},
		STORE_BOUNDS.retry,
	)

	it(
		'continues a read past its first slice to find the policy token',
		async () => {
			let count = 0
			const { transcript } = await retryUntil(
				'find the policy token past the first read slice',
				() => attempt(STORE_TASKS.paging, (count += 1)),
				(run) => matchesPagingOracle(run.transcript, STORE_POLICY_TOKEN),
				{ attempts: STORE_BOUNDS.attempts, budget: STORE_BOUNDS.budget },
			)
			expect(findContinuedRead(transcript.calls, STORE_POLICY_TOKEN)).toBeDefined()
			expectSharedOracles(transcript)
		},
		STORE_BOUNDS.retry,
	)
})

describe('Browser vocabulary (live) — the journey task', () => {
	beforeEach((context) => {
		context.skip(!READY, OLLAMA_ABSENT_REASON)
	})

	it(
		'records the checkout, lists it, edits it in one batch, and replays it with the input',
		async () => {
			let count = 0
			const { transcript } = await retryUntil(
				'record, list, edit, and replay the checkout journey',
				() => attempt(STORE_TASKS.journey, (count += 1)),
				(run) => matchesJourneyOracle(run.transcript, STORE_JOURNEY_BUYER),
				{ attempts: STORE_BOUNDS.attempts, budget: STORE_JOURNEY_BOUNDS.budget },
			)
			const evidence = requireValue(extractJourneyEvidence(transcript.files))
			const parameter = requireValue(findBoundParameter(evidence.journey))
			const listing = renderBrowserJourney(evidence.journey)
			const run = evidence.runs.find(
				(candidate) => candidate.inputs[parameter] === STORE_JOURNEY_BUYER,
			)
			expect(transcript.failure).toBeUndefined()
			expect(transcript.calls.length).toBeLessThanOrEqual(
				(1 + STORE_TASKS.journey.followups.length) * STORE_BOUNDS.limit,
			)
			expect(matchesJourneySequence(transcript.calls)).toBe(true)
			expect(evidence.journey.parameters[parameter]?.default).toBeDefined()
			expect(filterSubmissionLines(listing)).toHaveLength(1)
			expect(matchesRemovedSubmission(transcript.calls, listing)).toBe(true)
			expect(run?.outcome).toBe('complete')
			expect(run?.revision).toBe(evidence.revision)
			expect(transcript.state.orders.filter((order) => order === STORE_JOURNEY_BUYER)).toEqual([
				STORE_JOURNEY_BUYER,
			])
		},
		STORE_JOURNEY_BOUNDS.retry,
	)
})
