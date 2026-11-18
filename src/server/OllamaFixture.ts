import type {
	OllamaFixtureEventMap,
	OllamaFixtureInterface,
	OllamaFixtureOptions,
	OllamaFixtureRequest,
} from './types.js'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { isError, preview } from '@orkestrel/contract'
import { Emitter } from '@orkestrel/emitter'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { text } from 'node:stream/consumers'
import { OllamaError } from './errors.js'
import { buildOllamaAnswer } from './helpers.js'
import { isOllamaFixtureOptions } from './validators.js'

export class OllamaFixture implements OllamaFixtureInterface {
	readonly #options: OllamaFixtureOptions
	readonly #emitter: Emitter<OllamaFixtureEventMap>
	readonly #server: Server
	readonly #lifetime = new AbortController()
	readonly #requests: OllamaFixtureRequest[] = []
	#starting: Promise<void> | undefined
	#destruction: Promise<void> | undefined
	#url: string | undefined

	constructor(options: OllamaFixtureOptions) {
		if (!isOllamaFixtureOptions(options))
			throw new OllamaError(
				'Invalid fixture options: they need models with unique nonempty names and nonempty digests, a nonempty version, a positive integer context, a function for reply, on, and error where given, and no other key',
				{ code: 'invalid' },
			)
		this.#options = Object.freeze({
			...options,
			models: Object.freeze(options.models.map((model) => Object.freeze({ ...model }))),
		})
		this.#emitter = new Emitter({
			...(options.on === undefined ? {} : { on: options.on }),
			...(options.error === undefined ? {} : { error: options.error }),
		})
		this.#server = createServer((request, response) => {
			void this.#serve(request, response)
		})
	}

	get url(): string {
		if (this.#url === undefined)
			throw new OllamaError('The fixture is not listening; await start first', { code: 'state' })
		return this.#url
	}

	get requests(): readonly OllamaFixtureRequest[] {
		return Object.freeze([...this.#requests])
	}

	get emitter(): EmitterInterface<OllamaFixtureEventMap> {
		return this.#emitter
	}

	start(): Promise<void> {
		if (this.#destruction !== undefined)
			return Promise.reject(new OllamaError('A destroyed fixture cannot start', { code: 'state' }))
		this.#starting ??= this.#listen()
		return this.#starting
	}

	destroy(): Promise<void> {
		this.#destruction ??= this.#teardown()
		return this.#destruction
	}

	async #listen(): Promise<void> {
		const listening = once(this.#server, 'listening')
		this.#server.listen(0, '127.0.0.1')
		await listening
		const address = this.#server.address()
		if (address === null || typeof address === 'string')
			throw new OllamaError('The fixture listener reports no port', { code: 'state' })
		this.#url = `http://${address.address}:${address.port}`
	}

	async #teardown(): Promise<void> {
		this.#lifetime.abort(new OllamaError('The fixture was destroyed', { code: 'state' }))
		try {
			await this.#starting?.catch(() => undefined)
			if (this.#server.listening) {
				const closed = new Promise<void>((resolve) => {
					this.#server.close(() => resolve())
				})
				this.#server.closeAllConnections()
				await closed
			}
		} finally {
			this.#emitter.destroy()
		}
	}

	async #serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const exchange = new AbortController()
		response.once('close', () => {
			if (!response.writableFinished)
				exchange.abort(new OllamaError('The client disconnected', { code: 'aborted' }))
		})
		const signal = AbortSignal.any([exchange.signal, this.#lifetime.signal])
		try {
			const body = await text(request).catch(() => undefined)
			if (body === undefined || this.#lifetime.signal.aborted) {
				response.destroy()
				return
			}
			const record: OllamaFixtureRequest = Object.freeze({
				method: request.method ?? 'GET',
				path: request.url ?? '/',
				headers: Object.freeze(
					Object.fromEntries(
						Object.entries(request.headersDistinct).flatMap(([name, values]) =>
							values === undefined ? [] : [[name, values.join(', ')]],
						),
					),
				),
				body,
			})
			this.#requests.push(record)
			this.#emitter.emit('request', record)
			const reply = (await this.#ask(record, signal)) ?? buildOllamaAnswer(record, this.#options)
			if (signal.aborted) {
				await reply.body?.cancel().catch(() => undefined)
				response.destroy()
				return
			}
			await this.#write(reply, response, signal)
		} catch (error) {
			response.destroy()
			if (!this.#lifetime.signal.aborted) this.#emitter.emit('error', error)
		}
	}

	async #ask(record: OllamaFixtureRequest, signal: AbortSignal): Promise<Response | undefined> {
		try {
			return await this.#options.reply?.(record, signal)
		} catch (error) {
			if (!this.#lifetime.signal.aborted) this.#emitter.emit('error', error)
			return Response.json(
				{ error: isError(error) ? error.message : preview(error) },
				{ status: 500 },
			)
		}
	}

	async #write(reply: Response, response: ServerResponse, signal: AbortSignal): Promise<void> {
		const reader = (
			reply.body ??
			new ReadableStream<Uint8Array>({
				start: (controller) => {
					controller.close()
				},
			})
		).getReader()
		signal.addEventListener(
			'abort',
			() => {
				void reader.cancel(signal.reason).catch(() => undefined)
			},
			{ once: true },
		)
		const first = await reader.read().catch(() => undefined)
		if (first === undefined || signal.aborted) {
			response.destroy()
			return
		}
		const head = [...reply.headers].flat()
		if (reply.statusText === '') response.writeHead(reply.status, head)
		else response.writeHead(reply.status, reply.statusText, head)
		if (first.done) {
			response.end()
			return
		}
		response.flushHeaders()
		response.write(first.value)
		for (;;) {
			const step = await reader.read().catch(() => undefined)
			if (step === undefined || signal.aborted) {
				response.destroy()
				return
			}
			if (step.done) {
				response.end()
				return
			}
			response.write(step.value)
		}
	}
}
