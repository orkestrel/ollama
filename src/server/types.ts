import type { ProviderOptions } from '@orkestrel/agent'
import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'
import type { SessionOptions } from '@orkestrel/process'
import type { OllamaTiming } from '@src/core'
import type { OLLAMA_ERROR_CODES } from './constants.js'

/**
 * Declares the executable identity required before a daemon starts.
 *
 * @remarks
 * `path` is an absolute path to a regular executable file, never a PATH lookup or a shell script.
 * `digest` is its lowercase hexadecimal SHA-256 digest. `version` is the nonempty version
 * expected from `/api/version`, recorded by the caller for that digest before this invocation.
 * `arguments` is the complete argument vector. Default: `['serve']`. A protocol fixture can
 * supply a selected Node executable and its entry arguments; the digest covers the executable
 * alone, not its arguments, runtime libraries, or files those arguments name.
 */
export interface OllamaExecutable {
	readonly path: string
	readonly digest: string
	readonly version: string
	readonly arguments?: readonly string[]
}

/**
 * Declares a model name and the digest its inventory entry must report.
 *
 * @remarks
 * `name` is an exact, nonempty Ollama model name. `digest` is the nonempty digest from
 * `/api/tags`, compared verbatim. A daemon declaration admits no duplicate model names and
 * never pulls a missing model or substitutes a tag with a different digest.
 */
export interface OllamaModel {
	readonly name: string
	readonly digest: string
}

/**
 * Bounds each metadata or unload response independently of the startup deadline.
 *
 * @remarks
 * `timeout` bounds the complete request and body read in milliseconds. Default:
 * {@link OLLAMA_METADATA_TIMEOUT}. `bytes` bounds the retained response body in bytes.
 * Default: {@link OLLAMA_METADATA_BYTES}. Both values must be positive safe integers;
 * `timeout` must fit a Node timer. A startup request also shares the remaining readiness
 * allowance. Redirects are refused rather than followed.
 */
export interface OllamaMetadataOptions {
	readonly timeout?: number
	readonly bytes?: number
}

/**
 * Configures a dedicated daemon with explicit executable, endpoint, and model declarations.
 *
 * @remarks
 * `url` must be an HTTP origin on `127.0.0.1` with an explicit port other than 11434 or 0,
 * without credentials, a non-root path, query, or fragment. `workspace` is the absolute
 * existing working directory. `models` must be nonempty and contain unique names.
 *
 * `environment` overlays inherited variables by case-folded name on every host; an
 * `undefined` value removes a variable. The declaration owns `OLLAMA_HOST`, and also
 * `OLLAMA_MODELS` when `store` names an absolute existing model directory. These values
 * override every casing in the caller and inherited layers without changing unrelated
 * variables. An omitted `store` leaves the inherited or caller model directory in force.
 * Environment merging does not isolate the host or the model store.
 *
 * `readiness` bounds startup through version and model verification in milliseconds.
 * Default: {@link OLLAMA_READINESS}. It must be a positive integer that fits a Node timer.
 * `metadata` bounds individual replies. `termination` reuses the process session's POSIX
 * grace and stream-drain settings and their defaults. `signal` aborts startup or use and
 * starts the same permanent stop; an already aborted signal refuses before spawn.
 * `on` installs initial lifecycle listeners; `error` receives isolated listener failures.
 * `fetch` carries every version probe, model inventory, and unload request. Default: the
 * global `fetch` bound to `globalThis`. The collaborator must honor the supplied signal
 * and manual redirect policy and return an unread standard response body; the daemon
 * retains its byte and timer bounds when reading that body.
 * The daemon owns a snapshot of the declaration before doing I/O.
 */
