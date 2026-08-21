# `@yeoularu/effect-bun-test`

Unofficial Effect v4 helpers for Bun's native [`bun:test`](https://bun.com/docs/test) runner. The API follows the useful parts of `@effect/vitest` without running Vitest.

## Installation

```sh
bun add --dev @yeoularu/effect-bun-test
```

Requires Effect v4 and Bun 1.3.3 or newer.

## Overview

```ts
import { assert, it } from "@yeoularu/effect-bun-test"
import { Effect } from "effect"

it.effect("runs an Effect", () =>
  Effect.sync(() => {
    assert.strictEqual(1 + 1, 2)
  }))
```

| API | Environment | Purpose |
| --- | --- | --- |
| `it.effect` | `TestClock`, `TestConsole`, fresh `Scope` | Deterministic Effect tests |
| `it.live` | live clock and console, fresh `Scope` | Tests that require real time or output |
| `layer()` / `it.layer()` | shared serial Layer scope | Share resources across tests |
| `it.prop` | pure property | Schema or FastCheck property tests |
| `it.effect.prop` | Effect property with test services | Effectful property tests |
| `flakyTest` | current environment | Bounded retries for flaky Effects |

The package also re-exports Bun's test APIs and strict Node `assert` helpers.

## Test services

`it.effect` automatically provides `TestClock` and `TestConsole`. Every Effect test also receives a fresh `Scope`, which is closed when the test succeeds, fails, or times out.

```ts
import { assert, it } from "@yeoularu/effect-bun-test"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

it.effect("advances virtual time", () =>
  Effect.gen(function*() {
    const fiber = yield* Effect.sleep("1 hour").pipe(
      Effect.as("done"),
      Effect.forkChild,
    )

    yield* TestClock.adjust("1 hour")
    assert.strictEqual(yield* Fiber.join(fiber), "done")
  }))
```

Use `it.live` when the code must capture the live clock or console.

```ts
it.live("uses real time", () => Effect.sleep("10 millis"))
```

Do not wrap test bodies in `Effect.scoped`; the runner already manages their scope.

## Test context and cancellation

The callback receives a small Bun-compatible context. Its signal aborts when the test finishes or times out, and `onTestFinished` registers native Bun cleanup.

```ts
it.effect("uses the test signal", (ctx) =>
  Effect.tryPromise({
    try: () => fetch("https://example.com", { signal: ctx.signal }),
    catch: (cause) => cause,
  }))
```

Effect interruption is awaited so scoped finalizers finish before Bun moves on.

## Shared Layers

`layer()` builds a Layer once, shares it across its tests, and closes it after the serial suite. Nested Layers may depend on the parent; sibling-local resources remain isolated.

```ts
import { assert, layer } from "@yeoularu/effect-bun-test"
import { Context, Effect, Layer } from "effect"

class Database extends Context.Service<Database, "test-db">()("Database") {}

layer(Layer.succeed(Database)("test-db"))("database", (it) => {
  it.effect("provides the database", () =>
    Effect.gen(function*() {
      assert.strictEqual(yield* Database, "test-db")
    }))
})
```

Test services are included by default. Use `{ excludeTestServices: true }` only when the Layer must capture the live clock or console.

## Property tests

Pure and Effect property tests accept Effect Schema values, FastCheck arbitraries, arrays, or records.

```ts
import { assert, it } from "@yeoularu/effect-bun-test"
import { Effect, Schema } from "effect"
import { FastCheck } from "effect/testing"

it.prop(
  "integer addition is commutative",
  { a: Schema.Int, b: FastCheck.integer() },
  ({ a, b }) => a + b === b + a,
)

it.effect.prop("Schema values reach Effects", { value: Schema.Int }, ({ value }) =>
  Effect.sync(() => assert.strictEqual(Number.isInteger(value), true)))
```

Pass FastCheck parameters with the `fastCheck` test option.

```ts
it.prop("bounded runs", { value: Schema.Int }, () => true, {
  fastCheck: { numRuns: 100 },
})
```

## Modifiers and Bun options

Effect tests support `skip`, `only`, `each`, `skipIf`, `runIf`, and `fails`. Bun's `retry`, `repeats`, and `timeout` options are forwarded.

```ts
it.effect.skip("disabled", () => Effect.die("not run"))
it.effect.runIf(process.platform !== "win32")("unix", () => Effect.void)
it.effect("retry once", () => Effect.void, { retry: 1 })
```

## Flaky Effects

`flakyTest` retries an Effect up to ten times (eleven total attempts) within an elapsed-time budget. The default budget is 30 seconds. Exhausted failures become defects so the surrounding test fails.

```ts
import { flakyTest, it } from "@yeoularu/effect-bun-test"
import { Effect } from "effect"

let attempts = 0
const unreliable = Effect.suspend(() =>
  ++attempts < 3 ? Effect.fail("retry") : Effect.void)

it.live("eventually succeeds", () => flakyTest(unreliable, "5 seconds"))
```

Prefer Bun's `{ retry }` option for retrying a whole test. Use `flakyTest` when only part of an Effect program should retry.

## Bun behavior

- Effect-returning tests run serially within each file because Bun's `onTestFinished` does not support concurrent tests. Use `bun test --parallel` for file-level parallelism.
- Bun 1.3.2 exposes `onTestFinished` but does not run it after a timeout. Bun 1.3.3 is therefore the minimum supported version.
- Bun does not invert runner timeouts for `test.failing`. Timed `fails` tests receive an additional one-second cleanup window for Effect finalizers.

## Public exports

- `it`, `test`, `layer`, `flakyTest`
- `BunTest` public types
- Bun test APIs such as `describe`, `expect`, and `mock`
- strict Node `assert`

This package is adapted from Effect's MIT-licensed [`@effect/vitest`](https://github.com/Effect-TS/effect/tree/main/packages/vitest).

## License

MIT. This distribution retains the Effect copyright and permission notice in `LICENSE`.
