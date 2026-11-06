import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSkill } from "./core.ts";

function withHome(setup: (dir: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "tw-home-")), dir = join(home, ".agents/skills/titlewise");
  mkdirSync(dir, { recursive: true }); setup(dir);
  const saved = process.env.HOME; process.env.HOME = home;
  return loadSkill().finally(() => { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; });
}
test("skill: user skill wins when sane", async () => {
  assert.equal(await withHome(d => writeFileSync(join(d, "SKILL.md"), "custom")), "custom");
});
test("skill: oversized or non-file user skill falls back to the bundled one", async () => {
  const bundled = await withHome(() => {});
  assert.ok(bundled.includes("titlewise"));
  assert.equal(await withHome(d => writeFileSync(join(d, "SKILL.md"), "x".repeat(70_000))), bundled);
  assert.equal(await withHome(d => mkdirSync(join(d, "SKILL.md"))), bundled);
});
