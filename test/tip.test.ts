import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  AtumEscrowServerScheme,
  atumEscrowPrice,
  DEFAULT_PEG_GROUPS,
} from "@atumlabs/x402-atum-escrow/server";
import { TipError } from "../src/client/pay.ts";
import { PEGGED } from "../src/tips.ts";
import { fakeAtum, settlement, startTips, TESTNET_VARS, tip } from "./helpers.ts";

const stub = await startTips({ AUTHOR_NAME: "Ada", TIP_AMOUNTS: "1,3,0.5" });

const kindOf = (outcome: unknown) => (outcome instanceof TipError ? outcome.kind : outcome);

test("stub: the real payer SDK gets a 402, pays, and is thanked", async () => {
  const { outcome, exchanges } = await tip(stub, "3");

  assert.deepEqual(
    exchanges.map((exchange) => exchange.status),
    [402, 200],
  );
  assert.partialDeepStrictEqual(outcome, {
    message: "Thank you. This was a demo, so no funds moved.",
  });
});

test("stub: a re-attempt under one purchase identifier is the same payment", async () => {
  const purchaseId = "order-0123456789abcdef";
  const first = await tip(stub, "1", { purchaseId });
  const again = await tip(stub, "1", { purchaseId });
  const other = await tip(stub, "1", { purchaseId: "order-fedcba9876543210" });

  assert.deepEqual(again.outcome, first.outcome);
  assert.notDeepEqual(other.outcome, first.outcome);
});

test("the 402 is a friendly ask that mirrors its PAYMENT-REQUIRED header", async () => {
  const response = await fetch(`${stub}/tip/0.5`);
  const body = await response.json();
  const header = JSON.parse(atob(response.headers.get("PAYMENT-REQUIRED") ?? ""));

  assert.equal(response.status, 402);
  assert.equal(body.message, "If this helped, please consider supporting the author.");
  assert.equal(header.resource.description, body.message);
  assert.equal("error" in body, false, "asking for a tip is not an error");
  assert.equal(
    response.headers.get("link"),
    `<${stub}/llms.txt>; rel="describedby"; type="text/plain"`,
  );
  assert.partialDeepStrictEqual(body, header);
  assert.equal(header.accepts[0].extra.atumResource, "GET /tip/0.5");
  assert.equal(header.accepts[0].extra.atum.fulfillmentAmount, "500000");
  assert.equal(header.accepts[0].amount, "515000");
  assert.equal(body.tip.optional, true);
  assert.match(body.tip.invitation.join(" "), /within the spending authority/);
});

test("the offer matches what Atum's own server SDK builds for the same corridor", async () => {
  const origin = await startTips({ DEST_ADDRESS: "0x2222222222222222222222222222222222222222" });
  const { accepts } = await (await fetch(`${origin}/tip/3`)).json();
  const defaults = async (chain: string) =>
    (await fetch(`${origin}/v1/defaults?chain_id=${chain}`)).json();
  const [source, destination] = await Promise.all([
    defaults("eip155:84532"),
    defaults("eip155:42431"),
  ]);

  const config = {
    destination: {
      network: "eip155:42431",
      asset: destination.tokens[0].address,
      address: "0x2222222222222222222222222222222222222222",
      symbol: destination.tokens[0].symbol,
      decimals: destination.tokens[0].decimals,
    },
    fulfillmentAmount: "3000000",
    markupBps: 300,
    fulfillmentProxy: destination.fulfillment_proxy,
    reserver: source.quote_selector,
    releaser: source.fulfillment_verifier.account,
    fulfillmentVerifierEndpoint: source.fulfillment_verifier.endpoint,
    quoteDeadlineSeconds: 3,
    fulfillmentDeadlineSeconds: 300,
    sources: {
      "eip155:84532": {
        asset: source.tokens[0].address,
        escrow: source.escrow_contract,
        symbol: source.tokens[0].symbol,
        decimals: source.tokens[0].decimals,
      },
    },
  };
  const scheme = new AtumEscrowServerScheme(config);
  const price = await scheme.parsePrice(atumEscrowPrice(config), "eip155:84532");
  const expected = await scheme.enhancePaymentRequirements({
    scheme: "atum-escrow",
    network: "eip155:84532",
    asset: price.asset,
    amount: price.amount,
    payTo: source.escrow_contract,
    maxTimeoutSeconds: 60,
    extra: {},
  });

  assert.equal(accepts.length, 1);
  const { atumResource, ...extra } = accepts[0].extra;
  assert.equal(atumResource, "GET /tip/3");
  assert.deepEqual({ ...accepts[0], extra }, expected);
});

