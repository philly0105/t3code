/**
 * AgyCredentialProfile — switching the Antigravity CLI between accounts.
 *
 * `agy` is single-account. Its login is not a file: it lives in one Windows
 * Credential Manager entry (`gemini:antigravity`) that every agy process on the
 * machine shares. The CLI reads that entry once during startup and then caches
 * the token for the life of the process, so the account a session runs as is
 * decided entirely by what sits in the entry at the moment it spawns.
 *
 * That is what lets one T3 Code server drive several accounts: keep each
 * account's credential blob saved under `~/.agy-profiles/<profile>/cred.bin`
 * and restore the right one immediately before spawning. It is also what makes
 * a lock necessary. Two sessions on different accounts spawning at once would
 * both write the shared entry and the later writer would win for both, so one
 * session would silently run as the other's account. `withAgyAccountLock`
 * serializes restore and spawn, and keeps a spawn from starting until the
 * previous child has had time to read the entry.
 *
 * The profile layout is the one the `antigravity-account` PowerShell switcher
 * already uses, so profiles saved from a terminal work here and vice versa.
 *
 * @module provider/agy/AgyCredentialProfile
 */
import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { spawnAndCollect } from "../providerSnapshot.ts";

export class AgyCredentialProfileError extends Data.TaggedError("AgyCredentialProfileError")<{
  readonly profile: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

/** Generic credential the Antigravity CLI reads its login from. */
const CREDENTIAL_TARGET = "gemini:antigravity";

/** Credential username used when a profile has no saved `meta.json`. */
const DEFAULT_CREDENTIAL_USER = "antigravity";

/**
 * How long a spawn keeps the next one waiting, so the child has read the
 * credential before anything overwrites it. The CLI reads the keyring about
 * half a second in — `ChainedAuth: authenticated via keyring` in
 * `~/.gemini/antigravity-cli/cli.log` — so this leaves roughly six times the
 * observed need.
 *
 * ponytail: a fixed window rather than a real signal, because the CLI offers
 * nothing to observe. If a slow machine ever loses the race, wait on a new
 * "authenticated successfully as" line in cli.log instead.
 */
export const AGY_KEYRING_SETTLE_MS = 3_000;

/**
 * Guards the one Credential Manager entry every agy process shares. Module
 * scope rather than per-instance because the resource is machine-wide.
 *
 * ponytail: in-process only. A second T3 Code server, or the user's own
 * `a1`..`a6` shell functions, can still swap the entry underneath a spawn. A
 * lock file under the profiles directory would cover those if it matters.
 */
let accountLock: Semaphore.Semaphore | undefined;

/** When the last spawn released the entry, as epoch millis; unset before the first. */
let lastSpawnAt: number | undefined;

const acquireAccountLock = Effect.suspend(() => {
  if (accountLock) return Effect.succeed(accountLock);
  return Semaphore.make(1).pipe(
    Effect.tap((semaphore) =>
      Effect.sync(() => {
        accountLock = semaphore;
      }),
    ),
  );
});

/**
 * Run `spawn` as the only agy spawn in flight, delayed if the previous one is
 * still inside its settle window.
 *
 * Charging the wait to the *next* spawn rather than holding the lock past the
 * current one keeps the common case free: a thread whose last agy spawn was
 * minutes ago starts immediately, and only genuinely concurrent spawns pay.
 */
export const withAgyAccountLock = <A, E, R>(
  spawn: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const lock = yield* acquireAccountLock;
    return yield* lock.withPermit(
      Effect.gen(function* () {
        if (lastSpawnAt !== undefined) {
          const remaining = lastSpawnAt + AGY_KEYRING_SETTLE_MS - (yield* Clock.currentTimeMillis);
          if (remaining > 0) yield* Effect.sleep(remaining);
        }
        const result = yield* spawn;
        lastSpawnAt = yield* Clock.currentTimeMillis;
        return result;
      }),
    );
  });

/** Test seam: forget the lock and settle deadline between cases. */
export const resetAgyAccountLock = Effect.sync(() => {
  accountLock = undefined;
  lastSpawnAt = undefined;
});

export function agyProfilesDirectory(home: string = NodeOS.homedir()): string {
  return `${home}/.agy-profiles`;
}

export interface AgyProfileMeta {
  readonly user: string;
  readonly email: string | undefined;
}

/**
 * Read the sidecar the switcher writes beside `cred.bin`. `User` is the
 * credential's username, which has to go back with the blob, and `Email` is
 * what we log so the account in use is visible rather than guessed at.
 */
export const readAgyProfileMeta = Effect.fn("readAgyProfileMeta")(function* (
  profileDirectory: string,
): Effect.fn.Return<AgyProfileMeta, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fileSystem
    .readFileString(path.join(profileDirectory, "meta.json"))
    .pipe(Effect.orElseSucceed(() => ""));

  // PowerShell's Set-Content -Encoding UTF8 leaves a BOM that JSON.parse rejects.
  const parsed = yield* Effect.try(
    () => JSON.parse(contents.replace(/^\uFEFF/, "")) as unknown,
  ).pipe(Effect.orElseSucceed(() => undefined));
  const record =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const rawUser = record["User"];
  const rawEmail = record["Email"];
  return {
    user: typeof rawUser === "string" && rawUser.trim() ? rawUser.trim() : DEFAULT_CREDENTIAL_USER,
    email: typeof rawEmail === "string" && rawEmail.trim() ? rawEmail.trim() : undefined,
  };
});

