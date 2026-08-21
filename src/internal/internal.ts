/**
 * @since 0.1.0
 */

import * as B from "bun:test"
import * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { flow, pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import { isObject } from "effect/Predicate"
import * as Rec from "effect/Record"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as fc from "effect/testing/FastCheck"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"
import type * as Bun from "../index.ts"

type API = typeof B.test

const runPromise: <E, A>(effect: Effect.Effect<A, E, never>, signal?: AbortSignal) => Promise<A> = Effect.fnUntraced(
  function*<E, A>(effect: Effect.Effect<A, E>, _signal?: AbortSignal) {
    const exit = yield* Effect.exit(effect)
    if (Exit.isFailure(exit)) {
      const errors = Cause.prettyErrors(exit.cause)
      for (let i = 0; i < errors.length; i++) {
        yield* Effect.logError(errors[i])
      }
    }
    return yield* exit
  },
  (effect, _, signal) => Effect.runPromise(effect, { signal })
)

/** @internal */
export type TestContext = TestConsole.TestConsole | TestClock.TestClock

const TestEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer())

const testOptions = (options?: number | Bun.BunTest.TestOptions): number | B.TestOptions | undefined => {
  if (typeof options === "number" || options === undefined) {
    return options
  }
  const result: B.TestOptions = {}
  if (options.timeout !== undefined) result.timeout = options.timeout
  if (options.retry !== undefined) result.retry = options.retry
  if (options.repeats !== undefined) result.repeats = options.repeats
  return result
}

const hookTimeout = (timeout?: Duration.Input) =>
  timeout === undefined ? undefined : Duration.toMillis(Duration.fromInputUnsafe(timeout))

const runHook = <E, A>(effect: Effect.Effect<A, E, never>, timeout?: Duration.Input) => {
  const millis = hookTimeout(timeout)
  return runPromise(effect, millis === undefined ? undefined : AbortSignal.timeout(millis))
}

const makeRunner = (timeout?: number) => {
  const controller = new AbortController()
  let running: Promise<unknown> | undefined
  let timedOut = false
  const timer = timeout === undefined
    ? undefined
    : setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeout)
  const context: Bun.BunTest.TestContext = {
    signal: controller.signal,
    onTestFinished: B.onTestFinished
  }

  B.onTestFinished(() => {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
    return running?.then(
      () => undefined,
      () => undefined
    )
  })

  return {
    context,
    get timedOut() {
      return timedOut
    },
    run<E, A>(effect: Effect.Effect<A, E, never>) {
      const promise = runPromise(effect, controller.signal).catch((error) => {
        if (controller.signal.aborted) {
          return undefined as A
        }
        throw error
      })
      running = promise
      return promise
    }
  }
}

const makeItProxy = <Methods extends object>(
  it: API,
  overrides: Methods
): Methods & API =>
  new Proxy(it as Methods & API, {
    apply(target, thisArg, argArray) {
      return Reflect.apply(target, thisArg, argArray)
    },
    get(target, property) {
      if (Object.hasOwn(overrides, property)) {
        return Reflect.get(overrides, property)
      }
      return Reflect.get(target, property, target)
    }
  })

