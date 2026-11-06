import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { selectTitle, MODEL, ENDPOINT, INPUT_BYTES, RESPONSE_BYTES, type SelectionInput } from "./selector.ts";
import { piLauncher, resolveAuth } from "./selector-auth.ts";
import { readInput, runCli } from "./cli.ts";
import { createAdapter, validTitle } from "./core.ts";
import { generated } from "./test-fixtures.ts";
import { parseEnvelope, renderManual } from "./candidates.ts";

const date = "2026-10-16";
const titles = [`Session title integration and lifecycle validation - ${date}`, `İzmir and München naming selection with safety guards - ${date}`];
const input: SelectionInput = { topic: "Naming integration", candidates: titles };
const signal = () => new AbortController().signal;
function response(choice = "c1", probabilities: Record<string, number> = { c0: 0.1, c1: 0.8, skip: 0.1 }) {
  return { model: MODEL, answers: { title: { choice, probabilities, confidence: 0.8 } } };
}
function deps(value: unknown = response()) {
  let calls = 0, auths = 0; let wire: any;
  return { get calls() { return calls; }, get auths() { return auths; }, get wire() { return wire; },
    auth: async () => { auths++; return "fake-key"; },
    fetch: (async (url, options) => {
      calls++; assert.equal(url, ENDPOINT); assert.equal(options?.method, "POST"); assert.equal(options?.redirect, "error");
      wire = JSON.parse(options!.body as string);
      assert.deepEqual(Object.keys(wire).sort(), ["model", "questions", "state"]);
      assert.equal(wire.model, MODEL); assert.deepEqual(Object.keys(wire.questions), ["title"]);
      assert.ok(!JSON.stringify(wire).includes("fake-key"));
      return new Response(JSON.stringify(value));
    }) as typeof fetch };
}
test("selector: explicit Jev nonfirst selection, exact title and provenance, one request", async () => {
  const d = deps(), result = await selectTitle(input, signal(), 100, d);
  assert.equal(result.title, titles[1]); assert.equal(result.source, "jev"); assert.equal(result.model, MODEL);
  assert.equal(result.confidence, 0.8); assert.equal(d.calls, 1); assert.equal(d.auths, 1);
  assert.deepEqual(d.wire.state, { topic: input.topic, candidates: { c0: titles[0], c1: titles[1] } });
});
test("selector: valid keep/skip abstain without fallback; absent or choice type accepted", async () => {
  const keep = await selectTitle({ ...input, current: titles[0] }, signal(), 100,
    deps(response("keep", { c0: 0.1, c1: 0.1, keep: 0.7, skip: 0.1 })));
  assert.deepEqual([keep.source, keep.status, keep.title], ["jev", "keep", titles[0]]);
  const v = response("skip", { c0: 0.1, c1: 0.1, skip: 0.79 });
  Object.assign(v.answers.title, { type: "choice" });
  const skip = await selectTitle(input, signal(), 100, deps(v));
  assert.deepEqual([skip.source, skip.status, skip.title], ["jev", "skip", undefined]);
});
test("selector: unavailable auth/network/malformed response/timeout fall back deterministically", async () => {
  let network = 0;
  const missing = await selectTitle(input, signal(), 100, { auth: async () => undefined, fetch: async () => { network++; throw 0; } });
  assert.deepEqual([missing.source, missing.title, missing.reason], ["fallback", titles[0], "auth_unavailable"]); assert.equal(network, 0);
  for (const fetcher of [async () => { throw new Error("private failure"); }, async () => new Response("oops"), async () => new Response("{}", { status: 503 }), async () => new Response("{}", { status: 302 })]) {
    const result = await selectTitle(input, signal(), 100, { auth: async () => "fake-key", fetch: fetcher });
    assert.equal(result.source, "fallback"); assert.equal(result.title, titles[0]); assert.ok(!JSON.stringify(result).includes("private failure"));
  }
  const hangingAuth = await selectTitle(input, signal(), 10, { auth: () => new Promise(() => {}) });
  assert.equal(hangingAuth.reason, "timeout"); assert.equal(hangingAuth.title, titles[0]);
  const d = deps(); let late!: (v: Response) => void;
  d.fetch = async () => new Promise(r => { late = r; });
  const timeout = await selectTitle(input, signal(), 10, d); assert.equal(timeout.reason, "timeout");
  late(new Response(JSON.stringify(response()))); assert.equal(timeout.title, titles[0]);
});
test("selector: unknown/unsafe choices, wrong model/type/question and invalid probability maps rejected", async () => {
  const bad: any[] = [response("invented"), response("__proto__"), response("c1", { c0: 0.8, c1: 0.1, skip: 0.1 }),
    response("c1", { c0: 0.1, c1: 0.8 }), response("c1", { c0: 0.1, c1: 0.8, skip: 0.1, extra: 0 }),
    response("c1", { c0: -0.1, c1: 1.1, skip: 0 }), response("c1", { c0: 0, c1: 0.2, skip: 0 }),
    { ...response(), model: "jev-latest" }, { ...response(), answers: { other: response().answers.title } }];
  for (const type of ["bool", null]) { const v = response(); Object.assign(v.answers.title, { type }); bad.push(v); }
  for (const confidence of [NaN, Infinity, -1, 2, "0.8"]) { const v = response(); Object.assign(v.answers.title, { confidence }); bad.push(v); }
  for (const value of bad) {
    const result = await selectTitle(input, signal(), 100, deps(value));
    assert.deepEqual([result.source, result.title, result.reason], ["fallback", titles[0], "invalid_response"]);
  }
});
test("selector: envelope bounds fail before auth, response cap, no extra fields", async () => {
  const invalid: unknown[] = [null, { ...input, topic: "x".repeat(601) }, { ...input, candidates: [] },
    { ...input, candidates: Array(37).fill("title") }, { ...input, candidates: ["x".repeat(241)] },
    { ...input, candidates: ["bad\ntitle"] }, { ...input, preferences: "x".repeat(401) }, { ...input, endpoint: "https://other.invalid" }];
  for (const v of invalid) { const d = deps(); const result = await selectTitle(v, signal(), 100, d); assert.equal(result.reason, "invalid_input"); assert.equal(d.auths, 0); }
  const large = deps();
  const oversized = await selectTitle({ topic: "Naming", candidates: Array(36).fill("漢".repeat(240)) }, signal(), 100, large);
  assert.equal(oversized.reason, "input_size"); assert.equal(large.auths, 0);
  const result = await selectTitle(input, signal(), 100, { auth: async () => "fake-key", fetch: async () => new Response("x".repeat(RESPONSE_BYTES + 1)) });
  assert.equal(result.source, "fallback");
});
test("selector: conservative privacy filtering preserves original cN mapping", async () => {
  const secrets = ["api_key=do-not-send", "TYPESAFE_API_KEY=do-not-send", '"api_key":"do-not-send"', "email person@example.org", "host 192.168.1.8", "file /home/private/notes", "IPv6 2001:db8::1", "Bearer secret-value"];
  for (const unsafe of secrets) {
    const value = { topic: `Title task ${unsafe}`, candidates: [unsafe, titles[1]], preferences: unsafe, current: unsafe };
    const d = deps(response("c1", { c1: 0.9, skip: 0.1 }));
    const result = await selectTitle(value, signal(), 100, d);
    assert.equal(result.title, titles[1]); assert.deepEqual(Object.keys(d.wire.state.candidates), ["c1"]);
    assert.ok(!JSON.stringify(d.wire).includes(unsafe)); assert.equal(d.wire.state.current, undefined);
    const rejected = await selectTitle(value, signal(), 100, deps(response("c0", { c1: 0.9, skip: 0.1 })));
    assert.equal(rejected.source, "fallback"); assert.equal(rejected.title, titles[1]);
  }
  const d = deps(); const empty = await selectTitle({ ...input, candidates: secrets }, signal(), 100, d);
  assert.equal(empty.status, "skip"); assert.equal(d.auths, 0);
  const expanded = deps();
  await selectTitle({ ...input, topic: "x".repeat(593) + " a@b.co", preferences: "x".repeat(393) + " a@b.co" }, signal(), 100, expanded);
  assert.ok(expanded.wire.state.topic.length <= 600); assert.ok(expanded.wire.state.preferences.length <= 400);
});
test("selector: slash terms including Unicode survive while standalone paths are omitted", async () => {
  const topic = "Pi/OMP CI/CD A/B I/O and/or Türkçe/İngilizce 漢/字 cafe\u0301/menu";
  const title = `${topic} naming integration and safety - ${date}`;
  const paths = ["/home/private/notes", "~/private/notes", "C:\\private\\notes", "C:/private/notes", "./private/notes", "../../home/private/notes"];
  const d = deps(response("c0", { c0: 0.9, skip: 0.1 }));
  const result = await selectTitle({ topic: `${topic} ${paths.join(" ")}`, candidates: [title, ...paths] }, signal(), 100, d);
  assert.equal(result.title, title); assert.equal(result.source, "jev");
  assert.deepEqual(d.wire.state.candidates, { c0: title });
  assert.equal(d.wire.state.topic, `${topic} ${paths.map(() => "[redacted]").join(" ")}`);
  const envelope = parseEnvelope(JSON.stringify({ ...JSON.parse(generated(title)), topic }), false, t => validTitle(t, date));
  assert.equal(envelope?.candidates[0].title, title); assert.equal(envelope?.topic, topic);
});
test("auth: native Pi raw-key protocol and private bounded process group cleanup", async () => {
  function child() { return Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough() }); }
  let p = child(); const killed: any[] = [];
  const launch: any = (command: string, args: string[], options: any) => {
    assert.ok(command.endsWith("/pi")); assert.deepEqual(args, ["auth", "print-api-key", "--provider", "typesafe"]);
    assert.equal(options.shell, false);
    assert.equal(options.detached, true); assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]); return p;
  };
  const kill: any = (...args: any[]) => killed.push(args);
  const runtime = { platform: "linux" as const, launcher: () => "/fake/pi" };
  const work = resolveAuth(signal(), launch, kill, runtime); p.stdout.write('  fake-key\r\n'); p.emit("close", 0);
  assert.equal(await work, "fake-key"); assert.deepEqual(killed.pop(), [-12345, "SIGKILL"]);
  p = child(); const controller = new AbortController(); const aborted = resolveAuth(controller.signal, launch, kill, runtime); controller.abort();
  assert.equal(await aborted, undefined); assert.deepEqual(killed.pop(), [-12345, "SIGKILL"]);
  p.stdout.emit("data", Buffer.from("late-key")); p.emit("close", 0); assert.equal(await aborted, undefined); assert.equal(killed.length, 0);
  p = child(); const big = resolveAuth(signal(), launch, kill, runtime); p.stdout.write("x".repeat(12001)); assert.equal(await big, undefined);
  p = child(); const hung = resolveAuth(signal(), launch, kill, runtime); assert.equal(await hung, undefined); assert.deepEqual(killed.pop(), [-12345, "SIGKILL"]);
});

