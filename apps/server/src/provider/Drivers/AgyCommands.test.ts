import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverAgyCommands, parseAgyCommandDescription } from "./AgyCommands.ts";

describe("parseAgyCommandDescription", () => {
  it("reads the description key", () => {
    expect(parseAgyCommandDescription('description = "Do the thing"')).toBe("Do the thing");
  });

  it("ignores a description that only appears inside a multi-line prompt body", () => {
    const contents = ['prompt = """', 'description = "not mine"', '"""'].join("\n");
    expect(parseAgyCommandDescription(contents)).toBeUndefined();
  });

  it("returns undefined when the key is absent or empty", () => {
    expect(parseAgyCommandDescription('prompt = "hi"')).toBeUndefined();
    expect(parseAgyCommandDescription('description = ""')).toBeUndefined();
  });
});

// Builds a throwaway GEMINI_HOME plus an optional workspace, so discovery runs
// against real directories instead of a mocked filesystem.
const writeCommandTree = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-commands-" });
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = path.join(root, ...relativePath.split("/"));
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, contents);
    }
    return root;
  });

it.layer(NodeServices.layer)("discoverAgyCommands", (it) => {
  it.effect("collects user, plugin, and extension commands with their descriptions", () =>
    Effect.gen(function* () {
      const commands = yield* Effect.scoped(
        Effect.gen(function* () {
          const root = yield* writeCommandTree({
            "gemini/commands/mine.toml": 'description = "A user command"',
            "gemini/config/plugins/ponytail/commands/ponytail-help.toml":
              'description = "Quick reference"',
            "gemini/extensions/Stitch/commands/stitch.toml": 'description = "Design tool"',
          });
          const path = yield* Path.Path;
          return yield* discoverAgyCommands(undefined, {
            GEMINI_HOME: path.join(root, "gemini"),
          });
        }),
      );

      expect(commands.map((command) => command.name)).toEqual(["mine", "ponytail-help", "stitch"]);
      expect(commands.find((command) => command.name === "stitch")?.description).toBe(
        "Design tool",
      );
    }),
  );

  it.effect("namespaces nested commands with a colon, matching how the CLI invokes them", () =>
    Effect.gen(function* () {
      const commands = yield* Effect.scoped(
        Effect.gen(function* () {
          const root = yield* writeCommandTree({
            "gemini/commands/git/commit.toml": 'description = "Commit staged work"',
          });
          const path = yield* Path.Path;
          return yield* discoverAgyCommands(undefined, {
            GEMINI_HOME: path.join(root, "gemini"),
          });
        }),
      );

      expect(commands.map((command) => command.name)).toEqual(["git:commit"]);
    }),
  );

  it.effect("lets a workspace command override a user command of the same name", () =>
    Effect.gen(function* () {
      const commands = yield* Effect.scoped(
        Effect.gen(function* () {
          const root = yield* writeCommandTree({
            "gemini/commands/deploy.toml": 'description = "User version"',
            "workspace/.gemini/commands/deploy.toml": 'description = "Project version"',
          });
          const path = yield* Path.Path;
          return yield* discoverAgyCommands(path.join(root, "workspace"), {
            GEMINI_HOME: path.join(root, "gemini"),
          });
        }),
      );

      expect(commands).toHaveLength(1);
      expect(commands[0]?.description).toBe("Project version");
    }),
  );

  it.effect("returns nothing when no command roots exist", () =>
    Effect.gen(function* () {
      const commands = yield* Effect.scoped(
        Effect.gen(function* () {
          const root = yield* writeCommandTree({ "gemini/settings.json": "{}" });
          const path = yield* Path.Path;
          return yield* discoverAgyCommands(undefined, {
            GEMINI_HOME: path.join(root, "gemini"),
          });
        }),
      );

      expect(commands).toEqual([]);
    }),
  );
});
