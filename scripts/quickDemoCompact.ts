import { ethers } from "hardhat";
import { TransactionRequest } from "ethers";

/*
 quickDemoCompact.ts

 Purpose: Produce a TIGHT, screenshot‑ready terminal transcript demonstrating
 the full staking lifecycle with minimal, curated lines.

 Steps (auto-skipped if already satisfied): approve -> deposit -> stake -> accrue -> claim -> APR withdraw -> final state.

 Environment vars (optional unless marked):
  STAKING_ADDRESS (required)
  TOKEN_ADDRESS   (required)
  DEPOSIT_AMOUNT  (ether units, default 1)
  STAKE_PERCENT   (integer %, default 60)
  WAIT_SECONDS    (default 45) – emission accrual window
  APR_WITHDRAW_PERCENT (default 25) – percent of current staked to APR withdraw (0 to skip)
  ECONOMY=1       enable low gas mode (baseFee + ~10% + tiny tip)
  ECONOMY_PRIORITY_GWEI (priority when ECONOMY=1; default 1)
  GAS_PRIORITY_GWEI / GAS_MAX_GWEI explicit fee overrides (disable economy logic)
  SHOW_ONLY=1     dry run (no txs sent)

 Output format is intentionally concise – each action emits at most two lines.
*/

const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));

interface GasPlan { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; baseFee: bigint; }

async function buildGas(): Promise<GasPlan> {
  const fd = await ethers.provider.getFeeData();
  const latest = await ethers.provider.getBlock('latest');
  const base = latest?.baseFeePerGas || ethers.parseUnits('5','gwei');
  let priority = fd.maxPriorityFeePerGas || ethers.parseUnits('1','gwei');
  let maxFee = fd.maxFeePerGas || (base + priority * 2n);
  if (process.env.ECONOMY === '1') {
    priority = ethers.parseUnits(process.env.ECONOMY_PRIORITY_GWEI || '1','gwei');
    // Allow configurable multiplier; default 1.15x base
    const mult = parseFloat(process.env.ECONOMY_MULTIPLIER || '1.15');
    const scaled = (base * BigInt(Math.round(mult * 1000))) / 1000n; // integer math
    maxFee = scaled + priority; // headroom + tip
    if (priority < 500_000_000n) priority = 500_000_000n; // 0.5 gwei floor
  }
  if (process.env.GAS_PRIORITY_GWEI) priority = ethers.parseUnits(process.env.GAS_PRIORITY_GWEI,'gwei');
  if (process.env.GAS_MAX_GWEI) maxFee = ethers.parseUnits(process.env.GAS_MAX_GWEI,'gwei');
  if (maxFee <= priority) maxFee = priority + ethers.parseUnits('1','gwei');
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority, baseFee: base };
}

async function send(label:string, signer:any, build:()=>Promise<TransactionRequest>, dry:boolean) {
  const fees = await buildGas();
  let req = await build();
  req = { ...req, ...fees };
  const tight = process.env.TIGHT_GAS === '1';
  if (!req.gasLimit) {
    try {
      const est = await signer.estimateGas(req);
      const estBig = BigInt(est.toString());
      const multiplier = tight ? 105n : 120n; // tighter headroom if requested
      req.gasLimit = (estBig * multiplier) / 100n;
    } catch {}
  } else if (tight) {
    // If caller provided gasLimit and tight mode, shave it slightly (not below 95%)
    const glBig = BigInt(req.gasLimit.toString());
    req.gasLimit = (glBig * 105n) / 100n;
  }
  // Optional budget enforcement
  const budgetEth = process.env.GAS_BUDGET_ETH ? parseFloat(process.env.GAS_BUDGET_ETH) : undefined;
  if (budgetEth && req.gasLimit) {
    const budgetWei = ethers.parseEther(budgetEth.toString());
    const glBig = BigInt(req.gasLimit.toString());
    const maxCost = glBig * fees.maxFeePerGas;
    if (maxCost > budgetWei) {
      // Scale down maxFeePerGas to fit budget (leave at least priority + 1 gwei)
      const newMaxFee = budgetWei / glBig;
      if (newMaxFee > fees.maxPriorityFeePerGas + ethers.parseUnits('1','gwei')) {
        req.maxFeePerGas = newMaxFee;
      }
    }
  }
  const estCost = req.gasLimit && req.maxFeePerGas ? (BigInt(req.gasLimit.toString()) * BigInt(req.maxFeePerGas.toString())) : undefined;
  const costEth = estCost ? Number(estCost) / 1e18 : undefined;
  if (dry) {
    console.log(`${label}: DRY (gasLimit=${req.gasLimit?.toString()} maxFeeGwei=${req.maxFeePerGas ? Number(req.maxFeePerGas)/1e9 : 'n/a'} estMaxCostEth=${costEth?.toFixed(5)})`);
    return { hash: '0xDRY', gasUsed: 0n };
  }
  const bal = await signer.provider.getBalance(await signer.getAddress());
  if (estCost && estCost > bal) {
    console.log(`${label}: ABORT (estMaxCostEth=${costEth?.toFixed(5)} > balanceEth=${Number(bal)/1e18})`);
    return { hash: '0xSKIPPED', gasUsed: 0n };
  }
  const tx = await signer.sendTransaction(req);
  console.log(`${label}: sent ${tx.hash} nonce=${tx.nonce} gasLimit=${req.gasLimit?.toString()} maxFeeGwei=${req.maxFeePerGas ? Number(req.maxFeePerGas)/1e9 : 'n/a'}`);
  const r = await tx.wait();
  console.log(`${label}: mined block=${r?.blockNumber} gasUsed=${r?.gasUsed}`);
  return r;
}

