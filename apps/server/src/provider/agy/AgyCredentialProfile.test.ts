import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  AGY_KEYRING_SETTLE_MS,
  readAgyProfileMeta,
  resetAgyAccountLock,
  restoreAgyCredentialProfile,
  windowsPowerShellPath,
  withAgyAccountLock,
} from "./AgyCredentialProfile.ts";

interface RecordedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined>;
}

/** Spawner double that records the command and replays canned stdout. */
function recordingSpawner(
  recorded: Array<RecordedCommand>,
  stdout: string,
  code = 0,
): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  return ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const raw = command as unknown as {
        readonly command: string;
        readonly args?: ReadonlyArray<string>;
        readonly options?: { readonly env?: Record<string, string | undefined> };
      };
      recorded.push({
        command: raw.command,
        args: raw.args ?? [],
        env: raw.options?.env ?? {},
      });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
}

/** Restore only runs on Windows, so cases default to it and say when they differ. */
const withSpawner = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  platform: NodeJS.Platform = "win32",
) =>
  effect.pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcessPlatform, platform),
  );

const makeProfile = Effect.fn("makeProfile")(function* (input: {
  readonly profile: string;
  readonly meta?: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-agy-profiles-" });
  const directory = path.join(root, input.profile);
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(path.join(directory, "cred.bin"), '{"token":{}}');
  if (input.meta !== undefined) {
    yield* fileSystem.writeFileString(path.join(directory, "meta.json"), input.meta);
  }
  return { root, directory };
});

it.layer(NodeServices.layer)("AgyCredentialProfile", (it) => {
  describe("profile metadata", () => {
    it.effect("reads the username and email the switcher saved", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { directory } = yield* makeProfile({
            profile: "main",
            // Set-Content -Encoding UTF8 leaves a BOM in front of the JSON.
            meta: '\uFEFF{"Role":"main","User":"antigravity","Email":"a@example.com"}',
          });

          expect(yield* readAgyProfileMeta(directory)).toEqual({
            user: "antigravity",
            email: "a@example.com",
          });
        }),
      ),
    );

    it.effect("falls back to the default credential username when meta is missing", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { directory } = yield* makeProfile({ profile: "daily" });

          expect(yield* readAgyProfileMeta(directory)).toEqual({
            user: "antigravity",
            email: undefined,
          });
        }),
      ),
    );
  });

  describe("restore", () => {
    it.effect("refuses a profile that has never been saved", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { root } = yield* makeProfile({ profile: "main" });

          const error = yield* Effect.flip(
            withSpawner(
              restoreAgyCredentialProfile({
                profile: "never-saved",
                environment: {},
                profilesDirectory: root,
              }),
              recordingSpawner([], ""),
            ),
          );

          expect(error.detail).toContain("antigravity-account save never-saved");
        }),
      ),
    );

    it.effect("refuses to guess at an account where Credential Manager does not exist", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { root } = yield* makeProfile({ profile: "main" });

          const error = yield* Effect.flip(
            withSpawner(
              restoreAgyCredentialProfile({
                profile: "main",
                environment: {},
                profilesDirectory: root,
              }),
              recordingSpawner([], ""),
              "darwin",
            ),
          );

          expect(error.detail).toContain("only supported on Windows");
        }),
      ),
    );

    it.effect("hands the helper the credential path and username out of band", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { root, directory } = yield* makeProfile({
            profile: "main",
            meta: '{"User":"antigravity-alt","Email":"alt@example.com"}',
          });
          const path = yield* Path.Path;
          const recorded: Array<RecordedCommand> = [];
          const environment = { SYSTEMROOT: String.raw`C:\Windows` };

          const restored = yield* withSpawner(
            restoreAgyCredentialProfile({
              profile: "main",
              environment,
              profilesDirectory: root,
            }),
            recordingSpawner(recorded, "switched\n"),
          );

          expect(restored).toEqual({ switched: true, email: "alt@example.com" });

          const command = recorded[0];
          expect(command?.command).toBe(windowsPowerShellPath(environment));
          expect(command?.env["T3_AGY_TARGET"]).toBe("gemini:antigravity");
          expect(command?.env["T3_AGY_CRED_PATH"]).toBe(path.join(directory, "cred.bin"));
          expect(command?.env["T3_AGY_USER"]).toBe("antigravity-alt");
          // The saved token's path must never reach a command line.
          expect(command?.args.join(" ")).not.toContain(root);
        }),
      ),
    );

    it.effect("reports an unchanged credential when the account is already active", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { root } = yield* makeProfile({ profile: "main" });

          const restored = yield* withSpawner(
            restoreAgyCredentialProfile({
              profile: "main",
              environment: {},
              profilesDirectory: root,
            }),
            recordingSpawner([], "unchanged\n"),
          );

          expect(restored.switched).toBe(false);
        }),
      ),
    );

    it.effect("surfaces what the helper printed when it fails", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { root } = yield* makeProfile({ profile: "main" });

          const error = yield* Effect.flip(
            withSpawner(
              restoreAgyCredentialProfile({
                profile: "main",
                environment: {},
                profilesDirectory: root,
              }),
              recordingSpawner([], "", 1),
            ),
          );

          expect(error.detail).toContain("exited with code 1");
        }),
      ),
    );
  });

  describe("account lock", () => {
    it.effect("starts an isolated spawn without waiting", () =>
      Effect.gen(function* () {
        yield* resetAgyAccountLock;
        const spawned: Array<string> = [];

        yield* withAgyAccountLock(Effect.sync(() => spawned.push("first")));

        expect(spawned).toEqual(["first"]);
      }),
    );

    it.effect("holds the next spawn back until the previous child has read the credential", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* resetAgyAccountLock;
          const spawned: Array<string> = [];

          yield* withAgyAccountLock(Effect.sync(() => spawned.push("first")));
          const second = yield* withAgyAccountLock(Effect.sync(() => spawned.push("second"))).pipe(
            Effect.forkScoped,
          );

          yield* TestClock.adjust(Duration.millis(AGY_KEYRING_SETTLE_MS - 1));
          expect(spawned).toEqual(["first"]);

          yield* TestClock.adjust(Duration.millis(1));
          yield* Fiber.join(second);
          expect(spawned).toEqual(["first", "second"]);
        }),
      ),
    );

    it.effect("never runs two spawns at once", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* resetAgyAccountLock;
          let inFlight = 0;
          let overlapped = false;
          const spawn = Effect.sync(() => {
            inFlight += 1;
            if (inFlight > 1) overlapped = true;
            inFlight -= 1;
          });

          const fibers = yield* Effect.forEach([spawn, spawn, spawn], (effect) =>
            Effect.forkScoped(withAgyAccountLock(effect)),
          );
          yield* TestClock.adjust(Duration.millis(AGY_KEYRING_SETTLE_MS * 3));
          yield* Effect.forEach(fibers, Fiber.join);

          expect(overlapped).toBe(false);
        }),
      ),
    );
  });
});
