/**
 * The browser side of a tip: find a signer, prepare the wallet, pay. The tip page loads this
 * file, and the payer SDK with it, only when a reader starts a tip.
 */
import { ensureSourceApproval, needsSourceApproval } from "@atumlabs/x402-atum-escrow/client";
import { BrowserProvider, isError, type Signer, toQuantity, Wallet } from "ethers";
import type { Network } from "../config.ts";
import type { Menu } from "../tips.ts";
import { payTip, type Thanks, TipError } from "./pay.ts";

export type { TipErrorKind } from "./pay.ts";
export { TipError };
export type Step = "connecting" | "switching" | "approving" | "signing" | "settling";

type Tip = Menu["amounts"][number];

declare global {
  interface Window {
    /** The EIP-1193 provider a browser wallet injects. */
    ethereum?: { request(call: { method: string; params?: unknown[] }): Promise<unknown> };
  }
}

/** How long a person gets to read and approve the signature request in their wallet. */
const SIGNING_MS = 30_000;

/** EIP-1193 reports a request the user declined with code 4001. ethers has its own name for it. */
const declined = (error: unknown): boolean =>
  isError(error, "ACTION_REJECTED") ||
  (typeof error === "object" && error !== null && "code" in error && error.code === 4001);

async function connect(
  tip: Tip,
  onStep: (step: Step) => void,
): Promise<{ signer: Signer; network: Network; signingMs: number }> {
  const { ethereum } = window;
  if (!ethereum) throw new TipError("no-wallet");

  onStep("connecting");
  await ethereum.request({ method: "eth_requestAccounts" });
  const current = `eip155:${BigInt(String(await ethereum.request({ method: "eth_chainId" })))}`;
  const source = tip.payWith.find((option) => option.network === current) ?? tip.payWith[0];
  if (!source) throw new TipError("refused", "This tip jar offers no way to pay.");

  if (source.network !== current) {
    onStep("switching");
    const chainId = toQuantity(source.network.slice("eip155:".length));
    await ethereum
      .request({ method: "wallet_switchEthereumChain", params: [{ chainId }] })
      .catch((error: unknown) => {
        throw declined(error) ? error : new TipError("wrong-network", source.network);
      });
  }

  // Created after the switch, because ethers ties a provider to the chain it first saw.
  const signer = await new BrowserProvider(ethereum).getSigner();
  const approval = {
    network: source.network,
    token: source.asset,
    owner: await signer.getAddress(),
    signer,
    requiredAllowance: BigInt(source.maxAtomic),
  };
  // Atum's escrow collects through Permit2, so the token needs a Permit2 allowance once. Without
  // it the deposit reverts at settlement, which fails the payment for good.
  if (await needsSourceApproval(approval)) {
    onStep("approving");
    await ensureSourceApproval(approval);
  }
  return { signer, network: source.network, signingMs: SIGNING_MS };
}

export async function sendTip(
  tip: Tip,
  demo: boolean,
  onStep: (step: Step) => void,
): Promise<Thanks> {
  try {
    // Demo mode signs with a key made here and dropped with the tab. No chain is involved.
    const wallet = demo ? { signer: Wallet.createRandom() } : await connect(tip, onStep);

    // The identifier outlives this call until the tip reaches a final outcome. Pressing the
    // button again, or reloading, then resumes the same payment and never starts a second one.
    const key = `tip:${tip.url}`;
    const purchaseId = sessionStorage.getItem(key) ?? `tip-${crypto.randomUUID()}`;
    sessionStorage.setItem(key, purchaseId);

    onStep("signing");
    const spent = () => sessionStorage.removeItem(key);
    const thanks = await payTip({
      ...wallet,
      url: tip.url,
      purchaseId,
      gateway: location.origin,
      onSettling: () => onStep("settling"),
    }).catch((error: unknown) => {
      if (error instanceof TipError && error.kind === "failed") spent();
      throw error;
    });
    spent();
    return thanks;
  } catch (error) {
    throw declined(error) ? new TipError("rejected") : error;
  }
}