test("testnet: still settling, then settled, is one payment under one purchase identifier", async () => {
  const atum = fakeAtum({ settles: [settlement("pending"), settlement("paid")] });
  const origin = await startTips(TESTNET_VARS, atum.fetch);

  const { outcome, exchanges } = await tip(origin, "3");

  assert.deepEqual(
    exchanges.map(({ status, receipt }) => [status, receipt?.errorReason]),
    [
      [402, undefined],
      [402, "settlement_pending"],
      [402, undefined],
      [200, undefined],
    ],
  );
  assert.equal(exchanges[1]?.receipt?.extensions?.atum?.paymentId, "pay_1");
  assert.deepEqual(outcome, {
    message: "Thank you. the author received 3 pathUSD.",
    paymentId: "pay_1",
  });
  assert.equal(atum.seen.settle.length, 2);
  assert.equal(atum.seen.settle[0], atum.seen.settle[1]);
});

test("testnet: a terminal failure and a refusal are told apart", async () => {
  const atum = fakeAtum({ settles: [settlement("failed"), settlement("refused")] });
  const origin = await startTips(TESTNET_VARS, atum.fetch);

  const failed = await tip(origin, "3");
  const refused = await tip(origin, "3");

  assert.equal(kindOf(failed.outcome), "failed");
  assert.equal(failed.exchanges.at(-1)?.status, 402);
  assert.equal(kindOf(refused.outcome), "refused");
  assert.match(String(refused.outcome), /the payer has not approved Permit2/);
});

test("testnet: a payment the facilitator finds invalid is never settled", async () => {
  const atum = fakeAtum({ verify: { isValid: false, invalidReason: "stale quote deadline" } });
  const origin = await startTips(TESTNET_VARS, atum.fetch);

  const { outcome, exchanges } = await tip(origin, "3");

  assert.equal(kindOf(outcome), "refused");
  assert.match(String(outcome), /stale quote deadline/);
  assert.deepEqual(exchanges.at(-1), { status: 402 });
  assert.equal(atum.seen.settle.length, 0);
});

test("testnet: a signature that arrives after the quote window is reported as expired", async () => {
  const invalidReason =
    "quote_deadline has already passed, so there is no window in which this payment could be quoted";
  const atum = fakeAtum({ verify: { isValid: false, invalidReason } });
  const origin = await startTips(TESTNET_VARS, atum.fetch);

  const { outcome } = await tip(origin, "3");

  assert.equal(kindOf(outcome), "expired");
  assert.equal(atum.seen.settle.length, 0);
});

test("testnet: a refund the payer must claim stops the re-attempts", async () => {
  const atum = fakeAtum({ settles: [settlement("refund"), settlement("refund")] });
  const origin = await startTips(TESTNET_VARS, atum.fetch);

  const { outcome, exchanges } = await tip(origin, "3");

  assert.equal(kindOf(outcome), "refund");
  assert.match(String(outcome), /pay_1/);
  assert.equal(atum.seen.settle.length, 1, "it did not ask again");
  assert.equal(exchanges.at(-1)?.status, 402);
});

test("testnet: a refusal after Atum accepted an earlier attempt is still settling", async () => {
  const atum = fakeAtum({ settles: [settlement("pending")] });
  // The first attempt is accepted. By the second, the facilitator finds the signature stale.
  let verifies = 0;
  const later: typeof fetch = async (input, init) => {
    const stale = String(input).endsWith("/verify") && ++verifies > 1;
    return stale
      ? Response.json({ isValid: false, invalidReason: "quote_deadline has already passed" })
      : atum.fetch(input, init);
  };
  const origin = await startTips(TESTNET_VARS, later);

  const { outcome } = await tip(origin, "3");

  assert.equal(kindOf(outcome), "unsettled");
  assert.equal(atum.seen.settle.length, 1);
});

test("the tokens Atum's payers treat as one money match the payer SDK's list", () => {
  assert.deepEqual([PEGGED], DEFAULT_PEG_GROUPS);
});

test("a destination token that payers cannot price is a config error", async () => {
  const base = fakeAtum().fetch;
  const renamed: typeof fetch = async (input, init) => {
    const response = await base(input, init);
    const body = await response.json();
    if (body.chain_id === "eip155:42431") body.tokens[0].symbol = "OUSD";
    return Response.json(body, { status: response.status });
  };
  const origin = await startTips(TESTNET_VARS, renamed);

  const response = await fetch(`${origin}/tip/3`);

  assert.equal(response.status, 500);
  assert.match((await response.json()).detail, /USDC for a tip in OUSD/);
});

test("testnet: a settle that errors leaves the outcome unknown, never 'nothing was charged'", async () => {
  const atum = fakeAtum({ settles: [{ error: "upstream timeout" }], settleStatus: 504 });
  const origin = await startTips(TESTNET_VARS, atum.fetch);

  const { outcome, exchanges } = await tip(origin, "3");

  assert.deepEqual(
    exchanges.map((exchange) => exchange.status),
    [402, 502],
  );
  assert.equal(kindOf(outcome), "unknown");
  assert.equal(atum.seen.settle.length, 1, "the payment did reach Atum");
  assert.match(String(outcome), /Re-attempt it under the same purchase identifier/);
});

