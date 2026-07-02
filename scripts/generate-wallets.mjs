/**
 * Generate fresh Arc/EVM wallets for the agent (buyer) and an author (seller),
 * for a real PAYMENT_MODE=gateway run. Prints env lines to paste into .env.
 * Fund the buyer with testnet USDC via Circle's faucet before running.
 *
 *   npm run generate-wallets        (or: make generate-wallets)
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

function wallet(label) {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  return { label, key, address: account.address };
}

const buyer = wallet("BUYER");
const author = wallet("AUTHOR");

console.log("# Generated wallets — add the buyer to .env. Keep keys secret.\n");
console.log(`PAYMENT_MODE=gateway`);
console.log(`BUYER_ADDRESS=${buyer.address}`);
console.log(`BUYER_PRIVATE_KEY=${buyer.key}`);
console.log(`\n# Author wallet (fund credits.json / your credits API with this address):`);
console.log(`# AUTHOR_ADDRESS=${author.address}`);
console.log(`# AUTHOR_PRIVATE_KEY=${author.key}`);
console.log(
  `\n# Next: fund ${buyer.address} with Arc testnet USDC (Circle faucet),\n` +
    `# then 'PAYMENT_MODE=gateway npm run wayfarer -- \"<topic>\"'.`,
);
