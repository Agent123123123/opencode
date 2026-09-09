import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  providerEventFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { Cause, DateTime, Effect, Exit, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Flag } from "../../flag/flag"
import { InstallationUserAgent } from "../../installation/version"
import { Integration } from "../../integration"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionMessage } from "../message"
import { SessionModelContext } from "../model-context"
import { SessionSchema } from "../schema"
import { ManagedSessionAuthority } from "../authority"
import { SessionStore } from "../store"
import { ManagedTurnError, type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { SessionModelSwitch } from "../model-switch"
import { createLLMEventPublisher } from "./publish-llm-event"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@opencode-ai/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const permissions = yield* PermissionV2.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const db = (yield* Database.Service).db
    const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: declining a user prompt halts the loop instead of becoming model-facing tool output.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError),
      )

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    type Activity = {
      readonly turnID: SessionMessage.ID
      startCommitEntered: boolean
      started: boolean
      notStarted: boolean
      turnStartedAt?: DateTime.Utc
      activityInputIDs: ReadonlyArray<SessionMessage.ID>
      interruptedToolsReconciled: boolean
      providerID?: string
      modelID?: string
      providerWarning?: SessionEvent.Turn.Failure
      managed: boolean
      completion?: SessionInput.Completion
      managedExecution?: SessionInput.ManagedExecutionRef
      correctionActive: boolean
      correctionUsed: boolean
      terminalTool?: { readonly callID: string; readonly name: string }
      preStartRetryCount: number
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    const loadSystemContext = (
      session: SessionSchema.Info,
      agent: AgentV2.Selection,
      effectiveModel: ModelV2.Ref,
      activityInputIDs: ReadonlyArray<SessionMessage.ID>,
    ) =>
      Effect.all(
        [
          systemContext.load({ session, agent, effectiveModel, activityInputIDs }),
          skillGuidance.load(agent),
          referenceGuidance.load(),
        ],
        {
          concurrency: "unbounded",
        },
      ).pipe(Effect.map(SystemContext.combine))

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      activity: Activity,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      let needsContinuation = false
      let currentStep = step
      const cutoff = promotion ? yield* EventV2.latestSequence(db, session.id) : -1
      const pendingActivityInputIDs = promotion
        ? yield* SessionInput.pendingActivityIDs(db, session.id, promotion, cutoff)
        : []
      activity.activityInputIDs = mergeInputIDs(activity.activityInputIDs, pendingActivityInputIDs)
      if (promotion) {
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
        if (promoted > 0) currentStep = 1
      }
      // Establish failure ownership before model/credential/context preparation.
      // History remains context, not authority to adopt inputs of an older Turn.
      const activityInputIDs =
        activity.activityInputIDs.length > 0
          ? activity.activityInputIDs
          : currentActivityInputIDs(yield* getContext(session.id))
      activity.activityInputIDs = activityInputIDs
      activity.managed = session.execution.managed
      activity.providerID = session.model?.providerID
      activity.modelID = session.model?.id
      if (session.execution.managed) {
        if (activityInputIDs.length !== 1) {
          return yield* new ManagedTurnError({
            kind: "protocol",
            message: `Managed Turn requires exactly one root Input; received ${activityInputIDs.length}`,
          })
        }
        const root = yield* SessionInput.find(db, activityInputIDs[0]!)
        if (
          !root || root.sessionID !== session.id || root.delivery !== "queue" ||
          root.promotedSeq === undefined || !root.completion
        ) {
          return yield* new ManagedTurnError({
            kind: "protocol",
            message: "Managed Turn root Input lacks queued promotion or its durable completion contract",
          })
        }
        if (activity.completion && activity.completion.digest !== root.completion.digest) {
          return yield* new ManagedTurnError({
            kind: "protocol",
            message: "Managed Turn completion contract changed during execution",
          })
        }
        activity.completion = root.completion
        const execution = root.completion.managedExecution
        activity.managedExecution = execution?.origin === "DIRECT_USER"
          ? ManagedSessionAuthority.executionRef(session.id, activityInputIDs[0]!) ?? execution
          : execution
      }
      if (!activity.interruptedToolsReconciled) {
        yield* failInterruptedTools(session.id)
        activity.interruptedToolsReconciled = true
      }
      const agent = yield* agents.select(session.agent)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      const model = yield* models.resolve(session)
      activity.providerID = model.provider
      activity.modelID = model.id
      const effectiveModel = {
        id: ModelV2.ID.make(model.id),
        providerID: ProviderV2.ID.make(model.provider),
        ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
      }
      const contextSource = loadSystemContext(session, agent, effectiveModel, activityInputIDs)
      const initialized = yield* SessionContextEpoch.initialize(db, contextSource, session.id)
      const system = initialized ?? (yield* SessionContextEpoch.prepare(db, events, contextSource, session.id))
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const projection = yield* SessionModelContext.projectEntries(entries, model)
      const completionContract = activity.completion?.contract
      const requiresTerminalTool = completionContract?.mode === "required_terminal_tool"
      const isLastStep = !activity.correctionActive && agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolsDisabled = isLastStep && !requiresTerminalTool
      const toolMaterialization = toolsDisabled ? undefined : yield* tools.materialize(agent.info?.permissions)
      if (requiresTerminalTool) {
        const available = new Set(toolMaterialization?.definitions.map((tool) => tool.name) ?? [])
        if (!completionContract.terminalTools.some((name) => available.has(name))) {
          return yield* new ManagedTurnError({
            kind: "protocol",
            message: `No managed completion tool is available: ${completionContract.terminalTools.join(", ")}`,
          })
        }
      }
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const request = LLM.request({
        model,
        providerOptions: { openai: { promptCacheKey } },
        http: model.provider.startsWith("opencode")
          ? {
              headers: {
                "x-opencode-project": location.project.id,
                "x-opencode-session": session.id,
                "x-opencode-request": activity.turnID,
                "x-opencode-client": Flag.OPENCODE_CLIENT,
                "user-agent": InstallationUserAgent,
              },
            }
          : undefined,
        system: [agent.info?.system, system.baseline]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: [
          ...projection.messages,
          ...(toolsDisabled ? [Message.assistant(MAX_STEPS_PROMPT)] : []),
          ...(activity.correctionActive && completionContract?.mode === "required_terminal_tool"
            ? [Message.system(completionContract.correction.instruction)]
            : []),
        ],
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: toolsDisabled ? "none" : undefined,
      })
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries: projection.entries, model, request }))
        return yield* Effect.die(continueAfterCompaction(currentStep))
      const startSnapshot = yield* snapshots.capture()
      if (!activity.started) {
        const turnStartedAt = yield* DateTime.now
        activity.turnStartedAt = turnStartedAt
        // A failure after entering the durable publish window is ambiguous
        // until replay proves whether Started committed. Never emit a
        // contradictory NotStarted proof from this window.
        activity.startCommitEntered = true
        yield* events.publish(SessionEvent.Turn.Started, {
          sessionID: session.id,
          timestamp: turnStartedAt,
          turnID: activity.turnID,
          turnStartedAt,
          activityInputIDs,
          completionContractDigest: activity.completion?.digest,
          managedExecution: activity.managedExecution,
        })
        activity.started = true
      }
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        turnID: activity.turnID,
        activityInputIDs,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
        snapshot: startSnapshot,
        managedExecution: activity.managedExecution,
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
      let providerFailure: ProviderErrorEvent | undefined
      const providerStream = llm.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
              providerFailure = event
            }
            yield* publish(event)
            if (event.type !== "tool-call" || event.providerExecuted) return
            if (!toolMaterialization) {
              yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
              return
            }
            needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  turnID: activity.turnID,
                  assistantMessageID,
                  activityInputIDs,
                  call: event,
                  progress: (output) => withPublication(publisher.progress(event.id, output)),
                  ask: (request) =>
                    permissions.assert({
                      ...request,
                      sessionID: session.id,
                      agent: agent.id,
                      source: { type: "tool", messageID: assistantMessageID, callID: event.id },
                    }),
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  ),
                ),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        Effect.provideService(RequestExecutor.RetryObserver, (observation) =>
          withPublication(Effect.gen(function* () {
            yield* events.publish(SessionEvent.Retried, {
              sessionID: session.id,
              timestamp: yield* DateTime.now,
              turnID: activity.turnID,
              activityInputIDs,
              requestID: observation.requestID,
              phase: observation.phase,
              retryAttempt: observation.retryAttempt,
              retryLimit: observation.retryLimit,
              retryNotBefore: observation.phase === "waiting" ? DateTime.makeUnsafe(observation.retryNotBefore) : undefined,
              failure: runtimeFailure(observation.error, model.provider, model.id),
            })
          })),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(recoverOverflow({ sessionID: session.id, entries: projection.entries, model, request })))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) {
            providerFailure = overflowFailure
            yield* publish(overflowFailure)
          }
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message))
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
          if (stream._tag === "Failure")
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result"))
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement && !publisher.hasProviderError()) {
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: stepSettlement.finish,
                cost: 0,
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
              }),
            )
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result"))
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) {
            return yield* Effect.failCause(stream.cause)
          }
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause)) {
            return yield* Effect.failCause(settled.cause)
          }
          const terminalTool = completionContract?.mode === "required_terminal_tool"
            ? publisher.successfulLocalTools().find((tool) => completionContract.terminalTools.includes(tool.name))
            : undefined
          if (terminalTool) {
            activity.terminalTool = terminalTool
            const warning = failure instanceof LLMError
              ? failure
              : providerFailure
                ? providerEventFailure(providerFailure)
                : undefined
            if (warning) activity.providerWarning = runtimeFailure(warning, activity.providerID, activity.modelID)
            return { needsContinuation: false, step: currentStep }
          }
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          if (providerFailure) return yield* providerEventFailure(providerFailure)
          if (session.execution.managed && stepSettlement?.finish === "length") {
            return yield* new ManagedTurnError({
              kind: "resource",
              message: "Managed Turn reached the provider output limit before completion",
            })
          }
          if (completionContract?.mode === "required_terminal_tool") {
            if (activity.correctionActive) {
              return yield* new ManagedTurnError({
                kind: "protocol",
                message: "Managed completion contract remained unsatisfied after correction",
              })
            }
            if (stepSettlement?.finish === "stop") {
              activity.correctionUsed = true
              activity.correctionActive = true
              yield* events.publish(SessionEvent.Turn.Correction, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                turnID: activity.turnID,
                rootInputID: activityInputIDs[0]!,
                contractDigest: activity.completion!.digest,
                ordinal: 1,
                reason: "missing_required_terminal_tool",
                instruction: completionContract.correction.instruction,
              })
              return { needsContinuation: true, step: currentStep }
            }
            if (isLastStep || !needsContinuation) {
              return yield* new ManagedTurnError({
                kind: "protocol",
                message: "Managed completion contract remained unsatisfied at the Step limit",
              })
            }
          }
          return { needsContinuation: !publisher.hasProviderError() && needsContinuation, step: currentStep }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      activity: Activity,
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, activity) {
      return yield* runTurnAttempt(sessionID, promotion, step, activity).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step, activity)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, activity) {
      return yield* runTurnAttempt(sessionID, promotion, step, activity, compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step, activity)
            return yield* runTurn(sessionID, undefined, defect.transition.step, activity)
          }),
        ),
        Effect.catch((error) => {
          if (
            activity.started || !(error instanceof SystemContext.InitializationBlocked) ||
            activity.preStartRetryCount >= 2
          ) return Effect.fail(error)
          activity.preStartRetryCount += 1
          return Effect.yieldNow.pipe(Effect.andThen(runTurn(sessionID, promotion, step, activity)))
        }),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      const session = yield* getSession(input.sessionID)
      yield* SessionModelSwitch.applyPending(db, events, input.sessionID)
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      const hasOrphanedPromotion = yield* SessionInput.hasOrphanedPromoted(db, input.sessionID)
      const forced = input.force && !session.execution.managed
      if (!forced && !hasSteer && !hasQueue && !hasOrphanedPromotion) return
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = forced || hasSteer || hasQueue || hasOrphanedPromotion
      let preparationFailure: Cause.Cause<RunError> | undefined
      while (shouldRun) {
        yield* SessionModelSwitch.applyPending(db, events, input.sessionID)
        const activity: Activity = {
          turnID: SessionMessage.ID.create(),
          startCommitEntered: false,
          started: false,
          notStarted: false,
          activityInputIDs: [],
          interruptedToolsReconciled: false,
          managed: false,
          correctionActive: false,
          correctionUsed: false,
          preStartRetryCount: 0,
        }
        const activityExit = yield* Effect.uninterruptibleMask((restore) =>
          restore(
            Effect.gen(function* () {
              let needsContinuation = true
              let step = 1
              while (needsContinuation) {
                const result = yield* runTurn(input.sessionID, promotion, step, activity)
                needsContinuation = result.needsContinuation
                step = result.step + 1
                promotion = activity.managed ? undefined : "steer"
                if (!activity.managed && !needsContinuation) {
                  needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
                }
              }
            }),
          ).pipe(
            Effect.exit,
            Effect.tap((exit) =>
              Effect.gen(function* () {
                const interrupted = Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
                const error = Exit.isFailure(exit)
                  ? (Option.getOrUndefined(Cause.findErrorOption(exit.cause)) ?? Cause.squash(exit.cause))
                  : undefined
                const failureReason = interrupted
                  ? "Activity interrupted"
                  : error instanceof Error
                    ? error.message
                    : typeof error === "string"
                      ? error
                      : "Activity failed"

                if (!activity.started) {
                  if (activity.startCommitEntered || !Exit.isFailure(exit) || activity.activityInputIDs.length === 0)
                    return
                  const promotedInputIDs: SessionMessage.ID[] = []
                  for (const inputID of activity.activityInputIDs) {
                    const admitted = yield* SessionInput.find(db, inputID)
                    if (admitted?.promotedSeq !== undefined) promotedInputIDs.push(inputID)
                  }
                  if (promotedInputIDs.length === 0) return
                  const failure = runtimeFailure(error, activity.providerID, activity.modelID)
                  const terminal = yield* events.publish(SessionEvent.Turn.NotStarted, {
                    sessionID: input.sessionID,
                    timestamp: yield* DateTime.now,
                    schema: "opencode.turn_not_started.v2",
                    turnID: activity.turnID,
                    activityInputIDs: promotedInputIDs,
                    outcome: interrupted ? "interrupted" : "failed",
                    reason: failureReason,
                    errorClass: interrupted ? "interrupt" : runtimeErrorClass(error),
                    managedExecution: activity.managedExecution,
                    ...(!interrupted
                      ? {
                          failure: {
                            ...failure,
                            // No tool execution was started for this Input.
                            // An unexpected preparation failure is a protocol
                            // failure, not evidence of an unknown external effect.
                            ...(activity.managed && failure.kind === "unknown"
                              ? { kind: "protocol_contract_unsatisfied" as const }
                              : {}),
                            ...(error instanceof SystemContext.InitializationBlocked
                              ? { retryable: true, retryExhausted: true }
                              : {}),
                            attemptCount: Math.max(failure.attemptCount, activity.preStartRetryCount + 1),
                          },
                        }
                      : {}),
                  })
                  if (!terminal.durable) return yield* Effect.die("NotStarted proof was not durably committed")
                  activity.notStarted = true
                  revokeActivityInputGrants(input.sessionID, promotedInputIDs, activity.managedExecution)
                  return
                }

                const turnStartedAt = activity.turnStartedAt
                if (!turnStartedAt) return yield* Effect.die("Started activity is missing its start timestamp")
                yield* events.publish(SessionEvent.Turn.Settled, {
                  sessionID: input.sessionID,
                  timestamp: yield* DateTime.now,
                  schema: "opencode.turn_settled.v3",
                  turnID: activity.turnID,
                  turnStartedAt,
                  activityInputIDs: activity.activityInputIDs,
                  outcome: interrupted ? "aborted" : Exit.isFailure(exit) ? "error" : "completed",
                  managedExecution: activity.managedExecution,
                  ...(activity.terminalTool
                    ? {
                        completion: {
                          mode: "required_terminal_tool" as const,
                          correctionSteps: activity.correctionUsed ? 1 as const : 0 as const,
                          terminalTool: activity.terminalTool,
                        },
                      }
                    : activity.completion?.contract.mode === "ordinary_stop" && !Exit.isFailure(exit)
                      ? { completion: { mode: "ordinary_stop" as const, correctionSteps: 0 as const } }
                      : {}),
                  ...(activity.providerWarning ? { providerWarning: activity.providerWarning } : {}),
                  ...(Exit.isFailure(exit)
                    ? {
                        reason: failureReason,
                        errorClass: interrupted ? ("interrupt" as const) : runtimeErrorClass(error),
                        ...(interrupted ? { abortOrigin: "framework" as const } : {}),
                        ...(!interrupted
                          ? { failure: runtimeFailure(error, activity.providerID, activity.modelID) }
                          : {}),
                      }
                    : {}),
                })
                revokeActivityInputGrants(input.sessionID, activity.activityInputIDs, activity.managedExecution)
              }),
            ),
          ),
        )
        yield* SessionModelSwitch.applyPending(db, events, input.sessionID)
        if (Exit.isFailure(activityExit)) {
          if (!activity.managed || !activity.notStarted || Cause.hasInterrupts(activityExit.cause)) {
            return yield* Effect.failCause(activityExit.cause)
          }
          // A terminal no-start must not strand the next separately admitted
          // Input. Preserve the failure for explicit callers after draining.
          preparationFailure ??= activityExit.cause
        }
        shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = shouldRun ? "queue" : undefined
      }
      if (preparationFailure) return yield* Effect.failCause(preparationFailure)
    })

    return Service.of({
      run,
    })
  }),
)