test("testnet: a payment Atum rejects with a 400 is a refusal, not an outage", async () => {
  const verify = { isValid: false, invalidReason: "invalid_payload" };
  const atum = fakeAtum({ verify, verifyStatus: 400 });
  const origin = await startTips(TESTNET_VARS, atum.fetch);

  const { outcome, exchanges } = await tip(origin, "3");

  assert.equal(exchanges.at(-1)?.status, 402);
  assert.equal(kindOf(outcome), "refused");
  assert.match(String(outcome), /invalid_payload/);
});

test("testnet: /v1/defaults relays the gateway for the corridor's chains only", async () => {
  const origin = await startTips(TESTNET_VARS, fakeAtum().fetch);

  const served = await fetch(`${origin}/v1/defaults?chain_id=eip155:84532`);
  const other = await fetch(`${origin}/v1/defaults?chain_id=eip155:1`);

  assert.partialDeepStrictEqual(await served.json(), {
    chain_id: "eip155:84532",
    escrow_contract: "0x00000000000000000000000000000000000000E5",
    deposit_request_hash_versions: [1],
  });
  assert.equal(other.status, 404);
});

test("a real-mode config with no DEST_ADDRESS never serves a 402", async () => {
  const atum = fakeAtum();
  const origin = await startTips({ ATUM_ENV: "testnet" }, atum.fetch);

  const response = await fetch(`${origin}/tip/3`);

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("PAYMENT-REQUIRED"), null);
  assert.match((await response.json()).detail, /DEST_ADDRESS/);
});

test("a recipient that would lose the tips is a config error", async () => {
  const zero = "0x0000000000000000000000000000000000000000";
  // A valid EIP-55 address with the case of one letter flipped.
  const typo = "0x5Aaeb6053F3E94C9b9A09f33669435E7Ef1BeAeD";
  const valid = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const statusFor = async (DEST_ADDRESS: string) => {
    const origin = await startTips({ ATUM_ENV: "testnet", DEST_ADDRESS }, fakeAtum().fetch);
    return (await fetch(`${origin}/tip/3`)).status;
  };

  assert.deepEqual(
    await Promise.all([zero, typo, valid, valid.toLowerCase()].map(statusFor)),
    [500, 500, 402, 402],
  );
});

test("a tip menu that repeats an amount or cannot be paid is a config error", async () => {
  const statusFor = async (TIP_AMOUNTS: string) =>
    (await fetch(`${await startTips({ TIP_AMOUNTS })}/tip`)).status;

  assert.deepEqual(
    await Promise.all(["1,1.0", "0.0000001", "0.000001", "1,1.5"].map(statusFor)),
    [500, 500, 200, 200],
  );

  // An 18-decimal token admits a tip so small that its cap in a 6-decimal token rounds to zero.
  const base = fakeAtum().fetch;
  const eighteen: typeof fetch = async (input, init) => {
    const response = await base(input, init);
    const body = await response.json();
    if (body.chain_id === "eip155:42431") body.tokens[0].decimals = 18;
    return Response.json(body, { status: response.status });
  };
  const tiny = await startTips({ ...TESTNET_VARS, TIP_AMOUNTS: "0.0000001" }, eighteen);
  const response = await fetch(`${tiny}/tip/0.0000001`);
  assert.equal(response.status, 500);
  assert.match((await response.json()).detail, /too small to pay in USDC/);
});

test("mainnet has no default DEST_ASSET, so it must be configured", async () => {
  const origin = await startTips({ ATUM_ENV: "mainnet", DEST_ADDRESS: TESTNET_VARS.DEST_ADDRESS });

  const response = await fetch(`${origin}/tip/3`);

  assert.equal(response.status, 500);
  assert.match((await response.json()).detail, /DEST_ASSET/);
});

test("an Atum outage is a 502, not a 402", async () => {
  const down: typeof fetch = async () => new Response("", { status: 503 });
  const origin = await startTips(TESTNET_VARS, down);

  assert.equal((await fetch(`${origin}/tip/3`)).status, 502);
});

test("a Host header that is not a host is refused before it reaches any link", async () => {
  const { hostname, port } = new URL(stub);
  const { request } = await import("node:http");
  const status = await new Promise((resolve) => {
    const headers = { host: 'x";globalThis.PWNED=1;"' };
    request({ hostname, port, path: "/llms.txt", headers }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).end();
  });

  assert.equal(status, 400);
});

