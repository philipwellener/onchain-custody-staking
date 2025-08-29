import { ethers } from "hardhat";

// Sends replacement 0-value txs with higher fee for each pending nonce gap to speed inclusion
async function main() {
  const [signer] = await ethers.getSigners();
  const addr = await signer.getAddress();
  const latest = await ethers.provider.getTransactionCount(addr, "latest");
  const pending = await ethers.provider.getTransactionCount(addr, "pending");
  console.log({ addr, latest, pending });
  if (pending <= latest) {
    console.log("No pending gap.");
    return;
  }
  // Nonces from latest (mined) upward to pending-1 are pending; we replace them
  const feeData = await ethers.provider.getFeeData();
  let priority = feeData.maxPriorityFeePerGas || ethers.parseUnits("2", "gwei");
  let maxFee = feeData.maxFeePerGas || ethers.parseUnits("5", "gwei");
  // bump 100% initially
  priority = priority * 2n;
  maxFee = maxFee * 2n;
  console.log("Using replacement fees", { maxFeePerGas: maxFee.toString(), maxPriorityFeePerGas: priority.toString() });
  for (let nonce = latest; nonce < pending; nonce++) {
    console.log("Replacing nonce", nonce, "with fees", { maxFeePerGas: maxFee.toString(), maxPriorityFeePerGas: priority.toString() });
    try {
      const tx = await signer.sendTransaction({ to: addr, value: 0, nonce, maxFeePerGas: maxFee, maxPriorityFeePerGas: priority });
      console.log("Sent replacement tx", tx.hash);
    } catch (e:any) {
      console.error("Replacement failed", e.message || e);
      // Increase fees and retry once
      priority = priority + ethers.parseUnits("1", "gwei");
      maxFee = maxFee + ethers.parseUnits("1", "gwei");
      console.log("Retrying with higher fees", { maxFeePerGas: maxFee.toString(), maxPriorityFeePerGas: priority.toString() });
      const tx = await signer.sendTransaction({ to: addr, value: 0, nonce, maxFeePerGas: maxFee, maxPriorityFeePerGas: priority });
      console.log("Sent replacement tx (retry)", tx.hash);
    }
  }
  console.log("Submitted replacement transactions. Wait a bit then re-run accountInfo.ts");
}

main().catch(e => { console.error(e); process.exit(1); });
