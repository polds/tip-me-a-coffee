/**
 * Pays one tip with Atum's payer SDK and follows it to a final outcome. It touches no DOM, so
 * the tests drive the same code from Node.
 */
import {
  atumGatewayTrust,
  type EscrowSigner,
  registerAtumEscrowScheme,
} from "@atumlabs/x402-atum-escrow/client";
import { wrapFetchWithAtumPayment } from "@atumlabs/x402-atum-escrow/fetch";
import { x402Client } from "@x402/fetch";
import type { Network } from "../config.ts";
import { decodeHeader, isRecord, outcomeOf, PAYMENT_RESPONSE } from "../x402.ts";

export type TipErrorKind =
  | "no-wallet"
  | "wrong-network"
  | "rejected"
  | "expired"
  | "unknown"
  | "failed"
  | "refused"
  | "unsettled";

/** Why a tip stopped. `kind` is what callers branch on. */
export class TipError extends Error {
  override name = "TipError";
  readonly kind: TipErrorKind;
  constructor(kind: TipErrorKind, detail = "") {
    super(detail);
    this.kind = kind;
  }
}

export interface Thanks {
  message: string;
  paymentId?: string;
}

export interface PayOptions {
  /** The URL of one amount, such as `https://tips.example.com/tip/3`. */
  url: string;
  /** Names this tip. Every re-attempt reuses it, which is what keeps the tip to one charge. */
  purchaseId: string;
  signer: EscrowSigner;
  /** The origin whose `/v1/defaults` the payer trusts for the corridor's contracts. */
  gateway: string;
  /** Pay from this chain only. Defaults to the first offer. */
  network?: Network;
  /**
   * Milliseconds a person needs to approve the signature. The SDK stamps the payment's deadlines
   * before the wallet asks, and Atum refuses a payment whose 3 second quote window has closed.
   * The payer's clock runs ahead by this much, which moves both deadlines later together.
   * Atum collects quotes until the window closes, so the tip also takes this much longer.
   */
  signingMs?: number;
  onSigned?: () => void;
  onSettling?: (attempt: number) => void;
  fetch?: typeof globalThis.fetch;
  /** Milliseconds between re-attempts while the tip is still settling. */
  intervalMs?: number;
  maxAttempts?: number;
}

export async function payTip(options: PayOptions): Promise<Thanks> {
  const { maxAttempts = 20, intervalMs = 5000, signingMs = 0 } = options;

  // @x402/fetch reduces a failed signature to its message. The wallet's own error is kept, so
  // the caller can tell a declined signature from a broken one.
  let walletError: unknown;
  // What is known about the payment so far decides what a later failure may claim.
  let signed = false;
  let accepted = false;
  const signer: EscrowSigner = {
    getAddress: () => options.signer.getAddress(),
    signTypedData: (domain, types, value) =>
      options.signer.signTypedData(domain, types, value).then(
        (signature) => {
          signed = true;
          options.onSigned?.();
          return signature;
        },
        (error: unknown) => {
          walletError = error;
          throw error;
        },
      ),
  };
  const client = registerAtumEscrowScheme(new x402Client(), {
    signer,
    now: () => Date.now() + signingMs,
    trust: atumGatewayTrust({ gateways: [options.gateway], fetch: options.fetch }),
    ...(options.network && { networks: [options.network] }),
  });
  const pay = wrapFetchWithAtumPayment(
    options.fetch ?? ((input, init) => fetch(input, init)),
    client,
  );

  // Each attempt fetches a fresh 402 and signs again, because a signed payment goes stale in
  // seconds. Only the purchase identifier carries over, and it makes the attempts one payment.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signed = false;
    walletError = undefined;
    const response = await pay(options.url, {}, { paymentIdentifier: options.purchaseId }).catch(
      (error: unknown) => {
        // A signed payment that got no answer may have reached Atum. An earlier attempt that
        // Atum accepted is still settling, whatever happens to this one.
        if (signed) throw new TipError("unknown", error instanceof Error ? error.message : "");
        if (accepted) throw new TipError("unsettled");
        throw walletError ?? error;
      },
    );
    const body: unknown = await response.json().catch(() => undefined);
    const receipt = response.headers.get(PAYMENT_RESPONSE);
    if (!receipt) {
      const reason = isRecord(body) && typeof body.error === "string" ? body.error : "";
      // Only a 4xx says the payment was turned away. A 5xx leaves its outcome open.
      if (response.status >= 500) throw new TipError("unknown", reason);
      // Atum's facilitator names the deadline that passed while the wallet waited for a person.
      if (reason.includes("quote_deadline")) throw new TipError("expired");
      throw new TipError("refused", reason || `HTTP ${response.status}`);
    }

    const settled = decodeHeader(receipt);
    const outcome = outcomeOf(isRecord(settled) ? settled : {});
    switch (outcome.kind) {
      case "settled":
        return {
          message: isRecord(body) && typeof body.message === "string" ? body.message : "Thank you.",
          paymentId: outcome.paymentId,
        };
      case "pending":
        accepted = true;
        options.onSettling?.(attempt);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        break;
      case "failed":
        throw new TipError("failed", outcome.paymentId);
      case "refused":
        throw new TipError("refused", outcome.reason);
    }
  }
  throw new TipError("unsettled");
}