const pctOf = (v:bigint,p:number)=> (v * BigInt(p)) / 100n;

async function main() {
  const stakingAddress = process.env.STAKING_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  if (!stakingAddress || !tokenAddress) throw new Error('Need STAKING_ADDRESS & TOKEN_ADDRESS');
  const isValid = (a:string)=> /^0x[0-9a-fA-F]{40}$/.test(a);
  if (!isValid(stakingAddress)) throw new Error(`Invalid STAKING_ADDRESS format (expect 0x + 40 hex chars). Got: ${stakingAddress}`);
  if (!isValid(tokenAddress)) throw new Error(`Invalid TOKEN_ADDRESS format (expect 0x + 40 hex chars). Got: ${tokenAddress}`);
  const depositEth = process.env.DEPOSIT_AMOUNT || '1';
  const stakePct = parseInt(process.env.STAKE_PERCENT || '60',10);
  const waitSeconds = parseInt(process.env.WAIT_SECONDS || '45',10);
  const aprPct = parseInt(process.env.APR_WITHDRAW_PERCENT || '25',10);
  const dry = process.env.SHOW_ONLY === '1';

  const [signer] = await ethers.getSigners();
  const user = await signer.getAddress();
  const token = await ethers.getContractAt('ERC20Mock', tokenAddress);
  const staking = await ethers.getContractAt('InstitutionalStaking', stakingAddress);
  const targetDeposit = ethers.parseEther(depositEth);

  const acct0 = await staking.getAccount(user);
  const allowance: bigint = await token.allowance(user, stakingAddress);

  console.log(`config user=${user.slice(0,8)} deposit=${depositEth} stake%=${stakePct} wait=${waitSeconds}s apr%=${aprPct} economy=${process.env.ECONOMY==='1'} tight=${process.env.TIGHT_GAS==='1'} dry=${dry}`);

  // Approve & Deposit
  const already = acct0.deposited;
  const needDeposit = targetDeposit > already ? targetDeposit - already : 0n;
  if (needDeposit > 0n) {
    if (allowance < needDeposit) {
      await send('approve', signer, async()=> token.approve.populateTransaction(stakingAddress, needDeposit), dry);
    } else {
      console.log('approve: skipped');
    }
    await send('deposit', signer, async()=> staking["deposit(uint256)"].populateTransaction(needDeposit), dry);
  } else {
    console.log('deposit: skipped (target met)');
  }

  const acct1 = await staking.getAccount(user);

  // Stake
  const desiredStake = pctOf(acct1.deposited, stakePct);
  const avail = acct1.deposited - acct1.staked;
  const stakeDeficit = desiredStake > acct1.staked ? desiredStake - acct1.staked : 0n;
  const toStake = stakeDeficit > avail ? avail : stakeDeficit;
  if (toStake > 0n) {
    await send('stake', signer, async()=> staking.stake.populateTransaction(toStake), dry);
  } else {
    console.log('stake: skipped');
  }

  // Emission accrual sampling at ~15s intervals (max 3 samples)
  if (waitSeconds > 0) {
    const sampleTargets = [15,30,45].filter(t=> t <= waitSeconds);
    const start = Date.now();
    for (const t of sampleTargets) {
      const remaining = t - Math.floor((Date.now()-start)/1000);
      if (remaining > 0) await sleep(remaining * 1000);
      const pending = await staking.pendingRewards(user);
      console.log(`emission t+${t}s pending=${pending}`);
    }
  }

  // Claim emission rewards
  if (waitSeconds > 0) {
    const pend = await staking.pendingRewards(user);
    if (pend > 0n) {
      await send('claim', signer, async()=> staking["withdraw(uint256,bool)"].populateTransaction(0, true), dry);
    } else {
      console.log('claim: skipped (none)');
    }
  }

  // APR withdraw
  if (aprPct > 0) {
    const acct2 = await staking.getAccount(user);
    if (acct2.staked > 0n) {
      const aprAmt = pctOf(acct2.staked, aprPct);
      if (aprAmt > 0n) {
        await send('aprWithdraw', signer, async()=> staking["withdraw(uint256)"].populateTransaction(aprAmt), dry);
      } else {
        console.log('aprWithdraw: skipped (amount 0)');
      }
    } else {
      console.log('aprWithdraw: skipped (no staked)');
    }
  } else {
    console.log('aprWithdraw: disabled');
  }

  const finalAcct = await staking.getAccount(user);
  const finalPending = await staking.pendingRewards(user);
  console.log(`final deposited=${finalAcct.deposited} staked=${finalAcct.staked} rewardsAccrued=${finalAcct.rewardsAccrued} pending=${finalPending}`);
  console.log('done');
}

main().catch(e=>{ console.error(e); process.exit(1); });