function revokeActivityInputGrants(
  sessionID: SessionSchema.ID,
  inputIDs: readonly SessionMessage.ID[],
  execution: SessionInput.ManagedExecutionRef | undefined,
): void {
  if (!execution?.claimID || !execution.cell) return
  for (const inputID of inputIDs) {
    ManagedSessionAuthority.revokeInput({
      sessionID,
      inputID,
      claimID: execution.claimID,
      cell: execution.cell,
    })
  }
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    PermissionV2.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Snapshot.node,
    Database.node,
  ],
})

/** User inputs belonging to the current activity, bounded by the previous assistant step. */
const currentActivityInputIDs = (messages: ReadonlyArray<SessionMessage.Message>) => {
  let latestUser = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.type === "user") {
      latestUser = index
      break
    }
  }
  if (latestUser < 0) return []
  const inputIDs: SessionMessage.ID[] = []
  for (let index = latestUser; index >= 0; index--) {
    const message = messages[index]!
    if (message.type === "assistant") break
    if (message.type === "user") inputIDs.unshift(message.id)
  }
  return inputIDs
}

const mergeInputIDs = (
  current: ReadonlyArray<SessionMessage.ID>,
  added: ReadonlyArray<SessionMessage.ID>,
): ReadonlyArray<SessionMessage.ID> => [...new Set([...current, ...added])]

