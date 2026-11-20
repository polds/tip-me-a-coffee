/** The Atum services this server depends on: the payment gateway and its x402 facilitator. */
import type { Network } from "./config.ts";
import {
  type FacilitatorRequest,
  isRecord,
  type SettleResponse,
  type VerifyResponse,
} from "./x402.ts";

/** Atum could not be reached or answered something unusable. Maps to HTTP 502. */
export class AtumError extends Error {
  override name = "AtumError";
}

/**
 * One chain's entry in the gateway's `GET /v1/defaults`: the contracts, roles, and tokens of the
 * Atum network on that chain. These are network facts, so they are read and never configured.
 */
export interface ChainDefaults {
  chain_id: string;
  escrow_contract: string;
  quote_selector: string;
  fulfillment_proxy: string;
  fulfillment_verifier: { account: string; endpoint: string };
  tokens: { symbol: string; address: string; decimals: number }[];
  deposit_request_hash_versions?: number[];
}

export interface Atum {
  /** Resolves to `undefined` for a chain Atum does not serve. */
  defaults(network: Network): Promise<ChainDefaults | undefined>;
  /** Checks a signed payment. Moves no funds. */
  verify(request: FacilitatorRequest): Promise<VerifyResponse>;
  /** Submits a verified payment for settlement. Moves funds. */
  settle(request: FacilitatorRequest): Promise<SettleResponse>;
}

function isChainDefaults(body: unknown): body is ChainDefaults {
  const isToken = (token: unknown) =>
    isRecord(token) &&
    typeof token.symbol === "string" &&
    typeof token.address === "string" &&
    typeof token.decimals === "number";
  const versions = isRecord(body) ? body.deposit_request_hash_versions : undefined;
  return (
    isRecord(body) &&
    typeof body.chain_id === "string" &&
    typeof body.escrow_contract === "string" &&
    typeof body.quote_selector === "string" &&
    typeof body.fulfillment_proxy === "string" &&
    isRecord(body.fulfillment_verifier) &&
    typeof body.fulfillment_verifier.account === "string" &&
    typeof body.fulfillment_verifier.endpoint === "string" &&
    Array.isArray(body.tokens) &&
    body.tokens.every(isToken) &&
    (versions === undefined || (Array.isArray(versions) && versions.every(Number.isInteger)))
  );
}

const isVerifyResponse = (body: unknown): body is VerifyResponse =>
  isRecord(body) &&
  typeof body.isValid === "boolean" &&
  (body.invalidReason === undefined || typeof body.invalidReason === "string");

const isSettleResponse = (body: unknown): body is SettleResponse =>
  isRecord(body) && typeof body.success === "boolean";

export function hostedAtum(
  urls: { gatewayUrl: string; facilitatorUrl: string },
  fetch: typeof globalThis.fetch,
): Atum {
  async function json(what: string, url: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(url, init).catch((cause: unknown) => {
      throw new AtumError(`Atum's ${what} could not be reached`, { cause });
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new AtumError(`Atum's ${what} answered HTTP ${response.status}`);
    return response.json().catch((cause: unknown) => {
      throw new AtumError(`Atum's ${what} answered a body that is not JSON`, { cause });
    });
  }
  const facilitator = (operation: string, request: FacilitatorRequest) =>
    json(`facilitator /${operation}`, `${urls.facilitatorUrl}/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });

  return {
    async defaults(network) {
      const what = `gateway defaults for ${network}`;
      const body = await json(
        what,
        `${urls.gatewayUrl}/v1/defaults?chain_id=${encodeURIComponent(network)}`,
      );
      if (body === undefined || isChainDefaults(body)) return body;
      throw new AtumError(`Atum's ${what} have an unexpected shape`);
    },
    async verify(request) {
      const body = await facilitator("verify", request);
      if (isVerifyResponse(body)) return body;
      throw new AtumError("Atum's facilitator /verify answered an unexpected shape");
    },
    async settle(request) {
      const body = await facilitator("settle", request);
      if (isSettleResponse(body)) return body;
      throw new AtumError("Atum's facilitator /settle answered an unexpected shape");
    },
  };
}
