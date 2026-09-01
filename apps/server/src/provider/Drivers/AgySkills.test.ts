import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverAgySkills } from "./AgySkills.ts";

// Builds a throwaway GEMINI_HOME plus an optional workspace, so discovery runs
// against real directories instead of a mocked filesystem.
const writeSkillTree = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-skills-" });
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = path.join(root, ...relativePath.split("/"));
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, contents);
    }
    return root;
  });

const skillFile = (name: string, description: string) =>
  ["---", `name: ${name}`, `description: ${description}`, "---", "", "# Body"].join("\n");

it.layer(NodeServices.layer)("discoverAgySkills", (it) => {
  it.effect("collects builtin, user, and plugin skills with their descriptions", () =>
    Effect.gen(function* () {
      const skills = yield* Effect.scoped(
        Effect.gen(function* () {
          const root = yield* writeSkillTree({
            "gemini/antigravity-cli/builtin/skills/generative_ui/SKILL.md": skillFile(
              "generative_ui",
              "Build UI",
            ),
            "gemini/config/skills/recall/SKILL.md": skillFile("recall", "Search memory"),
            "gemini/config/plugins/ponytail/skills/ponytail/SKILL.md": skillFile(
              "ponytail",
              "Stay lazy",
            ),
          });
          const path = yield* Path.Path;
          return yield* discoverAgySkills(undefined, { GEMINI_HOME: path.join(root, "gemini") });
        }),
      );

      expect(skills.map((skill) => skill.name)).toEqual(["generative_ui", "ponytail", "recall"]);
      expect(skills.find((skill) => skill.name === "ponytail")).toMatchObject({
        description: "Stay lazy",
        scope: "plugin",
        enabled: true,
      });
    }),
  );

  it.effect("falls back to the directory name when frontmatter omits one", () =>
    Effect.gen(function* () {
      const skills = yield* Effect.scoped(
        Effect.gen(function* () {
          const root = yield* writeSkillTree({
            "gemini/config/skills/blast-radius/SKILL.md": "# No frontmatter here",
          });
          const path = yield* Path.Path;
          return yield* discoverAgySkills(undefined, { GEMINI_HOME: path.join(root, "gemini") });
        }),
      );

      expect(skills.map((skill) => skill.name)).toEqual(["blast-radius"]);
      expect(skills[0]?.description).toBeUndefined();
    }),
  );

  it.effect("lets a workspace skill shadow a builtin of the same name", () =>
    Effect.gen(function* () {
      const skills = yield* Effect.scoped(
        Effect.gen(function* () {
          const root = yield* writeSkillTree({
            "gemini/antigravity-cli/builtin/skills/recall/SKILL.md": skillFile(
              "recall",
              "Builtin version",
            ),
            "workspace/.agents/skills/recall/SKILL.md": skillFile("recall", "Project version"),
          });
          const path = yield* Path.Path;
          return yield* discoverAgySkills(path.join(root, "workspace"), {
            GEMINI_HOME: path.join(root, "gemini"),
          });
        }),
      );

      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({ description: "Project version", scope: "project" });
    }),
  );

  it.effect("ignores directories without a SKILL.md and returns nothing when no roots exist", () =>
    Effect.gen(function* () {
      const skills = yield* Effect.scoped(
        Effect.gen(function* () {
          const root = yield* writeSkillTree({
            "gemini/config/skills/not-a-skill/README.md": "just docs",
          });
          const path = yield* Path.Path;
          return yield* discoverAgySkills(undefined, { GEMINI_HOME: path.join(root, "gemini") });
        }),
      );

      expect(skills).toEqual([]);
    }),
  );
});