const failureKind = (error: unknown): SessionEvent.Turn.Failure["kind"] => {
  if (error instanceof SessionRunnerModel.ProviderConnectionRequiredError || error instanceof Integration.AuthorizationError)
    return "authentication"
  if (
    error instanceof SessionRunnerModel.ModelUnavailableError || error instanceof SessionRunnerModel.ModelNotSelectedError ||
    error instanceof SessionRunnerModel.VariantUnavailableError || error instanceof SessionRunnerModel.UnsupportedApiError
  ) return "invalid_request"
  if (error instanceof SystemContext.InitializationBlocked) return "protocol_contract_unsatisfied"
  if (error instanceof ManagedTurnError) {
    if (error.kind === "protocol") return "protocol_contract_unsatisfied"
    if (error.kind === "resource") return "resource_limit"
    return "tool_effect_unknown"
  }
  if (!(error instanceof LLMError)) return "unknown"
  switch (error.reason._tag) {
    case "Authentication": return "authentication"
    case "QuotaExceeded": return "quota"
    case "RateLimit": return "rate_limit"
    case "ProviderInternal": return "provider_internal"
    case "Transport": return "transport"
    case "InvalidRequest":
    case "NoRoute":
    case "InvalidProviderOutput": return "invalid_request"
    case "ContentPolicy": return "content_policy"
    case "UnknownProvider": return "unknown"
  }
}

