import { it } from "@yeoularu/effect-bun-test"
import { Effect } from "effect"

it.live(
  "interrupts a timed out Effect",
  () =>
    Effect.acquireRelease(
      Effect.void,
      () => Effect.sync(() => console.log("effect-finalized"))
    ).pipe(Effect.andThen(Effect.never)),
  5
)