test("auth: launcher fallback preserves absolute PATH/home npm launchers, never cwd", () => {
  const seen: string[] = [];
  // An executable symlink to npm cli.js is still accepted; the parent's modern
  // Node PATH remains inherited. Never inspect/parse wrapper or symlink contents.
  const exists = (file: string) => { seen.push(file); return file === "/home/mock/.local/bin/pi"; };
  assert.equal(piLauncher({ PATH: ".:relative:/missing" }, "linux", "/home/mock", exists, "/bin/node"), "/home/mock/.local/bin/pi");
  assert.deepEqual(seen, ["/home/mock/.local/share/mise/installs/pi/latest/pi/pi", "/missing/pi", "/home/mock/.local/bin/pi"]);
  assert.equal(piLauncher({ PATH: "/maintained:/other" }, "linux", "/home/mock", file => file === "/maintained/pi", "/bin/node"), "/maintained/pi");
  assert.equal(piLauncher({ Path: "C:\\Pi;C:\\Other" }, "win32", "C:\\Users\\Mock", file => file === "C:\\Pi\\pi.exe", "C:\\Node\\node.exe"), "C:\\Pi\\pi.exe");
  assert.equal(piLauncher({}, "linux", "/home/mock", () => false, "/bin/node"), undefined);
});

test("auth: current native Pi executable wins over installed Pi and a mutating PATH wrapper", () => {
  for (const platform of ["linux", "win32"] as const) {
    const current = platform === "linux" ? "/native/pi" : "C:\\Native\\pi.exe";
    const home = platform === "linux" ? "/home/mock" : "C:\\Users\\Mock";
    const seen: string[] = [];
    const selected = piLauncher({ PATH: platform === "linux" ? "/home/mock/.local/bin" : "C:\\Wrappers" },
      platform, home, file => { seen.push(file); return true; }, current);
    assert.equal(selected, current); assert.deepEqual(seen, [current]);
  }
});

