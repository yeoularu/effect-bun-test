/**
 * Effect v4 helpers for Bun's native `bun:test` runner.
 *
 * Effect tests receive a fresh `Scope`; `it.effect` also provides `TestClock`
 * and `TestConsole`, while `it.live` keeps the live Effect environment.
 * Effect-returning tests are registered as serial tests so Bun can reliably
 * run timeout cleanup through `onTestFinished`.
 *
 * @since 0.1.0
 * @packageDocumentation
 */
import * as B from "bun:test"
import type * as Duration from "effect/Duration"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as FC from "effect/testing/FastCheck"
import * as internal from "./internal/internal.ts"

/** The standard Bun test API, re-exported for one-import test files. */
export * from "bun:test"

/** Strict Node assertion helpers. */
export { strict as assert } from "node:assert"

type API = typeof B.test

/** Public types used by the Effect-aware Bun test API. */
export namespace BunTest {
  /**
   * Context passed to Effect test callbacks.
   *
   * The signal aborts after the test finishes or times out. Cleanup registered
   * with `onTestFinished` runs through Bun's native lifecycle.
   *
   * @since 0.1.0
   */
  export interface TestContext {
    readonly signal: AbortSignal
    readonly onTestFinished: typeof B.onTestFinished
  }

  /**
   * Bun test options plus FastCheck parameters for property tests.
   *
   * @since 0.1.0
   */
  export interface TestOptions extends B.TestOptions {
    readonly fastCheck?: FC.Parameters<any>
  }

  /** An Effect-returning test callback. */
  export interface TestFunction<A, E, R, TestArgs extends Array<any>> {
    (...args: TestArgs): Effect.Effect<A, E, R>
  }

  /** Registers an Effect-returning Bun test. */
  export interface Test<R> {
    <A, E>(
      name: string,
      self: TestFunction<A, E, R, [TestContext]>,
      options?: number | TestOptions
    ): void
  }

  /** Schema values or FastCheck arbitraries accepted by property tests. */
  export type Arbitraries =
    | Array<Schema.Schema<any> | FC.Arbitrary<any>>
    | { [K in string]: Schema.Schema<any> | FC.Arbitrary<any> }

  /**
   * Effect test registration with Bun modifiers and property testing.
   *
   * @since 0.1.0
   */
  export interface Tester<R> extends BunTest.Test<R> {
    skip: BunTest.Test<R>
    skipIf: (condition: unknown) => BunTest.Test<R>
    runIf: (condition: unknown) => BunTest.Test<R>
    only: BunTest.Test<R>
    each: <T>(
      cases: ReadonlyArray<T>
    ) => <A, E>(name: string, self: TestFunction<A, E, R, Array<T>>, options?: number | TestOptions) => void
    fails: BunTest.Test<R>

    /** Runs an Effect property test, deriving arbitraries from Schema values when needed. */
    prop: <const Arbs extends Arbitraries, A, E>(
      name: string,
      arbitraries: Arbs,
      self: TestFunction<
        A,
        E,
        R,
        [
          {
            [K in keyof Arbs]: Arbs[K] extends FC.Arbitrary<infer T> ? T
              : Arbs[K] extends Schema.Schema<infer T> ? T
              : never
          },
          TestContext
        ]
      >,
      options?: number | TestOptions
    ) => void
  }

  /** Effect-aware methods available inside a shared Layer scope. */
  export interface MethodsNonLive<R = never> extends API {
    readonly describe: typeof B.describe

    /** Runs a scoped Effect with `TestClock` and `TestConsole`. */
    readonly effect: BunTest.Tester<R | Scope.Scope>

    /** Retries an Effect up to ten times (eleven total attempts) within the elapsed-time budget. */
    readonly flakyTest: <A, E, R2>(
      self: Effect.Effect<A, E, R2 | Scope.Scope>,
      timeout?: Duration.Input
    ) => Effect.Effect<A, never, R2>