export interface OllamaDaemonOptions extends Pick<ProviderOptions, 'fetch'> {
	readonly on?: EmitterHooks<OllamaDaemonEventMap>
	readonly error?: EmitterErrorHandler
	readonly executable: OllamaExecutable
	readonly url: string
	readonly models: readonly OllamaModel[]
	readonly workspace: string
	readonly environment?: Readonly<Record<string, string | undefined>>
	readonly store?: string
	readonly readiness?: number
	readonly metadata?: OllamaMetadataOptions
	readonly termination?: Pick<SessionOptions, 'grace' | 'drain'>
	readonly signal?: AbortSignal
}

/**
 * Records the executable, endpoint, root process, and model identities verified at startup.
 *
 * @remarks
 * The executable digest was read before spawn, its version matched `/api/version`, and
 * every model digest matched `/api/tags` while the child was live. `pid` is the spawned
 * session's root process id, never supplied by an HTTP reply and never cleanup authority.
 * This immutable receipt records startup observations; it proves no later liveness,
 * native socket ownership, executable lock, or model residency.
 */
export interface OllamaDaemonIdentity {
	readonly executable: OllamaExecutable
	readonly url: string
	readonly pid: number
	readonly models: readonly OllamaModel[]
}

/**
 * Preserves a bounded HTTP body as base64 with its byte count and SHA-256 digest.
 *
 * @remarks
 * `content` encodes the retained bytes without decoding or JSON reserialization. `size`
 * counts those bytes, and `digest` is their lowercase hexadecimal SHA-256 digest.
 * `complete` is true if the body ended normally within its bound; false if only a prefix
 * was retained before a size, transport, timeout, or cancellation refusal.
 */
export interface OllamaBytes {
	readonly content: string
	readonly size: number
	readonly digest: string
	readonly complete: boolean
}

/**
 * Records one declared model's unload request and the response observed for that attempt.
 *
 * @remarks
 * `sequence` is the zero-based attempt ordinal across the daemon's lifetime. `model` is
 * the verified declaration, and `url` names `/api/generate` on the dedicated origin.
 * `request` retains the exact body sent: the declared model with `keep_alive: 0` and no
 * prompt. `response` exists when response bytes were observed, including an empty body;
 * `status` exists when HTTP headers arrived. `timing` carries the terminal reply's timing
 * only after that reply names the declared model. `error` carries an attempt's refusal.
 * Failed attempts remain recorded before `unload()` rejects; a successful attempt requires
 * a complete, successful terminal reply naming that model. Success does not prove eviction
 * from GPU memory, a cold cache, or `/api/ps` residency.
 */
export interface OllamaMaintenance {
	readonly sequence: number
	readonly model: OllamaModel
	readonly url: string
	readonly request: OllamaBytes
	readonly response?: OllamaBytes
	readonly status?: number
	readonly timing?: OllamaTiming
	readonly error?: unknown
}

/**
 * Reports verified startup, recorded unloads, permanent stop, and daemon failures.
 *
 * @remarks
 * `start` fires after every startup check passes. `unload` reports each settled attempt,
 * including a refused attempt retained in maintenance. `stop` fires after cleanup and
 * executable re-hashing; its boolean matches the stop result. `error` reports domain
 * failures as unknown values, separate from the options' listener-error handler.
 */
export type OllamaDaemonEventMap = {
	readonly start: readonly [identity: OllamaDaemonIdentity]
	readonly unload: readonly [maintenance: OllamaMaintenance]
	readonly stop: readonly [confirmed: boolean]
	readonly error: readonly [error: unknown]
}

/**
 * Owns a dedicated daemon from validated startup through declared-model maintenance and stop.
 *
 * @remarks
 * Startup validates the declaration, hashes the executable, refuses an occupied port, and
 * spawns through a process session. Readiness wakes on the child's own stderr and requires
 * its listen announcement, a matching version reply, and every declared model digest while
 * the child lives. No model operation is admitted before verification.
 *
 * Under U22, D1's replacement refusal is detection by executable hashes before start and
 * after stop. D3's owner refusal is detection by the occupied-port check, the owned child's
 * listen announcement, and its liveness at each readiness reply. Neither closes the port
 * handoff race or supplies native custody. On POSIX, the session detaches its child, so an
 * abrupt host death can leave both the daemon root and its runners alive, holding the port.
 * On Windows, the child isn't detached: the root in libuv's kill-on-close job ends with the
 * host, but runners outside that job can survive. A tree stop cannot recover descendants
 * after the root's native exit is observed.
 * D2 retains explicit endpoint and case-folded environment selection. D4 retains declared
 * maintenance bytes and the published process session's tree stop and exit barrier.
 */
