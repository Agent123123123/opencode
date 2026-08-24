import { Effect, Schema } from "effect"
import { Skill } from "../skill"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from available_skills" }),
  resource_path: Schema.optional(
    Schema.String.annotate({
      description: "Optional path to a skill resource, relative to the loaded skill base directory",
    }),
  ),
})

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* skill
            .require(params.name)
            .pipe(Effect.catchTag("Skill.NotFoundError", (error) => Effect.die(new Error(error.message))))

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })

          const base = yield* skill.base(params.name)

          if (params.resource_path) {
            const resource = yield* skill.readResource(params.name, params.resource_path)
            return {
              title: `Loaded skill resource: ${info.name}`,
              output: [
                `<skill_resource name="${info.name}" path="${resource.path}">`,
                resource.content,
                "</skill_resource>",
              ].join("\n"),
              metadata: { name: info.name, dir: base, path: resource.path },
            }
          }

          const files = yield* skill.listFiles(params.name, 10)

          return {
            title: `Loaded skill: ${info.name}`,
            output: [
              `<skill_content name="${info.name}">`,
              `# Skill: ${info.name}`,
              "",
              info.content.trim(),
              "",
              `Base directory for this skill: ${base}`,
              "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
              "Note: file list is sampled.",
              "",
              "<skill_files>",
              files.map((file) => `<file>${file}</file>`).join("\n"),
              "</skill_files>",
              "</skill_content>",
            ].join("\n"),
            metadata: {
              name: info.name,
              dir: base,
              path: info.location,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
