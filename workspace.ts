// Shared Pi / Pi-Bolt / OMP bridge. Reuse a successful first native title;
// no inference, shell, retries, session-store reads or native-name mutations.
import { basename } from "node:path";

export interface WorkspaceExec {
  (command: string, args: string[], options?: { timeout?: number }):
    Promise<{ code: number; stdout?: string; killed?: boolean }>;
}

export function folderStyle(label: string, cwd: string): boolean {
  // Exactly one suffix, matching the launch-time refresh recognizer.
  const base = label.replace(/ - [0-9]{4}-[0-9]{2}-[0-9]{2}$/, "");
  return !!cwd && (base === "~" || base === "." || base === (basename(cwd) || "/"));
}

export function workspaceEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.HERDR_ENV === "1" && !!env.HERDR_SOCKET_PATH && !!env.HERDR_WORKSPACE_ID &&
    !env.PI_HERDSMAN_AGENT_DEFINITION && env.OMPCODE !== "1";
}

// Detached from input/ownership. The local deadline also stops a misbehaving
// exec's late read result from advancing to a rename; native exec gets the same
// deadline. An already-dispatched rename cannot be retracted.
async function renameWorkspaceLabel(exec: WorkspaceExec, title: string, current: () => boolean,
  env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    // A leading '-' would be parsed by the Herdr CLI as an option, not a label.
    if (!workspaceEnabled(env) || !current() || !title || title.startsWith("-") || title.length > 240 || /[\x00-\x1f\x7f-\x9f]/.test(title)) return false;
    const id = env.HERDR_WORKSPACE_ID!;
    async function call(args: string[]) {
      if (!workspaceEnabled(env) || env.HERDR_WORKSPACE_ID !== id || !current()) throw new Error("Stale title");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          exec("herdr", args, { timeout: 750 }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Herdr timeout")), 750);
          }),
        ]);
        if (result.code !== 0 || result.killed) throw new Error("Herdr unavailable");
        return result.stdout ?? "";
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    const label = async () => JSON.parse(await call(["workspace", "get", id]))?.result?.workspace?.label;
    const initial = await label();
    if (typeof initial !== "string") return false;
    const cwd = JSON.parse(await call(["pane", "current", "--current"]))?.result?.pane?.cwd;
    if (typeof cwd !== "string" || !folderStyle(initial, cwd)) return false;
    // No intervening async work between this fresh label and rename dispatch.
    const latest = await label();
    if (typeof latest !== "string" || !folderStyle(latest, cwd)) return false;
    await call(["workspace", "rename", id, title]);
    return true;
  } catch {
    return false; // fail open, no logging of environment or command output
  }
}


const datedSuffix = / - [0-9]{4}-[0-9]{2}-[0-9]{2}$/;
// Tabs follow their own rule, independent of the workspace label policy: a default numeric label or an
// earlier Titlewise title is replaceable; any other label is the user's.
export async function renameTab(exec: WorkspaceExec, title: string, current: () => boolean,
  env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    if (!workspaceEnabled(env) || !env.HERDR_TAB_ID || !current() || !title || title.startsWith("-") || title.length > 240 || /[\x00-\x1f\x7f-\x9f]/.test(title)) return false;
    const id = env.HERDR_TAB_ID;
    const call = async (args: string[]) => {
      if (!workspaceEnabled(env) || env.HERDR_TAB_ID !== id || !current()) throw new Error("Stale title");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          exec("herdr", args, { timeout: 750 }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Herdr timeout")), 750); }),
        ]);
        if (result.code !== 0 || result.killed) throw new Error("Herdr unavailable");
        return result.stdout ?? "";
      } finally { if (timer) clearTimeout(timer); }
    };
    const label = JSON.parse(await call(["tab", "get", id]))?.result?.tab?.label;
    if (typeof label !== "string" || !(/^[0-9]+$/.test(label) || datedSuffix.test(label))) return false;
    await call(["tab", "rename", id, title]);
    return true;
  } catch {
    return false; // fail open
  }
}

export function renameWorkspace(exec: WorkspaceExec, title: string, current: () => boolean,
  env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  void renameTab(exec, title, current, env);
  return renameWorkspaceLabel(exec, title, current, env);
}
