import { expect, test } from "bun:test"
import { createPromptAdmissionInterceptors } from "../src/plugin/prompt"

test("prompt admission interceptors may reconcile the same explicit input once", async () => {
  const prompt = createPromptAdmissionInterceptors()
  const seen: string[] = []
  let attempts = 0
  const unregister = prompt.register(async (input, next) => {
    seen.push(`${input.sessionID}:${input.inputID}`)
    try {
      await next()
    } catch {
      await next()
    }
  })

  await prompt.admit({ sessionID: "ses_prompt", inputID: "msg_prompt" }, async () => {
    attempts++
    if (attempts === 1) throw new TypeError("fetch failed")
  })

  expect(attempts).toBe(2)
  expect(seen).toEqual(["ses_prompt:msg_prompt"])
  expect(unregister()).toBe(true)

  await prompt.admit({ sessionID: "ses_prompt", inputID: "msg_direct" }, async () => {
    attempts++
  })
  expect(attempts).toBe(3)
})

test("clearing prompt admission interceptors removes product policy", async () => {
  const prompt = createPromptAdmissionInterceptors()
  let intercepted = false
  prompt.register(async (_input, next) => {
    intercepted = true
    await next()
  })
  prompt.clear()
  await prompt.admit({ sessionID: "ses_prompt", inputID: "msg_prompt" }, async () => {})
  expect(intercepted).toBe(false)
})
