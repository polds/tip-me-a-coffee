/** Runs the app on Node. `node.ts` starts it from the process environment, and tests start it on ephemeral ports. */
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createApp, type Env } from "./app.ts";

/** The browser bundles written by `npm run build`. On Workers the ASSETS binding serves them. */
const PUBLIC = new URL("../dist/public/", import.meta.url);

const assets: Env["ASSETS"] = {
  async fetch(request) {
    const name = new URL(request.url).pathname.slice(1);
    const file =
      /^[\w-]+\.js$/.test(name) && (await readFile(new URL(name, PUBLIC)).catch(() => undefined));
    return file
      ? new Response(file, { headers: { "content-type": "text/javascript; charset=utf-8" } })
      : new Response("Not found", { status: 404 });
  },
};

export function listen(
  vars: Record<string, string | undefined>,
  options: { port: number; fetch?: typeof globalThis.fetch },
): Promise<{ origin: string; close: () => Promise<void> }> {
  const app = createApp({ fetch: options.fetch });
  const env: Env = { ...vars, ASSETS: assets };
  return new Promise((resolve) => {
    const server = serve(
      { fetch: (request) => app.fetch(request, env), port: options.port },
      ({ port }) =>
        resolve({
          origin: `http://localhost:${port}`,
          close: () => new Promise((closed) => server.close(() => closed())),
        }),
    );
  });
}
