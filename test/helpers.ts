import { after } from "node:test";
import { Wallet } from "ethers";
import { type PayOptions, payTip } from "../src/client/pay.ts";
import { listen } from "../src/server.ts";

/** Starts a tip server on an ephemeral port and stops it when the test file ends. */
export async function startTips(
  vars: Record<string, string> = {},
  fetch?: typeof globalThis.fetch,
): Promise<string> {
  const server = await listen(vars, { port: 0, fetch });
  after(server.close);
  return server.origin;
}

export interface Exchange {
  status: number;
  /** The decoded PAYMENT-RESPONSE header, when the response carries one. */
  receipt?: { errorReason?: string; extensions?: { atum?: { paymentId?: string } } };
}

/** Pays a tip with the real Atum payer SDK and records every HTTP exchange with the server. */
export async function tip(origin: string, amount: string, options: Partial<PayOptions> = {}) {
  const exchanges: Exchange[] = [];
  const recording: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (new URL(response.url).pathname.startsWith("/tip/")) {
      const receipt = response.headers.get("PAYMENT-RESPONSE");
      exchanges.push({
        status: response.status,
        ...(receipt && { receipt: JSON.parse(atob(receipt)) }),
      });
    }
    return response;
  };
  const outcome = await payTip({
    url: `${origin}/tip/${amount}`,
    purchaseId: `test-${crypto.randomUUID()}`,
    signer: Wallet.createRandom(),
    gateway: origin,
    fetch: recording,
    intervalMs: 5,
    ...options,
  }).catch((error: unknown) => error);
  return { outcome, exchanges };
}

const TESTNET = "https://payment-gw.production-testnet.atum.xyz";

const chain = (chain_id: string, token: { symbol: string; address: string }) => ({
  chain_id,
  escrow_contract: "0x00000000000000000000000000000000000000E5",
  quote_selector: "0x0000000000000000000000000000000000000A11",
  fulfillment_proxy: "0x000000000000000000000000000000000000F111",
  fulfillment_verifier: {
    account: "0x00000000000000000000000000000000000000AC",
    endpoint: "https://veri-fill.test",
  },
  tokens: [{ ...token, decimals: 6 }],
  deposit_request_hash_versions: [1],
});

const CHAINS = [
  chain("eip155:84532", { symbol: "USDC", address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" }),
  chain("eip155:42431", {
    symbol: "pathUSD",
    address: "0x20c0000000000000000000000000000000000000",
  }),
];

const PAID = { success: true, transaction: "0xfeed", network: "eip155:42431" };
export const settlement = (
  state: "paid" | "pending" | "failed" | "refused",
  paymentId = "pay_1",
) => ({
  ...(state === "paid" ? PAID : { success: false, transaction: "", network: "eip155:42431" }),
  ...(state === "pending" && { errorReason: "settlement_pending" }),
  ...(state === "failed" && { errorReason: "settlement_failed" }),
  ...(state === "refused" && {
    errorReason: "MISSING_TOKEN_APPROVAL",
    errorMessage: "the payer has not approved Permit2",
  }),
  ...(state !== "refused" && { extensions: { atum: { paymentId, state } } }),
});

/**
 * Stands in for Atum's hosted testnet gateway and facilitator. A server in `testnet` mode that is
 * given this `fetch` runs its real HTTP path against it. `settles` answers `/settle` in order.
 */
export function fakeAtum(
  script: {
    verify?: object;
    verifyStatus?: number;
    settles?: object[];
    settleStatus?: number;
  } = {},
) {
  const settles = [...(script.settles ?? [])];
  /** The `request_id` of every payment that reached `/verify` or `/settle`. */
  const seen = { verify: [] as string[], settle: [] as string[] };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== TESTNET) throw new Error(`unexpected outbound request to ${url}`);
    if (url.pathname === "/v1/defaults") {
      const found = CHAINS.find((entry) => entry.chain_id === url.searchParams.get("chain_id"));
      return found ? Response.json(found) : Response.json({ code: "NOT_FOUND" }, { status: 404 });
    }
    const operation = url.pathname === "/x402/v1/verify" ? "verify" : "settle";
    if (url.pathname !== `/x402/v1/${operation}`) return new Response("", { status: 404 });
    const body = JSON.parse(String(init?.body));
    seen[operation].push(body.paymentPayload.payload.paymentRequest.request_id);
    if (operation === "verify") {
      return Response.json(script.verify ?? { isValid: true }, {
        status: script.verifyStatus ?? 200,
      });
    }
    return Response.json(settles.shift() ?? settlement("paid"), {
      status: script.settleStatus ?? 200,
    });
  };
  return { fetch, seen };
}

export const TESTNET_VARS = {
  ATUM_ENV: "testnet",
  DEST_ADDRESS: "0x1111111111111111111111111111111111111111",
};