test("auth: installed native Pi wins over wrappers for Node/OMP hosts, never executes the host", () => {
  const installed = "/home/mock/.local/share/mise/installs/pi/latest/pi/pi";
  for (const current of ["/bin/node", "/bin/omp", "/bin/node.exe", "/bin/omp.exe", "pi", "/bin/not-pi"]) {
    const seen: string[] = [];
    assert.equal(piLauncher({ PATH: "/home/mock/.local/bin" }, "linux", "/home/mock",
      file => { seen.push(file); return true; }, current), installed);
    assert.deepEqual(seen, [installed], "no probe or selection of Node/OMP/relative execPath");
  }
  const windowsInstall = "C:\\Users\\Mock\\.local\\share\\mise\\installs\\pi\\latest\\pi\\pi.exe";
  assert.equal(piLauncher({ Path: "C:\\Wrappers" }, "win32", "C:\\Users\\Mock",
    () => true, "C:\\OMP\\omp.exe"), windowsInstall);
});

test("auth: unavailable current native Pi falls through to the installed binary, then npm PATH", () => {
  const installed = "/home/mock/.local/share/mise/installs/pi/latest/pi/pi";
  for (const available of [installed, "/npm/bin/pi"]) {
    assert.equal(piLauncher({ PATH: "/npm/bin" }, "linux", "/home/mock",
      file => file === available, "/removed/pi"), available);
  }
});

