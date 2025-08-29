import { ethers } from "hardhat";
import { TransactionRequest } from "ethers";

/*
 Quick low-ETH demo script to showcase ALL core features with the FEWEST transactions.

 Actions demonstrated (conditionally):
 1. approve (only if allowance insufficient)
 2. deposit (only missing portion)
 3. stake (stake a percentage of deposited tokens)
 4. wait (emission accrues)
 5. claim emission rewards (withdraw(0, true))
 6. APR withdraw (withdraw(amount)) on a small fraction of remaining staked principal

 Environment Variables (all optional unless marked required):
  STAKING_ADDRESS (required)
  TOKEN_ADDRESS   (required)
  DEPOSIT_AMOUNT  (ether units string, default "1")
  STAKE_PERCENT   (integer percent of total deposited to stake, default 60)
  WAIT_SECONDS    (seconds before claim, default 45; set 0 to skip wait/claim)
  CLAIM=1         (set 0 to skip emission claim step even if WAIT_SECONDS>0)
  WAIT_AFTER_CLAIM (seconds to wait after claim before APR withdraw, default 20)
  APR_WITHDRAW_PERCENT (percent of current staked to APR-withdraw, default 25)
  ECONOMY=1       (economy gas mode: baseFee + priority tip (default 1 gwei) + 10% headroom)
  ECONOMY_PRIORITY_GWEI (priority fee in gwei when ECONOMY=1, default 1)
  GAS_PRIORITY_GWEI / GAS_MAX_GWEI (override fees explicitly; overrides economy)
  SHOW_ONLY=1     (dry run: simulate & log but DO NOT send transactions)

 Gas Minimization Strategies:
  - Only send steps that are strictly necessary (skip if state already satisfies)
  - Economy fee calculation for low-cost inclusion
  - Small number of total writes (max 6)
  - Stake only a fraction so APR withdraw uses a very small amount

 NOTE: Gas consumed is largely independent of token amounts; using large vs small DEPOSIT_AMOUNT
       does not materially affect gas cost (aside from event data size). Keep amount reasonable
       so reward growth is visible but do not worry about it increasing gas.
*/

const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));

async function buildGas() {
  const fd = await ethers.provider.getFeeData();
  const minPrio = ethers.parseUnits("1","gwei");
  const minMax = ethers.parseUnits("5","gwei");
  let priority = fd.maxPriorityFeePerGas || minPrio;
  let maxFee = fd.maxFeePerGas || minMax;
  if (process.env.ECONOMY === '1') {
    const latest = await ethers.provider.getBlock('latest');
    const base = latest?.baseFeePerGas || maxFee;
    priority = ethers.parseUnits(process.env.ECONOMY_PRIORITY_GWEI || '1','gwei');
    maxFee = base + (base / 10n) + priority; // 10% headroom
    if (priority < 500_000_000n) priority = 500_000_000n; // 0.5 gwei safety
  }
  if (process.env.GAS_PRIORITY_GWEI) priority = ethers.parseUnits(process.env.GAS_PRIORITY_GWEI, 'gwei');
  if (process.env.GAS_MAX_GWEI) maxFee = ethers.parseUnits(process.env.GAS_MAX_GWEI, 'gwei');
  if (maxFee <= priority) maxFee = priority + ethers.parseUnits('1','gwei');
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
}

async function sendTx(label:string, signer:any, build:()=>Promise<TransactionRequest>, dry:boolean) {
  const overrides = await buildGas();
  let req = await build();
  req = { ...req, ...overrides };
  if (!req.gasLimit) {
    try { req.gasLimit = (await signer.estimateGas(req)) * 120n / 100n; } catch {/*ignore*/}
  }
  if (dry) {
    console.log(`[DRY] ${label} ->`, { to: req.to, dataLen: (req.data as string|undefined)?.length || 0, gasLimit: req.gasLimit?.toString(), maxFeeGwei: Number((req as any).maxFeePerGas)/1e9 });
    return;
  }
  const tx = await signer.sendTransaction(req);
  console.log(`[${label}] sent`, tx.hash, 'nonce', tx.nonce, 'fees(gwei)', { max: Number(tx.maxFeePerGas)/1e9, prio: Number(tx.maxPriorityFeePerGas)/1e9 });
  const rec = await tx.wait();
  console.log(`[${label}] mined block=${rec?.blockNumber} gasUsed=${rec?.gasUsed?.toString()}`);
}

