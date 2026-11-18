import { isArray, isRecord, isString } from '@orkestrel/contract'
import { buildOllamaAnswer } from '@src/server'
import { expect, it } from 'vitest'
import { DAEMON_FIXTURE_OPTIONS } from '../setupServer.js'
import { fetchDaemon, OLLAMA_CONFIG } from '../setupService.js'

// A name no daemon in the service axis holds, and no fixture in this proof pins.
const ABSENT = 'orkestrel-absent-model:latest'

it("refuses an unpinned model's show and unload with the real daemon's status and body", async () => {
	const listing: unknown = await (
		await fetchDaemon(
			`${OLLAMA_CONFIG.host}/api/tags`,
			{},
			5000,
			(reason) => `Ollama /api/tags could not be reached at ${OLLAMA_CONFIG.host} (${reason})`,
		)
	).json()
	const held =
		isRecord(listing) && isArray(listing.models)
			? listing.models.flatMap((model) =>
					isRecord(model) && isString(model.name) ? [model.name] : [],
				)
			: []
	expect(held).toContain(OLLAMA_CONFIG.model)
	expect(held).not.toContain(ABSENT)
	expect(DAEMON_FIXTURE_OPTIONS.models.map((model) => model.name)).not.toContain(ABSENT)

	const compared = await Promise.all(
		[
			{ path: '/api/show', body: JSON.stringify({ model: ABSENT }) },
			{ path: '/api/generate', body: JSON.stringify({ model: ABSENT, keep_alive: 0 }) },
		].map(async ({ path, body }) => {
			const live = await fetchDaemon(
				`${OLLAMA_CONFIG.host}${path}`,
				{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
				30_000,
				(reason) => `Ollama ${path} could not be reached at ${OLLAMA_CONFIG.host} (${reason})`,
			)
			const built = buildOllamaAnswer(
				{ method: 'POST', path, headers: {}, body },
				DAEMON_FIXTURE_OPTIONS,
			)
			const observed: unknown = await live.json()
			const answered: unknown = await built.json()
			return {
				path,
				live: { status: live.status, body: observed },
				built: { status: built.status, body: answered },
			}
		}),
	)

	expect(compared.map(({ path, live }) => ({ path, refused: live.status >= 400 }))).toEqual([
		{ path: '/api/show', refused: true },
		{ path: '/api/generate', refused: true },
	])
	expect(compared.map(({ path, built }) => ({ path, answer: built }))).toEqual(
		compared.map(({ path, live }) => ({ path, answer: live })),
	)
})
