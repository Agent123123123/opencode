export * as Tool from "./tool"

import { ToolDefinition, ToolFailure, ToolOutput, type ToolCall } from "@opencode-ai/llm"
import { Effect, JsonSchema, Schema } from "effect"
import type { AgentV2 } from "../agent"
import type { PermissionV2 } from "../permission"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"
import type { ToolExecution } from "./execution"

export interface Context {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly turnID: SessionMessage.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly activityInputIDs: ReadonlyArray<SessionMessage.ID>
  readonly toolCallID: string
  readonly abort: AbortSignal
  readonly progress: (output: ToolOutput) => Effect.Effect<void>
  readonly ask: (input: PermissionRequestInput) => Effect.Effect<void, unknown>
}

export type PermissionRequestInput = Omit<PermissionV2.AssertInput, "sessionID" | "agent" | "source">

export function permissionRequest(context: Context, input: PermissionRequestInput): PermissionV2.AssertInput {
  return {
    ...input,
    sessionID: context.sessionID,
    agent: context.agent,
    source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
  }
}

export type SchemaType<A> = Schema.Codec<A, any, never, never>

declare const TypeId: unique symbol

export interface Definition<Input extends SchemaType<any>, Output extends SchemaType<any>> {
  readonly [TypeId]: {
    readonly _Input: Input
    readonly _Output: Output
  }
}

export type AnyTool = Definition<any, any>
export const Failure = ToolFailure
export type Failure = ToolFailure

export class RegistrationError extends Schema.TaggedErrorClass<RegistrationError>()("Tool.RegistrationError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly data: string; readonly mime: string; readonly name?: string }
  | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }

type Config<
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
  Structured extends SchemaType<any> = Output,
  Authorization = void,
> = {
  readonly description: string
  readonly input: Input
  readonly inputJsonSchema?: JsonSchema.JsonSchema
  readonly output: Output
  readonly structured?: Structured
  readonly toStructuredOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => Schema.Schema.Type<Structured>
  readonly authorize?: (input: Schema.Schema.Type<Input>, context: Context) => Effect.Effect<Authorization, ToolFailure>
  readonly execute: (
    input: Schema.Schema.Type<Input>,
    context: Context,
    authorization: Authorization,
  ) => Effect.Effect<Schema.Schema.Type<Output>, ToolFailure>
  readonly toModelOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => ReadonlyArray<Content>
}

type Runtime = {
  readonly permission?: string
  readonly definition: (name: string) => ToolDefinition
  readonly settle: (
    name: string,
    call: ToolCall,
    context: Context,
    execution: ToolExecution.Interface,
  ) => Effect.Effect<ToolOutput, ToolFailure>
}

const runtimes = new WeakMap<AnyTool, Runtime>()

export function make<
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
  Structured extends SchemaType<any> = Output,
  Authorization = void,
>(config: Config<Input, Output, Structured, Authorization>): Definition<Input, Structured> {
  const tool = Object.freeze({}) as Definition<Input, Structured>
  const definitions = new Map<string, ToolDefinition>()
  runtimes.set(tool, {
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition = new ToolDefinition({
        name,
        description: config.description,
        inputSchema: config.inputJsonSchema ?? toJsonSchema(config.input),
        outputSchema: toJsonSchema(config.structured ?? config.output),
      })
      definitions.set(name, definition)
      return definition
    },
    settle: (name, call, context, execution) =>
      Effect.gen(function* () {
        const decode = Schema.decodeUnknownEffect(config.input)
        const invalidInput = (error: { readonly message: string }) =>
          new ToolFailure({ message: `Invalid tool input: ${error.message}` })
        let input = yield* decode(call.input).pipe(Effect.mapError(invalidInput))
        let authorization = config.authorize ? yield* config.authorize(input, context) : (undefined as Authorization)
        const invocation = {
          sessionID: context.sessionID,
          agent: context.agent,
          turnID: context.turnID,
          assistantMessageID: context.assistantMessageID,
          activityInputIDs: context.activityInputIDs,
          toolCallID: context.toolCallID,
          toolName: name,
          validatedInput: input,
        }
        const policyInput = yield* execution.before(invocation)
        if (!isDeepEqual(input, policyInput)) {
          const next = yield* decode(policyInput).pipe(Effect.mapError(invalidInput))
          input = next
          authorization = config.authorize ? yield* config.authorize(input, context) : (undefined as Authorization)
        }
        const value = yield* config.execute(input, context, authorization)
        const encoded = yield* Schema.encodeEffect(config.output)(value).pipe(
          Effect.flatMap((output) => {
            if (!config.structured || !config.toStructuredOutput) return Effect.succeed({ output, structured: output })
            return Schema.encodeEffect(config.structured)(config.toStructuredOutput({ input, output })).pipe(
              Effect.map((structured) => ({ output, structured })),
            )
          }),
          Effect.mapError(
            (error) =>
              new ToolFailure({
                message: `Tool returned an invalid value for its output schema: ${error.message}`,
              }),
          ),
        )
        const output: ToolOutput = {
          structured: encoded.structured,
          content:
            config.toModelOutput?.({ input, output: encoded.output }).map((part) =>
              part.type === "text"
                ? { type: "text" as const, text: part.text }
                : "uri" in part
                  ? { type: "file" as const, uri: part.uri, mime: part.mime, name: part.name }
                  : {
                      type: "file" as const,
                      uri: `data:${part.mime};base64,${part.data}`,
                      mime: part.mime,
                      name: part.name,
                    },
            ) ?? (typeof encoded.output === "string" ? [{ type: "text" as const, text: encoded.output }] : []),
        }
        return yield* execution.after({ ...invocation, validatedInput: input }, output)
      }),
  })
  return tool
}

export const validateName = (name: string) =>
  /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
    ? Effect.void
    : Effect.fail(new RegistrationError({ name, message: `Invalid tool name: ${name}` }))

export const withPermission = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  permission: string,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), permission })
  return decorated
}

export const permission = (tool: AnyTool, name: string) => runtimeOf(tool).permission ?? name
export const definition = (name: string, tool: AnyTool) => runtimeOf(tool).definition(name)
export const settle = (
  tool: AnyTool,
  name: string,
  call: ToolCall,
  context: Context,
  execution: ToolExecution.Interface,
) => runtimeOf(tool).settle(name, call, context, execution)

function runtimeOf(tool: AnyTool) {
  const runtime = runtimes.get(tool)
  if (!runtime) throw new TypeError("Invalid Core Tool value")
  return runtime
}

function toJsonSchema(schema: Schema.Top): JsonSchema.JsonSchema {
  const document = Schema.toJsonSchemaDocument(schema)
  if (Object.keys(document.definitions).length === 0) return document.schema
  return { ...document.schema, $defs: document.definitions }
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}
