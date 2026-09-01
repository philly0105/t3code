/**
 * AgySkills — filesystem discovery of Antigravity skills for the `$` picker.
 *
 * The `agy` CLI expands skills itself in print mode (the same
 * `--disable-slash-commands` flag turns both off), so T3 only has to list
 * them. Skills are a directory holding a `SKILL.md`, loaded from the CLI's
 * builtin set, the user's customization root, each installed plugin, and the
 * workspace's own `.agents/skills`.
 *
 * @module provider/Drivers/AgySkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { parseSkillFrontmatter } from "../skillFrontmatter.ts";

type AgySkillScope = "builtin" | "user" | "plugin" | "project";

/**
 * Every skill directly under `root`, keyed by its frontmatter name. Malformed
 * frontmatter is skipped because the CLI would not load that skill either.
 */
const collectSkillsUnder = Effect.fn("collectAgySkillsUnder")(function* (
  root: string,
  scope: AgySkillScope,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const entries = yield* fileSystem
    .readDirectory(root)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  const skills: Array<ServerProviderSkill> = [];
  for (const entry of [...entries].sort()) {
    const skillPath = path.join(root, entry, "SKILL.md");
    const contents = yield* fileSystem
      .readFileString(skillPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) continue;

    const frontmatter = parseSkillFrontmatter(contents);
    if (frontmatter.kind === "malformed") continue;

    const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.trim();
    if (!name) continue;

    skills.push({
      name,
      path: skillPath,
      enabled: true,
      scope,
      ...(frontmatter.kind === "parsed" && frontmatter.description
        ? { description: frontmatter.description }
        : {}),
    });
  }
  return skills;
});

/**
 * Enumerate Antigravity skills from the roots the CLI reads, in increasing
 * precedence: the CLI's builtin skills, the user's `config/skills`, each
 * plugin's `skills`, then the workspace's `.agents/skills`. Later roots win on
 * name collisions, so a workspace skill shadows a builtin of the same name.
 */
export const discoverAgySkills = Effect.fn("discoverAgySkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const geminiHome = environment.GEMINI_HOME?.trim()
    ? path.resolve(environment.GEMINI_HOME.trim())
    : path.join(NodeOS.homedir(), ".gemini");

  const pluginsRoot = path.join(geminiHome, "config", "plugins");
  const pluginEntries = yield* fileSystem
    .readDirectory(pluginsRoot)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  const roots: ReadonlyArray<{ directory: string; scope: AgySkillScope }> = [
    {
      directory: path.join(geminiHome, "antigravity-cli", "builtin", "skills"),
      scope: "builtin",
    },
    { directory: path.join(geminiHome, "config", "skills"), scope: "user" },
    ...[...pluginEntries].sort().map((entry) => ({
      directory: path.join(pluginsRoot, entry, "skills"),
      scope: "plugin" as const,
    })),
    ...(cwd ? [{ directory: path.join(cwd, ".agents", "skills"), scope: "project" as const }] : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    for (const skill of yield* collectSkillsUnder(root.directory, root.scope)) {
      skillsByName.set(skill.name, skill);
    }
  }
  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