/**
 * Writes the saved blob into the shared entry, and only when it differs from
 * what is already there, so repeat spawns on one account leave it untouched.
 *
 * Arguments travel in the environment rather than the script body: the token
 * file's path never reaches a command line, and there is no quoting to get
 * wrong.
 */
const RESTORE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace T3Agy {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  public class Api {
    [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="CredReadW")]
    static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
    [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="CredWriteW")]
    static extern bool CredWrite(ref CREDENTIAL cred, uint flags);
    [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
    public static byte[] Read(string target) {
      IntPtr p;
      if (!CredRead(target, 1u, 0u, out p)) return null;
      try {
        CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
        byte[] b = new byte[c.CredentialBlobSize];
        if (c.CredentialBlobSize > 0) Marshal.Copy(c.CredentialBlob, b, 0, (int)c.CredentialBlobSize);
        return b;
      } finally { CredFree(p); }
    }
    public static void Write(string target, string user, byte[] blob) {
      CREDENTIAL c = new CREDENTIAL();
      c.Type = 1u; c.Persist = 2u; c.TargetName = target; c.UserName = user;
      c.CredentialBlobSize = (uint)blob.Length;
      c.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
      try {
        Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);
        if (!CredWrite(ref c, 0u)) throw new Exception("CredWrite failed: " + Marshal.GetLastWin32Error());
      } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
    }
  }
}
'@
$desired = [System.IO.File]::ReadAllBytes($env:T3_AGY_CRED_PATH)
$current = [T3Agy.Api]::Read($env:T3_AGY_TARGET)
if ($null -ne $current -and [System.Linq.Enumerable]::SequenceEqual($current, $desired)) {
  Write-Output 'unchanged'
} else {
  [T3Agy.Api]::Write($env:T3_AGY_TARGET, $env:T3_AGY_USER, $desired)
  Write-Output 'switched'
}
`;

export function windowsPowerShellPath(environment: NodeJS.ProcessEnv): string {
  const root = environment["SYSTEMROOT"] || environment["windir"] || String.raw`C:\Windows`;
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function encodeUtf16LeBase64(input: string): string {
  const bytes = new Uint8Array(input.length * 2);
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >>> 8;
  }
  return Encoding.encodeBase64(bytes);
}

export interface AgyCredentialRestore {
  readonly switched: boolean;
  readonly email: string | undefined;
}

/**
 * Point the shared credential entry at `profile`'s account before a spawn.
 *
 * Fails rather than carrying on when the profile is missing or the helper
 * errors: running a thread as the wrong account without saying so is the
 * failure this module exists to prevent.
 */
export const restoreAgyCredentialProfile = Effect.fn("restoreAgyCredentialProfile")(
  function* (input: {
    readonly profile: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly profilesDirectory?: string;
  }): Effect.fn.Return<
    AgyCredentialRestore,
    AgyCredentialProfileError,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const profile = input.profile.trim();

    if ((yield* HostProcessPlatform) !== "win32") {
      return yield* new AgyCredentialProfileError({
        profile,
        detail:
          "Antigravity account profiles are only supported on Windows. On macOS, switch accounts with agy-switch from ~/.agy-profiles/agy-mac.sh and leave this setting empty.",
      });
    }

    const profileDirectory = path.join(input.profilesDirectory ?? agyProfilesDirectory(), profile);
    const credentialPath = path.join(profileDirectory, "cred.bin");

    const exists = yield* fileSystem.exists(credentialPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return yield* new AgyCredentialProfileError({
        profile,
        detail: `No saved Antigravity profile at ${credentialPath}. Log into that account in a terminal, then run: antigravity-account save ${profile}`,
      });
    }

    const meta = yield* readAgyProfileMeta(profileDirectory);
    const powerShell = windowsPowerShellPath(input.environment);

    const result = yield* spawnAndCollect(
      powerShell,
      ChildProcess.make(
        powerShell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          encodeUtf16LeBase64(RESTORE_SCRIPT),
        ],
        {
          env: {
            ...input.environment,
            T3_AGY_TARGET: CREDENTIAL_TARGET,
            T3_AGY_CRED_PATH: credentialPath,
            T3_AGY_USER: meta.user,
          },
          stdin: "ignore",
        },
      ),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new AgyCredentialProfileError({
            profile,
            detail: "Failed to run the Windows Credential Manager helper.",
            cause,
          }),
      ),
    );

    if (result.code !== 0) {
      return yield* new AgyCredentialProfileError({
        profile,
        detail: result.stderr.trim() || `Credential helper exited with code ${result.code}.`,
      });
    }

    return { switched: result.stdout.includes("switched"), email: meta.email };
  },
);
