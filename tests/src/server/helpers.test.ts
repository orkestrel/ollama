import { createHash } from 'node:crypto'
import { createRecorder } from '@orkestrel/test'
import {
	buildOllamaEnvironment,
	matchesOllamaAnnouncement,
	readOllamaReply,
	readOllamaBody,
	readOllamaJSON,
	readOllamaTerminal,
	retainOllamaBytes,
	verifyOllamaModels,
	verifyOllamaVersion,
} from '@src/server'
import {
	createDaemonPeer,
	DAEMON_MODEL,
	DAEMON_VERSION,
	METADATA_FAULTS,
} from '../../setupServer.js'
import { describe, expect, it } from 'vitest'

describe('daemon protocol helpers', () => {
	it('refuses an absent announcement even when the candidate origin is malformed', () => {
		expect(matchesOllamaAnnouncement('no listener announcement', 'not-an-origin')).toBe(false)
	})
	it('folds inherited and caller environment names before applying the dedicated values', () => {
		const parent = {
			Ollama_Host: 'parent',
			OLLAMA_MODELS: 'parent-store',
			REMAINS: 'kept',
			REMOVE: 'removed',
		}
		const caller = { ollama_HOST: 'caller', ollama_models: 'caller-store', REMOVE: undefined }
		const environment = buildOllamaEnvironment(parent, caller, 'http://127.0.0.1:31111', '/models')
		expect(environment).toEqual({
			REMAINS: 'kept',
			OLLAMA_HOST: '127.0.0.1:31111',
			OLLAMA_MODELS: '/models',
		})
		expect(buildOllamaEnvironment(parent, caller, 'http://127.0.0.1:31111')).toEqual({
			REMAINS: 'kept',
			ollama_models: 'caller-store',
			OLLAMA_HOST: '127.0.0.1:31111',
		})
		expect(parent.Ollama_Host).toBe('parent')
		expect(caller.ollama_HOST).toBe('caller')
	})

	it('requires an exact loopback port in the owned listen announcement with surrounding fields', () => {
		expect(
			matchesOllamaAnnouncement(
				'time=now level=INFO msg="Listening on 127.0.0.1:31111 (version 0.40.8)"',
				'http://127.0.0.1:31111',
			),
		).toBe(true)
		expect(
			matchesOllamaAnnouncement(
				'Listening on 127.0.0.1:311110 (version 0.40.8)',
				'http://127.0.0.1:31111',
			),
		).toBe(false)
		expect(
			matchesOllamaAnnouncement(
				'Listening on 0.0.0.0:31111 (version 0.40.8)',
				'http://127.0.0.1:31111',
			),
		).toBe(false)
		expect(
			matchesOllamaAnnouncement('a reply without a listen line', 'http://127.0.0.1:31111'),
		).toBe(false)
	})

	it('retains exact Unicode CRLF bytes with an independent digest and immutable receipt', () => {
		const bytes = Buffer.from('雪\r\n🌲\n')
		const retained = retainOllamaBytes(bytes, false)
		expect(Buffer.from(retained.content, 'base64')).toEqual(bytes)
		expect(retained.size).toBe(bytes.byteLength)
		expect(retained.digest).toBe(createHash('sha256').update(bytes).digest('hex'))
		expect(retained.complete).toBe(false)
		expect(Object.isFrozen(retained)).toBe(true)
	})

	it('accepts only the declared version and every exact model digest', () => {
		expect(() => verifyOllamaVersion({ version: DAEMON_VERSION }, DAEMON_VERSION)).not.toThrow()
		expect(() => verifyOllamaVersion({ version: 'other' }, DAEMON_VERSION)).toThrow(
			expect.objectContaining({ code: 'version' }),
		)
		expect(() => verifyOllamaVersion({}, DAEMON_VERSION)).toThrow(
			expect.objectContaining({ code: 'metadata' }),
		)
		expect(() => verifyOllamaModels({ models: [DAEMON_MODEL] }, [DAEMON_MODEL])).not.toThrow()
		expect(() =>
			verifyOllamaModels({ models: [{ ...DAEMON_MODEL, digest: 'other' }] }, [DAEMON_MODEL]),
		).toThrow(expect.objectContaining({ code: 'model' }))
		expect(() => verifyOllamaModels({ models: [] }, [DAEMON_MODEL])).toThrow(
			expect.objectContaining({ code: 'model' }),
		)
		expect(() => verifyOllamaModels({ models: [{ name: 7 }] }, [DAEMON_MODEL])).toThrow(
			expect.objectContaining({ code: 'metadata' }),
		)
	})

	it('accepts a version reply delayed past 1500 ms within the declared bound', async () => {
		const peer = await createDaemonPeer({ delay: 1550 })
		try {
			const reply = await readOllamaReply(peer.url, '/api/version', { timeout: 5000 })
			expect(reply.error).toBeUndefined()
			expect(reply.status).toBe(200)
			expect(reply.response?.complete).toBe(true)
			expect(peer.requests.map((request) => request.path)).toEqual(['/api/version'])
		} finally {
			await peer.destroy()
		}
	}, 10_000)

	it.each(METADATA_FAULTS)(
		'refuses the metadata %s fault without issuing a model request',
		async (fault) => {
			const peer = await createDaemonPeer({ fault })
			try {
				const reply = await readOllamaReply(peer.url, '/api/version', { timeout: 150, bytes: 256 })
				expect(reply.error).toEqual(expect.objectContaining({ code: 'metadata' }))
				expect(peer.requests.map((request) => request.path)).toEqual(['/api/version'])
				expect(fault !== 'oversized' || reply.response?.size === 256).toBe(true)
				expect(fault !== 'oversized' || reply.response?.complete === false).toBe(true)
			} finally {
				await peer.destroy()
			}
		},
	)

	it('sends only the declared unload body and retains both bodies before validating its model', async () => {
		const peer = await createDaemonPeer({ unload: 'another-model' })
		try {
			const request = retainOllamaBytes(
				Buffer.from(JSON.stringify({ model: DAEMON_MODEL.name, keep_alive: 0 })),
				true,
			)
			const reply = await readOllamaReply(peer.url, '/api/generate', {}, undefined, request)
			expect(peer.requests).toEqual([
				{ path: '/api/generate', body: Buffer.from(request.content, 'base64').toString() },
			])
			expect(reply.response).toBeDefined()
			const response = reply.response
			if (response === undefined) throw new Error('Missing retained response')
			expect(() => readOllamaTerminal(response, DAEMON_MODEL)).toThrow(
				expect.objectContaining({ code: 'unload' }),
			)
			expect(response.digest).toBe(
				createHash('sha256').update(Buffer.from(response.content, 'base64')).digest('hex'),
			)
		} finally {
			await peer.destroy()
		}
	})

	it('validates a complete terminal model reply before exposing its timing', () => {
		const bytes = retainOllamaBytes(
			Buffer.from(`${JSON.stringify({ model: DAEMON_MODEL.name, done: true, eval_count: 0 })}\r\n`),
			true,
		)
		expect(readOllamaTerminal(bytes, DAEMON_MODEL)?.counts.decode).toBe(0)
		expect(() => readOllamaTerminal({ ...bytes, complete: false }, DAEMON_MODEL)).toThrow(
			'Unload reply',
		)
		expect(() =>
			readOllamaTerminal(retainOllamaBytes(Buffer.from('{"done":false}'), true), DAEMON_MODEL),
		).toThrow('Unload reply')
	})

	it('accepts complete metadata JSON and refuses missing, malformed, or incomplete records', () => {
		expect(
			readOllamaJSON(retainOllamaBytes(Buffer.from(' {"version":"0.40.8"}\r\n'), true)),
		).toEqual({ version: '0.40.8' })
		expect(() => readOllamaJSON(retainOllamaBytes(Buffer.from('[]'), true))).toThrow(
			'Incomplete or malformed',
		)
		expect(() => readOllamaJSON(retainOllamaBytes(Buffer.from('{'), true))).toThrow(
			'Incomplete or malformed',
		)
		expect(() => readOllamaJSON(retainOllamaBytes(Buffer.from('{}'), false))).toThrow(
			'Incomplete or malformed',
		)
	})

	it('retains the response observation when cancellation interrupts an open body', async () => {
		const peer = await createDaemonPeer({ fault: 'partial' })
		const controller = new AbortController()
		const received = createRecorder<readonly []>()
		try {
			peer.emitter.once('request', received.handler)
			const response = await fetch(`${peer.url}/api/version`, { signal: controller.signal })
			const pending = readOllamaBody(response, 256)
			controller.abort(new Error('cancelled'))
			const reply = await pending
			expect(reply.error).toBeDefined()
			expect(reply.response?.complete).toBe(false)
			expect(received.count).toBe(1)
		} finally {
			controller.abort()
			await peer.destroy()
		}
	})
})
