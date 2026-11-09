# NDJSON

> A stateful newline-delimited-JSON (NDJSON) stream parser: a self-contained handle
> that turns string chunks into the complete records decoded so far, skips a blank
> line, and refuses a malformed or non-record line unless `strict: false` skips it.

`parse(chunk)` appends `chunk` to an internal buffer and splits it on `\n`: every
line before the last is `\n`-terminated, hence complete, and is parsed to a record,
while the final segment is held back for the next call, so a line split across chunk
boundaries is reassembled the moment its closing `\n` arrives. Each complete line is
trimmed with the `String.prototype.trim` method, then
filtered — a blank or whitespace-only line (including one whose only content was a
CRLF's trailing `\r`) is skipped — so only plain records come back, and a line the
stream never terminates is never emitted even when the buffered text already happens
to be valid JSON. By default the parser refuses a line it cannot return: `parse`
throws an `NDJSONError` with code `'SYNTAX'` for a complete line that is not valid
JSON and `'RECORD'` for a complete line that is not a plain record. The throwing call
returns no records, discards every held line, including earlier complete lines and
the trailing partial line, and leaves the parser cleared, as `clear()` leaves it. With `strict: false` the parser
skips such a line instead, for a caller that prefers the records it can read over a
refusal. Blank lines are skipped, and lines are split and trimmed, the same way in both
modes. A chunk that is not a string throws `'SYNTAX'` in both modes, because joining it
to the buffer would corrupt the line it holds. An unterminated line throws nothing until
a later chunk completes it, so a caller ends a stream with `parse('\n')`, which refuses
a half record unless the parser is lenient. `clear()` drops the buffered partial
line so a handle can be reused for a fresh stream. Nothing else is wired in: no
Emitter, no server, HTTP, or agent coupling. Pair it with a streaming `TextDecoder`
when reading a byte stream — the decoder handles partial characters, the parser
handles partial lines. The buffer has no size limit, so a caller fronting an
untrusted or unbounded upstream must enforce its own byte cap before feeding chunks
in. Source: [`src/core`](../src/core). Surfaced through the `@src/core` barrel.

## Surface

Create a parser and feed it chunks as they arrive; each `parse(chunk)`
returns the records completed so far, and a trailing partial line is held
for the next call:

```ts
import { createNDJSONParser } from '@orkestrel/ndjson'

const parser = createNDJSONParser()
parser.parse('{"a":1}\n{"b"') // [{ a: 1 }] - the second line is still partial
parser.parse(':2}\n') // [{ b: 2 }] - the split line reassembled
parser.clear() // drop any buffered partial - ready for a fresh stream
```

### Types

| Name                    | Kind      | Signature              | Summary                                                                                                                                                                                                                                |
| ----------------------- | --------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NDJSONParserInterface` | interface | `{ parse(), clear() }` | Represents the stateful NDJSON (newline-delimited JSON) stream-parser contract a consumer holds — a `parse` that turns each string chunk into the complete records decoded so far, and a `clear` that drops the buffered partial line. |
| `NDJSONParserOptions`   | interface | `{ strict? }`          | Configures the parser `createNDJSONParser` builds and the `NDJSONParser` constructor accepts — `strict` decides whether a complete line that is not a JSON object is refused or skipped.                                               |
| `NDJSONErrorCode`       | type      | `'SYNTAX' \| 'RECORD'` | Names the machine-readable code an `NDJSONError` carries — `'SYNTAX'` for a chunk that is not a string or a complete line that is not valid JSON, and `'RECORD'` for a complete line that is valid JSON but not a plain record.        |

Types a helper's parameter as `NDJSONParserInterface` and returns the records
its `parse` call completes:

```ts
import type { NDJSONParserInterface } from '@orkestrel/ndjson'

function feed(parser: NDJSONParserInterface, chunk: string): readonly Record<string, unknown>[] {
	return parser.parse(chunk)
}
```

### Errors

A parser throws an `NDJSONError` unless `strict: false` skips the line, and
`isNDJSONError` narrows a caught value to one:

| Name            | Kind     | Signature                                                     | Summary                                                                                                                                       |
| --------------- | -------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `NDJSONError`   | class    | `new (code: NDJSONErrorCode, message: string) => NDJSONError` | Represents a parser's refusal of a chunk or of a complete NDJSON line, carrying the machine-readable `NDJSONErrorCode` a `catch` branches on. |
| `isNDJSONError` | function | `(value: unknown) => value is NDJSONError`                    | Narrows an unknown caught value to an `NDJSONError`.                                                                                          |

Catches the refusal of a truncated line and branches on its code:

```ts
import { createNDJSONParser, isNDJSONError } from '@orkestrel/ndjson'

const parser = createNDJSONParser()
try {
	parser.parse('{"a":\n')
} catch (error) {
	if (isNDJSONError(error)) error.code // 'SYNTAX'
}
```

`isNDJSONError` recognizes the own identity brand and the declared code across package
copies and module formats. It accepts subclass instances without requiring their name and
refuses unbranded look-alikes, transparent proxies, objects carrying only the brand, and an
unknown code. The constructor stores the error itself under
`Symbol.for('@orkestrel/ndjson.NDJSONError')` as a non-enumerable, non-writable own
property. The message is fixed per code and quotes no text from the refused line.

### Factories

| Name                 | Kind     | Signature                                                  | Summary                                                                                                                                                                                                            |
| -------------------- | -------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createNDJSONParser` | function | `(options?: NDJSONParserOptions) => NDJSONParserInterface` | Creates an NDJSON (newline-delimited JSON) stream parser and returns it as an `NDJSONParserInterface` — a fresh `NDJSONParser` holding the buffer, so a caller holds the published contract rather than the class. |

#### Create a parser

Creates a parser through the factory and feeds it two complete lines, then a
line that completes only after its own newline arrives:

```ts
import { createNDJSONParser } from '@orkestrel/ndjson'

const parser = createNDJSONParser()
parser.parse('{"a":1}\n{"b":2}\n') // [{ a: 1 }, { b: 2 }]
parser.parse('{"c":3}') // [] — buffered until its trailing newline arrives
parser.parse('\n') // [{ c: 3 }]
```

#### Refuse a line

Refuses a non-record line by default, then shows that the refusal dropped the partial
line the same call carried:

```ts
import { createNDJSONParser, isNDJSONError } from '@orkestrel/ndjson'

const parser = createNDJSONParser()
parser.parse('{"a":1}\n\n') // [{ a: 1 }] - a blank line is skipped
try {
	parser.parse('[1,2]\n{"b"')
} catch (error) {
	if (isNDJSONError(error)) error.code // 'RECORD'
}
parser.parse('\n') // [] - the refusal dropped the partial line
parser.parse('{"b":2}\n') // [{ b: 2 }]
```

#### Create a lenient parser

Creates a parser that skips what the default refuses:

```ts
import { createNDJSONParser } from '@orkestrel/ndjson'

const parser = createNDJSONParser({ strict: false })
parser.parse('not json\n\n{"a":1}\n[1,2]\n') // [{ a: 1 }] - malformed, blank, and non-record lines skipped
```

### Classes

| Name           | Kind  | Signature                                                      | Summary                                                                                                                                                                                                                                                     |
| -------------- | ----- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NDJSONParser` | class | `new (options?: NDJSONParserOptions) => NDJSONParserInterface` | Decodes an NDJSON (newline-delimited JSON) stream statefully, implementing `NDJSONParserInterface` over a private buffer the instance owns — each `parse` call returns the records completed so far and reassembles a record split across chunk boundaries. |

## Methods

The public methods of `NDJSONParserInterface` — the class's full method
surface.

#### `NDJSONParserInterface`

| Method  | Returns                              | Summary                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse` | `readonly Record<string, unknown>[]` | Appends `chunk` to the buffer and returns every complete `\n`-terminated line parsed to a record, refusing a malformed or non-record line unless the parser is lenient; the trailing partial line is retained for the next call unless a refusal in the same call clears the buffer, so a line split across a chunk boundary is reassembled when its closing `\n` arrives. |
| `clear` | `void`                               | Drops any buffered partial line, leaving the handle ready for a fresh stream.                                                                                                                                                                                                                                                                                              |

`parse` holds an unterminated line indefinitely, unless a refusal in the same call
clears the buffer, and the buffer has no size limit, so a caller fronting an
untrusted upstream enforces its own byte cap.

```ts
import { NDJSONParser } from '@orkestrel/ndjson'

const parser = new NDJSONParser()
parser.parse('{"a":1}\n{"b"') // [{ a: 1 }] - the second line is still partial
parser.parse(':2}\n') // [{ b: 2 }] - the split line reassembled
parser.clear() // drop any buffered partial - ready for a fresh stream
parser.parse('{"c":3}\n') // [{ c: 3 }]
```

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` bijection (value and type exports), the `NDJSONParserInterface` ↔ `NDJSONParser` method bijection, and the equality gate: every `Summary` cell against its declaration's description paragraph, the titled `Create a parser`, `Refuse a line`, and `Create a lenient parser` fences against the `@example` blocks of those titles (pinned so the titled pairs cannot be retired silently), and the README pitch against this guide's tagline. It also runs the flagship fences, the refusal, lenient, and Errors fences included, and asserts the values their comments claim.
- [`tests/src/core/NDJSONParser.test.ts`](../tests/src/core/NDJSONParser.test.ts) — that `parse` returns the same records however a stream is cut into chunks, skipping blank lines and withholding a line the stream never terminates; that the default parser, and one built with any `strict` value but `false`, refuses each malformed line as `'SYNTAX'` and each non-record line as `'RECORD'` with a fixed message, returns no record from the refusing call and leaves the parser cleared, keeps its records however a clean stream is cut into chunks, and trims every Unicode space `String.prototype.trim` strips; that a chunk that is not a string is refused in both modes; and that a `strict: false` parser skips what the default refuses and never throws on a line.
- [`tests/src/core/errors.test.ts`](../tests/src/core/errors.test.ts) — that `isNDJSONError` accepts an `NDJSONError` and a subclass, refuses a look-alike, a transparent proxy, a plain object carrying the brand, and an unknown code, and that the constructor stamps a hidden, fixed brand.
- [`tests/policy.test.ts`](../tests/policy.test.ts) — repository coding law: source placement, exports, readonly contracts, syntax, and the prose this guide is written in.
- [`tests/config.test.ts`](../tests/config.test.ts) — the root configuration's aliases and projects, the policy Oxlint plugin's rules against its rule tester, and the configuration helpers.

## See also

- [`AGENTS.md`](../AGENTS.md) — the pointer to the `@orkestrel/scaffold` coding contract this package is written to.
- [`README.md`](README.md) — the guides index.
