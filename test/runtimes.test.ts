/** The built app started from each entry point it ships with, and paid with Atum's payer SDK. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { tip } from "./helpers.ts";

/** Runs a command until its output matches `ready`. Rejects if it exits first. */
function run(command: string, args: string[], env: Record<string, string>, ready: RegExp) {
  // Its own process group, so stopping it also stops what it started. Wrangler starts workerd.
  const child = spawn(command, args, { env: { ...process.env, ...env }, detached: true });
  let output = "";
  const started = new Promise<RegExpMatchArray>((resolve, reject) => {
    const read = (chunk: Buffer) => {
      output += chunk;
      const match = ready.exec(output);
      if (match) resolve(match);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", (code) => reject(new Error(`${command} exited with ${code}:\n${output}`)));
  });
  return { started, stop: () => child.exitCode === null && child.pid && process.kill(-child.pid) };
}

async function assertServesATip(origin: string): Promise<void> {
  const { outcome, exchanges } = await tip(origin, "3");
  assert.deepEqual(
    exchanges.map((exchange) => exchange.status),
    [402, 200],
  );
  assert.partialDeepStrictEqual(outcome, {
    message: "Thank you. This was a demo, so no funds moved.",
  });

  const widget = await fetch(`${origin}/widget.js`);
  assert.equal(widget.headers.get("access-control-allow-origin"), "*");
  assert.match(await widget.text(), /tip-me-a-coffee/);
  assert.match(await (await fetch(`${origin}/llms.txt`)).text(), /Tip Ada a coffee/);
}

test("Node: dist/node.js serves a tip, the widget, and llms.txt", async () => {
  const node = run("node", ["dist/node.js"], { PORT: "0", AUTHOR_NAME: "Ada" }, /on (http:\S+)/);
  try {
    const [, origin = ""] = await node.started;
    await assertServesATip(origin);
  } finally {
    node.stop();
  }
});

test("Node: refuses to start in a real mode with no DEST_ADDRESS", async () => {
  const node = run("node", ["dist/node.js"], { PORT: "0", ATUM_ENV: "mainnet" }, /on (http:\S+)/);

  await assert.rejects(node.started, /exited with 1[\s\S]*Refusing to start: DEST_ADDRESS/);
});

test("Workers: the same app serves the same tip under workerd", { timeout: 120_000 }, async () => {
  const free = createServer().listen(0);
  const address = free.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((closed) => free.close(closed));
  const worker = run(
    "node_modules/.bin/wrangler",
    ["dev", "--port", String(port), "--ip", "127.0.0.1", "--var", "AUTHOR_NAME:Ada"],
    { WRANGLER_SEND_METRICS: "false", CI: "1" },
    /Ready on (http:\S+)/,
  );
  try {
    const [, origin = ""] = await worker.started;
    await assertServesATip(origin);
  } finally {
    worker.stop();
  }
});
