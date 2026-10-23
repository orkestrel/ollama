import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { createLoopback, createScratch, isRunning } from '@orkestrel/test/server'
import { createRecorder, waitForCondition } from '@orkestrel/test'
import { createSession } from '@orkestrel/process/server'
import { OllamaDaemon } from '@src/server'
import {
	buildDaemonMode,
	createRechunkingTransport,
	DAEMON_ENDINGS,
	DAEMON_LIFECYCLE_BUDGET,
	DAEMON_LIFECYCLE_FAILURES,
	DAEMON_MODEL,
	DAEMON_MODELS,
	DAEMON_REFUSED_PATHS,
	DAEMON_SENDERS,
	DAEMON_UNLOAD_REPLY,
	runWithFetch,
} from '../../setupServer.js'
import { describe, expect, it } from 'vitest'

describe('OllamaDaemon lifecycle', () => {
	it.each(DAEMON_SENDERS)(
		'routes every request through the %s sender and retains re-chunked maintenance bytes',
		async (sender) => {
			const requests = createRecorder<readonly [Request]>()
			const globals = createRecorder<readonly [string]>()
			const original = globalThis.fetch.bind(globalThis)
			const transport = createRechunkingTransport(original, requests.handler)
			const options = {
				...(await buildDaemonMode('normal', {
					models: DAEMON_MODELS,
					environment: { FIXTURE_MODELS: JSON.stringify(DAEMON_MODELS) },
				})),
				...(sender === 'collaborator' ? { fetch: transport } : {}),
			}
			const daemon = new OllamaDaemon(options)
			options.fetch = () => Promise.reject(new Error('caller replaced its fetch'))
			try {
				await runWithFetch(
					(input, init) => {
						globals.handler(new Request(input, init).url)
						if (sender === 'collaborator')
							throw new Error('global fetch reached despite collaborator')
						return transport(input, init)
					},
					async () => {
						const identity = await daemon.start()
						await daemon.unload()
						await daemon.unload()
						const bodies = await Promise.all(
							requests.calls.map(async ([request]) => Buffer.from(await request.arrayBuffer())),
						)
						expect(requests.calls.map(([request]) => [request.method, request.url])).toEqual([
							['GET', `${options.url}/api/version`],
							['GET', `${options.url}/api/tags`],
							['POST', `${options.url}/api/generate`],
							['POST', `${options.url}/api/generate`],
							['POST', `${options.url}/api/generate`],
							['POST', `${options.url}/api/generate`],
						])
						const unload = Buffer.from('{"model":"fixture:雪","keep_alive":0}')
						const cedar = Buffer.from('{"model":"fixture:cedar","keep_alive":0}')
						expect(bodies).toEqual([Buffer.alloc(0), Buffer.alloc(0), unload, cedar, unload, cedar])
						expect(requests.calls.every(([request]) => request.redirect === 'manual')).toBe(true)
						expect(requests.calls.every(([request]) => !request.signal.aborted)).toBe(true)
						expect(requests.calls[2]?.[0].headers.get('content-type')).toBe('application/json')
						expect(daemon.maintenance.map((record) => record.sequence)).toEqual([0, 1, 2, 3])
						for (const record of daemon.maintenance) {
							const expected = record.model.name === DAEMON_MODEL.name ? unload : cedar
							const response = Buffer.from(
								record.model.name === DAEMON_MODEL.name
									? DAEMON_UNLOAD_REPLY
									: '{"model":"fixture:cedar","done":true,"eval_count":0}',
							)
							expect(record.request).toEqual({
								content: expected.toString('base64'),
								size: expected.byteLength,
								digest: createHash('sha256').update(expected).digest('hex'),
								complete: true,
							})
							expect(record.response).toEqual({
								content: response.toString('base64'),
								size: response.byteLength,
								digest: createHash('sha256').update(response).digest('hex'),
								complete: true,
							})
							expect(record.status).toBe(200)
							expect(record.error).toBeUndefined()
							expect(record.timing?.counts.decode).toBe(0)
						}
						expect(globals.calls).toEqual(
							sender === 'collaborator' ? [] : requests.calls.map(([request]) => [request.url]),
						)
						expect(await daemon.stop()).toBe(true)
						expect(isRunning(identity.pid)).toBe(false)
					},
				)
			} finally {
				await daemon.destroy()
			}
		},
		DAEMON_LIFECYCLE_BUDGET,
	)

	it.each(DAEMON_REFUSED_PATHS)(
		'preserves a collaborator rejection at %s and joins the owned child on stop',
		async (path) => {
			const scratch = createScratch()
			const pid = join(scratch.path, 'pid')
			const original = globalThis.fetch.bind(globalThis)
			const refused = new Error('consumer transport refused')
			const requests = createRecorder<readonly [string]>()
			const stopped = createRecorder<readonly [boolean]>()
			const daemon = new OllamaDaemon(
				await buildDaemonMode('normal', {
					environment: { FIXTURE_PID: pid },
					on: { stop: stopped.handler },
					fetch: (input, init) => {
						const request = new Request(input, init)
						requests.handler(new URL(request.url).pathname)
						return new URL(request.url).pathname === path
							? Promise.reject(refused)
							: original(input, init)
					},
				}),
			)
			try {
				const pending =
					path === '/api/generate' ? daemon.start().then(() => daemon.unload()) : daemon.start()
				await expect(pending).rejects.toMatchObject({ code: 'metadata', cause: refused })
				expect(daemon.identity?.models).toEqual(
					path === '/api/generate' ? [DAEMON_MODEL] : undefined,
				)
				expect(isRunning(Number(readFileSync(pid, 'utf8')))).toBe(path === '/api/generate')
				const record = expect.objectContaining({
					request: expect.objectContaining({ complete: true }),
					error: expect.objectContaining({ code: 'metadata', cause: refused }),
				})
				expect(daemon.maintenance).toEqual(path === '/api/generate' ? [record] : [])
				expect(daemon.maintenance[0]?.response).toBeUndefined()
				expect(requests.calls).toEqual(
					DAEMON_REFUSED_PATHS.slice(0, DAEMON_REFUSED_PATHS.indexOf(path) + 1).map((route) => [
						route,
					]),
				)
				expect(stopped.calls).toEqual(path === '/api/generate' ? [] : [[true]])
				expect(await daemon.stop()).toBe(true)
				expect(isRunning(Number(readFileSync(pid, 'utf8')))).toBe(false)
				expect(stopped.calls).toEqual([[true]])
			} finally {
				await daemon.destroy()
				scratch.destroy()
			}
		},
		DAEMON_LIFECYCLE_BUDGET,
	)

	it(
		'shares startup, verifies identity before maintenance, retains receipts, and refuses restart',
		async () => {
			const scratch = createScratch()
			const requests = scratch.write('requests.log', '')
			const options = await buildDaemonMode('delayed', {
				environment: {
					FIXTURE_REQUESTS: requests,
					FIXTURE_UNLOAD: join(scratch.path, 'unload-control'),
				},
			})
			const started = createRecorder<readonly [unknown]>()
			const daemon = new OllamaDaemon({ ...options, on: { start: started.handler } })
			try {
				await expect(daemon.unload()).rejects.toMatchObject({ code: 'state' })
				const first = daemon.start()
				expect(daemon.start()).toBe(first)
				const identity = await first
				expect(daemon.start()).toBe(first)
				expect(started.count).toBe(1)
				expect(identity.models).toEqual([DAEMON_MODEL])
				expect(isRunning(identity.pid)).toBe(true)
				expect(Object.isFrozen(identity)).toBe(true)
				expect(readFileSync(requests, 'utf8')).toContain('/api/tags')
				expect(readFileSync(requests, 'utf8')).not.toContain('/api/generate')
				const unloading = daemon.unload()
				await expect(daemon.unload()).rejects.toMatchObject({ code: 'state' })
				const maintenance = await unloading
				expect(maintenance).toHaveLength(1)
				expect(maintenance[0]?.model).toEqual(DAEMON_MODEL)
				expect(Buffer.from(maintenance[0]?.request.content ?? '', 'base64').toString()).toBe(
					JSON.stringify({ model: DAEMON_MODEL.name, keep_alive: 0 }),
				)
				expect(maintenance[0]?.response?.complete).toBe(true)
				expect(daemon.maintenance).toEqual(maintenance)
				scratch.write('unload-control', 'another-model')
				await expect(daemon.unload()).rejects.toMatchObject({ code: 'unload' })
				expect(daemon.maintenance[1]?.sequence).toBe(1)
				expect(daemon.maintenance[1]?.model).toEqual(DAEMON_MODEL)
				expect(daemon.maintenance[1]?.response?.complete).toBe(true)
				expect(daemon.maintenance[1]?.error).toEqual(expect.objectContaining({ code: 'unload' }))
				const stop = daemon.stop()
				expect(daemon.stop()).toBe(stop)
				expect(await stop).toBe(true)
				expect(isRunning(identity.pid)).toBe(false)
				expect(daemon.identity).toBe(identity)
				await expect(daemon.start()).rejects.toMatchObject({ code: 'state' })
			} finally {
				await daemon.destroy()
				scratch.destroy()
			}
		},
		DAEMON_LIFECYCLE_BUDGET,
	)

	it('refuses a stale executable digest before creating a child', async () => {
		const scratch = createScratch()
		const pid = join(scratch.path, 'pid')
		const options = await buildDaemonMode('normal', { environment: { FIXTURE_PID: pid } })
		const daemon = new OllamaDaemon({
			...options,
			executable: { ...options.executable, digest: '0'.repeat(64) },
		})
		try {
			await expect(daemon.start()).rejects.toMatchObject({ code: 'digest' })
			expect(existsSync(pid)).toBe(false)
			expect(await daemon.stop()).toBe(true)
		} finally {
			await daemon.destroy()
			scratch.destroy()
		}
	})

	it('refuses an occupied dedicated port before creating a child and preserves its occupant', async () => {
		const occupant = await createLoopback(createServer())
		const scratch = createScratch()
		const pid = join(scratch.path, 'pid')
		const daemon = new OllamaDaemon(
			await buildDaemonMode('normal', { url: occupant.url, environment: { FIXTURE_PID: pid } }),
		)
		try {
			await expect(daemon.start()).rejects.toMatchObject({ code: 'occupied' })
			expect(existsSync(pid)).toBe(false)
			expect(await daemon.stop()).toBe(true)
		} finally {
			await daemon.destroy()
			await occupant.destroy()
			scratch.destroy()
		}
	})

	it.each(DAEMON_LIFECYCLE_FAILURES)(
		'refuses %s and joins its owned child before rejection',
		async (mode, code) => {
			const scratch = createScratch()
			const pid = join(scratch.path, 'pid')
			const requests = scratch.write('requests.log', '')
			const daemon = new OllamaDaemon(
				await buildDaemonMode(mode, {
					readiness: 3000,
					environment: { FIXTURE_PID: pid, FIXTURE_REQUESTS: requests },
				}),
			)
			try {
				await expect(daemon.start()).rejects.toMatchObject({
					code: expect.stringMatching(new RegExp(`^(?:${code})$`)),
				})
				expect(await daemon.stop()).toBe(true)
				expect(existsSync(pid)).toBe(true)
				expect(isRunning(Number(readFileSync(pid, 'utf8')))).toBe(false)
				expect(readFileSync(requests, 'utf8')).not.toContain('/api/generate')
			} finally {
				await daemon.destroy()
				scratch.destroy()
			}
		},
		DAEMON_LIFECYCLE_BUDGET,
	)

	it(
		'detects executable bytes replaced through its declared path during use and keeps identity',
		async () => {
			const scratch = createScratch()
			const original = scratch.ensure('original')
			const replacement = scratch.ensure('replacement')
			copyFileSync(process.execPath, join(original, 'node.exe'))
			copyFileSync(process.execPath, join(replacement, 'node.exe'))
			appendFileSync(join(replacement, 'node.exe'), 'changed-image')
			const active = scratch.link('active', original)
			const options = await buildDaemonMode('normal')
			const errors = createRecorder<readonly [unknown]>()
			const daemon = new OllamaDaemon({
				...options,
				executable: { ...options.executable, path: join(active, 'node.exe') },
				on: { error: errors.handler },
			})
			try {
				const identity = await daemon.start()
				scratch.remove('active')
				scratch.link('active', replacement)
				expect(await daemon.stop()).toBe(false)
				expect(errors.calls).toContainEqual([expect.objectContaining({ code: 'digest' })])
				expect(daemon.identity).toBe(identity)
				expect(isRunning(identity.pid)).toBe(false)
			} finally {
				await daemon.destroy()
				scratch.destroy()
			}
		},
		DAEMON_LIFECYCLE_BUDGET,
	)

	it.each(DAEMON_ENDINGS)(
		'ends the owned daemon and runner on %s while an unrelated sentinel survives',
		async (ending) => {
			const scratch = createScratch()
			const runner = join(scratch.path, 'runner')
			const controller = new AbortController()
			const options = await buildDaemonMode('tree', {
				signal: controller.signal,
				environment: { FIXTURE_RUNNER: runner },
			})
			const sentinel = createSession({
				command: {
					file: process.execPath,
					arguments: [
						join(options.workspace, 'tests', 'src', 'server', 'fixtures', 'daemon.mjs'),
						'sentinel',
					],
					environment: { OLLAMA_HOST: new URL(options.url).host },
				},
				workspace: options.workspace,
				grace: 20,
			})
			const daemon = new OllamaDaemon(options)
			try {
				const identity = await daemon.start()
				await waitForCondition('runner PID file', () => existsSync(runner), { budget: 5000 })
				const pid = Number(readFileSync(runner, 'utf8'))
				expect(isRunning(pid)).toBe(true)
				if (ending === 'abort') controller.abort()
				expect(await daemon.stop()).toBe(true)
				expect(isRunning(identity.pid)).toBe(false)
				await waitForCondition('runner exit', () => !isRunning(pid), { budget: 5000 })
				expect(sentinel.pid).toBeDefined()
				expect(sentinel.code).toBeNull()
				expect(sentinel.signal).toBeNull()
			} finally {
				controller.abort()
				await daemon.destroy()
				await sentinel.destroy()
				scratch.destroy()
			}
		},
		DAEMON_LIFECYCLE_BUDGET,
	)
})
