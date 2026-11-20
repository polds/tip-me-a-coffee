/**
 * Atum's payer SDK is built for Node. Its bundles call `createRequire` from `node:module` to
 * load a few packages at run time, and a browser has no such thing. `scripts/build.mjs`
 * aliases `module` to this file, so those calls resolve to the copies bundled here.
 */
import * as ethers from "ethers";

const packages: Record<string, unknown> = {
  ethers,
  // @noble/hashes asks Node's crypto for a random source.
  crypto: { webcrypto: globalThis.crypto },
};

// The SDK also asks for `bs58` and `tweetnacl`, which only its Solana and Tron paths call.
// This server takes EVM sources only, so those two resolve to an empty module.
export const createRequire = () => (name: string) => packages[name] ?? {};
