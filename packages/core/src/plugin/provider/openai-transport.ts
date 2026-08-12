export * as OpenAITransport from "./openai-transport"

import os from "node:os"
import { Auth } from "@opencode-ai/llm/route"
import { Credential } from "../../credential"
import { InstallationVersion } from "../../installation/version"
import { ProviderV2 } from "../../provider"

export const codexBaseURL = "https://chatgpt.com/backend-api/codex"
export const codexResponsesURL = `${codexBaseURL}/responses`

export const codexHeaders = (input: { readonly sessionID?: string; readonly accountID?: string }) => ({
  originator: "opencode",
  "User-Agent": `opencode/${InstallationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`,
  ...(input.sessionID === undefined ? {} : { "session-id": input.sessionID }),
  ...(input.accountID === undefined ? {} : { "ChatGPT-Account-Id": input.accountID }),
})

/**
 * Projects a stored ChatGPT OAuth credential into the OpenAI transport it
 * authorizes. Token refresh remains owned by Integration.connection.resolve;
 * this boundary only maps the resolved credential into one request route.
 */
export const fromCredential = (input: {
  readonly providerID: ProviderV2.ID
  readonly credential?: Credential.Value
  readonly sessionID: string
}) => {
  if (input.providerID !== ProviderV2.ID.openai || input.credential?.type !== "oauth") return
  const accountID = input.credential.metadata?.accountID
  return {
    endpoint: { baseURL: codexBaseURL },
    headers: codexHeaders({
      sessionID: input.sessionID,
      accountID: typeof accountID === "string" ? accountID : undefined,
    }),
    auth: Auth.bearer(Auth.value(input.credential.access)),
  }
}
