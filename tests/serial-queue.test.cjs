const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  module._compile(output, filename);
};
const { createSerialQueue } = require("../lib/serial-queue.ts");

test("serial queue prevents overlapping read-modify-write operations", async () => {
  const run = createSerialQueue();
  const values = [];
  let inFlight = 0;
  const mutate = (value) => run(async () => {
    inFlight++;
    assert.equal(inFlight, 1);
    const snapshot = [...values];
    await new Promise(resolve => setTimeout(resolve, 5));
    values.splice(0, values.length, ...snapshot, value);
    inFlight--;
  });
  await Promise.all([mutate("ETH"), mutate("SOL"), mutate("DOGE")]);
  assert.deepEqual(values, ["ETH", "SOL", "DOGE"]);
});

test("serial queue continues after a failed operation", async () => {
  const run = createSerialQueue();
  await assert.rejects(run(async () => { throw new Error("expected"); }), /expected/);
  assert.equal(await run(async () => "next operation ran"), "next operation ran");
});
