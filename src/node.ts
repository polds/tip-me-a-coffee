/** The Node entry: `npm run dev`, `npm start`, and the Docker image. */
import { ConfigError, parseConfig } from "./config.ts";
import { listen } from "./server.ts";

try {
  // Fail at boot on a bad config. Workers cannot, so there the first request reports it.
  const config = parseConfig(process.env);
  const { origin } = await listen(process.env, { port: Number(process.env.PORT ?? 8787) });
  console.log(`Tip jar for ${config.authorName} on ${origin} (ATUM_ENV=${config.env})`);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`Refusing to start: ${error.message}`);
  process.exit(1);
}
