/**
 * `ATUM_ENV=stub`: an in-process stand-in for Atum, so the whole tip flow runs with no network,
 * no keys, and no funds. It answers for a placeholder corridor that exists nowhere on chain.
 */
import type { Atum } from "./atum.ts";
import type { Network } from "./config.ts";
import { purchaseIdOf } from "./x402.ts";

/**
 * The tokens the stub vouches for. A payer's client bounds its spend cap with these decimals, so
 * the stub lists what it knows and never guesses for a token it does not.
 */
const TOKENS: Record<Network, { symbol: string; address: string; decimals: number }[]> = {
  "eip155:84532": [
    { symbol: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
  ],
  "eip155:8453": [
    { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  ],
  "eip155:42431": [
    { symbol: "pathUSD", address: "0x20C0000000000000000000000000000000000000", decimals: 6 },
  ],
};

export function stubAtum(): Atum {
  return {
    async defaults(network) {
      const tokens = TOKENS[network];
      return (
        tokens && {
          chain_id: network,
          escrow_contract: "0x0000000000000000000000000000000000000001",
          quote_selector: "0x0000000000000000000000000000000000000002",
          fulfillment_proxy: "0x0000000000000000000000000000000000000003",
          fulfillment_verifier: {
            account: "0x0000000000000000000000000000000000000004",
            endpoint: "https://stub.invalid/veri-fill",
          },
          tokens,
        }
      );
    },

    // Atum's facilitator refuses a payment that names no purchase, so the stub does too.
    async verify({ paymentPayload }) {
      return purchaseIdOf(paymentPayload)
        ? { isValid: true }
        : { isValid: false, invalidReason: "the payment-identifier extension is missing" };
    },

    // The payment id is derived from the purchase, so a re-attempt reports the same payment,
    // as Atum does when it resolves a re-attempt onto the original.
    async settle({ paymentPayload, paymentRequirements }) {
      return {
        success: true,
        transaction: `0x${"5b".repeat(32)}`,
        network: paymentRequirements.extra.atum.destination.network,
        extensions: {
          atum: { paymentId: `pay_stub_${purchaseIdOf(paymentPayload)}`, state: "completed" },
        },
        fulfillmentConfirmation: { stub: true, note: "Stub settlement. No funds moved." },
      };
    },
  };
}
