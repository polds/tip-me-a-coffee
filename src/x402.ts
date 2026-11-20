/**
 * The x402 v2 wire protocol for the `atum-escrow` scheme, as pure functions.
 * Shapes follow Atum's x402 facilitator API: https://docs.atum.xyz/api-reference/x402/introduction
 */
import type { Address, Network } from "./config.ts";

/** Each header value is base64 of UTF-8 JSON. */
export const PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

/** One way to pay: an entry of `accepts[]`, and the terms the facilitator verifies against. */
export interface Offer {
  scheme: "atum-escrow";
  network: Network;
  asset: Address;
  /** The source-chain escrow. Funds lock there, never with the author. */
  payTo: string;
  /** The most the payer can be charged, in atomic units of the source token. */
  amount: string;
  maxTimeoutSeconds: number;
  extra: {
    atum: {
      destination: { network: Network; asset: Address; address: Address };
      /** Exactly what the author receives, in atomic units of the destination token. */
      fulfillmentAmount: string;
      escrow: string;
      fulfillmentProxy: string;
      reserver: string;
      releaser: string;
      fulfillmentVerifierEndpoint: string;
      quoteDeadlineSeconds: number;
      fulfillmentDeadlineSeconds: number;
      depositRequestHashVersions?: number[];
    };
    /** The page this payment is for. Atum derives the payment's identity from it. */
    atumResource: string;
  };
}

export interface PaymentRequired {
  x402Version: 2;
  resource: { url: string; description: string; mimeType: string };
  accepts: Offer[];
  extensions: Record<string, unknown>;
  error: string;
}

/**
 * The payer's signed credential, decoded from PAYMENT-SIGNATURE. Only `accepted` is read here,
 * to find the offer it answers. The rest travels to Atum's facilitator untouched.
 */
export interface PaymentPayload {
  accepted: { network: string; asset: string };
  [field: string]: unknown;
}

export interface FacilitatorRequest {
  x402Version: 2;
  paymentPayload: PaymentPayload;
  paymentRequirements: Offer;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
}

/** The facilitator's settlement report. The payer receives it whole in PAYMENT-RESPONSE. */
export interface SettleResponse {
  success: boolean;
  [field: string]: unknown;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

export function encodeHeader(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

/** Throws on a value that is not base64 of JSON. */
export function decodeHeader(value: string): unknown {
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function parsePaymentPayload(header: string): PaymentPayload | undefined {
  const isPayload = (value: unknown): value is PaymentPayload =>
    isRecord(value) &&
    isRecord(value.accepted) &&
    typeof value.accepted.network === "string" &&
    typeof value.accepted.asset === "string";
  try {
    const value = decodeHeader(header);
    return isPayload(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The x402 `payment-identifier` extension. The payer names each purchase, and Atum de-duplicates
 * on that name, so a re-attempt resolves to the original payment and never charges twice.
 * https://github.com/coinbase/x402/blob/main/specs/extensions/payment_identifier.md
 */
const PAYMENT_IDENTIFIER = "payment-identifier";
const PAYMENT_IDENTIFIER_DECLARATION = {
  info: { required: true },
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      required: { type: "boolean" },
      id: { type: "string", minLength: 16, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" },
    },
    required: ["required"],
  },
};

export function purchaseIdOf(payload: PaymentPayload): string | undefined {
  const { extensions } = payload;
  const entry = isRecord(extensions) ? extensions[PAYMENT_IDENTIFIER] : undefined;
  return isRecord(entry) && isRecord(entry.info) ? text(entry.info.id) : undefined;
}

export function paymentRequired(url: string, accepts: Offer[], error: string): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url, description: "A tip for the author", mimeType: "application/json" },
    accepts,
    extensions: { [PAYMENT_IDENTIFIER]: PAYMENT_IDENTIFIER_DECLARATION },
    error,
  };
}

/**
 * x402 reports settlement as one boolean, so everything short of settled arrives as
 * `success: false`. `errorReason` separates three cases that call for opposite actions.
 */
export type Outcome =
  | { kind: "settled"; paymentId?: string }
  /** Accepted and still settling. Re-attempt under the same purchase identifier. */
  | { kind: "pending"; paymentId?: string }
  /** Terminal. That purchase identifier is spent, so a fresh attempt needs a new one. */
  | { kind: "failed"; paymentId?: string }
  /** Nothing was charged. The same purchase identifier works once the cause is fixed. */
  | { kind: "refused"; reason: string };

export function outcomeOf(settled: Record<string, unknown>): Outcome {
  const atum = isRecord(settled.extensions) ? settled.extensions.atum : undefined;
  const paymentId = isRecord(atum) ? text(atum.paymentId) : undefined;
  if (settled.success === true) return { kind: "settled", paymentId };
  const reason = text(settled.errorReason);
  if (reason === "settlement_pending") return { kind: "pending", paymentId };
  if (reason === "settlement_failed") return { kind: "failed", paymentId };
  return { kind: "refused", reason: text(settled.errorMessage) ?? reason ?? "no reason given" };
}
