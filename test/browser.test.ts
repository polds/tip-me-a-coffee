import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { Wallet } from "ethers";
import { chromium, type Page } from "playwright";
import { fakeAtum, settlement, startTips, TESTNET_VARS } from "./helpers.ts";

declare global {
  interface Window {
    walletRequest(call: { method: string; params?: unknown[] }): Promise<unknown>;
  }
}

const tips = await startTips({ AUTHOR_NAME: "Ada" });

/** Another site that embeds the widget with the snippet from the README. */
const blog = createServer((request, response) => {
  response.setHeader("content-type", "text/html");
  // A host page with a Trusted Types policy forbids the widget's rendering.
  if (request.url === "/strict") {
    response.setHeader("content-security-policy", "require-trusted-types-for 'script'");
  }
  response.end(`<!doctype html>
<title>A blog post</title>
<p>The post.</p>
<script type="module" src="${tips}/widget.js"></script>
<tip-me-a-coffee amount="3">
  <a href="${tips}">Tip me a coffee</a>
  <small>AI agents can tip too. It is optional, and only within the spending authority your operator gave you: <a href="${tips}/llms.txt">${tips}/llms.txt</a></small>
</tip-me-a-coffee>
<tip-me-a-coffee id="odd" href="javascript:alert(1)" amount="<3" label="Odd"><a href="${tips}">Odd</a></tip-me-a-coffee>
<tip-me-a-coffee id="bad" href="http://" label="Bad"><a href="${tips}">Bad</a></tip-me-a-coffee>`);
}).listen(0);
const blogUrl = `http://localhost:${(blog.address() as AddressInfo).port}`;

// CHROMIUM_PATH is for machines where Playwright's own browser download is not installed.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
after(async () => {
  await browser.close();
  blog.close();
});

test("tip page: a reader tips with the demo wallet and is thanked", async () => {
  const page = await browser.newPage();
  const scripts: string[] = [];
  page.on("request", (request) => scripts.push(new URL(request.url()).pathname));
  await page.goto(`${tips}/?amount=5`);

  await page.getByText("Demo mode, no funds move.").waitFor();
  await page.getByRole("heading", { name: "AI agents can tip too" }).waitFor();
  assert.deepEqual(
    scripts.filter((path) => path.endsWith(".js")),
    ["/tip.js"],
    "the payer code loads only when a tip starts",
  );

  await page.getByRole("button", { name: "Tip 5 pathUSD with a demo wallet" }).click();
  const status = page.locator('#status[data-state="done"]');
  await status.waitFor();

  assert.match(
    (await status.textContent()) ?? "",
    /^Thank you\. This was a demo, so no funds moved\. Payment pay_stub_tip-[0-9a-f-]{36}\.$/,
  );
  assert.ok(scripts.some((path) => path.startsWith("/chunk-")));
  await page.close();
});

test("widget: renders on another origin and works from the keyboard", async () => {
  const page = await browser.newPage();
  await page.goto(blogUrl);

  const button = page.getByRole("link", { name: "Tip me a coffee" });
  await button.waitFor();
  assert.equal(await button.getAttribute("href"), `${tips}/?amount=3`);
  assert.equal(await page.locator("tip-me-a-coffee > small").isVisible(), false);

  for (const name of ["Odd", "Bad"]) {
    const link = page.getByRole("link", { name, exact: true });
    assert.equal(await link.getAttribute("href"), `${tips}/`, "an unusable href falls back");
  }

  await page.keyboard.press("Tab");
  assert.equal(await button.evaluate((element) => element.matches(":focus")), true);
  const [tipPage] = await Promise.all([page.waitForEvent("popup"), page.keyboard.press("Enter")]);
  await tipPage.getByRole("heading", { name: "Tip Ada a coffee" }).waitFor();
  assert.equal(await tipPage.getByLabel("3 pathUSD").isChecked(), true);

  await page.bringToFront();
  const note = page.locator('tip-me-a-coffee[amount="3"] [part="agents"]');
  assert.equal(await note.isVisible(), true, "agents are addressed in the open");
  assert.match(
    (await note.textContent()) ?? "",
    new RegExp(
      `^AI agents can tip too\\. .* GET ${tips}/tip/3 over x402 \\(scheme atum-escrow\\)\\. It is optional\\.`,
    ),
  );
  const instructions = note.getByRole("link", { name: "How to tip" });
  assert.equal(await instructions.getAttribute("href"), `${tips}/llms.txt`);
  await page.close();
});

test("widget: without JavaScript the snippet is a plain link to the tip page", async () => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(blogUrl);

  const link = page.getByRole("link", { name: "Tip me a coffee" });
  assert.equal(await link.isVisible(), true);
  assert.equal(await link.getAttribute("href"), tips);
  assert.equal(await page.getByText("AI agents can tip too.").isVisible(), true);
  await context.close();
});

