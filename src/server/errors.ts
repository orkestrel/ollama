import type { OllamaErrorCode, OllamaErrorContext, OllamaErrorOptions } from './types.js'
import { holds, INTRINSICS, isFunction, isObject, isString } from '@orkestrel/contract'
import { OLLAMA_ERROR_BRAND, OLLAMA_ERROR_CODES } from './constants.js'

/**
 * Carries a daemon refusal with a machine-readable category, observations, and original cause.
 *
 * @example
 * ```ts
 * const error = new OllamaError('The dedicated port is occupied', {
 * 	code: 'occupied',
 * 	context: { operation: 'start', url: 'http://127.0.0.1:11435' },
 * })
 * error.code // 'occupied'
 * ```
 */
export class OllamaError extends Error {
	override readonly name: string = 'OllamaError'
	readonly code: OllamaErrorCode
	readonly context?: OllamaErrorContext

	/**
	 * Creates a branded daemon refusal.
	 *
	 * @param message - Human-readable failure description
	 * @param options - Refusal category, optional observations, and optional cause
	 */
	constructor(message: string, options: OllamaErrorOptions) {
		super(message, INTRINSICS.own(options, 'cause') ? { cause: options.cause } : undefined)
		INTRINSICS.define(this, OLLAMA_ERROR_BRAND, { value: this })
		this.code = options.code
		if (INTRINSICS.own(options, 'context') && options.context !== undefined) {
			this.context = Object.freeze({ ...options.context })
		}
	}
}

/**
 * Checks whether an unknown value carries the daemon error brand and declared members.
 *
 * @remarks
 * Recognizes subclasses and errors from another installation or module format without
 * requiring the class name. The own brand must refer to the tested value, so a transparent
 * proxy over an error is refused. The brand recognizes a contract; it does not prove that
 * this constructor ran. Throwing accessors and revoked proxies return false.
 *
 * @param value - The value to inspect
 * @returns True if the value is a branded Error subclass with valid members; false otherwise
 *
 * @example
 * ```ts
 * isOllamaError(new OllamaError('Version differs', { code: 'version' })) // true
 * isOllamaError(new Error('Version differs')) // false
 * ```
 */
export function isOllamaError(value: unknown): value is OllamaError {
	return holds(() => {
		if (!(value instanceof Error) || INTRINSICS.prototype(value) === Error.prototype) {
			return false
		}
		const brand = INTRINSICS.describe(value, OLLAMA_ERROR_BRAND)
		if (brand === undefined || brand.value !== value) return false
		const code: unknown = INTRINSICS.reflect.read(value, 'code')
		const context: unknown = INTRINSICS.reflect.read(value, 'context')
		const stack: unknown = INTRINSICS.reflect.read(value, 'stack')
		return (
			OLLAMA_ERROR_CODES.some((candidate) => candidate === code) &&
			isString(INTRINSICS.reflect.read(value, 'message')) &&
			(stack === undefined || isString(stack)) &&
			(context === undefined ||
				((isObject(context) || isFunction(context)) &&
					['operation', 'path', 'url', 'model', 'evidence'].every((key) => {
						const member: unknown = INTRINSICS.reflect.read(context, key)
						return member === undefined || isString(member)
					})))
		)
	})
}
