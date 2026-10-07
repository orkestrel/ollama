import type { BrowserInterface } from '@orkestrel/browser/server'
import { requireValue, retryUntil } from '@orkestrel/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	attemptStoreTask,
	createPageBrowser,
	STORE_BOUNDS,
	STORE_JOURNEY_BOUNDS,
	STORE_PREDICATES,
	STORE_TASKS,
} from '../setupStore.js'
import { createLiveOllama, isOllamaReady } from '../setupService.js'

let browser: BrowserInterface | undefined

beforeAll(async () => {
	if (!(await isOllamaReady()))
		throw new Error('The store proof requires the configured Ollama daemon and model')
	browser = await createPageBrowser()
	await browser.connect()
})
afterAll(async () => {
	await browser?.destroy()
})

describe('Browser vocabulary (live)', () => {
	describe.each(Object.values(STORE_TASKS))('$name', (task) => {
		it(
			'satisfies its complete predicate',
			async () => {
				const predicate = requireValue(STORE_PREDICATES[task.name])
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
								think: STORE_BOUNDS.think,
							}),
						),
					(run) => predicate(run.transcript),
					{
						attempts: STORE_BOUNDS.attempts,
						budget: task.name === 'journey' ? STORE_JOURNEY_BOUNDS.budget : STORE_BOUNDS.budget,
					},
				)
				expect(predicate(result.transcript)).toBe(true)
			},
			task.name === 'journey' ? STORE_JOURNEY_BOUNDS.retry : STORE_BOUNDS.retry,
		)
	})
})