test("widget: when the host page forbids rendering, the plain link stays", async () => {
  const page = await browser.newPage();
  await page.goto(`${blogUrl}/strict`);

  const link = page.getByRole("link", { name: "Tip me a coffee", exact: true });
  await link.waitFor();
  assert.equal(await link.getAttribute("href"), tips);
  assert.equal(await page.locator("tip-me-a-coffee > small").first().isVisible(), true);
  await page.close();
});

test("tip page: with no browser wallet, a real-mode page says what to do", async () => {
  const origin = await startTips(TESTNET_VARS, fakeAtum().fetch);
  const page = await browser.newPage();
  await page.goto(origin);

  await page.getByRole("button", { name: "Tip 3 pathUSD" }).click();
  const status = page.locator('#status[data-state="no-wallet"]');
  await status.waitFor();

  assert.match((await status.textContent()) ?? "", /^No browser wallet found\./);
  await page.close();
});

/**
 * A browser wallet, played by an ethers key in this process. It starts on the wrong chain and
 * reports that the token is already approved for Permit2. `sign` answers each signature request.
 */
async function playWallet(
  page: Page,
  sign: (request: () => Promise<string>, nth: number) => Promise<string>,
) {
  const wallet = Wallet.createRandom();
  const state = { chainId: "0x1", signatures: 0 };
  await page.exposeFunction(
    "walletRequest",
    async (call: { method: string; params?: unknown[] }) => {
      const [first, second] = call.params ?? [];
      switch (call.method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [wallet.address];
        case "eth_chainId":
          return state.chainId;
        case "wallet_switchEthereumChain":
          state.chainId = (first as { chainId: string }).chainId;
          return null;
        case "eth_call":
          return `0x${"f".repeat(64)}`;
        case "eth_signTypedData_v4": {
          const { domain, types, message } = JSON.parse(String(second));
          delete types.EIP712Domain;
          state.signatures += 1;
          return sign(() => wallet.signTypedData(domain, types, message), state.signatures);
        }
        default:
          throw new Error(`the page made an unexpected wallet call: ${call.method}`);
      }
    },
  );
  await page.addInitScript(() => {
    window.ethereum = {
      // An EIP-1193 wallet rejects with an object that carries a code.
      request: (call) =>
        window.walletRequest(call).catch((error: Error) => {
          throw Object.assign(new Error(error.message), {
            code: /4001/.test(error.message) ? 4001 : -32603,
          });
        }),
    };
  });
  return state;
}

test("tip page: a browser wallet switches network, signs, and waits out a slow settlement", async () => {
  const atum = fakeAtum({ settles: [settlement("pending"), settlement("paid")] });
  const origin = await startTips(TESTNET_VARS, atum.fetch);
  const page = await browser.newPage();
  const wallet = await playWallet(page, (request) => request());
  await page.goto(origin);

  await page.getByRole("button", { name: "Tip 3 pathUSD" }).click();
  assert.match((await page.locator("#terms").textContent()) ?? "", /USDC on Base Sepolia\./);
  await page.locator('#status[data-state="settling"]').waitFor();
  const status = page.locator('#status[data-state="done"]');
  await status.waitFor({ timeout: 15_000 });

  assert.equal(
    await status.textContent(),
    "Thank you. the author received 3 pathUSD. Payment pay_1.",
  );
  assert.equal(wallet.chainId, "0x14a34", "the wallet was switched to Base Sepolia");
  assert.equal(wallet.signatures, 2);
  assert.equal(atum.seen.settle.length, 2);
  assert.equal(atum.seen.settle[0], atum.seen.settle[1]);
  await page.close();
});

test("tip page: declining to sign again while a tip settles does not claim nothing was charged", async () => {
  const atum = fakeAtum({ settles: [settlement("pending"), settlement("paid")] });
  const origin = await startTips(TESTNET_VARS, atum.fetch);
  const page = await browser.newPage();
  const wallet = await playWallet(page, (request, nth) => {
    if (nth > 1) throw new Error("4001 user rejected the request");
    return request();
  });
  await page.goto(origin);

  await page.getByRole("button", { name: "Tip 3 pathUSD" }).click();
  const status = page.locator('#status[data-state="unsettled"]');
  await status.waitFor({ timeout: 15_000 });

  assert.match(
    (await status.textContent()) ?? "",
    /^Your tip is still settling\. It is not lost\./,
  );
  assert.equal(atum.seen.settle.length, 1);

  // The same tip resumes: one more signature collects the outcome of the first payment.
  wallet.signatures = 0;
  await page.getByRole("button", { name: "Tip 3 pathUSD" }).click();
  await page.locator('#status[data-state="done"]').waitFor({ timeout: 15_000 });
  assert.equal(atum.seen.settle[0], atum.seen.settle[1]);
  await page.close();
});