const runtimeErrorClass = (error: unknown) => {
  if (error instanceof ManagedTurnError) {
    if (error.kind === "resource") return "resource" as const
    if (error.kind === "protocol") return "protocol" as const
    return "tool_unknown" as const
  }
  const kind = failureKind(error)
  if (kind === "authentication" || kind === "quota" || kind === "rate_limit") return "resource" as const
  if (kind === "provider_internal" || kind === "transport") return "transport" as const
  return "unknown" as const
}

const runtimeFailure = (
  error: unknown,
  providerID?: string,
  modelID?: string,
): SessionEvent.Turn.Failure => {
  const llmError = error instanceof LLMError ? error : undefined
  const reason = llmError?.reason
  const httpStatus = reason && "http" in reason
    ? reason.http?.response?.status
    : reason && "status" in reason && typeof reason.status === "number"
      ? reason.status
      : undefined
  const message = llmError?.reason.message ?? (error instanceof Error ? error.message : undefined) ??
    "Agent turn failed before a typed provider error was available"
  const safeMessage = message.replace(/\s+/g, " ").trim().slice(0, 500) || "Agent turn failed"
  return {
    kind: failureKind(error),
    safeMessage,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(reason?._tag === "Transport" && reason.kind ? { transportKind: reason.kind } : {}),
    ...(reason?._tag === "Transport" && reason.code ? { transportCode: reason.code } : {}),
    ...(error instanceof SessionRunnerModel.ProviderConnectionRequiredError
      ? { transportCode: "provider_connection_required" }
      : {}),
    retryable: llmError?.retryable ?? false,
    retryExhausted: llmError?.retryExhausted ?? (
      error instanceof ManagedTurnError || error instanceof SessionRunnerModel.ProviderConnectionRequiredError ||
      error instanceof Integration.AuthorizationError
    ),
    attemptCount: Math.max(1, Math.trunc(llmError?.attemptCount ?? 1)),
    ...(providerID ? { providerID } : {}),
    ...(modelID ? { modelID } : {}),
  }
}
