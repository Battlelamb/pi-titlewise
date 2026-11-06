import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assistantText, createAdapter, managedChild } from "./core.ts";
import type { Options } from "./core.ts";
import { renameWorkspace, type WorkspaceExec } from "./workspace.ts";
import { freshSession } from "./fresh-session.ts";

// Only type imports from Pi: candidate generation uses the active registry;
// the shared core explicitly selects titles with Jev (never routes models).
export default function titlewise(pi: ExtensionAPI, options: Options & { exec?: WorkspaceExec; track?: (p: Promise<void>) => void } = {}) {
  const exec: WorkspaceExec = options.exec ?? ((command, args, opts) => pi.exec(command, args, opts));
  let publication = 0;
  let publicationOpen = false;
  const workspaceEligible = (ctx: ExtensionContext) => {
    const kind = (ctx as ExtensionContext & { agent?: { kind: string } }).agent?.kind;
    return ctx.mode === "tui" && !managedChild() && (kind === undefined || kind === "main");
  };
  const adapter = createAdapter<ExtensionContext>({
    id: ctx => ctx.sessionManager.getSessionId(), // in-memory identity, never getBranch/getEntries
    eligible: ctx => !managedChild() && (ctx.mode === "tui" ||
      // Herdsman's native name listener may publish pane metadata in headless
      // mode. Until that owner is mode-safe, do not compete in an inherited pane.
      process.env.HERDR_PANE_ID === undefined && ["rpc", "json", "print"].includes(ctx.mode)),
    automaticByDefault: false,
    inputOrigin: (ctx, source) => source === "interactive" || ctx.mode === "rpc" && source === "rpc",
    name: () => pi.getSessionName(),
    setName: title => pi.setSessionName(title),
    firstTitle: (ctx, title, current) => {
      const generation = publication;
      // A pending first generation may finish after shutdown has begun. The
      // open flag rejects that callback; the token invalidates earlier reads.
      return renameWorkspace(exec, title, () => publicationOpen && generation === publication &&
        current() && workspaceEligible(ctx));
    },
    async generate(ctx, request) {
      if (!ctx.model) throw new Error("No active model");
      // Physical model first, not the active virtual router: its cold route can outlast the title budget.
      // Fall back to the active model when the fast one is missing, logged out, or errors.
      const fast = ctx.modelRegistry.find?.("openai", "gpt-6-luna");
      let failure: unknown = new Error("Generation failed");
      for (const model of fast && fast !== ctx.model ? [fast, ctx.model] : [ctx.model]) {
        try {
          const result = await ctx.modelRegistry.streamSimple(model, {
            messages: [
              { role: "system", content: request.system, timestamp: Date.now() },
              { role: "user", content: request.input, timestamp: Date.now() },
            ],
            tools: [],
          }, { signal: request.signal, maxTokens: request.maxTokens }).result();
          if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error("Generation failed");
          return assistantText(result);
        } catch (error) {
          if (request.signal.aborted) throw error;
          failure = error;
        }
      }
      throw failure;
    },
    show: content => pi.sendMessage({ customType: "titlewise", content, display: true }, { triggerTurn: false }),
    notify: (ctx, text) => ctx.ui.notify(text, "info"),
  }, options);
  pi.on("session_start", (event, ctx) => {
    const generation = ++publication;
    publicationOpen = true;
    adapter.start(ctx, freshSession(event.reason, ctx.sessionManager));
    try {
      const id = ctx.sessionManager.getSessionId(), title = pi.getSessionName();
      // Reuse even a manual native title; the bridge preserves custom labels.
      // A lifecycle token also invalidates old contexts with a stable session ID.
      if (title) void renameWorkspace(exec, title, () => generation === publication &&
        ctx.sessionManager.getSessionId() === id && pi.getSessionName() === title && workspaceEligible(ctx));
    } catch { /* invalidated context: fail open */ }
  });
  // Fire and forget: Pi awaits input handlers, so awaiting the title would stall the first prompt.
  pi.on("input", (event, ctx) => {
    const pending = adapter.input(ctx, event.text, event.source); // evaluated even without a tracker
    options.track?.(pending);
  });
  pi.on("message_end", (event, ctx) => adapter.assistant(ctx, assistantText(event.message)));
  pi.on("session_shutdown", (_event, ctx) => {
    publicationOpen = false;
    publication++;
    return adapter.shutdown(ctx);
  });
  pi.registerCommand("titlewise", {
    description: "Titlewise suggestions: English/Long/Suffix/all styles; optional topic or preference override (does not rename)",
    handler: (args, ctx) => adapter.manual(ctx, args),
  });
}