/** @internal */
const makeTester = <R>(
  mapEffect: <A, E>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, never>,
  it: API = B.it
): Bun.BunTest.Tester<R> => {
  const runWith = <A, E>(
    runner: ReturnType<typeof makeRunner>,
    self: (ctx: Bun.BunTest.TestContext) => Effect.Effect<A, E, R>
  ) => runner.run(pipe(Effect.suspend(() => self(runner.context)), mapEffect))

  const run = <A, E>(self: (ctx: Bun.BunTest.TestContext) => Effect.Effect<A, E, R>) => runWith(makeRunner(), self)

  const f: Bun.BunTest.Test<R> = (name, self, options) => it.serial(name, () => run(self), testOptions(options))

  const skip: Bun.BunTest.Tester<R>["skip"] = (name, self, options) =>
    it.skip(name, () => run(self), testOptions(options))

  const skipIf: Bun.BunTest.Tester<R>["skipIf"] = (condition) => (name, self, options) =>
    it.skipIf(Boolean(condition)).serial(name, () => run(self), testOptions(options))

  const runIf: Bun.BunTest.Tester<R>["runIf"] = (condition) => (name, self, options) =>
    it.if(Boolean(condition)).serial(name, () => run(self), testOptions(options))

  const only: Bun.BunTest.Tester<R>["only"] = (name, self, options) =>
    it.only.serial(name, () => run(self), testOptions(options))

  const each: Bun.BunTest.Tester<R>["each"] = (cases) => (name, self, options) =>
    it.serial.each(cases.map((value) => [value] as const))(
      name,
      (value) => run(() => self(value)),
      testOptions(options)
    )

  const fails: Bun.BunTest.Tester<R>["fails"] = (name, self, options) => {
    const timeout = typeof options === "number" ? options : options?.timeout
    if (timeout === undefined) {
      return it.failing.serial(name, () => run(self), testOptions(options))
    }
    const converted = testOptions(options)
    // ponytail: Bun does not invert runner timeouts for test.failing; remove the cleanup window when it does.
    const failingOptions: B.TestOptions = {
      ...(typeof converted === "object" ? converted : {}),
      timeout: timeout + 1_000
    }
    return it.serial(
      name,
      () => {
        const runner = makeRunner(timeout)
        return runWith(runner, self).then(
          () => {
            if (runner.timedOut) return
            throw new Error("Expected Effect test to fail")
          },
          () => undefined
        )
      },
      failingOptions
    )
  }

  const prop: Bun.BunTest.Tester<R>["prop"] = (name, arbitraries, self, options) => {
    if (Array.isArray(arbitraries)) {
      const arbs = arbitraries.map((arbitrary) =>
        Schema.isSchema(arbitrary) ? Schema.toArbitrary(arbitrary)(fc) : arbitrary as fc.Arbitrary<any>
      )
      return it.serial(
        name,
        () => {
          const runner = makeRunner()
          return fc.assert(
            // @ts-ignore
            fc.asyncProperty(...arbs, (...as) =>
              runner.run(pipe(
                Effect.suspend(() => self(as as any, runner.context)),
                mapEffect
              ))),
            // @ts-ignore
            isObject(options) ? options.fastCheck : {}
          )
        },
        testOptions(options)
      )
    }

    const arbs = fc.record(
      Object.keys(arbitraries).reduce(function(result, key) {
        const arbitrary: any = arbitraries[key]
        Rec.assignProperty(result, key, Schema.isSchema(arbitrary) ? Schema.toArbitrary(arbitrary)(fc) : arbitrary)
        return result
      }, {} as Record<string, fc.Arbitrary<any>>)
    )

    return it.serial(
      name,
      () => {
        const runner = makeRunner()
        return fc.assert(
          // @ts-ignore
          fc.asyncProperty(arbs, (as) =>
            // @ts-ignore
            runner.run(pipe(
              Effect.suspend(() => self(as as any, runner.context)),
              mapEffect
            ))),
          // @ts-ignore
          isObject(options) ? options.fastCheck : {}
        )
      },
      testOptions(options)
    )
  }

  return Object.assign(f, { skip, skipIf, runIf, only, each, fails, prop })
}

/** @internal */
export const prop: Bun.BunTest.Methods["prop"] = (name, arbitraries, self, options) => {
  if (Array.isArray(arbitraries)) {
    const arbs = arbitraries.map((arbitrary) =>
      Schema.isSchema(arbitrary) ? Schema.toArbitrary(arbitrary)(fc) : arbitrary
    )
    return B.it.serial(
      name,
      () => {
        const runner = makeRunner()
        return fc.assert(
          // @ts-ignore
          fc.property(...arbs, (...as) => self(as, runner.context)),
          // @ts-ignore
          isObject(options) ? options.fastCheck : {}
        )
      },
      testOptions(options)
    )
  }

  const arbs = fc.record(
    Object.keys(arbitraries).reduce(function(result, key) {
      const arbitrary: any = arbitraries[key]
      Rec.assignProperty(result, key, Schema.isSchema(arbitrary) ? Schema.toArbitrary(arbitrary)(fc) : arbitrary)
      return result
    }, {} as Record<string, fc.Arbitrary<any>>)
  )

  return B.it.serial(
    name,
    () => {
      const runner = makeRunner()
      return fc.assert(
        fc.property(arbs, (as) => self(as as any, runner.context)),
        // @ts-ignore
        isObject(options) ? options.fastCheck : {}
      )
    },
    testOptions(options)
  )
}

