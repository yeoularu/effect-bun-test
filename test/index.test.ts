import { assert, describe, flakyTest, it, layer, test } from "@yeoularu/effect-bun-test"
import { Clock, Context, Duration, Effect, Fiber, Layer, Schema } from "effect"
import { FastCheck, TestClock, TestConsole } from "effect/testing"
import { fileURLToPath } from "node:url"

describe("Effect tests", () => {
  it.effect("provides TestClock and a Scope", () =>
    Effect.gen(function*() {
      const fiber = yield* Effect.sleep("1 hour").pipe(Effect.forkChild)
      yield* TestClock.adjust("1 hour")
      yield* Fiber.join(fiber)
    }))

  it.effect("provides TestConsole", () =>
    Effect.gen(function*() {
      yield* Effect.log("captured")
      assert.strictEqual((yield* TestConsole.logLines).includes("captured"), true)
    }))

  test.live("supports the test alias", () => Effect.void)

  it.effect.each([1, 2, 3])("supports each", (n) => Effect.sync(() => assert.strictEqual(n, n)))

  it.effect.skipIf(true)("supports skipIf", () => Effect.die("skipped"))
  it.effect.skipIf(false)("runs when skipIf is false", () => Effect.void)
  it.effect.runIf(false)("supports runIf", () => Effect.die("skipped"))
  it.effect.runIf(true)("runs when runIf is true", () => Effect.void)

  let finished = false
  let signal: AbortSignal | undefined
  it.effect("provides test completion context", (ctx) =>
    Effect.sync(() => {
      signal = ctx.signal
      ctx.onTestFinished(() => {
        finished = true
      })
    }))

  test.serial("finishes and aborts the test context", () => {
    assert.strictEqual(finished, true)
    assert.strictEqual(signal?.aborted, true)
  })

  let runnerAttempts = 0
  it.effect("forwards Bun retry options", () =>
    Effect.sync(() => {
      runnerAttempts++
      if (runnerAttempts === 1) throw new Error("retry")
    }), { retry: 1 })

  test.serial("retries the Effect test once", () => {
    assert.strictEqual(runnerAttempts, 2)
  })

  it.live("retries flaky Effects", () => {
    let attempts = 0
    return flakyTest(
      Effect.suspend(() => ++attempts < 3 ? Effect.fail("retry") : Effect.void)
    ).pipe(Effect.andThen(Effect.sync(() => assert.strictEqual(attempts, 3))))
  })

  it.live.fails(
    "supports expected failures",
    () => Effect.die("expected")
  )

  let expectedTimeoutReleased = false
  it.live.fails(
    "supports expected timeouts",
    () =>
      Effect.acquireRelease(
        Effect.void,
        () => Effect.sync(() => expectedTimeoutReleased = true)
      ).pipe(Effect.andThen(Effect.never)),
    5
  )

  test.serial("waits for expected timeout finalizers", () => {
    assert.strictEqual(expectedTimeoutReleased, true)
  })

  test.serial("finalizes a timed out Effect", () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", fileURLToPath(new URL("./fixtures/timeout.fixture.ts", import.meta.url))],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe"
    })

    return Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]).then(([stdout, stderr, exitCode]) => {
      assert.strictEqual(exitCode, 1)
      assert.match(stdout + stderr, /effect-finalized/)
      assert.doesNotMatch(stdout + stderr, /Unhandled error between tests/)
    })
  })
})

class Foo extends Context.Service<Foo, "foo">()("Foo") {
  static readonly layer = Layer.succeed(Foo)("foo")
}

class Bar extends Context.Service<Bar, "bar">()("Bar") {
  static readonly layer = Layer.effect(Bar)(Effect.map(Foo, () => "bar" as const))
}

class Sleeper extends Context.Service<Sleeper, {
  readonly sleep: (duration: Duration.Input) => Effect.Effect<void>
}>()("Sleeper") {
  static readonly layer = Layer.effect(Sleeper)(
    Effect.map(
      Clock.Clock,
      (clock) => ({ sleep: (duration: Duration.Input) => clock.sleep(Duration.fromInputUnsafe(duration)) })
    )
  )
}

describe("layers", () => {
  const releases: Array<string> = []

  layer(Foo.layer)((it) => {
    it.effect("provides an unnamed layer", () =>
      Effect.gen(function*() {
        assert.strictEqual(yield* Foo, "foo")
      }))

    it.layer(Bar.layer)((it) => {
      it.effect("provides a nested unnamed layer", () =>
        Effect.gen(function*() {
          assert.strictEqual(yield* Foo, "foo")
          assert.strictEqual(yield* Bar, "bar")
        }))
    })

    it.layer(Layer.effectDiscard(Effect.acquireRelease(
      Effect.void,
      () => Effect.sync(() => releases.push("released"))
    )))("scoped layer", (it) => {
      it.effect("keeps resources open for the suite", () => Effect.sync(() => assert.deepStrictEqual(releases, [])))
    })

    it.serial("closes nested layer resources", () => {
      assert.deepStrictEqual(releases, ["released"])
    })
  })

  layer(Sleeper.layer)("test services", (it) => {
    it.effect("replaces a captured Clock with TestClock", () =>
      Effect.gen(function*() {
        const sleeper = yield* Sleeper
        const fiber = yield* Effect.forkChild(sleeper.sleep("1 day"))
        yield* TestClock.adjust("1 day")
        yield* Fiber.join(fiber)
      }))
  })

  layer(Sleeper.layer, { excludeTestServices: true })("live services", (it) => {
    it.effect("keeps the captured live Clock", () =>
      Effect.gen(function*() {
        const sleeper = yield* Sleeper
        yield* sleeper.sleep(1)
      }))
  })

  describe("nested sibling isolation", () => {
    let nextId = 0
    const released: Array<number> = []

    class Child extends Context.Service<Child, { readonly id: number }>()("Child") {}

    const ChildLayer = Layer.effect(Child)(
      Effect.gen(function*() {
        yield* Foo
        const id = ++nextId
        return yield* Effect.acquireRelease(
          Effect.succeed({ id }),
          () => Effect.sync(() => released.push(id))
        )
      })
    )

    layer(Foo.layer)("parent", (it) => {
      it.layer(ChildLayer)("first child", (it) => {
        it.effect("allocates the first child", () =>
          Effect.gen(function*() {
            assert.strictEqual((yield* Child).id, 1)
          }))
      })

      it.layer(ChildLayer)("second child", (it) => {
        it.effect("allocates an isolated second child", () =>
          Effect.gen(function*() {
            assert.deepStrictEqual(released, [1])
            assert.strictEqual((yield* Child).id, 2)
          }))
      })

      it.serial("releases both child layers", () => {
        assert.deepStrictEqual(released, [1, 2])
      })
    })
  })
})

describe("property tests", () => {
  const integer = FastCheck.integer()

  it.prop("runs pure properties", [integer], ([n]) => Number.isInteger(n), {
    fastCheck: { numRuns: 10 }
  })

  it.prop("derives pure properties from Schema", { n: Schema.Int }, ({ n }) => Number.isInteger(n), {
    fastCheck: { numRuns: 10 }
  })

  it.effect.prop(
    "derives arbitraries from Schema",
    { n: Schema.Int },
    ({ n }) => Effect.sync(() => assert.strictEqual(Number.isInteger(n), true)),
    {
      fastCheck: { numRuns: 10 }
    }
  )
})
