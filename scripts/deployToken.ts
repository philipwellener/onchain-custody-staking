import { ethers } from "hardhat";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Deployer:", await signer.getAddress());
  console.log("Fetching contract factory for ERC20Mock...");
  const beforeFactory = Date.now();
  const F = await ethers.getContractFactory("ERC20Mock");
  console.log("Factory acquired in", Date.now() - beforeFactory, "ms. Starting deployment...");
  // 1,000,000 tokens initial supply
  const initialSupply = ethers.parseEther("1000000");
  const feeData = await ethers.provider.getFeeData();
  console.log("Fee data:", feeData);
  // Provide fallbacks if provider returns nulls
  const minPriority = ethers.parseUnits("2", "gwei");
  const minMax = ethers.parseUnits("5", "gwei");
  let priority = feeData.maxPriorityFeePerGas || minPriority;
  let base = feeData.maxFeePerGas || minMax;
  if (priority < minPriority) priority = minPriority;
  if (base < minMax) base = minMax;
  const maxPriorityFeePerGas = priority;
  const maxFeePerGas = base > priority ? base : priority + ethers.parseUnits("1", "gwei");
  console.log("Using fees (gwei):", Number(maxFeePerGas) / 1e9, Number(maxPriorityFeePerGas) / 1e9);
  const deployTxStart = Date.now();
  const token = await F.deploy("DemoToken", "DMT", await signer.getAddress(), initialSupply, { maxFeePerGas, maxPriorityFeePerGas });
  console.log("Deployment transaction sent. Hash:", token.deploymentTransaction()?.hash);
  await token.waitForDeployment();
  console.log("Deployment mined in", Date.now() - deployTxStart, "ms");
  const addr = await token.getAddress();
  console.log("ERC20Mock deployed:", addr);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
