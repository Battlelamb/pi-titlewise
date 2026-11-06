// Offline only: fake exec, active-model streams and native setters. No Herdr,
// provider, session store, environment values or subprocess output is consulted.
import assert from "node:assert/strict";
import { test } from "node:test";
import piTitlewise from "./index.ts";
import { fakeSelector, generated } from "./test-fixtures.ts";
import { folderStyle, renameTab, renameWorkspace, type WorkspaceExec } from "./workspace.ts";

const GOOD = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/mock/herdr.sock", HERDR_WORKSPACE_ID: "workspace-1" };
const date = "2026-10-14";
const first = `Türkçe çalışma alanı başlığını güvenle düzenleme sınaması - ${date}`;
const final = `Türkçe çalışma alanı başlığının son kapanış sınaması - ${date}`;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function bridge(labels = [`work - ${date}`]) {
  const calls: { command: string; args: string[]; options: { timeout?: number } | undefined }[] = [];
  let reads = 0;
  const exec: WorkspaceExec = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, "herdr"); assert.equal(options?.timeout, 750);
    if (args[0] === "workspace" && args[1] === "get") {
      assert.deepEqual(args, ["workspace", "get", GOOD.HERDR_WORKSPACE_ID]);
      return { code: 0, stdout: JSON.stringify({ result: { workspace: { label: labels[Math.min(reads++, labels.length - 1)] } } }) };
    }
    if (args[0] === "pane") {
      assert.deepEqual(args, ["pane", "current", "--current"]);
      return { code: 0, stdout: JSON.stringify({ result: { pane: { cwd: "/projects/work", foreground_cwd: "/not/the/workspace" } } }) };
    }
    assert.deepEqual(args, ["workspace", "rename", GOOD.HERDR_WORKSPACE_ID, first]);
    return { code: 0, stdout: "{}" };
  };
  return { calls, exec };
}

test("workspace: folder recognizer strips exactly one date; root, tilde and dot", () => {
  for (const label of ["work", `work - ${date}`, "~", `~ - ${date}`, ".", `. - ${date}`]) assert.ok(folderStyle(label, "/projects/work/"));
  assert.ok(folderStyle(`/ - ${date}`, "/"));
  for (const label of ["My topic", `My topic - ${date}`, `work - ${date} - ${date}`, "work - 26-10-14", " work"]) assert.equal(folderStyle(label, "/projects/work"), false);
  assert.equal(folderStyle("work", ""), false);
});

test("workspace: folder label replaced with exact native title using argv", async () => {
  const f = bridge();
  assert.equal(await renameWorkspace(f.exec, first, () => true, GOOD), true);
  assert.deepEqual(f.calls.map(c => c.args.slice(0, 2)), [["workspace", "get"], ["pane", "current"], ["workspace", "get"], ["workspace", "rename"]]);
});

test("workspace: topical/manual labels and the fresh-read race win", async () => {
  for (const labels of [["Manual topic"], [`work - ${date}`, `Manual topic - ${date}`], ["workspace - " + date]]) {
    const f = bridge(labels);
    assert.equal(await renameWorkspace(f.exec, first, () => true, GOOD), false);
    assert.ok(!f.calls.some(c => c.args[1] === "rename"));
  }
});

test("workspace: numeric or earlier-Titlewise tab labels are replaced; custom tab labels and missing tab id win", async () => {
  const env = { ...GOOD, HERDR_TAB_ID: "tab-1" };
  for (const [label, renamed] of [["1", true], [`Old topic - ${date}`, true], ["Manual tab", false], ["", false]] as const) {
    const calls: string[][] = [];
    const exec: WorkspaceExec = async (_command, args) => { calls.push(args); return args[1] === "get" ? { code: 0, stdout: JSON.stringify({ result: { tab: { label } } }) } : { code: 0, stdout: "{}" }; };
    assert.equal(await renameTab(exec, first, () => true, env), renamed);
    assert.deepEqual(calls.filter(a => a[1] === "rename"), renamed ? [["tab", "rename", "tab-1", first]] : []);
  }
  const none: string[][] = [];
  assert.equal(await renameTab(async (_c, args) => { none.push(args); return { code: 0, stdout: "{}" }; }, first, () => true, GOOD), false);
  assert.equal(none.length, 0);
});