/** @internal */
export const layer = <R, E>(
  layer_: Layer.Layer<R, E>,
  options?: {
    readonly memoMap?: Layer.MemoMap
    readonly timeout?: Duration.Input
    readonly excludeTestServices?: boolean
  }
): {
  (f: (it: Bun.BunTest.MethodsNonLive<R>) => void): void
  (name: string, f: (it: Bun.BunTest.MethodsNonLive<R>) => void): void
} =>
(
  ...args:
    | [name: string, f: (it: Bun.BunTest.MethodsNonLive<R>) => void]
    | [f: (it: Bun.BunTest.MethodsNonLive<R>) => void]
) => {
  const excludeTestServices = options?.excludeTestServices ?? false
  const withTestEnv = excludeTestServices
    ? layer_ as Layer.Layer<R, E>
    : Layer.provideMerge(layer_, TestEnv)
  const memoMap = options?.memoMap ?? Effect.runSync(Layer.makeMemoMap)
  const scope = Effect.runSync(Scope.make())
  const contextEffect = Layer.buildWithMemoMap(withTestEnv, memoMap, scope).pipe(
    Effect.orDie,
    Effect.cached,
    Effect.runSync
  )
  let closed = false
  const closeScope = () => {
    if (closed) {
      return Promise.resolve()
    }
    closed = true
    return runHook(Scope.close(scope, Exit.void), options?.timeout)
  }

  const makeIt = (it: API): Bun.BunTest.MethodsNonLive<R> =>
    makeItProxy(it, {
      describe: B.describe,
      effect: makeTester<R | Scope.Scope>(
        (effect) =>
          Effect.flatMap(contextEffect, (context) =>
            effect.pipe(
              Effect.scoped,
              Effect.provide(context)
            )),
        it
      ),
      prop,
      flakyTest,
      layer<R2, E2>(nestedLayer: Layer.Layer<R2, E2, R>, nestedOptions?: {
        readonly timeout?: Duration.Input
      }) {
        return layer(Layer.provideMerge(nestedLayer, withTestEnv), {
          ...nestedOptions,
          memoMap: Layer.forkMemoMapUnsafe(memoMap),
          excludeTestServices
        })
      }
    })

  const define = (f: (it: Bun.BunTest.MethodsNonLive<R>) => void) => {
    B.beforeAll(
      () => runHook(Effect.asVoid(contextEffect), options?.timeout),
      hookTimeout(options?.timeout)
    )
    B.afterAll(closeScope, hookTimeout(options?.timeout))
    return f(makeIt(B.it))
  }

  if (args.length === 1) {
    return B.describe.serial(() => define(args[0]))
  }
  return B.describe.serial(args[0], () => define(args[1]))
}

/** @internal */
export const flakyTest = <A, E, R>(
  self: Effect.Effect<A, E, R | Scope.Scope>,
  timeout: Duration.Input = Duration.seconds(30)
) =>
  pipe(
    self,
    Effect.scoped,
    Effect.sandbox,
    Effect.retry(
      pipe(
        Schedule.recurs(10),
        Schedule.while((_) =>
          Effect.succeed(Duration.isLessThanOrEqualTo(
            Duration.fromInputUnsafe(_.elapsed),
            Duration.fromInputUnsafe(timeout)
          ))
        )
      )
    ),
    Effect.orDie
  )

/** @internal */
export const makeMethods = (it: API): Bun.BunTest.Methods =>
  makeItProxy(it, {
    describe: B.describe,
    effect: makeTester<Scope.Scope>(flow(Effect.scoped, Effect.provide(TestEnv)), it),
    live: makeTester<Scope.Scope>(Effect.scoped, it),
    flakyTest,
    layer,
    prop
  })
