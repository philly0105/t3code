// @effect-diagnostics nodeBuiltinImport:off
/**
 * Test-only helper: writes a wrapper script that runs the mock agy CLI and
 * can be handed to the adapter as a `binaryPath`. Platform-aware, because
 * the shell wrappers used by the ACP provider tests are POSIX-only.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPath = NodePath.join(__dirname, "../../../scripts/agy-mock-cli.ts");
const encodeShellString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const makeMockAgyBinary = Effect.fn("makeMockAgyBinary")(function* () {
  const platform = yield* HostProcessPlatform;
  const dir = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agy-mock-")),
  );
  if (platform === "win32") {
    const wrapperPath = NodePath.join(dir, "fake-agy.cmd");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        wrapperPath,
        `@echo off\r\n"${process.execPath}" "${mockPath}" %*\r\n`,
        "utf8",
      ),
    );
    return wrapperPath;
  }
  const wrapperPath = NodePath.join(dir, "fake-agy.sh");
  yield* Effect.promise(() =>
    NodeFSP.writeFile(
      wrapperPath,
      `#!/bin/sh\nexec ${encodeShellString(process.execPath)} ${encodeShellString(mockPath)} "$@"\n`,
      "utf8",
    ),
  );
  yield* Effect.promise(() => NodeFSP.chmod(wrapperPath, 0o755));
  return wrapperPath;
});