test("workspace: all environment/current-session guards skip with zero exec calls", async () => {
  const f = bridge();
  for (const env of [{}, { ...GOOD, HERDR_ENV: "0" }, { ...GOOD, HERDR_SOCKET_PATH: "" },
    { ...GOOD, HERDR_WORKSPACE_ID: "" }, { ...GOOD, PI_HERDSMAN_AGENT_DEFINITION: "child" }, { ...GOOD, OMPCODE: "1" }]) {
    assert.equal(await renameWorkspace(f.exec, first, () => true, env), false);
  }
  assert.equal(await renameWorkspace(f.exec, first, () => false, GOOD), false);
  assert.equal(await renameWorkspace(f.exec, "--help " + first, () => true, GOOD), false);
  assert.equal(f.calls.length, 0);
});

test("workspace: exec errors, nonzero/killed results and malformed responses fail open", async () => {
  for (const response of [() => { throw new Error("offline"); }, () => ({ code: 1 }),
    () => ({ code: 0, killed: true }), () => ({ code: 0, stdout: "not json" }), () => ({ code: 0, stdout: "{}" })]) {
    let calls = 0;
    const exec: WorkspaceExec = async () => { calls++; return response(); };
    assert.equal(await renameWorkspace(exec, first, () => true, GOOD), false);
    assert.equal(calls, 1, "no retries or rename after failed read");
  }
});

test("workspace: timed-out exec fails open; late read cannot advance to rename", async () => {
  let calls = 0;
  let release!: (value: { code: number; stdout: string }) => void;
  const exec: WorkspaceExec = async () => { calls++; return new Promise(resolve => { release = resolve; }); };
  assert.equal(await renameWorkspace(exec, first, () => true, GOOD), false);
  release({ code: 0, stdout: JSON.stringify({ result: { workspace: { label: "work" } } }) });
  await tick(); assert.equal(calls, 1);
});

