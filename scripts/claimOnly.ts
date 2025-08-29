import { ethers } from "hardhat";
import { TransactionRequest } from "ethers";

/*
 claimOnly.ts
 Minimal script to claim emission rewards via withdraw(0,true) with:
  - Gas estimation & cost preview
  - Economy / manual fee overrides
  - Balance sufficiency check (abort if not enough ETH)
  - Optional dry run (SHOW_ONLY=1)

 Env:
  STAKING_ADDRESS (required)
  TOKEN_ADDRESS   (required, for completeness / future extension)
  ECONOMY=1               (baseFee * multiplier + small priority tip)
  ECONOMY_PRIORITY_GWEI=1 (priority fee in gwei when ECONOMY=1)
  ECONOMY_MULTIPLIER=1.15 (headroom multiplier for baseFee)
  GAS_PRIORITY_GWEI / GAS_MAX_GWEI (explicit overrides)
  SHOW_ONLY=1 (no transaction sent; just logs plan)
  GAS_BUFFER_PCT=20 (add % buffer to estimated gas limit; default 15)
  FORCE_SEND=1 (skip estimateGas and send directly)
  FORCE_GAS_LIMIT=95000 (override fallback gas limit when FORCE_SEND=1)
*/

async function buildGas() {
  const fd = await ethers.provider.getFeeData();
  const latest = await ethers.provider.getBlock('latest');
  const base = latest?.baseFeePerGas || ethers.parseUnits('5','gwei');
  let priority = fd.maxPriorityFeePerGas || ethers.parseUnits('1','gwei');
  let maxFee = fd.maxFeePerGas || (base + priority * 2n);
  if (process.env.ECONOMY === '1') {
    priority = ethers.parseUnits(process.env.ECONOMY_PRIORITY_GWEI || '1','gwei');
    const mult = parseFloat(process.env.ECONOMY_MULTIPLIER || '1.15');
    const scaled = (base * BigInt(Math.round(mult * 1000))) / 1000n;
    maxFee = scaled + priority;
    if (priority < 500_000_000n) priority = 500_000_000n;
  }
  if (process.env.GAS_PRIORITY_GWEI) priority = ethers.parseUnits(process.env.GAS_PRIORITY_GWEI,'gwei');
  if (process.env.GAS_MAX_GWEI) maxFee = ethers.parseUnits(process.env.GAS_MAX_GWEI,'gwei');
  if (maxFee <= priority) maxFee = priority + ethers.parseUnits('1','gwei');
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority, baseFee: base };
}

async function main() {
  const stakingAddress = process.env.STAKING_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS; // not strictly needed for claim
  if (!stakingAddress || !tokenAddress) throw new Error('Need STAKING_ADDRESS & TOKEN_ADDRESS');
  const isValid = (a:string)=> /^0x[0-9a-fA-F]{40}$/.test(a);
  if (!isValid(stakingAddress) || !isValid(tokenAddress)) throw new Error('Invalid address format');
  const dry = process.env.SHOW_ONLY === '1';

  const [signer] = await ethers.getSigners();
  const user = await signer.getAddress();
  const staking = await ethers.getContractAt('InstitutionalStaking', stakingAddress);
  const pending: bigint = await staking.pendingRewards(user);
  console.log('claimOnly config', { user, stakingAddress, pending: pending.toString(), dry, economy: process.env.ECONOMY==='1' });
  if (pending === 0n) {
    console.log('No pending rewards; nothing to claim.');
    return;
  }

  const fees = await buildGas();
  let txReq: TransactionRequest = await staking["withdraw(uint256,bool)"].populateTransaction(0, true);
  const force = process.env.FORCE_SEND === '1';
  // Determine gas limit
  let gasLimit: bigint | undefined;
  if (force) {
    const fallback = BigInt(process.env.FORCE_GAS_LIMIT || '95000');
    gasLimit = fallback;
    console.log('FORCE_SEND active: using gasLimit', gasLimit.toString());
  } else {
    try {
      const est = await signer.estimateGas({ ...txReq, ...fees });
      const estBig = BigInt(est.toString());
      const bufPct = BigInt(parseInt(process.env.GAS_BUFFER_PCT || '15',10));
      gasLimit = estBig + (estBig * bufPct)/100n;
    } catch (e:any) {
      console.log('Gas estimation failed, using fallback 95000:', e.message || e);
      gasLimit = 95_000n;
    }
  }
  txReq = { ...txReq, ...fees, gasLimit };
  const maxCost = gasLimit * fees.maxFeePerGas;
  const balance = await ethers.provider.getBalance(user);
  console.log('feePlan', {
    baseFeeGwei: Number(fees.baseFee)/1e9,
    maxFeeGwei: Number(fees.maxFeePerGas)/1e9,
    priorityGwei: Number(fees.maxPriorityFeePerGas)/1e9,
    gasLimit: gasLimit.toString(),
    maxCostWei: maxCost.toString(),
    maxCostEth: Number(maxCost)/1e18,
    balanceWei: balance.toString(),
    balanceEth: Number(balance)/1e18
  });
  if (balance < maxCost) {
    if (force) {
      console.log('WARNING: balance < theoretical max cost, attempting send anyway due to FORCE_SEND');
    } else {
      console.log('ABORT: Insufficient ETH for worst-case maxFeePerGas * gasLimit');
      return;
    }
  }
  if (dry) {
    console.log('DRY RUN: would send claim transaction now.');
    return;
  }
  const tx = await signer.sendTransaction(txReq);
  console.log('claim sent', { hash: tx.hash, nonce: tx.nonce });
  const rec = await tx.wait();
  console.log('claim mined', { block: rec?.blockNumber, gasUsed: rec?.gasUsed?.toString() });
  const pendingAfter: bigint = await staking.pendingRewards(user);
  console.log('postClaimPending', pendingAfter.toString());
}

main().catch(e=>{ console.error(e); process.exit(1); });
