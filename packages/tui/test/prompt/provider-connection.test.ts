import { expect, test } from "bun:test"
import {
  managedSessionProviderRequirement,
  providerConnectionRequirement,
} from "../../src/component/prompt/provider-connection"

test("recognizes only the typed provider connection error", () => {
  const error = {
    _tag: "ProviderConnectionRequiredError",
    providerID: "qianfan",
    modelID: "glm-5.2",
    variant: "default",
    message: "connect qianfan",
  }
  expect(providerConnectionRequirement(error)).toEqual({
    providerID: "qianfan",
    modelID: "glm-5.2",
    variant: "default",
    message: "connect qianfan",
  })
  expect(providerConnectionRequirement({ message: "Provider connection required for qianfan" })).toBeUndefined()
})

test("reports the exact managed model only while it is unavailable", () => {
  const session = {
    metadata: { executionManaged: true },
    model: { providerID: "qianfan", id: "glm-5.2", variant: "default" },
  }
  expect(managedSessionProviderRequirement(session, [])).toMatchObject({
    providerID: "qianfan",
    modelID: "glm-5.2",
    variant: "default",
  })
  expect(managedSessionProviderRequirement(session, [{ providerID: "qianfan", id: "glm-5.2" }])).toBeUndefined()
  expect(managedSessionProviderRequirement({ ...session, metadata: { executionManaged: false } }, [])).toBeUndefined()
})