function pctOf(value: bigint, pct: number): bigint { return (value * BigInt(pct)) / 100n; }

async function main() {
  const stakingAddress = process.env.STAKING_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  if (!stakingAddress || !tokenAddress) throw new Error('Need STAKING_ADDRESS & TOKEN_ADDRESS');
  const isValid = (a:string)=> /^0x[0-9a-fA-F]{40}$/.test(a);
  if (!isValid(stakingAddress)) throw new Error(`Invalid STAKING_ADDRESS format (expect 0x + 40 hex chars). Got: ${stakingAddress}`);
  if (!isValid(tokenAddress)) throw new Error(`Invalid TOKEN_ADDRESS format (expect 0x + 40 hex chars). Got: ${tokenAddress}`);
  const depositAmountEth = process.env.DEPOSIT_AMOUNT || '1';
  const stakePercent = parseInt(process.env.STAKE_PERCENT || '60',10); // % of total deposited to stake
  const waitSeconds = parseInt(process.env.WAIT_SECONDS || '45',10);
  const doClaim = process.env.CLAIM === '0' ? false : true; // default yes
  const waitAfterClaim = parseInt(process.env.WAIT_AFTER_CLAIM || '20',10);
  const aprPct = parseInt(process.env.APR_WITHDRAW_PERCENT || '25',10);
  const dry = process.env.SHOW_ONLY === '1';

  const [signer] = await ethers.getSigners();
  const user = await signer.getAddress();
  const token = await ethers.getContractAt('ERC20Mock', tokenAddress);
  const staking = await ethers.getContractAt('InstitutionalStaking', stakingAddress);
  const targetDeposit = ethers.parseEther(depositAmountEth);

  console.log('--- Quick Demo Config ---');
  console.log({ user, stakingAddress, tokenAddress, targetDeposit: targetDeposit.toString(), stakePercent, waitSeconds, doClaim, waitAfterClaim, aprPct, economy: process.env.ECONOMY==='1', dry });

  // Fetch current state
  const acctBefore = await staking.getAccount(user);
  const allowance: bigint = await token.allowance(user, stakingAddress);
  console.log('Initial account', { deposited: acctBefore.deposited.toString(), staked: acctBefore.staked.toString(), rewardsAccrued: acctBefore.rewardsAccrued.toString() });

  // Determine required actions
  // 1. Approve: need allowance to cover (targetDeposit - already deposited) if additional deposit needed
  const alreadyDeposited = acctBefore.deposited;
  const neededDeposit = targetDeposit > alreadyDeposited ? (targetDeposit - alreadyDeposited) : 0n;
  const needApprove = neededDeposit > 0n && allowance < neededDeposit;
  if (needApprove) {
    console.log('Will approve amount needed for new deposit:', neededDeposit.toString());
    await sendTx('approve', signer, async()=> token.approve.populateTransaction(stakingAddress, neededDeposit), dry);
  } else {
    console.log('Approve skipped (allowance sufficient or no new deposit needed).');
  }

  // 2. Deposit missing portion
  if (neededDeposit > 0n) {
    console.log('Depositing difference', neededDeposit.toString());
    await sendTx('deposit', signer, async()=> staking["deposit(uint256)"].populateTransaction(neededDeposit), dry);
  } else {
    console.log('Deposit skipped (target already met).');
  }

  // Refresh account after potential deposit
  const acctAfterDeposit = await staking.getAccount(user);

  // 3. Stake stakePercent of total deposited, but not exceeding unstaked balance
  const desiredStake = pctOf(acctAfterDeposit.deposited, stakePercent);
  const currentStake = acctAfterDeposit.staked;
  const availableToStake = acctAfterDeposit.deposited - currentStake;
  const stakeDeficit = desiredStake > currentStake ? (desiredStake - currentStake) : 0n;
  const toStake = stakeDeficit > availableToStake ? availableToStake : stakeDeficit;
  if (toStake > 0n) {
    console.log('Staking', toStake.toString());
    await sendTx('stake', signer, async()=> staking.stake.populateTransaction(toStake), dry);
  } else {
    console.log('Stake skipped (already at or above desired stake%).');
  }

  // 4. Wait for emission rewards
  if (waitSeconds > 0) {
    console.log(`Waiting ${waitSeconds}s to accrue emission rewards...`);
    const start = Date.now();
    let lastLog = 0;
    while ((Date.now()-start)/1000 < waitSeconds) {
      await sleep(5000);
      const elapsed = Math.floor((Date.now()-start)/1000);
      if (elapsed - lastLog >= 15 || elapsed === waitSeconds) {
        lastLog = elapsed;
        const pending = await staking.pendingRewards(user);
        console.log(`t+${elapsed}s pendingEmission=${pending.toString()}`);
      }
    }
  }

  // 5. Claim emission rewards via withdraw(0,true)
  if (doClaim && waitSeconds > 0) {
    const pendingBeforeClaim = await staking.pendingRewards(user);
    if (pendingBeforeClaim > 0n) {
      console.log('Claiming emission rewards', pendingBeforeClaim.toString());
      await sendTx('claim', signer, async()=> staking["withdraw(uint256,bool)"].populateTransaction(0, true), dry);
    } else {
      console.log('Claim skipped (no pending emission rewards).');
    }
  } else {
    console.log('Claim step skipped by config.');
  }

  // Optional extra wait to show accrual continues post-claim
  if (waitAfterClaim > 0 && doClaim && waitSeconds > 0) {
    console.log(`Waiting ${waitAfterClaim}s post-claim (shows accrual reset & resumes)...`);
    const start = Date.now();
    while ((Date.now()-start)/1000 < waitAfterClaim) {
      await sleep(5000);
      const elapsed = Math.floor((Date.now()-start)/1000);
      const pending = await staking.pendingRewards(user);
      console.log(`post-claim t+${elapsed}s pendingEmission=${pending.toString()}`);
    }
  }

  // 6. APR withdraw a fraction of current staked principal
  const acctForApr = await staking.getAccount(user);
  if (acctForApr.staked > 0n && aprPct > 0) {
    const aprAmount = pctOf(acctForApr.staked, aprPct);
    if (aprAmount > 0n) {
      console.log(`APR withdrawing ${aprPct}% of staked = ${aprAmount.toString()}`);
      await sendTx('aprWithdraw', signer, async()=> staking["withdraw(uint256)"].populateTransaction(aprAmount), dry);
    } else {
      console.log('APR withdraw skipped (computed amount 0).');
    }
  } else {
    console.log('APR withdraw skipped (no staked balance or aprPct=0).');
  }

  // Final state
  const finalAcct = await staking.getAccount(user);
  const tokenBal = await token.balanceOf(user);
  const pendingFinal = await staking.pendingRewards(user);
  console.log('--- Final Account State ---');
  console.log({ deposited: finalAcct.deposited.toString(), staked: finalAcct.staked.toString(), rewardsAccrued: finalAcct.rewardsAccrued.toString(), pendingEmission: pendingFinal.toString() });
  console.log('User token balance', tokenBal.toString());
  console.log('Demo complete.');
}

main().catch(e=>{ console.error(e); process.exit(1); });
