/** Everything the operator decides, parsed once from the environment. */

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** CAIP-2 chain id of an EVM chain, for example `eip155:8453`. */
export type Network = `eip155:${string}`;
export type Address = `0x${string}`;
/** A token on a chain: the two halves of a CAIP-19 id. */
export interface Asset {
  network: Network;
  address: Address;
}

/** Names for the EVM chains Atum serves. People read these. Protocol fields keep the CAIP-2 id. */
const CHAIN_NAMES: Record<Network, string> = {
  "eip155:1": "Ethereum",
  "eip155:10": "Optimism",
  "eip155:137": "Polygon",
  "eip155:4217": "Tempo",
  "eip155:8453": "Base",
  "eip155:42161": "Arbitrum",
  "eip155:42220": "Celo",
  "eip155:43114": "Avalanche",
  "eip155:11155111": "Ethereum Sepolia",
  "eip155:11155420": "Optimism Sepolia",
  "eip155:80002": "Polygon Amoy",
  "eip155:42431": "Tempo Moderato",
  "eip155:84532": "Base Sepolia",
  "eip155:421614": "Arbitrum Sepolia",
  "eip155:11142220": "Celo Sepolia",
  "eip155:43113": "Avalanche Fuji",
};
export const chainName = (network: Network): string => CHAIN_NAMES[network] ?? network;

export type AtumEnv = "stub" | "testnet" | "mainnet";

interface Environment {
  /** Atum's hosted services. `stub` has none: it answers for both in-process. */
  hosted?: { gatewayUrl: string; facilitatorUrl: string };
  /** Defaults for `DEST_ASSET` and `SOURCE_ASSETS`, as CAIP-19. */
  destAsset?: string;
  sourceAssets: string;
}

const BASE_SEPOLIA_USDC = "eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TEMPO_MODERATO_PATHUSD = "eip155:42431/erc20:0x20C0000000000000000000000000000000000000";

export const ENVIRONMENTS: Record<AtumEnv, Environment> = {
  stub: { destAsset: TEMPO_MODERATO_PATHUSD, sourceAssets: BASE_SEPOLIA_USDC },
  testnet: {
    hosted: {
      gatewayUrl: "https://payment-gw.production-testnet.atum.xyz",
      facilitatorUrl: "https://payment-gw.production-testnet.atum.xyz/x402/v1",
    },
    destAsset: TEMPO_MODERATO_PATHUSD,
    sourceAssets: BASE_SEPOLIA_USDC,
  },
  mainnet: {
    hosted: {
      gatewayUrl: "https://payment-gw.production-mainnet.atum.xyz",
      facilitatorUrl: "https://payment-gw.production-mainnet.atum.xyz/x402/v1",
    },
    sourceAssets: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
};

/** Nobody holds this address. `stub` moves no funds, so it only has to be well formed. */
const STUB_RECIPIENT: Address = "0x000000000000000000000000000000000000dEaD";

/** Payers refuse a spend cap more than 5% over the tip. */
const MAX_MARKUP_BPS = 500;

export interface Config {
  env: AtumEnv;
  hosted: Environment["hosted"];
  /** Where the author receives, on the destination asset's chain. */
  recipient: Address;
  destAsset: Asset;
  sourceAssets: Asset[];
  /** The tip menu, as the decimal strings the operator wrote. They are also the `/tip/:amount` paths. */
  amounts: string[];
  authorName: string;
  message: string;
  markupBps: number;
}

const isAtumEnv = (value: string): value is AtumEnv => Object.hasOwn(ENVIRONMENTS, value);
const isAddress = (value: string): value is Address => /^0x[0-9a-fA-F]{40}$/.test(value);
const isNetwork = (value: string): value is Network => /^eip155:[0-9]+$/.test(value);

function parseAsset(name: string, caip19: string): Asset {
  const [network, address, ...rest] = caip19.split("/erc20:");
  if (!network || !address || rest.length > 0 || !isNetwork(network) || !isAddress(address)) {
    throw new ConfigError(
      `${name} must be CAIP-19 for an EVM token (eip155:<chain>/erc20:<address>), got "${caip19}"`,
    );
  }
  return { network, address };
}

export function parseConfig(vars: Record<string, unknown>): Config {
  // Deploy buttons submit untouched fields as empty strings, so empty means unset.
  const read = (name: string): string | undefined => {
    const value = vars[name];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  const list = (value: string): string[] => value.split(",").map((item) => item.trim());

  const env = read("ATUM_ENV") ?? "stub";
  if (!isAtumEnv(env)) {
    throw new ConfigError(`ATUM_ENV must be stub, testnet, or mainnet, got "${env}"`);
  }
  const { hosted, ...defaults } = ENVIRONMENTS[env];

  const recipient = read("DEST_ADDRESS") ?? (hosted ? undefined : STUB_RECIPIENT);
  if (!recipient || !isAddress(recipient)) {
    throw new ConfigError(
      `DEST_ADDRESS must be the 0x address that receives tips when ATUM_ENV is ${env}`,
    );
  }

  const destAsset = read("DEST_ASSET") ?? defaults.destAsset;
  if (!destAsset) throw new ConfigError(`DEST_ASSET is required when ATUM_ENV is ${env}`);

  const amounts = list(read("TIP_AMOUNTS") ?? "1,3,5");
  const invalid = amounts.find((amount) => !/^(?=.*[1-9])(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(amount));
  if (invalid !== undefined || new Set(amounts).size !== amounts.length) {
    throw new ConfigError(
      "TIP_AMOUNTS must be distinct positive amounts separated by commas, such as 1,3,5",
    );
  }

  const markupBps = Number(read("MARKUP_BPS") ?? "300");
  if (!Number.isInteger(markupBps) || markupBps < 0 || markupBps > MAX_MARKUP_BPS) {
    throw new ConfigError(`MARKUP_BPS must be a whole number from 0 to ${MAX_MARKUP_BPS}`);
  }

  return {
    env,
    hosted,
    recipient,
    destAsset: parseAsset("DEST_ASSET", destAsset),
    sourceAssets: list(read("SOURCE_ASSETS") ?? defaults.sourceAssets).map((asset) =>
      parseAsset("SOURCE_ASSETS", asset),
    ),
    amounts,
    authorName: read("AUTHOR_NAME") ?? "the author",
    message: read("TIP_MESSAGE") ?? "If this helped, please consider supporting the author.",
    markupBps,
  };
}
