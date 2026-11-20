/** The Node entry: `npm run dev`, `npm start`, and the Docker image. */
import { AtumError } from "./atum.ts";
import { ConfigError, parseConfig } from "./config.ts";
import { listen } from "./server.ts";
import { loadTips } from "./tips.ts";

try {
  // Fail at boot on a bad config. Workers cannot, so there the first request reports it.
  const config = parseConfig(process.env);
  // Some mistakes only show against Atum's gateway, such as a token it does not list. An
  // unreachable gateway is not a mistake, so the server starts and the first request retries.
  await loadTips(process.env, fetch).catch((error: unknown) => {
    if (!(error instanceof AtumError)) throw error;
    console.warn(`Starting without Atum's network facts: ${error.message}`);
  });
  const { origin } = await listen(process.env, { port: Number(process.env.PORT ?? 8787) });
  console.log(`Tip jar for ${config.authorName} on ${origin} (ATUM_ENV=${config.env})`);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`Refusing to start: ${error.message}`);
  process.exit(1);
}
