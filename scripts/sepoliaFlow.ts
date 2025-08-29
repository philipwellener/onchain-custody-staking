import { ethers } from "hardhat";

// Env vars:
// STAKING_ADDRESS (required)
// TOKEN_ADDRESS (required)
// AMOUNT (ether units string, default "1") amount to deposit & stake
// NEW_REWARD_RATE (optional, raw uint256 scaled 1e18) to update rewardRate before flow (admin only)
// WAIT_SECONDS (optional, default 60) how long to wait to accrue emission rewards

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const stakingAddress = process.env.STAKING_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  if (!stakingAddress || !tokenAddress) throw new Error("Set STAKING_ADDRESS & TOKEN_ADDRESS in env");
  const amountEth = process.env.AMOUNT || "1";
  const waitSeconds = parseInt(process.env.WAIT_SECONDS || "60", 10);

  const staking = await ethers.getContractAt("InstitutionalStaking", stakingAddress);
  const token = await ethers.getContractAt("ERC20Mock", tokenAddress);
  const [signer] = await ethers.getSigners();
  const user = await signer.getAddress();
  console.log({ user, stakingAddress, tokenAddress });

  // Optional reward rate update
  if (process.env.NEW_REWARD_RATE) {
    const current: bigint = await staking.rewardRate();
    const desired = BigInt(process.env.NEW_REWARD_RATE);
    if (current !== desired) {
      console.log(`Updating rewardRate from ${current.toString()} to ${desired.toString()}`);
      const tx = await staking.setRewardRate(desired);
      await tx.wait();
      console.log("rewardRate updated");
    } else {
      console.log("rewardRate already matches desired value");
    }
  }

  const amount = ethers.parseEther(amountEth);
  // Helper to build gas overrides
  const buildGas = async () => {
    const fd = await ethers.provider.getFeeData();
    const minPrio = ethers.parseUnits("2", "gwei");
    const minMax = ethers.parseUnits("5", "gwei");
    let priority = fd.maxPriorityFeePerGas || minPrio;
    let maxFee = fd.maxFeePerGas || minMax;
    if (priority < minPrio) priority = minPrio;
    if (maxFee < minMax) maxFee = minMax;
    // Optional env overrides
    if (process.env.GAS_PRIORITY_GWEI) priority = ethers.parseUnits(process.env.GAS_PRIORITY_GWEI, "gwei");
    if (process.env.GAS_MAX_GWEI) maxFee = ethers.parseUnits(process.env.GAS_MAX_GWEI, "gwei");
    if (maxFee <= priority) maxFee = priority + ethers.parseUnits("1", "gwei");
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
  };

  const waitFor = async (label: string, txPromise: Promise<any>, timeoutSec = 180) => {
    const overrides = await buildGas();
    const tx = await txPromise; // already includes overrides if provided upstream
    console.log(`${label} tx sent:`, tx.hash, 'fees(gwei)=', {
      maxFee: Number(tx.maxFeePerGas) / 1e9,
      maxPrio: Number(tx.maxPriorityFeePerGas) / 1e9
    });
    const start = Date.now();
    while (true) {
      const receipt = await ethers.provider.getTransactionReceipt(tx.hash);
      if (receipt) {
        console.log(`${label} mined in block`, receipt.blockNumber, 'gasUsed', receipt.gasUsed?.toString());
        return receipt;
      }
      const elapsed = (Date.now() - start) / 1000;
      if (elapsed > timeoutSec) {
        console.log(`${label} still pending after ${timeoutSec}s (hash ${tx.hash}). Consider sending a replacement with higher fees.`);
        throw new Error(`${label} pending timeout`);
      }
      await sleep(7000);
    }
  };

  // Check existing allowance; skip if sufficient
  const currentAllowance: bigint = await token.allowance(user, stakingAddress);
  const forceApprove = process.env.FORCE_APPROVE === '1';
  const resetAllowance = process.env.RESET_ALLOWANCE === '1';
  const needApprove = forceApprove || currentAllowance < amount;
  if (!needApprove) {
    console.log(`Skipping approve: existing allowance ${currentAllowance.toString()} >= amount ${amount.toString()} (set FORCE_APPROVE=1 to force)`);
  } else {
    if (resetAllowance && currentAllowance > 0n) {
      console.log(`Resetting allowance to 0 before setting new allowance (currentAllowance=${currentAllowance.toString()})`);
      try {
        const gasReset = await buildGas();
        let resetGasLimit: bigint;
        try {
          resetGasLimit = await token.approve.estimateGas(stakingAddress, 0n, gasReset);
          resetGasLimit = (resetGasLimit * 120n) / 100n;
        } catch {
          resetGasLimit = 60000n;
        }
        await waitFor("approveReset0", token.approve(stakingAddress, 0n, { ...gasReset, gasLimit: resetGasLimit }));
      } catch (e) {
        console.log("Allowance reset to 0 failed, proceeding anyway:", (e as any)?.message || e);
      }
    }
    console.log("Approving", amount.toString(), "force=", forceApprove, "currentAllowance=", currentAllowance.toString());
    const gas1 = await buildGas();
    // Add explicit gasLimit from estimation to avoid provider re-estimation delays
    let gasLimit: bigint;
    try {
      gasLimit = await token.approve.estimateGas(stakingAddress, amount, gas1);
      gasLimit = (gasLimit * 120n) / 100n; // +20% buffer
      console.log("Estimated gas (approve) with buffer:", gasLimit.toString());
    } catch (e) {
      console.log("Gas estimation for approve failed, using fallback 60000", (e as any)?.message || e);
      gasLimit = 60000n;
    }
    await waitFor("approve", token.approve(stakingAddress, amount, { ...gas1, gasLimit }));
  }
  console.log("Depositing", amount.toString());
  const gas2 = await buildGas();
  let depGasLimit: bigint;
  try {
    depGasLimit = await staking["deposit(uint256)"].estimateGas(amount, gas2);
    depGasLimit = (depGasLimit * 125n) / 100n;
    console.log("Estimated gas (deposit) with buffer:", depGasLimit.toString());
  } catch (e) {
    console.log("Gas estimation for deposit failed, using fallback 120000", (e as any)?.message || e);
    depGasLimit = 120000n;
  }
  await waitFor("deposit", staking["deposit(uint256)"](amount, { ...gas2, gasLimit: depGasLimit }));
  console.log("Staking", amount.toString());
  const gas3 = await buildGas();
  let stakeGasLimit: bigint;
  try {
    stakeGasLimit = await staking.stake.estimateGas(amount, gas3);
    stakeGasLimit = (stakeGasLimit * 125n) / 100n;
    console.log("Estimated gas (stake) with buffer:", stakeGasLimit.toString());
  } catch (e) {
    console.log("Gas estimation for stake failed, using fallback 150000", (e as any)?.message || e);
    stakeGasLimit = 150000n;
  }
  await waitFor("stake", staking.stake(amount, { ...gas3, gasLimit: stakeGasLimit }));

  console.log(`Waiting ${waitSeconds}s to accrue emission rewards...`);
  const start = Date.now();
  let lastLogged = 0;
  while ((Date.now() - start) / 1000 < waitSeconds) {
    await sleep(5000);
    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (elapsed - lastLogged >= 15 || elapsed === waitSeconds) {
      lastLogged = elapsed;
      const pending: bigint = await staking.pendingRewards(user);
      console.log(`t+${elapsed}s pendingRewards=${pending.toString()}`);
    }
  }

  // Claim emission rewards only (principal stays)
  console.log("Claiming emission rewards via withdraw(0, true)...");
  const gas4 = await buildGas();
  await waitFor("claimEmissions", staking["withdraw(uint256,bool)"](0, true, gas4));
  console.log("Claimed.");
  const afterClaim: bigint = await staking.pendingRewards(user);
  console.log("Pending after claim (should be small / zero):", afterClaim.toString());

  // APR path withdraw half of staked principal (if staked > 0)
  const acct = await staking.getAccount(user);
  if (acct.staked > 0n) {
    const half = acct.staked / 2n;
    if (half > 0n) {
      console.log("Withdrawing half via APR path withdraw(uint256):", half.toString());
  const gas5 = await buildGas();
  await waitFor("aprWithdrawHalf", staking["withdraw(uint256)"](half, gas5));
    }
  }
  const acctFinal = await staking.getAccount(user);
  console.log("Final account:", {
    deposited: acctFinal.deposited.toString(),
    staked: acctFinal.staked.toString(),
    rewardsAccrued: acctFinal.rewardsAccrued.toString(),
    lastUpdate: acctFinal.lastUpdate.toString(),
    stakeStart: acctFinal.stakeStart.toString(),
    rewardRemainder: acctFinal.rewardRemainder.toString()
  });

  console.log("Done. Inspect token balance to see claimed rewards + APR payout.");
  const bal = await token.balanceOf(user);
  console.log("User token balance:", bal.toString());
}

main().catch(e => { console.error(e); process.exit(1); });
