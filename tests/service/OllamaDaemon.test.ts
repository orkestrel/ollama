import { parseJSONAs } from '@orkestrel/contract'
import { createOllamaDaemon, isOllamaDaemonOptions } from '@src/server'
import { expect, it } from 'vitest'

// The live window supplies offline executable identity and declared model digests.
// This suite intentionally requires the service project's ordinary readiness setup too.
it('starts the selected real serve executable, verifies its inventory, unloads, and confirms stop', async () => {
	const declaration = parseJSONAs(
		process.env.OLLAMA_DAEMON_DECLARATION ?? '',
		isOllamaDaemonOptions,
	)
	if (declaration === undefined)
		throw new Error(
			'OLLAMA_DAEMON_DECLARATION must contain the complete dedicated daemon declaration with offline executable and model identities',
		)
	const daemon = createOllamaDaemon(declaration)
	try {
		const identity = await daemon.start()
		expect(identity.executable.digest).toBe(declaration.executable.digest)
		expect(identity.executable.version).toBe(declaration.executable.version)
		expect(identity.models).toEqual(declaration.models)
		const maintenance = await daemon.unload()
		expect(maintenance.map((record) => record.model)).toEqual(declaration.models)
		for (const record of maintenance) {
			expect(record.error).toBeUndefined()
			expect(record.response?.complete).toBe(true)
			expect(Buffer.from(record.request.content, 'base64').toString()).toBe(
				JSON.stringify({ model: record.model.name, keep_alive: 0 }),
			)
		}
		expect(await daemon.stop()).toBe(true)
	} finally {
		await daemon.destroy()
	}
})
