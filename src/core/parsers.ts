// The Ollama response coercer — the non-stream `/api/chat` body read off the wire and
// coerced to a record inside a total guard, never a raw `SyntaxError`.

import { isRecord, parseJSONAs } from '@orkestrel/contract'

/**
 * Parses a non-stream `/api/chat` response body into a wire record.
 *
 * @remarks
 * Total by construction: an empty body, a body that is not JSON, and a body whose JSON is
 * not an object all yield `undefined`, so a malformed daemon response never escapes as a
 * `SyntaxError`. The call site supplies the empty-record default that reads as empty
 * content and no usage.
 *
 * @param response - The 200-OK `/api/chat` response whose body is read as text
 * @returns The parsed record, or `undefined` when the body is empty or malformed
 *
 * @example
 * ```ts
 * await parseBody(new Response('{"message":{"content":"ok"}}'))
 * // { message: { content: 'ok' } }
 * ```
 */
export async function parseBody(
	response: Response,
): Promise<Readonly<Record<string, unknown>> | undefined> {
	return parseJSONAs(await response.text(), isRecord)
}
