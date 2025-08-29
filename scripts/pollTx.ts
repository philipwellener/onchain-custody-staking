import { ethers } from "hardhat";

async function main() {
  const hash = process.env.TX_HASH || process.argv[2];
  if (!hash) throw new Error("Pass tx hash as TX_HASH env var or first arg");
  console.log("Polling for receipt:", hash);
  const provider = ethers.provider;
  for (let i = 0; i < 120; i++) { // ~10 minutes if 5s interval
    const r = await provider.getTransactionReceipt(hash);
    if (r) {
      console.log("Mined in block", r.blockNumber, "status", r.status);
      if (r.contractAddress) console.log("Contract address:", r.contractAddress);
      return;
    }
    if (i % 6 === 0) {
      const tx = await provider.getTransaction(hash);
      if (tx) {
        console.log("Pending... nonce", tx.nonce, "gasPrice", tx.gasPrice?.toString());
      } else {
        console.log("Transaction not found yet (maybe dropped)");
      }
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  console.log("Timed out waiting for receipt. You can keep polling.");
}

main().catch(e => { console.error(e); process.exit(1); });
