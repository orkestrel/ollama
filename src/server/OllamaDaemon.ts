import type {
	OllamaDaemonEventMap,
	OllamaDaemonIdentity,
	OllamaDaemonInterface,
	OllamaDaemonOptions,
	OllamaMaintenance,
} from './types.js'
import type { SessionInterface } from '@orkestrel/process'
import type { EmitterInterface } from '@orkestrel/emitter'
import { Emitter } from '@orkestrel/emitter'
import { createSession } from '@orkestrel/process/server'
import { addAbortListener, once } from 'node:events'
import { createServer } from 'node:net'
import { access, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { extname } from 'node:path'
import { createHash } from 'node:crypto'
import { OLLAMA_READINESS } from './constants.js'
import { isOllamaDaemonOptions } from './validators.js'
import { isOllamaError, OllamaError } from './errors.js'
import {
	buildOllamaEnvironment,
	matchesOllamaAnnouncement,
	readOllamaJSON,
	readOllamaReply,
	readOllamaTerminal,
	retainOllamaBytes,
	verifyOllamaModels,
	verifyOllamaVersion,
} from './helpers.js'

/**
 * Owns a dedicated daemon through verified startup, declared maintenance, and permanent cleanup.
 * @example
 * ```ts
 * const daemon = new OllamaDaemon(declaration)
 * try {
 * 	await daemon.start()
 * 	await daemon.unload()
 * } finally {
 * 	await daemon.destroy()
 * }
 * ```
 */
export class OllamaDaemon implements OllamaDaemonInterface {
	readonly #options: OllamaDaemonOptions
	readonly #emitter: Emitter<OllamaDaemonEventMap>
	readonly #lifetime = new AbortController()
	readonly #announcement = Promise.withResolvers<void>()
	readonly #unloads = new Set<Promise<readonly OllamaMaintenance[]>>()
	readonly #maintenance: OllamaMaintenance[] = []
	#listener: ReturnType<typeof addAbortListener> | undefined
	#launching: Promise<SessionInterface> | undefined
	#starting: Promise<OllamaDaemonIdentity> | undefined
	#stopping: Promise<boolean> | undefined
	#destruction: Promise<void> | undefined
	#identity: OllamaDaemonIdentity | undefined
	#stderr = ''

	/**
	 * Captures a declaration before any filesystem, socket, or process operation.
	 * @param options - The complete executable, endpoint, model, and lifecycle declaration
	 * @throws OllamaError Thrown when the declaration is malformed.
	 */
	constructor(options: OllamaDaemonOptions) {
		if (!isOllamaDaemonOptions(options))
			throw new OllamaError('Invalid dedicated daemon declaration', { code: 'invalid' })
		this.#options = Object.freeze({
			...options,
			url: options.url.replace(/\/$/, ''),
			executable: Object.freeze({
				...options.executable,
				arguments: Object.freeze([...(options.executable.arguments ?? ['serve'])]),
			}),
			models: Object.freeze(options.models.map((model) => Object.freeze({ ...model }))),
			...(options.environment === undefined
				? {}
				: { environment: Object.freeze({ ...options.environment }) }),
			...(options.metadata === undefined
				? {}
				: { metadata: Object.freeze({ ...options.metadata }) }),
			...(options.termination === undefined
				? {}
				: { termination: Object.freeze({ ...options.termination }) }),
		})
		this.#emitter = new Emitter({
			...(options.on === undefined ? {} : { on: options.on }),
			...(options.error === undefined ? {} : { error: options.error }),
		})
		if (options.signal !== undefined)
			this.#listener = addAbortListener(options.signal, () => {
				void this.stop()
			})
	}

	/** Holds the dedicated origin declared before startup. */
	get url(): string {
		return this.#options.url
	}
	/** Holds the immutable verified receipt after startup, including after stop. */
	get identity(): OllamaDaemonIdentity | undefined {
		return this.#identity
	}
	/** Holds every immutable maintenance receipt in attempt order. */
	get maintenance(): readonly OllamaMaintenance[] {
		return Object.freeze([...this.#maintenance])
	}
	/** Holds the typed lifecycle observation surface. */
	get emitter(): EmitterInterface<OllamaDaemonEventMap> {
		return this.#emitter
	}

	/** Starts once and shares the verified startup result among callers. */
	start(): Promise<OllamaDaemonIdentity> {
		if (this.#options.signal?.aborted)
			return Promise.reject(
				new OllamaError('Daemon signal is aborted', {
					code: 'aborted',
					cause: this.#options.signal.reason,
				}),
			)
		if (this.#stopping !== undefined || this.#destruction !== undefined)
			return Promise.reject(new OllamaError('A stopped daemon cannot restart', { code: 'state' }))
		if (this.#starting === undefined) {
			this.#launching = this.#launch()
			this.#starting = this.#verify()
		}
		return this.#starting
	}

	/** Unloads declared models sequentially and retains every settled attempt. */
	unload(): Promise<readonly OllamaMaintenance[]> {
		if (this.#identity === undefined || this.#stopping !== undefined || this.#unloads.size > 0)
			return Promise.reject(
				new OllamaError('Maintenance requires a verified idle daemon', { code: 'state' }),
			)
		const operation = this.#maintain()
		this.#unloads.add(operation)
		void operation.then(
			() => this.#unloads.delete(operation),
			() => this.#unloads.delete(operation),
		)
		return operation
	}

	/** Stops pending work and shares one permanent tree-stop and digest barrier. */
	stop(): Promise<boolean> {
		this.#stopping ??= Promise.resolve().then(() => this.#finish())
		return this.#stopping
	}

	/** Releases the observation emitter after the shared cleanup barrier settles. */
	destroy(): Promise<void> {
		this.#destruction ??= this.stop().then(() => {
			this.#emitter.destroy()
		})
		return this.#destruction
	}

	async #launch(): Promise<SessionInterface> {
		try {
			await this.#requireDirectory(this.#options.workspace)
			if (this.#options.store !== undefined) await this.#requireDirectory(this.#options.store)
			const executable = this.#options.executable.path
			if (!(await stat(executable)).isFile())
				throw new OllamaError('Executable is not a regular file', { code: 'invalid' })
			if (process.platform === 'win32') {
				if (!['.exe', '.com'].includes(extname(executable).toLowerCase()))
					throw new OllamaError('Executable must name a native Windows executable', {
						code: 'invalid',
					})
			} else {
				await access(executable, constants.X_OK)
			}
			if ((await this.#readDigest()) !== this.#options.executable.digest)
				throw new OllamaError('Executable digest differs before spawn', {
					code: 'digest',
					context: { path: executable },
				})
			await this.#reserve()
			this.#lifetime.signal.throwIfAborted()
			if (this.#stopping !== undefined || this.#options.signal?.aborted)
				throw new OllamaError('Daemon stopped before spawn', { code: 'aborted' })
			return createSession({
				command: {
					file: executable,
					arguments: this.#options.executable.arguments ?? ['serve'],
					isolated: true,
					environment: buildOllamaEnvironment(
						process.env,
						this.#options.environment,
						this.url,
						this.#options.store,
					),
				},
				workspace: this.#options.workspace,
				...this.#options.termination,
				on: { stderr: (text) => this.#announce(text) },
			})
		} catch (cause) {
			if (isOllamaError(cause)) throw cause
			throw new OllamaError('Daemon preflight or spawn refused', { code: 'spawn', cause })
		}
	}

	async #requireDirectory(path: string): Promise<void> {
		try {
			if (!(await stat(path)).isDirectory()) throw new Error('Not a directory')
		} catch (cause) {
			throw new OllamaError('Workspace or model store is not an existing directory', {
				code: 'invalid',
				context: { path },
				cause,
			})
		}
	}

	async #readDigest(): Promise<string> {
		try {
			const bytes = await readFile(this.#options.executable.path)
			if (bytes.subarray(0, 2).toString() === '#!')
				throw new OllamaError('Shell script executables are refused', { code: 'invalid' })
			return createHash('sha256').update(bytes).digest('hex')
		} catch (cause) {
			if (isOllamaError(cause)) throw cause
			throw new OllamaError('Executable identity is unreadable', {
				code: 'digest',
				context: { path: this.#options.executable.path },
				cause,
			})
		}
	}

	async #reserve(): Promise<void> {
		const server = createServer()
		const listening = once(server, 'listening')
		try {
			server.listen(Number(this.url.match(/:([0-9]+)$/)?.[1]), '127.0.0.1')
			await listening
		} catch (cause) {
			throw new OllamaError('Dedicated endpoint is occupied or cannot bind', {
				code: 'occupied',
				context: { url: this.url },
				cause,
			})
		} finally {
			if (server.listening)
				await new Promise<void>((resolve, reject) =>
					server.close((error) => (error === undefined ? resolve() : reject(error))),
				)
		}
	}

	#announce(text: string): void {
		const lines = `${this.#stderr}${text}`.split(/\r\n|\n/)
		this.#stderr = (lines.at(-1) ?? '').slice(-4096)
		for (const line of lines.slice(0, -1)) {
			if (matchesOllamaAnnouncement(line, this.url)) this.#announcement.resolve()
		}
	}

	async #wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
		signal.throwIfAborted()
		const aborted = Promise.withResolvers<never>()
		const listener = addAbortListener(signal, () => aborted.reject(signal.reason))
		try {
			return await Promise.race([promise, aborted.promise])
		} finally {
			listener[Symbol.dispose]()
		}
	}

	#requireLive(session: SessionInterface): void {
		this.#lifetime.signal.throwIfAborted()
		if (
			session.pid === undefined ||
			session.code !== null ||
			session.signal !== null ||
			session.terminated ||
			session.settled
		)
			throw new OllamaError('Owned daemon is not live', {
				code: 'owner',
				context: { evidence: session.evidence },
			})
	}

	async #verify(): Promise<OllamaDaemonIdentity> {
		const deadline = new AbortController()
		const timer = setTimeout(
			() =>
				deadline.abort(new OllamaError('Daemon readiness deadline elapsed', { code: 'readiness' })),
			this.#options.readiness ?? OLLAMA_READINESS,
		)
		const signal = AbortSignal.any([deadline.signal, this.#lifetime.signal])
		try {
			if (this.#launching === undefined)
				throw new OllamaError('Daemon launch is absent', { code: 'state' })
			const session = await this.#wait(this.#launching, signal)
			if (session.pid === undefined)
				throw new OllamaError('Daemon spawn produced no child', {
					code: 'spawn',
					context: { evidence: session.evidence },
				})
			void session.ended.then(() =>
				this.#lifetime.abort(
					new OllamaError('Owned daemon exited', {
						code: 'owner',
						context: { evidence: session.evidence },
					}),
				),
			)
			this.#requireLive(session)
			await this.#wait(this.#announcement.promise, signal)
			this.#requireLive(session)
			const version = await readOllamaReply(
				this.url,
				'/api/version',
				this.#options.metadata,
				signal,
				undefined,
				this.#options.fetch,
			)
			signal.throwIfAborted()
			this.#requireLive(session)
			if (version.error !== undefined) throw version.error
			if (version.response === undefined)
				throw new OllamaError('Version body is absent', { code: 'metadata' })
			verifyOllamaVersion(readOllamaJSON(version.response), this.#options.executable.version)
			const inventory = await readOllamaReply(
				this.url,
				'/api/tags',
				this.#options.metadata,
				signal,
				undefined,
				this.#options.fetch,
			)
			signal.throwIfAborted()
			this.#requireLive(session)
			if (inventory.error !== undefined) throw inventory.error
			if (inventory.response === undefined)
				throw new OllamaError('Model inventory is absent', { code: 'metadata' })
			verifyOllamaModels(readOllamaJSON(inventory.response), this.#options.models)
			if (session.pid === undefined)
				throw new OllamaError('Owned daemon PID is absent', { code: 'owner' })
			this.#identity = Object.freeze({
				executable: this.#options.executable,
				url: this.url,
				models: this.#options.models,
				pid: session.pid,
			})
			this.#emitter.emit('start', this.#identity)
			return this.#identity
		} catch (cause) {
			const error = isOllamaError(cause)
				? cause
				: new OllamaError('Daemon startup refused', { code: 'readiness', cause })
			this.#emitter.emit('error', error)
			if (!(await this.stop()))
				throw new OllamaError('Daemon startup refused and cleanup was not confirmed', {
					code: 'cleanup',
					cause: error,
				})
			throw error
		} finally {
			clearTimeout(timer)
		}
	}

	async #maintain(): Promise<readonly OllamaMaintenance[]> {
		const records: OllamaMaintenance[] = []
		for (const model of this.#options.models) {
			if (this.#launching === undefined)
				throw new OllamaError('Daemon session is absent', { code: 'state' })
			const session = await this.#launching
			this.#requireLive(session)
			const request = retainOllamaBytes(
				Buffer.from(JSON.stringify({ model: model.name, keep_alive: 0 })),
				true,
			)
			const reply = await readOllamaReply(
				this.url,
				'/api/generate',
				this.#options.metadata,
				this.#lifetime.signal,
				request,
				this.#options.fetch,
			)
			try {
				if (reply.error !== undefined) throw reply.error
				this.#requireLive(session)
				if (reply.response === undefined)
					throw new OllamaError('Unload body is absent', { code: 'unload' })
				const timing = readOllamaTerminal(reply.response, model)
				const record = Object.freeze({
					sequence: this.#maintenance.length,
					model,
					url: new URL('/api/generate', this.url).href,
					request,
					...reply,
					...(timing === undefined ? {} : { timing }),
				})
				this.#maintenance.push(record)
				records.push(record)
				this.#emitter.emit('unload', record)
			} catch (error) {
				const record = Object.freeze({
					sequence: this.#maintenance.length,
					model,
					url: new URL('/api/generate', this.url).href,
					request,
					...reply,
					error,
				})
				this.#maintenance.push(record)
				this.#emitter.emit('unload', record)
				this.#emitter.emit('error', error)
				throw error
			}
		}
		return Object.freeze(records)
	}

	async #finish(): Promise<boolean> {
		this.#lifetime.abort(new OllamaError('Daemon was stopped', { code: 'aborted' }))
		this.#listener?.[Symbol.dispose]()
		try {
			const session = await this.#launching?.catch(() => undefined)
			const confirmed = session === undefined || (await session.stop())
			await Promise.allSettled([...this.#unloads])
			await session?.exit
			await session?.destroy()
			if (!confirmed)
				throw new OllamaError('Owned daemon termination was not confirmed', { code: 'cleanup' })
			if (session?.pid !== undefined) {
				const digest = await this.#readDigest()
				if (digest !== this.#options.executable.digest)
					throw new OllamaError('Executable digest changed during use', {
						code: 'digest',
						context: {
							path: this.#options.executable.path,
							expected: this.#options.executable.digest,
							received: digest,
						},
					})
			}
			this.#emitter.emit('stop', true)
			return true
		} catch (cause) {
			this.#emitter.emit(
				'error',
				isOllamaError(cause)
					? cause
					: new OllamaError('Daemon cleanup or re-hash failed', { code: 'cleanup', cause }),
			)
			this.#emitter.emit('stop', false)
			return false
		}
	}
}
