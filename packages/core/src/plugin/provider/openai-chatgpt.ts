export * as OpenAIChatGPT from "./openai-chatgpt"

/** ChatGPT subscription capacity, distinct from OpenAI API model capacity. */
export const gpt56Limit = {
  context: 200_000,
  input: 72_000,
  output: 128_000,
} as const

export const isGPT56 = (modelID: string) => modelID.includes("gpt-5.6")
