import { pathToFileURL } from "node:url";
import type { Readable } from "node:stream";
import { INPUT_BYTES, prepare, selectTitle, type Decision, type SelectionInput, type Selector } from "./selector.ts";

const invalid = (): Decision => ({ source: "fallback", status: "skip", reason: "invalid_input" });
export function readInput(input: Readable, timeoutMs = 1000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0; const chunks: Buffer[] = [];
    const timer = setTimeout(() => finish(false), timeoutMs);
    const data = (chunk: Buffer | string) => {
      const b = Buffer.from(chunk); bytes += b.length;
      if (bytes > INPUT_BYTES) finish(false); else chunks.push(b);
    };
    const end = () => {
      try { const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); finish(true, value); }
      catch { finish(false); }
    };
    const error = () => finish(false);
    function finish(ok: boolean, value?: unknown) {
      clearTimeout(timer); input.removeListener("data", data); input.removeListener("end", end); input.removeListener("error", error);
      input.pause();
      if (ok) resolve(value); else reject(new Error("invalid_input"));
    }
    input.on("data", data); input.on("end", end); input.on("error", error);
  });
}
export async function runCli(input: Readable, args: string[], select: Selector = selectTitle): Promise<Decision> {
  if (args.length) return invalid();
  try {
    const value = await readInput(input);
    if (!prepare(value)) return invalid();
    return await select(value as SelectionInput, new AbortController().signal);
  } catch { return invalid(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runCli(process.stdin, process.argv.slice(2)).then(result => {
    // One JSON, no topic/credential diagnostics. Bound even a blocked stdout.
    const timer = setTimeout(() => process.exit(1), 500);
    process.stdout.write(JSON.stringify(result) + "\n", () => { clearTimeout(timer); process.exit(0); });
  });
}
