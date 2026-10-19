import type { BrowserInterface } from '@orkestrel/browser/server'
import { requireValue, retryUntil } from '@orkestrel/test'
import { beforeAll, describe, expect, it } from 'vitest'
import {
	attemptStoreTask,
	createPageBrowser,
	STORE_BOUNDS,
	STORE_JOURNEY_BOUNDS,
	STORE_PREDICATES,
	STORE_TASKS,
} from '../setupStore.js'
import { createLiveOllama, isOllamaReady } from '../setupService.js'

const connection = Promise.withResolvers<BrowserInterface>()

// The browser is released by the teardown `beforeAll` returns, which Vitest runs after the
// last case whether or not a case failed. A connection that fails is released before it is
// rethrown, because a failed `beforeAll` returns no teardown.
beforeAll(async () => {
	if (!(await isOllamaReady()))
		throw new Error('The store proof requires the configured Ollama daemon and model')
	const created = await createPageBrowser()
	try {
		await created.connect()
	} catch (failure) {
		await created.destroy()
		throw failure
	}
	connection.resolve(created)
	return () => created.destroy()
})

describe('Browser vocabulary (live)', () => {
	describe.each(Object.values(STORE_TASKS))('$name', (task) => {
		it(
			'satisfies its complete predicate',
			async () => {
				const predicate = requireValue(STORE_PREDICATES[task.name])
				const browser = await connection.promise
				const attempts = Array.from(
					{ length: STORE_BOUNDS.attempts },
					(_, index) => index + 1,
				).values()
				const result = await retryUntil(
					task.prompt,
					() =>
						attemptStoreTask(
							browser,
							task,
							requireValue(attempts.next().value),
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