test("auth: raw key bounds, invalid/missing/error output, cleanup failures and abort-before-launch", async () => {
  const runtime = { platform: "linux" as const, launcher: () => "/fake/pi" };
  for (const [raw, code, expected] of [
    ["fake-key", 0, "fake-key"], ["\r\n fake-key \r\n", 0, "fake-key"],
    ["x".repeat(8192) + "\n", 0, "x".repeat(8192)], ["x".repeat(8193), 0, undefined],
    ["", 0, undefined], [" \n", 0, undefined], ["fake key", 0, undefined],
    ["fake\nkey", 0, undefined], ["fake\x00key", 0, undefined], ["fake\x7fkey", 0, undefined],
    [Buffer.from([0xff]), 0, undefined], ["fake-key", 1, undefined], ["fake-key", null, undefined],
  ] as const) {
    const p = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough() });
    let kills = 0;
    const work = resolveAuth(signal(), (() => p) as any, (() => { kills++; throw new Error("cleanup failed"); }) as any, runtime);
    p.stdout.write(raw); p.emit("close", code);
    assert.equal(await work, expected); assert.equal(kills, 1); assert.ok(p.stdout.destroyed);
  }
  for (const source of ["child", "stdout", "missing"] as const) {
    const p = Object.assign(new EventEmitter(), { pid: undefined, stdout: source === "missing" ? null : new PassThrough() });
    let kills = 0;
    const work = resolveAuth(signal(), (() => p) as any, (() => { kills++; }) as any, runtime);
    if (source === "child") p.emit("error", new Error("private failure"));
    if (source === "stdout") p.stdout!.emit("error", new Error("private failure"));
    assert.equal(await work, undefined); assert.equal(kills, 0);
  }
  let launches = 0;
  const launch = (() => { launches++; throw new Error("missing executable"); }) as any;
  const c = new AbortController(); c.abort();
  assert.equal(await resolveAuth(c.signal, launch, undefined, runtime), undefined); assert.equal(launches, 0);
  assert.equal(await resolveAuth(signal(), launch, undefined, { launcher: () => undefined }), undefined); assert.equal(launches, 0);
  assert.equal(await resolveAuth(signal(), launch, undefined, runtime), undefined); assert.equal(launches, 1);
  assert.equal(await resolveAuth(signal(), launch, undefined,
    { platform: "win32", launcher: () => "C:\\Pi\\pi.exe", systemRoot: "" }), undefined);
  assert.equal(launches, 1, "no Windows child without a safe tree-cleanup command path");
  for (const pid of [0, 1, -12345, NaN]) {
    const p = Object.assign(new EventEmitter(), { pid, stdout: new PassThrough() });
    const c = new AbortController();
    let kills = 0;
    const work = resolveAuth(c.signal, (() => p) as any, (() => { kills++; }) as any, runtime);
    c.abort(); assert.equal(await work, undefined); assert.equal(kills, 0);
  }
});