    /** Creates an isolated nested Layer scope that can depend on the parent Layer. */
    readonly layer: <R2, E>(layer: Layer.Layer<R2, E, R>, options?: {
      readonly timeout?: Duration.Input
    }) => {
      (f: (it: BunTest.MethodsNonLive<R | R2>) => void): void
      (name: string, f: (it: BunTest.MethodsNonLive<R | R2>) => void): void
    }

    /** Runs a pure property test with Schema values or FastCheck arbitraries. */
    readonly prop: <const Arbs extends Arbitraries>(
      name: string,
      arbitraries: Arbs,
      self: (
        properties: {
          [K in keyof Arbs]: Arbs[K] extends FC.Arbitrary<infer T> ? T
            : Arbs[K] extends Schema.Schema<infer T> ? T
            : never
        },
        ctx: TestContext
      ) => void,
      options?: number | TestOptions
    ) => void
  }

  /** The complete Effect-aware `it` / `test` API. */
  export interface Methods<R = never> extends MethodsNonLive<R> {
    /** Runs a scoped Effect with the live clock and console. */
    readonly live: BunTest.Tester<Scope.Scope | R>

    /**
     * Shares a Layer across a serial suite.
     *
     * Test services are provided by default. Set `excludeTestServices` to
     * `true` when the Layer must capture the live clock or console.
     */
    readonly layer: <R2, E>(layer: Layer.Layer<R2, E, R>, options?: {
      readonly memoMap?: Layer.MemoMap
      readonly timeout?: Duration.Input
      readonly excludeTestServices?: boolean
    }) => {
      (f: (it: BunTest.MethodsNonLive<R | R2>) => void): void
      (name: string, f: (it: BunTest.MethodsNonLive<R | R2>) => void): void
    }
  }
}

/**
 * Shares a Layer across multiple serial tests and closes it after the suite.
 * Nested Layer scopes reuse parent allocations while isolating sibling-local
 * resources.
 *
 * @example
 * ```ts
 * import { assert, layer } from "@yeoularu/effect-bun-test"
 * import { Context, Effect, Layer } from "effect"
 *
 * class Database extends Context.Service<Database, "test">()("Database") {}
 *
 * layer(Layer.succeed(Database)("test"))("database", (it) => {
 *   it.effect("provides the database", () =>
 *     Effect.gen(function*() {
 *       assert.strictEqual(yield* Database, "test")
 *     }))
 * })
 * ```
 *
 * @since 0.1.0
 */
export const layer: <R, E>(
  layer_: Layer.Layer<R, E>,
  options?: {
    readonly memoMap?: Layer.MemoMap
    readonly timeout?: Duration.Input
    readonly excludeTestServices?: boolean
  }
) => {
  (f: (it: BunTest.MethodsNonLive<R>) => void): void
  (name: string, f: (it: BunTest.MethodsNonLive<R>) => void): void
} = internal.layer

/**
 * Retries a flaky Effect up to ten times (eleven total attempts) until it
 * succeeds or exceeds the elapsed-time budget. The default budget is 30
 * seconds. Exhausted failures become defects so the surrounding test fails.
 *
 * @since 0.1.0
 */
export const flakyTest: <A, E, R>(
  self: Effect.Effect<A, E, R | Scope.Scope>,
  timeout?: Duration.Input
) => Effect.Effect<A, never, R> = internal.flakyTest

/**
 * Bun's `it` function enhanced with Effect tests, shared Layers, property
 * tests, and bounded retries.
 *
 * @example
 * ```ts
 * import { assert, it } from "@yeoularu/effect-bun-test"
 * import { Effect } from "effect"
 *
 * it.effect("runs an Effect", () =>
 *   Effect.sync(() => assert.strictEqual(1 + 1, 2)))
 * ```
 *
 * @since 0.1.0
 */
export const it: BunTest.Methods = internal.makeMethods(B.it)

/** `it` under Bun's `test` name. */
export const test: BunTest.Methods = internal.makeMethods(B.test)
