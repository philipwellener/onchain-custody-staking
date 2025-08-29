import { ethers, network } from "hardhat";

async function main() {
  const stakingAddress = process.env.STAKING_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  if (!stakingAddress || !tokenAddress) throw new Error("Need STAKING_ADDRESS & TOKEN_ADDRESS in env");

  const staking = await ethers.getContractAt("InstitutionalStaking", stakingAddress);
  const token = await ethers.getContractAt("ERC20Mock", tokenAddress);
  const [signer] = await ethers.getSigners();
  console.log("Signer:", await signer.getAddress());

  const amount = ethers.parseEther("10");
  console.log("Approving & depositing", amount.toString());
  await (await token.approve(stakingAddress, amount)).wait();
  await (await staking["deposit(uint256)"](amount)).wait();
  console.log("Deposited");
  await (await staking.stake(amount)).wait();
  console.log("Staked");

  if (network.name === 'hardhat' || network.name === 'localhost') {
    console.log("Advancing 1 hour...");
    await network.provider.send("evm_increaseTime", [3600]);
    await network.provider.send("evm_mine");
  } else {
    console.log("Wait a few minutes to see rewards grow on testnet.");
  }

  const pending = await staking.pendingRewards(await signer.getAddress());
  console.log("Pending rewards:", pending.toString());

  console.log("Withdrawing 5 tokens via APR withdraw path...");
  await (await staking["withdraw(uint256)"](ethers.parseEther("5"))).wait();
  console.log("Withdrawn");
}

main().catch(e => { console.error(e); process.exitCode = 1; });
