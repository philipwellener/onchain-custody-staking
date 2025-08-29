import { ethers } from "hardhat";
import { TransactionRequest } from "ethers";

/*
 fullEtherscanShowcase.ts

 Goal: Emit ONE on-chain transaction for every distinct externally callable action
 so they can all be showcased on Etherscan. Covers:
  - approve (ERC20)
  - deposit(uint256)
  - deposit(address,uint256)  (generic deposit of an alternate token) *optional*
  - stake(uint256)
  - withdraw(uint256,bool) principal-only (claimRewards=false)
  - withdraw(0,bool) emission claim (claimRewards=true)
  - withdraw(uint256) annual-rate withdraw (APR path)
  - unstake(uint256)
  - setRewardRate(uint256) (admin only)
  - pause() & unpause()

 Sequence keeps balances consistent and gas minimal.

 Env Vars:
  STAKING_ADDRESS  (required)
  TOKEN_ADDRESS    (required) main staking token
  ALT_TOKEN_ADDRESS (optional) token for generic deposit; if omitted action skipped
  DEPOSIT_AMOUNT   (default 1) main token amount to deposit (ether units)
  STAKE_PERCENT    (default 60) percent of post-deposit balance to stake
  IDLE_WITHDRAW_PERCENT   (default 20) percent of idle (unstaked) principal to withdraw (principal-only)
  ANNUAL_WITHDRAW_PERCENT (default 25) percent of staked (after claim) to withdraw via annual-rate path
  WAIT_SECONDS     (default 18) seconds to accrue emission rewards before claim
  ECONOMY=1        enable economical gas calculation
  SHOW_ONLY=1      dry run (no sends)
  TIGHT_GAS=1      tighter gasLimit multiplier (est * 1.05)
  GAS_BUDGET_ETH   cap estimated max (gasLimit * maxFeePerGas)

 Output: Each action logs label, tx hash, and a ready Etherscan URL.

 NOTE: setRewardRate increments rewardRate by +1 (minimal) to produce event, then does NOT revert to original
 to keep action history simple. Adjust if you want revert.
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
    const mult = parseFloat(process.env.ECONOMY_MULTIPLIER || '1.12');
    const scaled = (base * BigInt(Math.round(mult * 1000))) / 1000n;
    maxFee = scaled + priority;
    if (priority < 500_000_000n) priority = 500_000_000n;
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
      req.gasLimit = (estBig * BigInt(tight ? 105 : 125)) / 100n;
    } catch {}
  } else if (tight) {
    const gl = BigInt(req.gasLimit.toString());
    req.gasLimit = (gl * 105n)/100n;
  }
  // Budget scaling (simple)
  const budgetEth = process.env.GAS_BUDGET_ETH ? parseFloat(process.env.GAS_BUDGET_ETH) : undefined;
  if (budgetEth && req.gasLimit) {
    const budgetWei = ethers.parseEther(budgetEth.toString());
    const gl = BigInt(req.gasLimit.toString());
    const maxCost = gl * fees.maxFeePerGas;
    if (maxCost > budgetWei) {
      const newMaxFee = budgetWei / gl;
      if (newMaxFee > fees.maxPriorityFeePerGas + ethers.parseUnits('1','gwei')) {
        req.maxFeePerGas = newMaxFee;
      }
    }
  }
  if (dry) {
    console.log(`${label}: DRY gasLimit=${req.gasLimit?.toString()} maxFeeGwei=${req.maxFeePerGas ? Number(req.maxFeePerGas)/1e9 : 'n/a'}`);
    return { hash: '0xDRY' };
  }
  const tx = await signer.sendTransaction(req);
  const url = `https://sepolia.etherscan.io/tx/${tx.hash}`;
  console.log(`${label}: sent ${tx.hash} (${url})`);
  const r = await tx.wait();
  console.log(`${label}: mined block=${r?.blockNumber} gasUsed=${r?.gasUsed}`);
  return r;
}

// Percentage helper: accepts number or bigint for flexibility, coerces to bigint safely
const pctOf = (v: bigint | number, p: bigint | number): bigint => {
  const vb = typeof v === 'bigint' ? v : BigInt(v);
  const pb = typeof p === 'bigint' ? p : BigInt(p);
  return (vb * pb) / 100n;
};

async function main() {
  const stakingAddress = process.env.STAKING_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  if (!stakingAddress || !tokenAddress) throw new Error('Need STAKING_ADDRESS & TOKEN_ADDRESS');
  const isAddress = (a:string)=> /^0x[0-9a-fA-F]{40}$/.test(a);
  if (!isAddress(stakingAddress)) throw new Error('Bad STAKING_ADDRESS');
  if (!isAddress(tokenAddress)) throw new Error('Bad TOKEN_ADDRESS');
  const altAddress = process.env.ALT_TOKEN_ADDRESS;
  if (altAddress && !isAddress(altAddress)) throw new Error('Bad ALT_TOKEN_ADDRESS');
  const depositEth = process.env.DEPOSIT_AMOUNT || '1';
  const stakePct = parseInt(process.env.STAKE_PERCENT || '60',10);
  const idleWithdrawPct = parseInt(process.env.IDLE_WITHDRAW_PERCENT || '20',10);
  const annualWithdrawPct = parseInt(process.env.ANNUAL_WITHDRAW_PERCENT || '25',10);
  const waitSeconds = parseInt(process.env.WAIT_SECONDS || '18',10);
  const dry = process.env.SHOW_ONLY === '1';

  const [signer] = await ethers.getSigners();
  const user = await signer.getAddress();
  const staking = await ethers.getContractAt('InstitutionalStaking', stakingAddress);
  const token = await ethers.getContractAt('ERC20Mock', tokenAddress);
  const altToken = altAddress ? await ethers.getContractAt('ERC20Mock', altAddress) : null;

  const targetDeposit = ethers.parseEther(depositEth);
  const acct0 = await staking.getAccount(user);
  const allowance: bigint = await token.allowance(user, stakingAddress);

  console.log(`user=${user} deposit=${depositEth} stake%=${stakePct} idleWithdraw%=${idleWithdrawPct} annualWithdraw%=${annualWithdrawPct} wait=${waitSeconds}s dry=${dry}`);

  // 1. approve (if needed)
  if (allowance < targetDeposit) {
    await send('approve', signer, async()=> token.approve.populateTransaction(stakingAddress, targetDeposit), dry);
  } else {
    console.log('approve: skipped (sufficient)');
  }

  // 2. deposit(uint256)
  if (acct0.deposited < targetDeposit) {
    const need = targetDeposit - acct0.deposited;
    await send('deposit', signer, async()=> staking["deposit(uint256)"].populateTransaction(need), dry);
  } else {
    console.log('deposit: skipped (met)');
  }

  // 3. deposit(address,uint256) generic (optional)
  if (altToken) {
    const altAllowance: bigint = await altToken.allowance(user, stakingAddress);
    const altAmount = ethers.parseEther('0.1');
    if (altAllowance < altAmount) {
      await send('altApprove', signer, async()=> altToken.approve.populateTransaction(stakingAddress, altAmount), dry);
    }
    await send('genericDeposit', signer, async()=> staking["deposit(address,uint256)"].populateTransaction(altAddress, altAmount), dry);
  } else {
    console.log('genericDeposit: skipped (no ALT_TOKEN_ADDRESS)');
  }

  // Refresh
  const acct1 = await staking.getAccount(user);

  // 4. stake(uint256)
  const desiredStake = pctOf(acct1.deposited, BigInt(stakePct));
  const toStake = desiredStake > acct1.staked ? desiredStake - acct1.staked : 0n;
  if (toStake > 0n) {
    await send('stake', signer, async()=> staking.stake.populateTransaction(toStake), dry);
  } else {
    console.log('stake: skipped');
  }

  // 5. wait for emission accrual
  if (waitSeconds > 0) {
    console.log(`waiting ${waitSeconds}s for emission accrual...`);
    await sleep(waitSeconds * 1000);
    const pending = await staking.pendingRewards(user);
    console.log(`emission pending=${pending}`);
  }

  // 6. withdraw principal-only (withdraw(uint256,bool) claimRewards=false)
  const acct2 = await staking.getAccount(user);
  const idle = acct2.deposited - acct2.staked;
  const principalPortion = pctOf(idle, BigInt(idleWithdrawPct));
  if (principalPortion > 0n) {
    await send('withdrawPrincipalOnly', signer, async()=> staking["withdraw(uint256,bool)"].populateTransaction(principalPortion, false), dry);
  } else {
    console.log('withdrawPrincipalOnly: skipped (idle 0)');
  }

  // 7. claim emission rewards (withdraw(0,true))
  const pendingBeforeClaim = await staking.pendingRewards(user);
  if (pendingBeforeClaim > 0n) {
    if (!dry && process.env.AUTO_FUND === '1') {
      // Ensure staking contract has enough tokens to cover rewards payout
      const stakingBal: bigint = await token.balanceOf(stakingAddress);
      // Rough principal still owed is acct2.deposited (includes staked + idle after principal withdraw)
      // We just need enough liquid tokens to cover rewards transfer; principal backing remains.
      if (stakingBal < pendingBeforeClaim + acct2.deposited) {
        const shortfall = (pendingBeforeClaim + acct2.deposited) - stakingBal;
        const topUp = (shortfall * 101n) / 100n; // +1% buffer
        console.log(`AUTO_FUND minting shortfall topUp=${topUp}`);
        await send('mintRewardsBuffer', signer, async()=> token.mint.populateTransaction(stakingAddress, topUp), false);
      }
    }
    try {
      await send('claimEmission', signer, async()=> staking["withdraw(uint256,bool)"].populateTransaction(0, true), dry);
    } catch (e:any) {
      console.error('claimEmission: failed (likely insufficient reward funding). Consider lowering REWARD_RATE or enable AUTO_FUND=1 with mint-capable token.');
      throw e;
    }
  } else {
    console.log('claimEmission: skipped (none)');
  }

  // 8. annual-rate withdraw(uint256)
  const acct3 = await staking.getAccount(user);
  if (acct3.staked > 0n) {
  const annualAmt = pctOf(acct3.staked, BigInt(annualWithdrawPct));
    if (annualAmt > 0n) {
      await send('annualWithdraw', signer, async()=> staking["withdraw(uint256)"].populateTransaction(annualAmt), dry);
    } else {
      console.log('annualWithdraw: skipped (0)');
    }
  } else {
    console.log('annualWithdraw: skipped (no staked)');
  }

  // 9. unstake remaining
  const acct4 = await staking.getAccount(user);
  if (acct4.staked > 0n) {
    await send('unstakeAll', signer, async()=> staking.unstake.populateTransaction(acct4.staked), dry);
  } else {
    console.log('unstakeAll: skipped (none)');
  }

  // 10. setRewardRate (admin)
  const currentRate: bigint = await staking.rewardRate();
  const newRate = currentRate + 1n; // minimal increment
  await send('setRewardRate', signer, async()=> staking.setRewardRate.populateTransaction(newRate), dry);

  // 11. pause()
  await send('pause', signer, async()=> staking.pause.populateTransaction(), dry);
  // 12. unpause()
  await send('unpause', signer, async()=> staking.unpause.populateTransaction(), dry);

  // 13. (optional) grant & revoke a role to showcase AccessControl events
  // Enable by setting INCLUDE_ROLES=1; creates a fresh throwaway address to grant ADMIN_ROLE, then revokes it.
  if (process.env.INCLUDE_ROLES === '1') {
    const adminRole = await staking.ADMIN_ROLE();
    const temp = ethers.Wallet.createRandom();
    console.log(`roleShowcase temp=${temp.address}`);
    await send('grantAdminRole', signer, async()=> staking.grantRole.populateTransaction(adminRole, temp.address), dry);
    await send('revokeAdminRole', signer, async()=> staking.revokeRole.populateTransaction(adminRole, temp.address), dry);
  } else {
    console.log('roleShowcase: skipped (INCLUDE_ROLES!=1)');
  }

  // Final summary
  const finalAcct = await staking.getAccount(user);
  const finalPend = await staking.pendingRewards(user);
  console.log(`FINAL deposited=${finalAcct.deposited} staked=${finalAcct.staked} rewardsAccrued=${finalAcct.rewardsAccrued} pending=${finalPend}`);
  console.log('Showcase complete');
}

main().catch(e=>{ console.error(e); process.exit(1); });
