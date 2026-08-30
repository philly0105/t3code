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

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPath = NodePath.join(__dirname, "../../../scripts/agy-mock-cli.ts");

export async function makeMockAgyBinary(): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agy-mock-"));
  if (process.platform === "win32") {
    const wrapperPath = NodePath.join(dir, "fake-agy.cmd");
    await NodeFSP.writeFile(
      wrapperPath,
      `@echo off\r\n"${process.execPath}" "${mockPath}" %*\r\n`,
      "utf8",
    );
    return wrapperPath;
  }
  const wrapperPath = NodePath.join(dir, "fake-agy.sh");
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockPath)} "$@"\n`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}
