import type { OllamaDaemonOptions, OllamaExecutable, OllamaModel } from './types.js'
import { arrayOf, holds, isFunction, isInteger, isRecord, isString } from '@orkestrel/contract'
import { isAbsolute } from 'node:path'

/**
 * Checks whether a value declares an absolute executable and its offline identity.
 * @param value - The declaration to inspect
 * @returns True if the identity and argument vector are well formed; false otherwise
 * @example
 * ```ts
 * isOllamaExecutable({ path: 'node', digest: '', version: '' }) // false
 * ```
 */
export function isOllamaExecutable(value: unknown): value is OllamaExecutable {
	return holds(
		() =>
			isRecord(value) &&
			isString(value.path) &&
			isAbsolute(value.path) &&
			!value.path.includes('\0') &&
			isString(value.digest) &&
			/^[a-f0-9]{64}$/.test(value.digest) &&
			isString(value.version) &&
			value.version.trim().length > 0 &&
			!value.version.includes('\0') &&
			(value.arguments === undefined ||
				(arrayOf(isString)(value.arguments) &&
					value.arguments.every((argument) => !argument.includes('\0')))),
	)
}

/**
 * Checks whether a value declares an exact model name and inventory digest.
 * @param value - The declaration to inspect
 * @returns True if both model identity members are nonempty strings; false otherwise
 * @example
 * ```ts
 * isOllamaModel({ name: 'cedar', digest: 'declared' }) // true
 * ```
 */
export function isOllamaModel(value: unknown): value is OllamaModel {
	return holds(
		() =>
			isRecord(value) &&
			isString(value.name) &&
			value.name.trim().length > 0 &&
			!value.name.includes('\0') &&
			isString(value.digest) &&
			value.digest.trim().length > 0,
	)
}

/**
 * Checks whether a string selects an explicit dedicated HTTP loopback origin.
 * @param value - The endpoint to inspect
 * @returns True if the endpoint declares an allowed loopback port and no other URL components; false otherwise
 * @example
 * ```ts
 * isOllamaOrigin('http://127.0.0.1:31111') // true
 * ```
 */
export function isOllamaOrigin(value: unknown): value is string {
	return holds(() => {
		if (!isString(value) || !/^http:\/\/127\.0\.0\.1:[0-9]+\/?$/.test(value)) return false
		const url = new URL(value)
		const port = Number(value.match(/:([0-9]+)\/?$/)?.[1])
		return (
			url.protocol === 'http:' &&
			url.hostname === '127.0.0.1' &&
			port > 0 &&
			port <= 65535 &&
			port !== 11434 &&
			url.pathname === '/'
		)
	})
}

/**
 * Checks whether an unknown declaration can safely reach daemon preflight.
 * @param value - The complete declaration to inspect
 * @returns True if every supplied option satisfies the daemon contract; false otherwise
 * @example
 * ```ts
 * isOllamaDaemonOptions({}) // false
 * ```
 */
export function isOllamaDaemonOptions(value: unknown): value is OllamaDaemonOptions {
	return holds(() => {
		if (
			!isRecord(value) ||
			!isOllamaExecutable(value.executable) ||
			!isOllamaOrigin(value.url) ||
			!isString(value.workspace) ||
			!isAbsolute(value.workspace) ||
			value.workspace.includes('\0') ||
			!arrayOf(isOllamaModel)(value.models) ||
			value.models.length === 0 ||
			new Set(value.models.map((model) => model.name)).size !== value.models.length
		)
			return false
		if (
			value.store !== undefined &&
			(!isString(value.store) || !isAbsolute(value.store) || value.store.includes('\0'))
		)
			return false
		if (
			value.readiness !== undefined &&
			(!isInteger(value.readiness) || value.readiness <= 0 || value.readiness > 2_147_483_647)
		)
			return false
		if (
			value.metadata !== undefined &&
			(!isRecord(value.metadata) ||
				(value.metadata.timeout !== undefined &&
					(!isInteger(value.metadata.timeout) ||
						value.metadata.timeout <= 0 ||
						value.metadata.timeout > 2_147_483_647)) ||
				(value.metadata.bytes !== undefined &&
					(!isInteger(value.metadata.bytes) ||
						value.metadata.bytes <= 0 ||
						value.metadata.bytes > Number.MAX_SAFE_INTEGER)))
		)
			return false
		if (
			value.termination !== undefined &&
			(!isRecord(value.termination) ||
				Object.values(value.termination).some(
					(duration) => !isInteger(duration) || duration < 0 || duration > 2_147_483_647,
				))
		)
			return false
		if (
			value.environment !== undefined &&
			(!isRecord(value.environment) ||
				Object.entries(value.environment).some(
					([name, entry]) =>
						name.length === 0 ||
						name.includes('\0') ||
						name.includes('=') ||
						(entry !== undefined && (!isString(entry) || entry.includes('\0'))),
				))
		)
			return false
		return (
			(value.signal === undefined || value.signal instanceof AbortSignal) &&
			(value.error === undefined || isFunction(value.error)) &&
			(value.on === undefined || (isRecord(value.on) && Object.values(value.on).every(isFunction)))
		)
	})
}
