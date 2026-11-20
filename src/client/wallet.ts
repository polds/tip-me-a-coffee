/**
 * The browser side of a tip: find a signer, prepare the wallet, pay. The tip page loads this
 * file, and the payer SDK with it, only when a reader starts a tip.
 */
import { ensureSourceApproval, needsSourceApproval } from "@atumlabs/x402-atum-escrow/client";
import { BrowserProvider, isError, type Signer, toQuantity, Wallet } from "ethers";
import type { Network } from "../config.ts";
import type { Menu } from "../tips.ts";
import { payTip, type Thanks, TipError, type TipErrorKind } from "./pay.ts";

export type { TipErrorKind } from "./pay.ts";
export { TipError };
export type Step = "connecting" | "switching" | "approving" | "signing" | "paying" | "settling";

type Tip = Menu["amounts"][number];
type Source = Tip["payWith"][number];

declare global {
  interface Window {
    /** The EIP-1193 provider a browser wallet injects. */
    ethereum?: { request(call: { method: string; params?: unknown[] }): Promise<unknown> };
  }
}

/** EIP-1193 reports a request the user declined with code 4001. ethers has its own name for it. */
const declined = (error: unknown): boolean =>
  isError(error, "ACTION_REJECTED") ||
  (typeof error === "object" && error !== null && "code" in error && error.code === 4001);

async function connect(source: Source, onStep: (step: Step) => void): Promise<Signer> {
  const { ethereum } = window;
  if (!ethereum) throw new TipError("no-wallet");

  onStep("connecting");
  await ethereum.request({ method: "eth_requestAccounts" });
  const current = `eip155:${BigInt(String(await ethereum.request({ method: "eth_chainId" })))}`;
  if (source.network !== current) {
    onStep("switching");
    const chainId = toQuantity(source.network.slice("eip155:".length));
    await ethereum
      .request({ method: "wallet_switchEthereumChain", params: [{ chainId }] })
      .catch((error: unknown) => {
        throw declined(error) ? error : new TipError("wrong-network", source.chain);
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
  return signer;
}

/** Where purchase identifiers are kept. A browser that blocks site storage throws on access. */
const memory = new Map<string, string>();
function storage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  try {
    sessionStorage.getItem("");
    return sessionStorage;
  } catch {
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => void memory.set(key, value),
      removeItem: (key) => void memory.delete(key),
    };
  }
}

/** A purchase that may still be settling, and the token it was signed for. */
interface Purchase {
  id: string;
  network: Network;
  asset: string;
}

function isPurchase(value: unknown): value is Purchase {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "network" in value &&
    typeof value.network === "string" &&
    "asset" in value &&
    typeof value.asset === "string"
  );
}

function readPurchase(stored: string | null): Purchase | undefined {
  try {
    const value: unknown = JSON.parse(stored ?? "null");
    return isPurchase(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Outcomes after which the payment may still complete, so its purchase is kept. */
const OPEN: ReadonlySet<TipErrorKind> = new Set(["unsettled", "unknown", "refund"]);

export async function sendTip(
  tip: Tip,
  /** The token the reader chose to pay with. */
  chosen: Source,
  /** `signingMs` is how long a person gets to approve the signature in their wallet. */
  options: { demo: boolean; signingMs: number },
  onStep: (step: Step) => void,
): Promise<Thanks> {
  // A stored purchase is one whose payment may still be settling. Pressing the button again, or
  // reloading, resumes it and never starts a second payment. It resumes with the token it was
  // signed for, because Atum refuses a changed payment under the same identifier.
  const key = `tip:${tip.url}`;
  const store = storage();
  const stored = readPurchase(store.getItem(key));
  const resuming = stored !== undefined;
  const purchase = stored ?? {
    id: `tip-${crypto.randomUUID()}`,
    network: chosen.network,
    asset: chosen.asset,
  };
  const source =
    tip.payWith.find(
      (option) => option.network === purchase.network && option.asset === purchase.asset,
    ) ?? chosen;

  try {
    // Demo mode signs with a key made here and dropped with the tab. No chain is involved.
    const wallet = options.demo
      ? { signer: Wallet.createRandom() }
      : { signer: await connect(source, onStep), signingMs: options.signingMs };
    store.setItem(key, JSON.stringify(purchase));

    onStep("signing");
    const thanks = await payTip({
      ...wallet,
      url: tip.url,
      purchaseId: purchase.id,
      source,
      resuming,
      gateway: location.origin,
      onSigned: () => onStep("paying"),
      onSettling: () => onStep("settling"),
    });
    store.removeItem(key);
    return thanks;
  } catch (error) {
    const failure = declined(error) ? new TipError("rejected") : error;
    const open = failure instanceof TipError && OPEN.has(failure.kind);
    const failed = failure instanceof TipError && failure.kind === "failed";
    if (failed || !(open || resuming)) {
      store.removeItem(key);
      throw failure;
    }
    // An earlier press left this tip in flight, so whatever stopped this press settles nothing.
    throw open ? failure : new TipError("unsettled");
  }
}