test("auth: Windows cleanup targets only a live owned child tree, bounded/private; never negative PIDs", async () => {
  for (const end of ["abort", "close", "exit-abort", "cleanup-error"] as const) {
    const c = new AbortController();
    const p = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough() });
    const cleanup = Object.assign(new EventEmitter(), { unref: () => {} });
    const calls: any[] = [];
    const launch = ((command: string, args: string[], options: any) => {
      calls.push({ command, args, options });
      if (calls.length === 1) { assert.equal(options.detached, false); return p; }
      if (end === "cleanup-error") throw new Error("private cleanup failure");
      return cleanup;
    }) as any;
    let kills = 0;
    const work = resolveAuth(c.signal, launch, (() => { kills++; }) as any,
      { platform: "win32", launcher: () => "C:\\Pi\\pi.exe", systemRoot: "C:\\Windows" });
    if (end === "close") { p.stdout.write("fake-key\n"); p.emit("close", 0); }
    else { if (end === "exit-abort") p.emit("exit", 0); c.abort(); }
    assert.equal(await work, end === "close" ? "fake-key" : undefined); assert.equal(kills, 0);
    assert.equal(calls.length, end === "close" || end === "exit-abort" ? 1 : 2);
    if (calls.length === 2) {
      assert.equal(calls[1].command, "C:\\Windows\\System32\\taskkill.exe");
      assert.deepEqual(calls[1].args, ["/PID", "12345", "/T", "/F"]);
      assert.deepEqual(calls[1].options, { shell: false, windowsHide: true, stdio: "ignore", timeout: 250, killSignal: "SIGKILL" });
      if (end !== "cleanup-error") cleanup.emit("error", new Error("private failure"));
    }
  }
});

test("auth: selector cancellation never uses a late credential for a request", async () => {
  let release!: (key: string) => void, calls = 0;
  const c = new AbortController();
  const work = selectTitle(input, c.signal, 100, {
    auth: () => new Promise(resolve => { release = resolve; }),
    fetch: async () => { calls++; throw new Error("must not request"); },
  });
  c.abort(); const result = await work; release("fake-late-key"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.reason, "cancelled"); assert.equal(calls, 0);
});
test("CLI: one strict bounded JSON, no flags, no auth for invalid envelopes; Unicode input", async () => {
  const run = (text: string, args: string[] = []) => { const d = deps(); return runCli(Readable.from([text]), args,
    (v, s) => selectTitle(v, s, 100, d)).then(result => ({ result, d })); };
  for (const text of ["{}", JSON.stringify(input) + "{}", "x".repeat(INPUT_BYTES + 1), "not-json"]) {
    const { result, d } = await run(text); assert.equal(result.status, "skip"); assert.equal(d.auths, 0);
  }
  const flagged = await run(JSON.stringify(input), ["--key=forbidden"]); assert.equal(flagged.d.auths, 0);
  const good = await run(JSON.stringify(input)); assert.equal(good.result.title, titles[1]); assert.equal(good.d.calls, 1);
  await assert.rejects(readInput(new PassThrough(), 10));
  await assert.rejects(readInput(Readable.from([Buffer.from([0xff])]), 10));
});

