import { ethers } from "hardhat";

async function main() {
  const stakingToken = process.env.TOKEN_ADDRESS;
  const rewardRate = process.env.REWARD_RATE; // scaled by 1e18
  const admin = process.env.ADMIN_ADDRESS;
  if (!stakingToken) throw new Error("TOKEN_ADDRESS missing");
  if (!rewardRate) throw new Error("REWARD_RATE missing");
  if (!admin) throw new Error("ADMIN_ADDRESS missing");

  console.log("Deploying InstitutionalStaking with:");
  console.log({ stakingToken, rewardRate, admin });

  const F = await ethers.getContractFactory("InstitutionalStaking");
  const feeData = await ethers.provider.getFeeData();
  const minPriority = ethers.parseUnits("2", "gwei");
  const minMax = ethers.parseUnits("5", "gwei");
  let priority = feeData.maxPriorityFeePerGas || minPriority;
  let base = feeData.maxFeePerGas || minMax;
  if (priority < minPriority) priority = minPriority;
  if (base < minMax) base = minMax;
  const maxPriorityFeePerGas = priority;
  const maxFeePerGas = base > priority ? base : priority + ethers.parseUnits("1", "gwei");
  console.log("Using fees (gwei):", Number(maxFeePerGas) / 1e9, Number(maxPriorityFeePerGas) / 1e9);
  const start = Date.now();
  const contract = await F.deploy(stakingToken, rewardRate, admin, { maxFeePerGas, maxPriorityFeePerGas });
  console.log("Deployment tx hash:", contract.deploymentTransaction()?.hash);
  await contract.waitForDeployment();
  console.log("Mined in", Date.now() - start, "ms");
  const addr = await contract.getAddress();
  console.log("InstitutionalStaking deployed:", addr);
  console.log("Constructor args:");
  console.log(stakingToken, rewardRate, admin);
  console.log("Verify command (after a few mins):");
  console.log(`npx hardhat verify --network sepolia ${addr} ${stakingToken} ${rewardRate} ${admin}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
