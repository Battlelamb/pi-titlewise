import assert from "node:assert/strict";
import { test, after } from "node:test";
import { loadSkill, validTitle, clean } from "./core.ts";
import { fakeSelector, generated } from "./test-fixtures.ts";
import { selectTitle } from "./selector.ts";

// Synthetic host only. These tests neither load a provider nor a session store.
export function contract(label: string, install: (api: any, options: any) => void, omp = false) {
  const savedIdentity = process.env.PI_HERDSMAN_AGENT_DEFINITION;
  delete process.env.PI_HERDSMAN_AGENT_DEFINITION;
  after(() => {
    if (savedIdentity === undefined) delete process.env.PI_HERDSMAN_AGENT_DEFINITION;
    else process.env.PI_HERDSMAN_AGENT_DEFINITION = savedIdentity;
  });
  const date = "2026-10-02";
  const title = `Session title integration + safe shutdown and validation - ${date}`;
  const answer = (text = title) => ({ role: "assistant", content: [{ type: "text", text: generated(text) }], stopReason: "stop" });
  async function fixture(timeoutMs = 100, select: any = fakeSelector) {
    const skill = await loadSkill();
    const events = new Map<string, Function>();
    const commands = new Map<string, any>();
    const calls: any[] = [], names: string[] = [], displays: any[] = [], notes: string[] = [];
    let name: string | undefined;
    let id = "synthetic-a";
    let response: () => Promise<any> = async () => answer();
    let setter: (title: string) => any = title => { name = title; names.push(title); };
    const model = { id: "active-model", provider: "mock", api: "mock" };
    const stream = (selected: any, context: any, options: any) => {
      assert.equal(selected, model, "must reuse active model");
      assert.deepEqual(context.tools, []);
      assert.ok(options.signal instanceof AbortSignal);
      calls.push({ context, options });
      return { result: () => response() };
    };
    const ctx: any = {
      mode: "tui", hasUI: true, agent: { kind: "main" }, model,
      sessionManager: new Proxy({ getSessionId: () => id }, { get(target, key) {
        assert.equal(key, "getSessionId", "no transcript/session history access");
        return target.getSessionId;
      } }),
      modelRegistry: {
        streamSimple: stream,
        resolveModelHeaders: async () => ({ "x-mock": "yes" }),
        resolver: (selected: any, session: string) => {
          assert.equal(selected, model); assert.equal(session, id); return "mock-runtime-auth";
        },
      },
      ui: { notify: (text: string) => notes.push(text) },
    };
    const api: any = {
      on: (event: string, callback: Function) => events.set(event, callback),
      registerCommand: (name: string, command: any) => commands.set(name, command),
      getSessionName: () => name,
      setSessionName: (title: string) => setter(title),
      sendMessage: (message: any, options: any) => {
        assert.deepEqual(options, { triggerTurn: false }); displays.push(message);
      },
    };
    const tracked: Promise<void>[] = [];
    install(api, { track: (p: Promise<void>) => tracked.push(p), now: () => new Date(`${date}T12:00:00Z`), skill: async () => skill, timeoutMs, select, ...(omp ? { stream } : {}) });
    // Pi only automates fresh sessions (automaticByDefault: false), so the synthetic host starts as "new".
    events.get("session_start")?.({ type: "session_start", reason: "new" }, ctx);
    return { calls, names, displays, notes, ctx, skill, commands,
      emit: (event: string, data: any = {}) => events.get(event)!({ type: event, ...(event === "session_start" ? { reason: "new" } : {}), ...data }, ctx),
      input: (text = "Başlık entegrasyonunu ve kapanış sınamalarını uygula", source = "interactive") => Promise.resolve(events.get("input")!({ text, source }, ctx)).then(() => Promise.all(tracked.splice(0))),
      manual: (args = "") => commands.get("titlewise").handler(args, ctx),
      rename: (value: string) => { name = value; },
      name: () => name,
      session: (value: string) => { id = value; name = undefined; },
      response: (fn: () => Promise<any>) => { response = fn; },
      setter: (fn: (title: string) => any) => { setter = fn; },
    };
  }
  test(`${label}: empty start/exit and trivial or command input are no-ops`, async () => {
    const f = await fixture(); await f.emit("session_start");
    for (const text of ["", "  ", "merhaba", "/titlewise", "!pwd", "."]) await f.input(text);
    await f.emit("session_shutdown"); assert.equal(f.calls.length, 0);
  });
  test(`${label}: first input once, live assistant-only capture, final exactly once`, async () => {
    const f = await fixture(); await f.emit("session_start"); await f.input();
    assert.equal(f.calls.length, 1); assert.equal(f.name(), title);
    assert.ok(f.notes[0].includes("source=fallback; status=selected")); assert.ok(f.notes[0].includes("applied=true"));
    await f.input("İkinci gerçek kullanıcı isteği");
    await f.emit("message_end", { message: { role: "assistant", content: [
      { type: "text", text: "Türkçe başlıklar doğrulandı" }, { type: "thinking", thinking: "PRIVATE-REASONING" },
      { type: "toolCall", arguments: "PRIVATE-TOOL-ARGUMENTS" },
    ] } });
    await f.emit("message_end", { message: { role: "toolResult", content: [{ type: "text", text: "PRIVATE-TOOL-RESULT" }] } });
    await f.emit("session_shutdown"); await f.emit("session_shutdown");
    assert.equal(f.calls.length, 2); assert.equal(f.names.length, 2);
    const wire = JSON.stringify(f.calls[1].context);
    assert.ok(wire.includes("Türkçe başlıklar doğrulandı")); assert.ok(!wire.includes("PRIVATE-"));
    for (const call of f.calls) {
      const system = omp ? call.context.systemPrompt.join("\n") : call.context.messages[0].content;
      assert.ok(system.includes("## User preset")); assert.ok(system.includes("Compact"));
      assert.ok(system.includes("- Language: English")); assert.ok(!system.includes("- Language: Turkish"));
      assert.ok(system.includes("1 to 3 distinct Long English Descriptive titles"));
      assert.ok(system.includes("Preserve proper names and diacritics, and use ordinary hyphens"));
      assert.ok(system.includes("Selection is a later code step"));
    }
  });
  test(`${label}: auto title with Jev configured uses the Jev pick and sends only the synopsis`, async () => {
    const seen: any[] = [];
    const jev = (input: any, signal: AbortSignal) => selectTitle(input, signal, 100, {
      auth: async () => "test-key",
      fetch: async (url: any, init: any) => {
        seen.push({ url, auth: init.headers.Authorization, body: init.body });
        return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { title: { type: "choice", choice: "c0", confidence: 0.9, probabilities: { c0: 0.9, skip: 0.1 } } } }));
      },
    });
    const f = await fixture(100, jev); await f.emit("session_start"); await f.input("PRIVATE-TRANSCRIPT-MARKER please title this");
    assert.equal(f.name(), title); assert.ok(f.notes[0].includes("source=jev; status=selected")); assert.ok(f.notes[0].includes("applied=true"));
    assert.equal(seen.length, 1); assert.equal(seen[0].url, "https://api.typesafe.ai/v1/systemone"); assert.equal(seen[0].auth, "Bearer test-key");
    assert.ok(!seen[0].body.includes("PRIVATE-TRANSCRIPT-MARKER"));
  });
  test(`${label}: manual standalone full skill suggestions, independent of name/automatic state`, async () => {
    const f = await fixture(); f.rename("My manual session name");
    f.ctx.mode = "rpc"; // explicit manual command does not depend on auto eligibility
    await f.manual(); assert.equal(f.calls.length, 0);
    const hint = "Başlık entegrasyonuna öneriler; language: Turkish (Türkçe)";
    await f.manual(hint);
    assert.equal(f.calls.length, 1); assert.equal(f.displays.length, 1); assert.equal(f.names.length, 0);
    const wire = JSON.stringify(f.calls[0].context);
    assert.ok(wire.includes("full suggestion-only skill output")); assert.ok(wire.includes("Slug, Keyword, Bracket"));
    assert.ok(wire.includes("- Language: English"));
    assert.ok(wire.includes("unless the explicit user title request overrides it"));
    assert.ok(wire.includes("unless they explicitly override one"));
    assert.ok(f.calls[0].context.messages.at(-1).content.includes(`user title request: ${hint}`));
    assert.equal(f.commands.get("titlewise").description,
      "Titlewise suggestions: English/Long/Suffix/all styles; optional topic or preference override (does not rename)");
    assert.equal(f.name(), "My manual session name");
    assert.ok(f.displays[0].content.includes("source=fallback"));
    assert.ok(f.displays[0].content.includes("Recommended"));
    assert.ok(f.displays[0].content.includes("Description:"));
    assert.ok(f.displays[0].content.includes("Tags:"));
    assert.ok(f.displays[0].content.includes("Nothing was renamed."));
  });
  test(`${label}: extension/rpc/managed-child/headless/subagent inputs skipped`, async () => {
    const f = await fixture(); await f.emit("session_start");
    await f.input(undefined, "extension"); await f.input(undefined, "rpc");
    process.env.PI_HERDSMAN_AGENT_DEFINITION = "synthetic-child";
    try { await f.input(); } finally { delete process.env.PI_HERDSMAN_AGENT_DEFINITION; }
    // Headless modes are skipped only inside an inherited herdr pane; pin that so the test does not depend on the shell.
    const pane = process.env.HERDR_PANE_ID; process.env.HERDR_PANE_ID = "pane-1";
    try { f.ctx.mode = "print"; await f.input(); } finally { f.ctx.mode = "tui"; if (pane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = pane; }
    if (omp) { f.ctx.agent.kind = "sub"; await f.input(); f.ctx.agent.kind = "main"; }
    await f.emit("session_shutdown"); assert.equal(f.calls.length, 0);
  });
  test(`${label}: existing names and manual renames win (including in-flight)`, async () => {
    const existing = await fixture(); existing.rename("Existing"); await existing.input();
    await existing.emit("session_shutdown"); assert.equal(existing.calls.length, 0);
    const f = await fixture(); await f.input(); f.rename("Manual rename");
    await f.emit("session_shutdown"); assert.equal(f.calls.length, 1); assert.equal(f.name(), "Manual rename");
    const racing = await fixture(); let resolve!: (value: any) => void;
    racing.response(() => new Promise(r => { resolve = r; })); const work = racing.input();
    await new Promise(r => setTimeout(r, 0)); racing.rename("Race winner"); resolve(answer()); await work;
    assert.equal(racing.name(), "Race winner"); assert.equal(racing.names.length, 0);
  });
  test(`${label}: shutdown waits for first request; overlapping events do not double-fire`, async () => {
    const f = await fixture(); let resolve!: (value: any) => void;
    f.response(() => new Promise(r => { resolve = r; })); const first = f.input();
    await new Promise(r => setTimeout(r, 0)); await f.input("Daha fazla canlı bilgi");
    await f.manual("simultaneous manual"); const end = f.emit("session_shutdown");
    f.response(async () => answer()); resolve(answer()); await Promise.all([first, end]);
    assert.equal(f.calls.length, 2); assert.equal(f.displays.length, 0);
  });
  test(`${label}: reload/resume dedup and session-switch isolation`, async () => {
    const f = await fixture(); await f.input(); await f.emit("session_start", { reason: "reload" }); await f.input();
    assert.equal(f.calls.length, 1);
    f.session("synthetic-b"); await f.emit("session_start", { reason: "fork" }); await f.emit("session_shutdown");
    assert.equal(f.calls.length, 1);
    const late = await fixture(); let resolve!: (value: any) => void;
    late.response(() => new Promise(r => { resolve = r; })); const work = late.input();
    await new Promise(r => setTimeout(r, 0)); late.session("new-session"); await late.emit("session_start");
    resolve(answer()); await work; assert.equal(late.names.length, 0);
  });
  test(`${label}: provider failure/timeout fail open; late results cannot rename`, async () => {
    const failed = await fixture(); failed.response(async () => { throw new Error("mock failure"); });
    await failed.input(); await failed.emit("session_shutdown"); assert.equal(failed.calls.length, 2); assert.equal(failed.names.length, 0);
    const f = await fixture(15); let resolve!: (value: any) => void;
    f.response(() => new Promise(r => { resolve = r; })); await f.input();
    assert.ok(f.calls[0].options.signal.aborted); await f.emit("session_shutdown");
    assert.equal(f.calls.length, 1); resolve(answer()); await new Promise(r => setTimeout(r, 0)); assert.equal(f.names.length, 0);
  });
  test(`${label}: native setter wait is also bounded`, async () => {
    const f = await fixture(15); f.setter(() => new Promise(() => {}));
    const before = Date.now(); await f.input(); await f.emit("session_shutdown");
    assert.ok(Date.now() - before < 500); assert.equal(f.calls.length, 1);
    assert.ok(!f.notes.some(text => text.includes("applied=true")));
  });
  test(`${label}: fast model failure falls back to the active model; total failure warns once`, async () => {
    if (omp) return; // the registry facade is Pi-only
    const fast = { id: "fast-model" };
    const f = await fixture(); const used: string[] = [];
    const original = f.ctx.modelRegistry.streamSimple;
    f.ctx.modelRegistry.find = () => fast;
    f.ctx.modelRegistry.streamSimple = (m: any, c: any, o: any) => { used.push(m.id); return m === fast ? { result: async () => { throw new Error("logged out"); } } : original(m, c, o); };
    await f.input();
    assert.deepEqual(used, ["fast-model", "active-model"]); assert.equal(f.name(), title);
    const g = await fixture();
    g.ctx.modelRegistry.find = () => fast;
    g.ctx.modelRegistry.streamSimple = () => ({ result: async () => { throw new Error("down"); } });
    await g.input(); await g.input("A second real request that must not warn again");
    assert.equal(g.name(), undefined);
    assert.equal(g.notes.filter(n => n.includes("automatic title generation failed")).length, 1);
  });
  test(`${label}: bounded context, secret filtering, strict Unicode/date/output validation`, async () => {
    const f = await fixture(); await f.input("Türkçe iş: " + "a".repeat(20000));
    await f.input("Son ayrıntı " + "b".repeat(20000) + " api_key=DO-NOT-SEND"); await f.emit("session_shutdown");
    assert.ok(f.calls[1].context.messages.at(-1).content.length <= 12030);
    assert.equal(validTitle(title, date), title);
    const unicodeTitle = `İzmir and München session title integration + validation - ${date}`;
    assert.equal(validTitle(unicodeTitle, date), unicodeTitle);
    for (const bad of ["hello", title + "\nextra", title.replace("2026-10-02", "2026-10-01"), "```" + title, title.replace("+", "—")]) assert.equal(validTitle(bad, date), undefined);
    assert.ok(!clean("password=DO-NOT-SEND").includes("DO-NOT-SEND"));
  });
}