test("candidates: manual Turkish/compact date exceptions, safe renderer, strict auto date and bounds", () => {
  const manual = { ...JSON.parse(generated(titles[0])), candidates: [
    { title: "izmir-baslik-sinamasi", style: "Slug", language: "Turkish" },
    { title: "İzmir · başlık · güvenlik", style: "Keyword", language: "Turkish" },
    { title: `[${date}][İzmir] Başlık + güvenlik`, style: "Bracket", language: "Turkish" },
  ], suppressed: 14 };
  const parsed = parseEnvelope(JSON.stringify(manual), true, t => validTitle(t, date))!;
  assert.equal(parsed.candidates.length, 3);
  const rendered = renderManual(parsed, { source: "jev", status: "selected", title: manual.candidates[1].title, model: MODEL });
  assert.ok(rendered.includes("Turkish / Keyword")); assert.ok(rendered.includes("14 combinations suppressed"));
  assert.ok(rendered.includes(manual.candidates[1].title));
  assert.equal(parseEnvelope(JSON.stringify(manual), false, t => validTitle(t, date)), undefined);
  assert.equal(parseEnvelope(generated(titles[0].replace(date, "2026-10-15")), false, t => validTitle(t, date)), undefined);
  assert.equal(parseEnvelope("```json\n" + generated(titles[0]) + "\n```", false, t => t), undefined);
  assert.equal(parseEnvelope(JSON.stringify({ ...manual, candidates: Array(13).fill(manual.candidates[0]) }), true, t => t), undefined);
  assert.equal(parseEnvelope(JSON.stringify({ ...manual, topic: "x".repeat(601) }), true, t => t), undefined);
  assert.equal(parseEnvelope(JSON.stringify({ ...manual, candidates: [{ ...manual.candidates[0], title: "api_key=do-not-send" }] }), true, t => t), undefined);
});

