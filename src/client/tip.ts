/** The tip page's script: amount picker and status messages. The wallet code loads on demand. */
import type { Menu } from "../tips.ts";
import type { Step, TipErrorKind } from "./wallet.ts";

const STEPS: Record<Step, string> = {
  connecting: "Connect your wallet to continue.",
  switching: "Approve the network switch in your wallet.",
  approving:
    "Approve the one-time token allowance in your wallet. It lets Atum's escrow collect the tips you sign.",
  signing: "Confirm the tip in your wallet. Signing is free.",
  settling:
    "Your tip was accepted and is still settling. This page asks again every few seconds, and your wallet may ask you to sign again. You are charged once.",
};

const ERRORS: Record<TipErrorKind, string> = {
  "no-wallet":
    "No browser wallet found. Install one, such as MetaMask, or open this page in your wallet app.",
  "wrong-network":
    "Your wallet could not switch to the network this tip uses. Select it in your wallet, then try again.",
  rejected: "You declined the request in your wallet. Nothing was charged.",
  failed:
    "The payment failed for good and no tip was delivered. Trying again starts a new payment.",
  refused: "The payment was refused and nothing was charged.",
  unsettled:
    "Your tip is still settling. It is not lost. Press the button again later to check on the same payment.",
};

function $<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`The tip page has no ${selector}`);
  return element;
}

const menu: Menu = JSON.parse($("#menu").textContent ?? "");
const form = $<HTMLFormElement>("#tip");
const button = $<HTMLButtonElement>("#tip button");
const terms = $("#terms");
const status = $<HTMLElement>("#status");

function selected(): Menu["amounts"][number] {
  const amount = new FormData(form).get("amount");
  const tip = menu.amounts.find((item) => item.amount === amount);
  if (!tip) throw new Error("No amount is selected");
  return tip;
}

function show(state: Step | TipErrorKind | "done" | "error", message: string): void {
  status.dataset.state = state;
  status.textContent = message;
}

function renderSelection(): void {
  const tip = selected();
  const options = tip.payWith.map(
    (source) => `at most ${source.maxAmount} ${source.symbol} on ${source.network}`,
  );
  terms.textContent = `You pay ${options.join(", or ")}. ${menu.author} receives exactly ${tip.amount} ${menu.asset}.`;
  button.textContent = `Tip ${tip.amount} ${menu.asset}${menu.demo ? " with a demo wallet" : ""}`;
}

async function tip(): Promise<void> {
  const { sendTip, TipError } = await import("./wallet.ts");
  try {
    const thanks = await sendTip(selected(), menu.demo, (step) => show(step, STEPS[step]));
    show("done", `${thanks.message} Payment ${thanks.paymentId ?? "confirmed"}.`);
  } catch (error) {
    if (!(error instanceof TipError)) throw error;
    show(error.kind, `${ERRORS[error.kind]} ${error.message}`.trim());
  }
}

form.addEventListener("change", renderSelection);
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  await tip().catch((error: unknown) =>
    show("error", `Something went wrong: ${error instanceof Error ? error.message : error}`),
  );
  button.disabled = false;
});
renderSelection();
