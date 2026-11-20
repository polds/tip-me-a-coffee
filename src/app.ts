/**
 * The HTTP shell. It parses requests, calls the pure modules, and shapes responses.
 * The same app runs on Cloudflare Workers (`worker.ts`) and on Node (`node.ts`).
 */
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { AtumError } from "./atum.ts";
import { buttonSvg } from "./brand.ts";
import { ConfigError } from "./config.ts";
import { agentNote, llmsTxt } from "./invite.ts";
import { tipPage } from "./page.ts";
import { loadTips, menuOf, offersFor, type Tips } from "./tips.ts";
import {
  encodeHeader,
  type Outcome,
  outcomeOf,
  PAYMENT_REQUIRED,
  PAYMENT_RESPONSE,
  PAYMENT_SIGNATURE,
  parsePaymentPayload,
  paymentRequired,
} from "./x402.ts";

/** Operator config as strings, plus the browser bundles from `dist/public`. */
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  [variable: string]: unknown;
}

/** Atum's network facts change when a chain's contracts are redeployed, so they are re-read. */
const TIPS_TTL_MS = 5 * 60_000;

const UNSETTLED: Record<Exclude<Outcome["kind"], "settled">, string> = {
  pending:
    "Your tip was accepted and is still settling. Re-attempt it under the same purchase " +
    "identifier to collect the result. It resolves to the same payment and is charged once.",
  failed:
    "Settlement failed for good and no tip was delivered. A fresh attempt needs a new " +
    "purchase identifier.",
  refused: "The payment was refused and nothing was charged.",
};

// A proxy such as Cloud Run terminates TLS, so the request URL says http where readers use https.
function originOf(c: Context): string {
  const url = new URL(c.req.url);
  const forwarded = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwarded === "https" || forwarded === "http") url.protocol = forwarded;
  return url.origin;
}

export function createApp(deps: { fetch?: typeof globalThis.fetch } = {}) {
  const app = new Hono<{ Bindings: Env }>();

  // Workers hand over the environment with each request, so the tip jar is built on first use.
  let cached: { tips: Promise<Tips>; expires: number } | undefined;
  const tipsFor = (env: Env): Promise<Tips> => {
    if (!cached || Date.now() > cached.expires) {
      const tips = loadTips(env, deps.fetch ?? ((input, init) => fetch(input, init)));
      cached = { tips, expires: Date.now() + TIPS_TTL_MS };
      tips.catch(() => {
        if (cached?.tips === tips) cached = undefined;
      });
    }
    return cached.tips;
  };

  app.onError((error, c) => {
    if (error instanceof ConfigError) {
      return c.json({ error: "This tip jar is misconfigured.", detail: error.message }, 500);
    }
    if (error instanceof AtumError) {
      return c.json({ error: "Atum could not be reached.", detail: error.message }, 502);
    }
    console.error(error);
    return c.json({ error: "Internal error." }, 500);
  });

  // Any page may embed the widget and any payer may call the tip endpoints from a browser.
  // A preflight is answered with the headers it asks for, which admits PAYMENT-SIGNATURE.
  const open = cors({ origin: "*", exposeHeaders: [PAYMENT_REQUIRED, PAYMENT_RESPONSE] });
  app.use("/tip/*", open);
  app.use("/llms.txt", open);
  app.use("/widget.js", open);

  // Agents that read headers find the instructions without parsing a page.
  app.use(async (c, next) => {
    await next();
    c.header("Link", `<${originOf(c)}/llms.txt>; rel="describedby"; type="text/plain"`);
  });

  app.get("/", async (c) => {
    const origin = originOf(c);
    const menu = menuOf(await tipsFor(c.env), origin);
    return c.html(tipPage(menu, origin, c.req.query("amount")));
  });

  app.get("/tip", async (c) => {
    const origin = originOf(c);
    return c.json({ ...menuOf(await tipsFor(c.env), origin), agents: agentNote(origin) });
  });

  app.get("/tip/:amount", async (c) => {
    const tips = await tipsFor(c.env);
    const origin = originOf(c);
    const amount = c.req.param("amount");
    const fulfillment = tips.amounts.get(amount);
    if (fulfillment === undefined) {
      const amounts = menuOf(tips, origin).amounts.map(({ amount, url }) => ({ amount, url }));
      return c.json({ error: `There is no ${amount} tip.`, amounts }, 404);
    }

    // The amount is in the path, so each amount is its own page and the query plays no part.
    const offers = offersFor(tips, `GET /tip/${amount}`, fulfillment);
    const resource = { url: `${origin}/tip/${amount}`, description: tips.config.message };
    const ask = (error?: string) => {
      const required = paymentRequired(resource, offers, error);
      c.header(PAYMENT_REQUIRED, encodeHeader(required));
      return c.json({ ...required, message: tips.config.message, tip: agentNote(origin) }, 402);
    };

    const credential = c.req.header(PAYMENT_SIGNATURE);
    if (!credential) return ask();

    const paymentPayload = parsePaymentPayload(credential);
    if (!paymentPayload) {
      return c.json({ error: `${PAYMENT_SIGNATURE} must be a base64 x402 payment payload.` }, 400);
    }
    const { network, asset } = paymentPayload.accepted;
    const offer = offers.find(
      (offer) => offer.network === network && offer.asset.toLowerCase() === asset.toLowerCase(),
    );
    if (!offer) return ask("The payment answers none of the offers below.");

    const request = { x402Version: 2, paymentPayload, paymentRequirements: offer } as const;
    const verified = await tips.atum.verify(request);
    if (!verified.isValid) return ask(verified.invalidReason ?? "The payment is not valid.");

    // The payer learns the outcome and the payment id from PAYMENT-RESPONSE, settled or not.
    const settled = await tips.atum.settle(request);
    c.header(PAYMENT_RESPONSE, encodeHeader(settled));
    const outcome = outcomeOf(settled);
    if (outcome.kind !== "settled") {
      const detail = outcome.kind === "refused" ? ` ${outcome.reason}` : "";
      return ask(UNSETTLED[outcome.kind] + detail);
    }

    // A tip buys nothing, so there is no delivery to guard: a re-attempt under the same
    // purchase identifier settles onto the same payment and reads the same thank-you.
    const demo = tips.config.env === "stub";
    const received = `${tips.config.authorName} received ${amount} ${tips.destination.symbol}.`;
    return c.json({
      status: "thanks",
      message: `Thank you. ${demo ? "This was a demo, so no funds moved." : received}`,
      demo,
      paymentId: outcome.paymentId,
    });
  });

  app.get("/llms.txt", async (c) => {
    const origin = originOf(c);
    return c.text(llmsTxt(menuOf(await tipsFor(c.env), origin), origin));
  });

  app.get("/button.svg", (c) =>
    c.body(buttonSvg(c.req.query()), 200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    }),
  );

  // The browser payer checks a 402's contracts against a gateway it trusts, and Atum's gateway
  // sends no CORS headers. So this relays the gateway's answer, for this tip jar's chains only.
  app.get("/v1/defaults", async (c) => {
    const tips = await tipsFor(c.env);
    const chain = [tips.destination, ...tips.sources].find(
      (token) => token.network === c.req.query("chain_id"),
    )?.chain;
    return chain
      ? c.json(chain)
      : c.json({ error: "This server answers only for the chains of its own tips." }, 404);
  });

  // `widget.js` and the tip page's scripts.
  app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

  return app;
}
