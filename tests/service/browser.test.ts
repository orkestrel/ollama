/**
 * The live browser-vocabulary proof: `qwen3.5:2b-q4_K_M` at temperature 0 drives the store
 * fixture through `createBrowserToolset` and `@orkestrel/agent`, and every assertion reads the
 * run's transcript and the store's own state rather than the model's words alone.
 *
 * The read, click, and search tasks get one attempt each. The form and paging tasks each spend at
 * most `STORE_BOUNDS.attempts` attempts through `retryUntil`, because the model's choice to wait
 * for late text or to continue a `read` is the step they measure. Every attempt writes
 * `tmp/probes/logs/<task>-<attempt>.json`, the failing ones included. A daemon 5xx on a model
 * turn is the daemon's fault rather than the toolset's, so it ends that attempt as a failed one,
 * with its message in the transcript's `failure`, and spends the same attempt budget.
 *
 * The search task is pinned to its known failure. At temperature 0 with 256 predicted tokens,
 * `qwen3.5:2b-q4_K_M` clicks the search box and ends its turn empty after the click receipt names
 * `type`: the transcripts under `tmp/probes/logs/v4/`, `tmp/probes/logs/c5/`, and
 * `tmp/probes/logs/v5/` show that sequence. The first round, `tmp/probes/logs/v1/`, failed
 * differently, with repeated reads and no search-box click. The case asserts the attempt, the
 * shared oracles, and that sequence, and expects only the search oracle to fail, so a completed
 * search reddens the pin and a thrown attempt or a daemon fault fails the case as itself.
 *
 * The paging task's oracle is the reading, not the answer: a `read` continued at the offset an
 * earlier footer named, whose slice contains the token. Paging is what the toolset controls;
 * whether the model then names the token rather than summarising the page is its own choice, so
 * the transcript records that as `mentioned` and the proof does not assert it, as it does not
 * assert the click task's answer.
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
 * cut that narration before the call. `TOOL_LOOP_OPTIONS` carries no timeout, so the agent's
 * deadline is `STORE_BOUNDS.run`.
 */

import type { BrowserInterface } from '@orkestrel/browser/server'
import type { StoreAttempt, StoreTask, StoreTranscript } from '../setupStore.js'
import { BROWSER_TOOL_LIMIT } from '@orkestrel/browser'
import { createBrowser } from '@orkestrel/browser/server'
import { retryUntil } from '@orkestrel/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { reservePort } from '../setupServer.js'
import {
	attemptStoreTask,
	findContinuedRead,
	findUnlistedReferences,
	matchesPagingOracle,
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

/** Runs one attempt of a task in the browser this file launched. */
function attempt(task: StoreTask, number: number): Promise<StoreAttempt> {
	if (browser === undefined) throw new Error('the store proof launched no browser')
	return attemptStoreTask(
		browser,
		task,
		number,
		createLiveOllama({ temperature: 0, predict: STORE_BOUNDS.predict }),
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

describe('Browser vocabulary (live) — the store tasks', () => {
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

	beforeEach((context) => {
		context.skip(!READY, OLLAMA_ABSENT_REASON)
	})

	it(
		'answers the shipping cutoff from a read the seeded view did not carry',
		async () => {
			const { transcript } = await attempt(STORE_TASKS.read, 1)
			const fact = normalizeAnswer(STORE_FACT)
			expect(normalizeAnswer(transcript.seed)).not.toContain(fact)
			const reading = transcript.calls.find(
				(call) =>
					(call.name === 'read' || call.name === 'look') &&
					normalizeAnswer(call.text).includes(fact),
			)
			expect(reading).toBeDefined()
			expect(normalizeAnswer(transcript.answer)).toContain(fact)
			expectSharedOracles(transcript)
		},
		STORE_BOUNDS.single,
	)

	it(
		'adds the named product to the cart and no other',
		async () => {
			const { transcript, store } = await attempt(STORE_TASKS.click, 1)
			expect(store.readCart()).toEqual([STORE_NAMED])
			expectSharedOracles(transcript)
		},
		STORE_BOUNDS.single,
	)

	it(
		'ends its turn empty after the click receipt names type, short of submitting the query',
		async () => {
			const { transcript } = await attempt(STORE_TASKS.search, 1)
			expectSharedOracles(transcript)
			expect(
				matchesSearchOracle(transcript, STORE_QUERY),
				'the model completed the search, so the pin no longer holds',
			).toBe(false)
			expect(matchesStalledSearch(transcript), 'the search failed another way').toBe(true)
		},
		STORE_BOUNDS.single,
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
