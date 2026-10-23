import { createOllamaDaemon, OllamaDaemon } from '@src/server'
import { buildDaemonOptions, DAEMON_DECLARATION } from '../../setupServer.js'
import { createScratch } from '@orkestrel/test/server'
import { expect, it } from 'vitest'

it('constructs an unstarted dedicated daemon and releases it without spawning', async () => {
	const options = await buildDaemonOptions()
	const daemon = createOllamaDaemon(options)
	try {
		expect(daemon).toBeInstanceOf(OllamaDaemon)
		expect(daemon.url).toBe(options.url)
		expect(daemon.identity).toBeUndefined()
		await expect(daemon.unload()).rejects.toMatchObject({ code: 'state' })
		expect(await daemon.stop()).toBe(true)
		await expect(daemon.start()).rejects.toMatchObject({ code: 'state' })
	} finally {
		await daemon.destroy()
	}
	expect(daemon.emitter.destroyed).toBe(true)
})

it('refuses a pre-aborted declaration without creating a session', async () => {
	const controller = new AbortController()
	controller.abort()
	const daemon = createOllamaDaemon(await buildDaemonOptions({ signal: controller.signal }))
	try {
		await expect(daemon.start()).rejects.toMatchObject({ code: 'aborted' })
		expect(daemon.identity).toBeUndefined()
		expect(await daemon.stop()).toBe(true)
	} finally {
		await daemon.destroy()
	}
})

it('refuses an existing file used as a workspace before creating a session', async () => {
	const scratch = createScratch()
	const daemon = createOllamaDaemon({
		...DAEMON_DECLARATION,
		workspace: scratch.write('workspace', 'not a directory'),
	})
	try {
		await expect(daemon.start()).rejects.toMatchObject({ code: 'invalid' })
		expect(daemon.identity).toBeUndefined()
		expect(await daemon.stop()).toBe(true)
	} finally {
		await daemon.destroy()
		scratch.destroy()
	}
})