async function withEnv(run: () => Promise<void>) {
  const values: NodeJS.ProcessEnv = { ...GOOD, HERDR_PANE_ID: undefined, HERDR_TAB_ID: undefined, OMPCODE: undefined, PI_HERDSMAN_AGENT_DEFINITION: undefined };
  const saved = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
function fixture(install: (api: any, options: any) => void, exec: WorkspaceExec) {
  const events = new Map<string, Function>(), commands = new Map<string, any>();
  let name: string | undefined, id = "session-a", requests = 0, writes = 0;
  let setter: (title: string) => void | Promise<void> = title => { name = title; };
  let respond = (n: number) => Promise.resolve(n === 1 ? first : final);
  const model = { id: "mock-model" };
  const stream = (selected: any, context: any) => {
    assert.equal(selected, model); assert.deepEqual(context.tools, []); requests++;
    return { result: async () => ({ role: "assistant", content: [{ type: "text", text: generated(await respond(requests)) }], stopReason: "stop" }) };
  };
  const ctx: any = { mode: "tui", agent: { kind: "main" }, model,
    sessionManager: { getSessionId: () => id },
    modelRegistry: { streamSimple: stream, resolveModelHeaders: async () => ({}), resolver: () => "mock-auth" },
    ui: { notify: () => {} } };
  const api: any = { on: (event: string, handler: Function) => events.set(event, handler),
    registerCommand: (command: string, handler: any) => commands.set(command, handler),
    getSessionName: () => name, setSessionName: (title: string) => { writes++; return setter(title); }, sendMessage: () => {} };
  const tracked: Promise<void>[] = [];
  install(api, { track: (p: Promise<void>) => tracked.push(p), exec, stream, select: fakeSelector, skill: async () => "mock instructions", now: () => new Date(`${date}T12:00:00Z`), timeoutMs: 40 });
  events.get("session_start")?.({ reason: "new" }, ctx); // Pi automates fresh sessions only
  return { ctx, name: () => name, requests: () => requests, writes: () => writes,
    start: (reason = "resume") => events.get("session_start")!({ reason }, ctx),
    input: () => Promise.resolve(events.get("input")!({ text: "Çalışma alanı başlığını güvenle düzenle", source: "interactive" }, ctx)).then(() => Promise.all(tracked.splice(0))),
    shutdown: () => events.get("session_shutdown")!({}, ctx),
    manual: () => commands.get("titlewise").handler("Çalışma alanı başlık önerisi", ctx),
    setter: (fn: typeof setter) => { setter = fn; }, apply: (title: string) => { name = title; },
    respond: (fn: typeof respond) => { respond = fn; },
    switchSession: () => { id = "session-b"; name = undefined; events.get("session_start")!({ reason: "new" }, ctx); } };
}

for (const [label, install] of [["Pi / Pi-Bolt", piTitlewise]] as const) {
  test(`${label}: startup/resume/reload copies an existing native title without inference or native writes`, () => withEnv(async () => {
    for (const reason of ["startup", "resume", "reload"]) {
      const h = bridge(), f = fixture(install, h.exec);
      f.apply(first); await f.start(reason); await tick();
      assert.equal(h.calls.filter(c => c.args[1] === "rename").length, 1);
      assert.equal(f.name(), first); assert.equal(f.requests(), 0); assert.equal(f.writes(), 0);
    }
  }));

  test(`${label}: startup preserves custom workspace labels and never requires a generated native name`, () => withEnv(async () => {
    for (const labels of [["My workspace"], ["work", "Manual workspace winner"]]) {
      const h = bridge(labels), f = fixture(install, h.exec);
      f.apply("Manual native name"); await f.start(); await tick();
      assert.ok(!h.calls.some(c => c.args[1] === "rename"));
      assert.equal(f.name(), "Manual native name"); assert.equal(f.requests(), 0); assert.equal(f.writes(), 0);
    }
    const h = bridge();
    const f = fixture(install, async (cmd, args, opts) => {
      if (args[1] === "rename") {
        assert.equal(args[3], "Manual native name");
        return h.exec(cmd, [...args.slice(0, 3), first], opts);
      }
      return h.exec(cmd, args, opts);
    });
    f.apply("Manual native name"); await f.start(); await tick();
    assert.equal(h.calls.length, 4); assert.equal(f.writes(), 0); assert.equal(f.requests(), 0);
  }));

  test(`${label}: startup guards skip unnamed, RPC, nonmain, child and nested sessions`, () => withEnv(async () => {
    const h = bridge(); await fixture(install, h.exec).start();
    for (const mode of ["rpc", "print"]) {
      const f = fixture(install, h.exec); f.apply(first); f.ctx.mode = mode; await f.start();
    }
    const sub = fixture(install, h.exec); sub.apply(first); sub.ctx.agent.kind = "sub"; await sub.start();
    for (const key of ["PI_HERDSMAN_AGENT_DEFINITION", "OMPCODE"]) {
      process.env[key] = "1";
      const f = fixture(install, h.exec); f.apply(first); await f.start(); delete process.env[key];
    }
    await tick(); assert.equal(h.calls.length, 0);
  }));

  test(`${label}: detached startup rechecks session/name/eligibility and shutdown before dispatch`, () => withEnv(async () => {
    for (const change of ["name", "session", "mode", "kind", "child", "nested", "shutdown"]) {
      const h = bridge(); let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const f = fixture(install, async (...args) => { await gate; return h.exec(...args); });
      f.apply(first); await f.start(); // must not await held I/O
      if (change === "name") f.apply("User winner");
      if (change === "session") {
        // Real replaced contexts can retain the old ID; the new session may even
        // have the same native title. A lifecycle token must still cancel work.
        f.ctx.sessionManager.getSessionId = () => "session-a";
        f.switchSession(); f.apply(first);
      }
      if (change === "mode") f.ctx.mode = "rpc";
      if (change === "kind") f.ctx.agent.kind = "sub";
      if (change === "child") process.env.PI_HERDSMAN_AGENT_DEFINITION = "child";
      if (change === "nested") process.env.OMPCODE = "1";
      if (change === "shutdown") await f.shutdown();
      release(); await tick();
      assert.equal(h.calls.length, 1, change); assert.equal(f.requests(), 0); assert.equal(f.writes(), 0);
      delete process.env.PI_HERDSMAN_AGENT_DEFINITION; delete process.env.OMPCODE;
    }
  }));

  test(`${label}: startup native rename during the final workspace read wins`, () => withEnv(async () => {
    const h = bridge(); let reads = 0;
    const f = fixture(install, async (...args) => {
      const result = await h.exec(...args);
      if (++reads === 3) f.apply("Manual winner just before dispatch");
      return result;
    });
    f.apply(first); await f.start(); await tick();
    assert.equal(h.calls.length, 3); assert.equal(f.writes(), 0); assert.equal(f.requests(), 0);
  }));

  test(`${label}: only successful first auto title renames; shutdown/manual never rename`, () => withEnv(async () => {
    const h = bridge(), f = fixture(install, h.exec);
    await f.manual(); await tick(); assert.equal(h.calls.length, 0);
    // Reset response numbering after the explicit manual call.
    f.respond(n => Promise.resolve(n === 2 ? first : final));
    await f.input(); await tick(); assert.equal(f.name(), first);
    assert.equal(h.calls.filter(c => c.args[1] === "rename").length, 1);
    await f.shutdown(); await f.manual(); await tick();
    assert.equal(f.name(), final); assert.equal(f.requests(), 4);
    assert.equal(h.calls.length, 4, "final/manual add no workspace reads or renames");
  }));

  test(`${label}: failed first generation does not promote final title to workspace`, () => withEnv(async () => {
    const h = bridge(), f = fixture(install, h.exec);
    f.respond(n => n === 1 ? Promise.reject(new Error("mock failure")) : Promise.resolve(final));
    await f.input(); await f.shutdown(); await tick();
    assert.equal(f.name(), final); assert.equal(h.calls.length, 0);
  }));

  test(`${label}: bridge requires TUI main, not managed child or nested OMP`, () => withEnv(async () => {
    const h = bridge();
    for (const mode of ["rpc", "print"]) { const f = fixture(install, h.exec); f.ctx.mode = mode; await f.input(); }
    const sub = fixture(install, h.exec); sub.ctx.agent.kind = "sub"; await sub.input();
    process.env.PI_HERDSMAN_AGENT_DEFINITION = "child"; await fixture(install, h.exec).input();
    delete process.env.PI_HERDSMAN_AGENT_DEFINITION;
    process.env.OMPCODE = "1"; await fixture(install, h.exec).input();
    await tick(); assert.equal(h.calls.length, 0);
  }));

  test(`${label}: async native setter must succeed before bridge starts`, () => withEnv(async () => {
    const h = bridge(), f = fixture(install, h.exec);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.setter(async title => { await gate; f.apply(title); });
    const input = f.input(); await tick(); assert.equal(h.calls.length, 0);
    release(); await input; await tick(); assert.equal(h.calls.length, 4);
    const rejected = fixture(install, h.exec);
    rejected.setter(async () => { throw new Error("storage failed"); });
    await rejected.input(); await tick(); assert.equal(h.calls.length, 4);
  }));

  test(`${label}: hung native setter times out; late success never starts bridge`, () => withEnv(async () => {
    const h = bridge(), f = fixture(install, h.exec);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.setter(async title => { await gate; f.apply(title); });
    await f.input(); assert.equal(h.calls.length, 0);
    release(); await tick(); assert.equal(h.calls.length, 0);
  }));

  test(`${label}: workspace I/O is detached; session switch cancels remaining work`, () => withEnv(async () => {
    const h = bridge();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(install, async (...args) => { await gate; return h.exec(...args); });
    let finished = false;
    const input = f.input().then(() => { finished = true; });
    await tick(); assert.equal(finished, true, "input does not await the held workspace read");
    assert.equal(f.name(), first);
    f.switchSession(); release(); await input; await tick();
    assert.equal(h.calls.length, 1, "stale session never reaches rename");
  }));
}