function adapterFixture(choice = "c1") {
  let name: string | undefined; let generations = 0; const notices: string[] = [], displays: string[] = [], decisions: any[] = [];
  let id = "a"; let release: (() => void) | undefined;
  const adapter = createAdapter({ id: () => id, eligible: () => true, name: () => name, setName: title => { name = title; },
    generate: async (_ctx, req) => { generations++; assert.ok(req.input.includes("RAW-TRANSCRIPT-MARKER"));
      return JSON.stringify({ ...JSON.parse(generated(titles[0])), candidates: titles.map(title => ({ title, style: "Descriptive", language: "English" })) }); },
    show: text => displays.push(text), notify: (_ctx, text) => notices.push(text),
  }, { skill: async () => "skill", now: () => new Date(`${date}T12:00:00Z`), timeoutMs: 200,
    select: async (v, s, budget) => {
      decisions.push(v); assert.ok(!JSON.stringify(v).includes("RAW-TRANSCRIPT-MARKER"));
      assert.ok(!("description" in v)); assert.ok(!("tags" in v));
      if (release) await new Promise<void>(r => { release = r; });
      const probabilities = v.current ? { c0: 0.1, c1: 0.1, keep: 0.1, skip: 0.1, [choice]: 0.7 } : { c0: 0.1, c1: 0.1, skip: 0.1, [choice]: 0.8 };
      return selectTitle(v, s, budget, deps(response(choice, probabilities)));
    } });
  return { adapter, name: () => name, notices, displays, decisions, generations: () => generations,
    rename: (v: string) => { name = v; }, switch: () => { id = "b"; name = undefined; adapter.start({}); },
    hold: () => { release = () => {}; }, release: () => release!() };
}
test("runtime: manual generation/selection timeout notifies, retains raw guard, and allows later automatic naming", async () => {
  for (const stage of ["generation", "selection"] as const) {
    let name: string | undefined, observedSignal: AbortSignal | undefined;
    let generations = 0, selections = 0, writes = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const notices: string[] = [], displays: string[] = [];
    const adapter = createAdapter({ id: () => "manual-timeout", eligible: () => true, name: () => name,
      setName: title => { name = title; writes++; },
      generate: async (_ctx, req) => {
        generations++; observedSignal = req.signal;
        if (stage === "generation" && generations === 1) await held;
        return generated(titles[0]);
      }, show: text => displays.push(text), notify: (_ctx, text) => notices.push(text),
    }, { skill: async () => "", now: () => new Date(`${date}T00:00:00Z`), timeoutMs: 20,
      select: async () => {
        selections++;
        if (stage === "selection" && selections === 1) await held;
        return { source: "fallback", status: "selected", title: titles[0], reason: "auth_unavailable" };
      } });
    await adapter.manual({}, "Naming integration");
    assert.ok(observedSignal?.aborted); assert.equal(generations, 1);
    assert.ok(notices[0].includes("manual request timed out"));
    await adapter.manual({}, "Overlapping request");
    assert.ok(notices[1].includes("already running")); assert.equal(generations, 1);
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes, 0); assert.deepEqual(displays, []);
    assert.equal(selections, stage === "generation" ? 0 : 1);
    await adapter.input({}, "Eligible automatic naming topic", "interactive");
    assert.equal(generations, 2); assert.equal(selections, stage === "generation" ? 1 : 2);
    assert.equal(writes, 1); assert.equal(name, titles[0]);
    assert.ok(notices.at(-1)?.includes("source=fallback")); assert.ok(notices.at(-1)?.includes("applied=true"));
  }
});
test("runtime: selected notice requires the setter's title to remain current", async () => {
  let name: string | undefined;
  const notices: string[] = [];
  const adapter = createAdapter({ id: () => "setter-race", eligible: () => true, name: () => name,
    setName: async () => { name = "User winner"; }, generate: async () => generated(titles[0]),
    show: () => {}, notify: (_ctx, text) => notices.push(text),
  }, { skill: async () => "", now: () => new Date(`${date}T00:00:00Z`), select: async () =>
    ({ source: "fallback", status: "selected", title: titles[0], reason: "auth_unavailable" }) });
  await adapter.input({}, "Naming integration topic", "interactive");
  assert.equal(name, "User winner"); assert.equal(notices.length, 1);
  assert.ok(notices[0].includes("source=fallback; status=selected")); assert.ok(notices[0].includes("applied=false"));
});
test("runtime: nonfirst applies once, short decision state only, full manual recommendation never renames", async () => {
  const f = adapterFixture(); await f.adapter.input({}, "RAW-TRANSCRIPT-MARKER title integration", "interactive");
  assert.equal(f.name(), titles[1]); assert.equal(f.generations(), 1); assert.equal(f.decisions.length, 1);
  assert.ok(f.notices[0].includes("source=jev")); assert.ok(f.notices[0].includes("applied=true"));
  f.rename("Manual name"); await f.adapter.manual({}, "language: Turkish");
  assert.equal(f.name(), "Manual name"); assert.equal(f.decisions[1].current, undefined);
  assert.ok(f.displays[0].includes(`Recommended:\n\n\`\`\`\n${titles[1]}`));
  for (const text of ["source=jev", "Description:", "Tags:", "Nothing was renamed."]) assert.ok(f.displays[0].includes(text));
});
test("runtime: skip no mutation; keep preserves owned name; selector-race rename/session switch win", async () => {
  const skip = adapterFixture("skip"); await skip.adapter.input({}, "RAW-TRANSCRIPT-MARKER topic", "interactive"); assert.equal(skip.name(), undefined);
  assert.ok(skip.notices[0].includes("status=skip")); assert.ok(!skip.notices[0].includes("applied="));
  for (const action of ["rename", "switch"] as const) {
    const f = adapterFixture(); f.hold(); const work = f.adapter.input({}, "RAW-TRANSCRIPT-MARKER topic", "interactive");
    await new Promise(r => setImmediate(r));
    if (action === "rename") f.rename("User winner"); else f.switch();
    f.release(); await work; assert.equal(f.name(), action === "rename" ? "User winner" : undefined);
    assert.ok(!f.notices.some(text => text.includes("applied=true")));
    if (action === "rename") {
      assert.ok(f.notices[0].includes("source=jev; status=selected")); assert.ok(f.notices[0].includes("applied=false"));
    } else assert.deepEqual(f.notices, []);
  }
  // Independent host preserves ownership through a selected first title then KEEP.
  let name: string | undefined; let n = 0, writes = 0; const notices: string[] = [];
  const a = createAdapter({ id: () => "keep", eligible: () => true, name: () => name, setName: t => { name = t; writes++; },
    generate: async () => generated(titles[0]), show: () => {}, notify: (_ctx, text) => notices.push(text) },
  { skill: async () => "", now: () => new Date(`${date}T00:00:00Z`), select: (v, s) => {
    n++; return selectTitle(v, s, 100, deps(response(n === 1 ? "c0" : "keep", n === 1 ? { c0: 0.9, skip: 0.1 } : { c0: 0.1, keep: 0.8, skip: 0.1 })));
  } });
  await a.input({}, "Real naming topic", "interactive"); await a.shutdown({}); assert.equal(writes, 1); assert.equal(n, 2);
  assert.ok(notices[1].includes("source=jev; status=keep")); assert.ok(!notices[1].includes("applied="));
});
