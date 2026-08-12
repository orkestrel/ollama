# NDJSON

> A stateful newline-delimited-JSON (NDJSON) stream parser: feed it string
> chunks, get back the complete records parsed so far. `parse(chunk)` appends
> `chunk` to an internal buffer and splits it on `\n` — every line _before_
> the last is `\n`-terminated, hence complete, and is `JSON.parse`d into a
> record; the final segment is the trailing partial line and is held back
> for the next call, so a line split across chunk boundaries is reassembled
> the moment its closing `\n` arrives. Each trimmed line is filtered three
> ways: a blank / whitespace-only line (including one whose only content was
> a CRLF's trailing `\r`) is skipped, malformed JSON is silently skipped
> (never thrown), and a non-record value (an array, a primitive, `null`) is
> dropped — only plain records come back. A never-terminated line is never
> emitted, even when the buffered text already happens to be valid JSON.
> `reset()` drops the buffered partial line so a handle can be reused for a
> fresh stream. A pure functional primitive — no Emitter, no server / HTTP /
> agent coupling; it never throws, on malformed input or otherwise. Pair it
> with a streaming `TextDecoder` when reading a byte stream: the decoder
> handles partial characters, the parser handles partial lines. A line that
> is never terminated by a newline is buffered indefinitely by design — the
> parser has no size limit, so a caller fronting an untrusted or unbounded
> upstream must enforce its own byte cap before feeding chunks in.
> Source: [`src/core`](../../src/core). Surfaced through the `@src/core`
> barrel.

## Surface

Create a parser and feed it chunks as they arrive; each `parse(chunk)`
returns the records completed so far, and a trailing partial line is held
for the next call:

```ts
import { createNDJSONParser } from '@orkestrel/ndjson'

const parser = createNDJSONParser()
parser.parse('{"a":1}\n{"b"') // [{ a: 1 }] - the second line is still partial
parser.parse(':2}\n') // [{ b: 2 }] - the split line reassembled
parser.reset() // drop any buffered partial - ready for a fresh stream
```

### Types

| Type                    | Kind      | Shape                                                                                                         |
| ----------------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| `NDJSONParserInterface` | interface | The stateful stream-parser contract — `parse(chunk: string): readonly Record<string, unknown>[]` + `reset()`. |

```ts
import type { NDJSONParserInterface } from '@orkestrel/ndjson'

function feed(parser: NDJSONParserInterface, chunk: string): readonly Record<string, unknown>[] {
	return parser.parse(chunk)
}
```

### Factories

| API                  | Kind     | Builds…                                                      |
| -------------------- | -------- | ------------------------------------------------------------ |
| `createNDJSONParser` | function | A working `NDJSONParserInterface`, backed by `NDJSONParser`. |

```ts
import { createNDJSONParser } from '@orkestrel/ndjson'

const parser = createNDJSONParser()
parser.parse('{"a":1}\n{"b":2}\n') // [{ a: 1 }, { b: 2 }]
```

### Entities

| API            | Kind  | Summary                                                                                                          |
| -------------- | ----- | ---------------------------------------------------------------------------------------------------------------- |
| `NDJSONParser` | class | The stateful NDJSON stream parser — implements `NDJSONParserInterface`, reassembles records split across chunks. |

## Methods

The public methods of `NDJSONParserInterface` — the class's full method
surface (AGENTS §22).

#### `NDJSONParserInterface`

| Method  | Returns                              | Behavior                                                                                                                                                                                                                                                                    |
| ------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse` | `readonly Record<string, unknown>[]` | Append `chunk`, then return every COMPLETE `\n`-terminated line parsed to a record (malformed / non-record lines skipped); retain a trailing partial line indefinitely until its newline arrives — callers fronting an unbounded upstream should cap input size themselves. |
| `reset` | `void`                               | Drop any buffered partial line — reset for a fresh stream.                                                                                                                                                                                                                  |

```ts
import { NDJSONParser } from '@orkestrel/ndjson'

const parser = new NDJSONParser()
parser.parse('{"a":1}\n{"b"') // [{ a: 1 }] - the second line is still partial
parser.parse(':2}\n') // [{ b: 2 }] - the split line reassembled
parser.reset() // drop any buffered partial - ready for a fresh stream
parser.parse('{"c":3}\n') // [{ c: 3 }]
```