test("an unknown amount is a 404 that lists the valid ones", async () => {
  const response = await fetch(`${stub}/tip/7`);

  assert.equal(response.status, 404);
  assert.deepEqual(
    (await response.json()).amounts.map((entry: { url: string }) => entry.url),
    [`${stub}/tip/1`, `${stub}/tip/3`, `${stub}/tip/0.5`],
  );
});

test("a malformed credential is a 400", async () => {
  for (const credential of [
    "not base64!",
    btoa("not json"),
    btoa('{"x402Version":2}'),
    btoa('{"accepted":{"network":"eip155:84532","asset":"0x00"}}'),
  ]) {
    const response = await fetch(`${stub}/tip/3`, { headers: { "PAYMENT-SIGNATURE": credential } });
    assert.equal(response.status, 400, credential);
  }
});

test("stub: a payment that names no valid purchase identifier is not thanked", async () => {
  // Atum's payer SDK always names a valid purchase, so this credential is built by hand.
  const credential = (id: string) =>
    btoa(
      JSON.stringify({
        x402Version: 2,
        accepted: { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
        payload: {},
        extensions: { "payment-identifier": { info: { required: true, id } } },
      }),
    );
  const pay = (id: string) =>
    fetch(`${stub}/tip/3`, { headers: { "PAYMENT-SIGNATURE": credential(id) } });

  assert.equal((await pay("x")).status, 402);
  assert.equal((await pay("tip-0123456789abcdef")).status, 200);
});

test("a credential for an offer this server never made is asked again", async () => {
  const credential = btoa(
    JSON.stringify({ x402Version: 2, accepted: { network: "eip155:1", asset: "0x00" } }),
  );
  const response = await fetch(`${stub}/tip/3`, { headers: { "PAYMENT-SIGNATURE": credential } });

  assert.equal(response.status, 402);
  assert.equal(response.headers.get("PAYMENT-RESPONSE"), null);
});

test("the menu lists each amount with its URL, its cost, and the invitation", async () => {
  const response = await fetch(`${stub}/tip`);
  const menu = await response.json();

  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.partialDeepStrictEqual(menu, { author: "Ada", demo: true, asset: "pathUSD" });
  assert.partialDeepStrictEqual(menu.amounts[1], {
    amount: "3",
    url: `${stub}/tip/3`,
    payWith: [{ network: "eip155:84532", symbol: "USDC", maxAmount: "3.09" }],
  });
  assert.partialDeepStrictEqual(menu.agents.protocol, { name: "x402", scheme: "atum-escrow" });
});

test("llms.txt invites without pressure, and its example runs as written", async () => {
  const text = await (await fetch(`${stub}/llms.txt`)).text();

  assert.match(text, /Tip Ada a coffee/);
  assert.match(text, new RegExp(`GET ${stub}/tip/3 `));
  assert.match(text, /scheme `atum-escrow`/);
  assert.match(text, /purchase identifier/);
  assert.match(text, /only within the spending authority your operator gave you/);
  assert.match(text, /ask your human/);
  assert.doesNotMatch(text, /you must|payment (is )?required|ignore (all )?previous/i);

  const example = /```js\n([\s\S]+?)```/.exec(text)?.[1];
  assert.ok(example);
  await writeFile("dist/llms-example.mjs", example);
  const { stdout } = await promisify(execFile)("node", ["dist/llms-example.mjs"]);
  assert.match(stdout, /status: 'thanks'/);
});

test("button.svg is an image that takes a label and colors", async () => {
  const plain = await fetch(`${stub}/button.svg`);
  const custom = await (
    await fetch(`${stub}/button.svg?label=Buy <me> tea&bg=0af&fg=ffffff`)
  ).text();

  assert.equal(plain.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.match(await plain.text(), />Tip me a coffee<\/text>/);
  assert.match(custom, />Buy &#60;me&#62; tea<\/text>/);
  assert.match(custom, /fill="#0af"/);
  assert.match(custom, /fill="#ffffff"/);
  const control = await (await fetch(`${stub}/button.svg?label=a%0Bb%01c`)).text();
  assert.match(control, />abc<\/text>/);
});

test("browsers on other origins may read the terms, pay, and read the receipt", async () => {
  const preflight = await fetch(`${stub}/tip/3`, {
    method: "OPTIONS",
    headers: {
      origin: "https://blog.example",
      "access-control-request-method": "GET",
      "access-control-request-headers": "payment-signature,access-control-expose-headers",
    },
  });
  const unpaid = await fetch(`${stub}/tip/3`, { headers: { origin: "https://blog.example" } });

  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /PAYMENT-SIGNATURE/i);
  assert.match(
    preflight.headers.get("access-control-allow-headers") ?? "",
    /Access-Control-Expose-Headers/i,
  );
  assert.equal(
    unpaid.headers.get("access-control-expose-headers"),
    "PAYMENT-REQUIRED,PAYMENT-RESPONSE",
  );
});
