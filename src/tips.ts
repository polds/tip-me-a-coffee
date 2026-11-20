/** The tip jar: the operator's config joined with Atum's network facts. */
import { type Atum, type ChainDefaults, hostedAtum } from "./atum.ts";
import {
  type Address,
  type Asset,
  type Config,
  ConfigError,
  chainName,
  type Network,
  parseConfig,
} from "./config.ts";
import { stubAtum } from "./stub.ts";
import type { Offer } from "./x402.ts";

/** A configured token, with the facts Atum's gateway reports for it and for its chain. */
export interface Token extends Asset {
  symbol: string;
  decimals: number;
  chain: ChainDefaults;
}

export interface Tips {
  config: Config;
  atum: Atum;
  destination: Token;
  sources: Token[];
  /** Each amount on the menu, in atomic units of the destination token. */
  amounts: Map<string, bigint>;
}

/**
 * The dollar tokens Atum's payer SDK treats as one money (its `DEFAULT_PEG_GROUPS`). A payer
 * refuses an offer whose two tokens are neither in this group nor the same symbol. A test
 * compares this list with the SDK's.
 */
export const PEGGED = [
  "USDC",
  "USDC.e",
  "USDT",
  "USDT0",
  "PYUSD",
  "pathUSD",
  "rUSD",
  "SBC",
  "alphaUSD",
  "betaUSD",
  "thetaUSD",
];

/**
 * Atum's defaults. Quotes are collected for 3 seconds after the payer builds a payment, and the
 * gateway waits out that window, so a longer one only slows every tip. The tip must then be
 * delivered within 5 minutes or the payer is refunded.
 */
const QUOTE_DEADLINE_SECONDS = 3;
const FULFILLMENT_DEADLINE_SECONDS = 300;

