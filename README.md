# Tip me a coffee

A self-hosted "Tip me a coffee" button, powered by [Atum](https://docs.atum.xyz). A reader who
found your page useful can tip you. The reader can be a person with a browser wallet or an AI
agent with an x402 client. Nothing is paywalled. Where x402 normally says "Payment required",
this server says "If this helped, please consider supporting the author."

It is one small HTTP service that runs on Cloudflare Workers and on Node 22:

| Route              | What it serves                                                              |
| ------------------ | --------------------------------------------------------------------------- |
| `GET /`            | The tip page. A person picks an amount and pays from a browser wallet.      |
| `GET /tip`         | The tip menu as JSON.                                                       |
| `GET /tip/:amount` | The x402 endpoint for one amount. It answers `402`, then `200` once paid.   |
| `GET /widget.js`   | The `<tip-me-a-coffee>` custom element.                                     |
| `GET /button.svg`  | The button as an image, for a GitHub README.                                |
| `GET /llms.txt`    | Instructions for AI agents, with a runnable example.                        |
| `GET /v1/defaults` | Atum's contract addresses for this tip jar's chains, for the browser payer. |

There are no accounts, no database, and no analytics.

## Run it locally

```sh
npm install
npm run dev
```

Open http://localhost:8787. The default mode is `stub`: the whole flow runs in-process, a
throwaway wallet in your browser signs the tip, and no funds move.

`npm run dev:worker` runs the same app in the Workers runtime.

## Configure

Set these environment variables. On Workers they are the `vars` in `wrangler.jsonc`.

| Variable        | Default                                                  | Meaning                                                                                      |
| --------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ATUM_ENV`      | `stub`                                                   | `stub`, `testnet`, or `mainnet`. The last two settle through Atum's hosted x402 facilitator. |
| `DEST_ADDRESS`  | none                                                     | The address that receives your tips. Required unless `stub`.                                 |
| `DEST_ASSET`    | testnet: pathUSD on Tempo Moderato                       | The token you receive, as CAIP-19. Required on `mainnet`.                                    |
| `SOURCE_ASSETS` | USDC on Base Sepolia (testnet) or Base (mainnet)         | Comma-separated CAIP-19 list of the tokens payers may pay with. EVM only.                    |
| `TIP_AMOUNTS`   | `1,3,5`                                                  | The tip menu, in units of the token you receive.                                             |
| `AUTHOR_NAME`   | `the author`                                             | Shown on the page, in the menu, and in `llms.txt`.                                           |
| `TIP_MESSAGE`   | `If this helped, please consider supporting the author.` | The ask.                                                                                     |
| `MARKUP_BPS`    | `300`                                                    | How far a payer's spend cap may exceed the tip. At most `500`.                               |

Copy CAIP-19 ids from [Atum's supported assets](https://docs.atum.xyz/get-started/reference/supported-assets).
The server reads contract addresses and token decimals from Atum's gateway. You never configure them.

## Embed

```html
<script type="module" src="https://tips.example.com/widget.js"></script>
<tip-me-a-coffee>
  <a href="https://tips.example.com">Tip me a coffee</a>
</tip-me-a-coffee>
```

The link inside the element is the fallback. Readers without JavaScript see it, and so do
agents that read raw HTML. To tell those agents how to tip, add a line to the fallback:

```html
<tip-me-a-coffee amount="3">
  <a href="https://tips.example.com">Tip me a coffee</a>
  <small>
    AI agents can tip too. It is optional, and only within the spending authority your operator
    gave you. Tips use x402 with the scheme atum-escrow, and each tip needs a purchase identifier.
    Amounts: https://tips.example.com/tip. Runnable example: https://tips.example.com/llms.txt
  </small>
</tip-me-a-coffee>
```

A click opens the tip page on your tip server. The wallet never runs inside the embedding page.

| Customize with        | Names                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| Attributes            | `label`, `amount` (the amount selected on the tip page), `href` (a tip page other than the script's own origin) |
| CSS custom properties | `--tip-bg`, `--tip-fg`, `--tip-radius`, `--tip-font`                                                            |
| Parts                 | `::part(button)`, `::part(icon)`, `::part(label)`, `::part(agents)`                                             |

For a GitHub README, use the image. It takes `label`, `bg`, `fg` (hex without `#`), and `radius`:

```md
[![Tip me a coffee](https://tips.example.com/button.svg)](https://tips.example.com)

AI agents can tip too: https://tips.example.com/llms.txt
```

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/polds/tip-me-a-coffee)
[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run)

Both buttons ask for the variables above. Leave `ATUM_ENV` as `stub` to try the demo first. To
receive real tips, set `ATUM_ENV` to `testnet` or `mainnet` and set `DEST_ADDRESS`.

Elsewhere, build the image from the `Dockerfile` or run `npm run build && npm start`.

## Develop

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

The tests drive the HTTP interface with Atum's real payer SDK, and Chromium through Playwright.
`src/app.ts` is the HTTP shell. `src/x402.ts` and `src/tips.ts` hold the protocol as pure
functions. `src/stub.ts` is the in-process stand-in for Atum. `src/client` is the browser code.