export interface OllamaDaemonInterface {
	/** Holds the declared dedicated origin; it is usable only after startup resolves. */
	readonly url: string
	/** Holds the verified startup receipt, retained after stop, or undefined before verification. */
	readonly identity: OllamaDaemonIdentity | undefined
	/** Holds immutable attempt records in sequence order, including refused unloads. */
	readonly maintenance: readonly OllamaMaintenance[]
	/** Holds the typed lifecycle observation surface. */
	readonly emitter: EmitterInterface<OllamaDaemonEventMap>
	/**
	 * Starts the declared executable and verifies its endpoint and models.
	 *
	 * @remarks
	 * Concurrent or repeated calls share the first startup result. A failed startup stops
	 * and joins the owned session before rejecting, preserving any cleanup refusal alongside
	 * the original failure. A stopped or destroyed daemon cannot restart.
	 *
	 * @returns The verified immutable startup receipt
	 * @throws {@link OllamaError} Thrown when validation, spawn, readiness, identity, or cancellation refuses startup.
	 */
	start(): Promise<OllamaDaemonIdentity>
	/**
	 * Unloads the declared models in declaration order and retains each attempt's bytes.
	 *
	 * @remarks
	 * Requires a started, live daemon. An overlapping unload refuses with `state`.
	 * The first refused attempt ends the operation; earlier records remain in maintenance.
	 * A transport or collaborator failure, or a refused reply, rejects this call and leaves
	 * the daemon running until `stop()`. A rejection during `start()` stops and joins the child.
	 * Stop or cancellation aborts the request and retains its bounded partial observation.
	 *
	 * @returns The immutable records made by this call
	 * @throws {@link OllamaError} Thrown when state, transport, model identity, bounds, or cancellation refuses maintenance.
	 */
	unload(): Promise<readonly OllamaMaintenance[]>
	/**
	 * Permanently stops the owned tree, joins its session, and re-hashes the executable.
	 *
	 * @remarks
	 * Repeated calls share one barrier. Stops pending startup or maintenance first and never
	 * rejects. A failed tree-stop confirmation or re-hash emits an error and resolves false.
	 * Before a spawn, stop releases pending work and resolves true without creating a child.
	 *
	 * @returns True if the root exit was confirmed and the executable digest stayed equal, or no child started; false otherwise
	 */
	stop(): Promise<boolean>
	/**
	 * Stops the daemon and releases its observation emitter after cleanup settles.
	 *
	 * @remarks
	 * Idempotent and never rejects. Await `stop()` first when the caller needs its boolean
	 * cleanup result. Identity and maintenance receipts remain readable after destruction.
	 *
	 * @returns The shared teardown barrier
	 */
	destroy(): Promise<void>
}

/** Defines the machine-readable refusal categories of the daemon lifecycle. */
export type OllamaErrorCode = (typeof OLLAMA_ERROR_CODES)[number]

/** Carries the operation and identity observations accompanying a daemon refusal. */
export interface OllamaErrorContext {
	readonly operation?: string
	readonly path?: string
	readonly url?: string
	readonly model?: string
	readonly expected?: unknown
	readonly received?: unknown
	readonly evidence?: string
}

/** Configures a daemon refusal with its category, observations, and original cause. */
export interface OllamaErrorOptions {
	readonly code: OllamaErrorCode
	readonly context?: OllamaErrorContext
	readonly cause?: unknown
}