function toAtomic(amount: string, decimals: number): bigint {
  const [whole = "", fraction = ""] = amount.split(".");
  if (fraction.length > decimals) {
    throw new ConfigError(`TIP_AMOUNTS: ${amount} has more than ${decimals} decimal places`);
  }
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

export function fromAtomic(value: bigint, decimals: number): string {
  const digits = value.toString().padStart(decimals + 1, "0");
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return digits.slice(0, digits.length - decimals) + (fraction && `.${fraction}`);
}

export async function loadTips(
  vars: Record<string, unknown>,
  fetch: typeof globalThis.fetch,
): Promise<Tips> {
  const config = parseConfig(vars);
  const atum = config.hosted ? hostedAtum(config.hosted, fetch) : stubAtum();

  const token = async (asset: Asset): Promise<Token> => {
    const id = `${asset.network}/erc20:${asset.address}`;
    const chain = await atum.defaults(asset.network);
    const listed = chain?.tokens.find(
      (token) => token.address.toLowerCase() === asset.address.toLowerCase(),
    );
    if (!chain || !listed) {
      throw new ConfigError(`${id} is not a token Atum supports when ATUM_ENV is ${config.env}`);
    }
    return { ...asset, symbol: listed.symbol, decimals: listed.decimals, chain };
  };
  const [destination, ...sources] = await Promise.all(
    [config.destAsset, ...config.sourceAssets].map(token),
  );
  if (!destination) throw new ConfigError("DEST_ASSET is required");
  for (const source of sources) {
    const pegged = PEGGED.includes(source.symbol) && PEGGED.includes(destination.symbol);
    if (source.symbol !== destination.symbol && !pegged) {
      throw new ConfigError(
        `SOURCE_ASSETS: payers refuse to pay ${source.symbol} for a tip in ${destination.symbol}, because the two are not the same money`,
      );
    }
  }

  const amounts = new Map(
    config.amounts.map((amount) => [amount, toAtomic(amount, destination.decimals)]),
  );
  const tips = { config, atum, destination, sources, amounts };
  // A cap is rounded down to a whole unit of the source token. When that leaves less than the
  // tip itself, no settlement operator can fill it without a loss, so the tip could never settle.
  for (const [amount, fulfillment] of amounts) {
    for (const source of sources) {
      const cap = spendCap(tips, source, fulfillment) * 10n ** BigInt(destination.decimals);
      if (cap < fulfillment * 10n ** BigInt(source.decimals)) {
        throw new ConfigError(
          `TIP_AMOUNTS: ${amount} ${destination.symbol} is too small to pay in ${source.symbol}`,
        );
      }
    }
  }
  return tips;
}

/**
 * The most a payer can be charged in `source` for a tip of `fulfillment`: the tip plus the
 * markup, converted between the two tokens' decimals and rounded down. The payer's client
 * bounds the cap with the same arithmetic.
 */
export function spendCap(tips: Tips, source: Token, fulfillment: bigint): bigint {
  const scaled =
    fulfillment * (10_000n + BigInt(tips.config.markupBps)) * 10n ** BigInt(source.decimals);
  return scaled / (10_000n * 10n ** BigInt(tips.destination.decimals));
}

/** One offer per source token. Each field is config or a gateway fact, so a rebuild reproduces it. */
export function offersFor(tips: Tips, resource: string, fulfillment: bigint): Offer[] {
  const { destination, config } = tips;
  return tips.sources.map((source) => {
    const versions = source.chain.deposit_request_hash_versions;
    return {
      scheme: "atum-escrow",
      network: source.network,
      asset: source.address,
      payTo: source.chain.escrow_contract,
      amount: spendCap(tips, source, fulfillment).toString(),
      maxTimeoutSeconds: 60,
      extra: {
        atum: {
          destination: {
            network: destination.network,
            asset: destination.address,
            address: config.recipient,
          },
          fulfillmentAmount: fulfillment.toString(),
          escrow: source.chain.escrow_contract,
          fulfillmentProxy: destination.chain.fulfillment_proxy,
          reserver: source.chain.quote_selector,
          releaser: source.chain.fulfillment_verifier.account,
          fulfillmentVerifierEndpoint: source.chain.fulfillment_verifier.endpoint,
          quoteDeadlineSeconds: QUOTE_DEADLINE_SECONDS,
          fulfillmentDeadlineSeconds: FULFILLMENT_DEADLINE_SECONDS,
          // Payers read an absent list as [1]. Clients from before the field refuse any list,
          // so publish one only once the gateway lists a later version.
          ...(versions?.some((version) => version !== 1) && {
            depositRequestHashVersions: versions,
          }),
        },
        atumResource: resource,
      },
    };
  });
}

/** `GET /tip`, and what the tip page's script reads. */
export interface Menu {
  author: string;
  message: string;
  /** True in `stub`: tips are simulated and no funds move. */
  demo: boolean;
  /** The token the author receives. */
  asset: string;
  amounts: {
    amount: string;
    url: string;
    /** The ways to pay it, with the most each can cost: for people, and in atomic units. */
    payWith: {
      network: Network;
      /** The chain's name for people, such as "Base Sepolia". */
      chain: string;
      asset: Address;
      symbol: string;
      maxAmount: string;
      maxAtomic: string;
    }[];
  }[];
}

export function menuOf(tips: Tips, origin: string): Menu {
  return {
    author: tips.config.authorName,
    message: tips.config.message,
    demo: tips.config.env === "stub",
    asset: tips.destination.symbol,
    amounts: [...tips.amounts].map(([amount, fulfillment]) => ({
      amount,
      url: `${origin}/tip/${amount}`,
      payWith: tips.sources.map((source) => {
        const cap = spendCap(tips, source, fulfillment);
        return {
          network: source.network,
          chain: chainName(source.network),
          asset: source.address,
          symbol: source.symbol,
          maxAmount: fromAtomic(cap, source.decimals),
          maxAtomic: cap.toString(),
        };
      }),
    })),
  };
}
