import { expect, test } from "bun:test"
import { managedSessionProviderRequirement } from "../../src/component/prompt/provider-connection"

test("reports the exact managed model only while it is unavailable", () => {
  const session = {
    metadata: { executionManaged: true },
    model: { providerID: "qianfan", id: "glm-5.2", variant: "default" },
  }
  expect(managedSessionProviderRequirement(session, [])).toMatchObject({
    providerID: "qianfan",
    modelID: "glm-5.2",
    variant: "default",
    message: "Connect qianfan for model execution with glm-5.2#default",
  })
  expect(managedSessionProviderRequirement(session, [{ providerID: "qianfan", id: "glm-5.2" }])).toBeUndefined()
  expect(managedSessionProviderRequirement({ ...session, metadata: { executionManaged: false } }, [])).toBeUndefined()
})
