/**
 * AgyCommands — filesystem discovery of Antigravity slash commands.
 *
 * The `agy` CLI expands slash commands itself in print mode (see
 * `--disable-slash-commands`), so T3 only has to list them: the composer
 * inserts `/name` as plain prompt text and the CLI does the rest. There is no
 * `agy commands` subcommand and the stream-json handshake never reports them,
 * so discovery scans the same TOML roots the CLI reads, mirroring how
 * `ClaudeSkills` scans Claude's skill directories.
 *
 * @module provider/Drivers/AgyCommands
 */
import * as NodeOS from "node:os";

import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * The commands the CLI itself expands. They are not files on disk and the CLI
 * has no way to list them, so the menu would otherwise never show them even
 * though typing `/boost` already works. Names and descriptions track
 * https://antigravity.google/docs/slash-commands/; a command Google gates
 * behind a paid plan still lists here and fails at the CLI, same as typing it
 * by hand.
 *
 * ponytail: a hardcoded list, because there is nothing to ask. Replace it the
 * day `agy` grows a discovery command.
 */
const BUILTIN_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  { name: "boost", description: "Multi-agent deep reasoning for complex bugs and algorithms." },
  { name: "browser", description: "Launches a sandboxed browser subagent for web research." },
  { name: "btw", description: "Asks a quick contextual question without pausing work." },
  { name: "goal", description: "Autonomous execution until the goal is achieved." },
  { name: "grill-me", description: "Interviews you to align on design details and edge cases." },
  { name: "learn", description: "Distills session feedback into persistent Rules or Skills." },
  { name: "plan", description: "Researches code and generates a reviewable plan artifact." },
  { name: "schedule", description: "Schedules an instruction as a timer or recurring cron job." },
  {
    name: "teamwork-preview",
    description: "Collaborative agent teams for repo-scale migrations and research.",
  },
];

/**
 * Reads the `description` key out of a command TOML.
 *
 * ponytail: deliberately not a TOML parser — the menu needs one single-line
 * string and the repo has no TOML dependency. Scanning stops at the first
 * multi-line delimiter so a `prompt = """..."""` body can never donate a
 * stray `description =` line. Pull in a real parser if the menu ever needs
 * `args` or other structured fields.
 */
export function parseAgyCommandDescription(contents: string): string | undefined {
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.includes('"""')) break;
    const match = /^description\s*=\s*"([^"]*)"/.exec(trimmed);
    if (match) {
      const description = match[1]?.trim();
      return description ? description : undefined;
    }
  }
  return undefined;
}

/**
 * Command name for a TOML file relative to its commands root. The CLI
 * namespaces nested directories with a colon, so `git/commit.toml` is
 * invoked as `/git:commit`.
 */
function commandNameFromRelativePath(relativePath: string): string {
  return relativePath
    .replace(/\.toml$/i, "")
    .split(/[\\/]/)
    .join(":");
}

/**
 * Every `*.toml` under `root`, as `{ name, description }`. Unreadable
 * directories yield nothing so a missing root never fails discovery.
 */
const collectCommandsUnder = Effect.fn("collectAgyCommandsUnder")(function* (
  root: string,
  relativePrefix = "",
): Effect.fn.Return<
  ReadonlyArray<ServerProviderSlashCommand>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const entries = yield* fileSystem
    .readDirectory(root)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  const commands: Array<ServerProviderSlashCommand> = [];
  for (const entry of [...entries].sort()) {
    const entryPath = path.join(root, entry);
    const relativePath = relativePrefix ? `${relativePrefix}/${entry}` : entry;

    const info = yield* fileSystem.stat(entryPath).pipe(Effect.orElseSucceed(() => undefined));
    if (info?.type === "Directory") {
      commands.push(...(yield* collectCommandsUnder(entryPath, relativePath)));
      continue;
    }
    if (!entry.toLowerCase().endsWith(".toml")) continue;

    const contents = yield* fileSystem
      .readFileString(entryPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) continue;

    const name = commandNameFromRelativePath(relativePath);
    if (!name) continue;
    const description = parseAgyCommandDescription(contents);
    commands.push({ name, ...(description ? { description } : {}) });
  }
  return commands;
});

/**
 * Enumerate Antigravity slash commands: the CLI's own builtins, then the
 * roots the CLI reads, being user commands, plugin and extension commands,
 * and finally the workspace's own `.gemini/commands`. Later sources win on
 * name collisions, so a project command overrides a user one of the same
 * name, and any file on disk overrides a builtin.
 */
export const discoverAgyCommands = Effect.fn("discoverAgyCommands")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ReadonlyArray<ServerProviderSlashCommand>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const geminiHome = environment.GEMINI_HOME?.trim()
    ? path.resolve(environment.GEMINI_HOME.trim())
    : path.join(NodeOS.homedir(), ".gemini");

  // Plugins and extensions each own a commands directory one level down.
  const containerRoots = [
    path.join(geminiHome, "config", "plugins"),
    path.join(geminiHome, "extensions"),
  ];
  const nestedRoots: Array<string> = [];
  for (const container of containerRoots) {
    const entries = yield* fileSystem
      .readDirectory(container)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of [...entries].sort()) {
      nestedRoots.push(path.join(container, entry, "commands"));
    }
  }

  const roots = [
    path.join(geminiHome, "commands"),
    ...nestedRoots,
    ...(cwd ? [path.join(cwd, ".gemini", "commands")] : []),
  ];

  const commandsByName = new Map<string, ServerProviderSlashCommand>(
    BUILTIN_COMMANDS.map((command) => [command.name, command]),
  );
  for (const root of roots) {
    for (const command of yield* collectCommandsUnder(root)) {
      commandsByName.set(command.name, command);
    }
  }
  return [...commandsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
