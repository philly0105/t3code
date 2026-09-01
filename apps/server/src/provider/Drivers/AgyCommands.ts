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
 * Enumerate Antigravity slash commands from the roots the CLI reads: user
 * commands, then plugin and extension commands, then the workspace's own
 * `.gemini/commands`. Later roots win on name collisions, so a project
 * command overrides a user one of the same name.
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

  const commandsByName = new Map<string, ServerProviderSlashCommand>();
  for (const root of roots) {
    for (const command of yield* collectCommandsUnder(root)) {
      commandsByName.set(command.name, command);
    }
  }
  return [...commandsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
