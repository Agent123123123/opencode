import { expect, test } from "bun:test"
import { Layer, ManagedRuntime } from "effect"
import { LocationServiceMap, LocationServiceMapLive } from "@opencode-ai/core/location-layer"

test("process runtimes sharing the composition memo map reuse one LocationServiceMap identity", async () => {
  const memoMap = Layer.makeMemoMapUnsafe()
  const first = ManagedRuntime.make(LocationServiceMapLive, { memoMap })
  const second = ManagedRuntime.make(LocationServiceMapLive, { memoMap })
  try {
    const firstMap = await first.runPromise(LocationServiceMap)
    const secondMap = await second.runPromise(LocationServiceMap)
    expect(firstMap).toBe(secondMap)
  } finally {
    await Promise.allSettled([first.dispose(), second.dispose()])
  }
})
