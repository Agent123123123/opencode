export * as SessionTitle from "./session-title"

import { Schema } from "effect"

export const Title = Schema.String.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isNonEmpty()),
  Schema.check(Schema.isMaxLength(100)),
).annotate({ identifier: "Session.Title" })
export type Title = typeof Title.Type
