import { createOllamaDaemon } from '@src/server'
import { expect, it } from 'vitest'
import { resolveDaemonDeclaration } from '../setupServer.js'
import { OLLAMA_CONFIG } from '../setupService.js'

// The service project provisions the inventory; this proof uses a separate daemon endpoint.
it('starts the selected real serve executable, verifies its inventory, unloads, and confirms stop', async () => {
	const declaration = await resolveDaemonDeclaration({
		host: OLLAMA_CONFIG.host,
		model: OLLAMA_CONFIG.model,
		executable: process.env.OLLAMA_DAEMON_EXECUTABLE,
		declaration: process.env.OLLAMA_DAEMON_DECLARATION,
	})
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
