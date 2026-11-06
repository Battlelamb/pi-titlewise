import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";

// Native Pi creates an unflushed path for a fresh persisted session. Opening
// any existing file (even empty/header-only) is not proof of a new session.
// Do not inspect stored entries, headers, timestamps or titles for freshness.
export function freshSession(reason: unknown, manager: { getSessionFile(): string | undefined },
  metadata: (path: string) => unknown = lstatSync): boolean {
  if (reason === "new") return true;
  if (reason !== "startup") return false;
  let path: string | undefined;
  try { path = manager.getSessionFile(); } catch { return false; }
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) return false;
  try {
    metadata(path); // lstat also rejects dangling symlinks as existing paths.
    return false;
  } catch (error) {
    return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
  }
}
