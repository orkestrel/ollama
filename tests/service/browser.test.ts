import type { BrowserInterface } from '@orkestrel/browser/server'
import { createBrowser } from '@orkestrel/browser/server'
import { requireValue, retryUntil } from '@orkestrel/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { reservePort } from '../setupServer.js'
import {
	attemptStoreTask,
	STORE_BOUNDS,
	STORE_JOURNEY_BOUNDS,
	STORE_PREDICATES,
	STORE_TASKS,
} from '../setupStore.js'
import {
	createLiveOllama,
	isOllamaReady,
	PAGE_BROWSER_ARGS,
	requirePageBrowser,
} from '../setupService.js'

let browser: BrowserInterface | undefined

beforeAll(async () => {
	if (!(await isOllamaReady()))
		throw new Error('The store proof requires the configured Ollama daemon and model')
	browser = createBrowser({
		executable: requirePageBrowser().executable,
		headless: true,
		args: PAGE_BROWSER_ARGS,
		cdp: { port: await reservePort(), discover: false },
	})
	await browser.connect()
})
afterAll(async () => {
	await browser?.destroy()
})

describe('Browser vocabulary (live)', () => {
	describe.each(Object.values(STORE_TASKS))('$task', (task) => {
		it(
			'satisfies its complete predicate',
			async () => {
				const predicate = requireValue(STORE_PREDICATES[task.task])
				let attempt = 0
				const result = await retryUntil(
					task.prompt,
					() =>
						attemptStoreTask(
							requireValue(browser),
							task,
							++attempt,
							createLiveOllama({
								temperature: 0,
								context: STORE_BOUNDS.context,
								turn: STORE_BOUNDS.turn,
								predict: STORE_BOUNDS.predict,
							}),
						),
					(run) => predicate(run.transcript),
					{
						attempts: STORE_BOUNDS.attempts,
						budget: task.task === 'journey' ? STORE_JOURNEY_BOUNDS.budget : STORE_BOUNDS.budget,
					},
				)
				expect(predicate(result.transcript)).toBe(true)
			},
			task.task === 'journey' ? STORE_JOURNEY_BOUNDS.retry : STORE_BOUNDS.retry,
		)
	})
})
