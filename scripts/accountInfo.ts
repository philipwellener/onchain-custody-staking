import { ethers } from "hardhat";

async function main() {
  const [signer] = await ethers.getSigners();
  const addr = await signer.getAddress();
  const latest = await ethers.provider.getTransactionCount(addr, "latest");
  const pending = await ethers.provider.getTransactionCount(addr, "pending");
  const bal = await ethers.provider.getBalance(addr);
  console.log({ addr, latest, pending, balanceEth: ethers.formatEther(bal) });
  if (pending > latest + 1) {
    console.log("There is at least one missing nonce between latest mined and highest pending");
  } else if (pending === latest + 1) {
    console.log("Exactly one pending tx (next nonce). No gaps.");
  } else if (pending === latest) {
    console.log("No pending transactions.");
  } else {
    console.log("Unexpected: pending < latest");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
