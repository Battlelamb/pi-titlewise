// Native Pi owns credential interpretation. Never invoke this for diagnostics:
// stdout is a private bounded pipe; no SDK import, shell or Node dependency.
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const executable = (file: string) => {
  try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; }
};
export function piLauncher(env: NodeJS.ProcessEnv = process.env, platform = process.platform,
  home = homedir(), exists = executable, execPath = process.execPath): string | undefined {
  const windows = platform === "win32", path = windows ? win32 : posix;
  const name = windows ? "pi.exe" : "pi";
  // A native Pi can reuse itself; Node/OMP hosts must never be invoked as Pi.
  // Prefer already-installed binaries to PATH wrappers that may run `mise use`.
  if (path.isAbsolute(execPath) && path.basename(execPath) === name && exists(execPath)) return execPath;
  const installed = path.join(home, ".local", "share", "mise", "installs", "pi", "latest", "pi", name);
  if (path.isAbsolute(installed) && exists(installed)) return installed;
  // Retain npm/maintained launchers when no native binary is available.
  // Ignore cwd-relative PATH entries; Windows .cmd/.bat launchers require a shell.
  const search = env.PATH ?? (windows ? env.Path : undefined) ?? "";
  for (const dir of [...search.split(path.delimiter), path.join(home, ".local", "bin")]) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    if (exists(file)) return file;
  }
  return undefined;
}

interface Runtime {
  platform?: NodeJS.Platform;
  launcher?: () => string | undefined;
  systemRoot?: string;
}
export function resolveAuth(signal: AbortSignal, launch: typeof spawn = spawn,
  kill: typeof process.kill = process.kill.bind(process), runtime: Runtime = {}): Promise<string | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise(resolve => {
    const windows = (runtime.platform ?? process.platform) === "win32";
    const root = runtime.systemRoot ?? process.env.SystemRoot;
    const taskkill = windows && root && win32.isAbsolute(root) ? win32.join(root, "System32", "taskkill.exe") : undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let chunks: Buffer[] = [], size = 0, done = false, exited = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (key?: string) => {
      if (done) return; done = true;
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      try {
        const pid = child?.pid;
        if (pid && Number.isSafeInteger(pid) && pid > 1) {
          if (!windows) {
            // Our detached child owns this process group, including auth helpers.
            kill(-pid, "SIGKILL");
          } else if (!exited && child?.exitCode == null && child?.signalCode == null) {
            // Windows has no POSIX groups. Target only our child tree before
            // observing exit; never reuse a known-exited PID. Bounded/private.
            const cleanup = launch(taskkill!, ["/PID", String(pid), "/T", "/F"],
              { shell: false, windowsHide: true, stdio: "ignore", timeout: 250, killSignal: "SIGKILL" });
            cleanup.on("error", () => {});
            cleanup.unref();
          }
        }
      } catch { /* best-effort cleanup, no retries or sensitive diagnostics */ }
      child?.stdout?.destroy();
      chunks = []; resolve(key);
    };
    const abort = () => finish();
    try {
      const command = (runtime.launcher ?? piLauncher)();
      if (!command || (windows && !taskkill) || signal.aborted) { finish(); return; }
      child = launch(command, ["auth", "print-api-key", "--provider", "typesafe"],
        { detached: !windows, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      timer = setTimeout(abort, 1000);
      signal.addEventListener("abort", abort, { once: true });
      child.on("error", () => finish());
      child.on("exit", () => { exited = true; });
      child.on("close", code => {
        exited = true;
        if (done) return;
        try {
          // Native CLI writes the raw key followed by a newline, not JSON.
          const key = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)).trim();
          finish(code === 0 && key.length > 0 && key.length <= 8192 &&
            !/[\s\x00-\x1f\x7f]/.test(key) ? key : undefined);
        } catch { finish(); }
      });
      if (!child.stdout) { finish(); return; }
      child.stdout.on("error", () => finish());
      child.stdout.on("data", (chunk: Buffer) => {
        if (done) return;
        size += chunk.length;
        if (size > 12000) { finish(); return; }
        chunks.push(Buffer.from(chunk));
      });
      if (signal.aborted) finish();
    } catch { finish(); }
  });
}
