import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const HealthGroup = HttpApiGroup.make("server.health").add(
  HttpApiEndpoint.get("health.get", "/api/health", {
    success: Schema.Struct({
      healthy: Schema.Literal(true),
      capabilities: Schema.Struct({
        sessionCreateByID: Schema.Boolean,
        durableInputIdempotency: Schema.Boolean,
        inputDeliveryQueue: Schema.Boolean,
        sessionEventReplay: Schema.Boolean,
        toolExecutionIdentity: Schema.Boolean,
        transportActivityEvents: Schema.Boolean,
        activitySettlement: Schema.Boolean,
        targetedInterrupt: Schema.Boolean,
      }),
    }),
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.health.get",
      summary: "Check server health",
      description: "Check whether the API server is ready to accept requests.",
    }),
  ),
)
