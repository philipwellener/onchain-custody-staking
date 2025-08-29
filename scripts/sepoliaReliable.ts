import { ethers } from "hardhat";
import { TransactionRequest } from "ethers";

/*
 Resilient end-to-end staking flow with automatic gas bump & step controls.

 Env vars:
  STAKING_ADDRESS  (required)
  TOKEN_ADDRESS    (required)
  AMOUNT           (ether units, default 1)
  WAIT_SECONDS     (default 60)
  FORCE_APPROVE=1  force new approve even if allowance sufficient
  RESET_ALLOWANCE=1 reset allowance to 0 before approving
  AUTO_BUMP=1      enable automatic gas replacement if pending too long
  BUMP_INTERVAL_SECONDS=40  how long to wait before each bump
  BUMP_PERCENT=25  percent increase each bump
  MAX_BUMPS=5      maximum replacement attempts
  GAS_PRIORITY_GWEI / GAS_MAX_GWEI override initial gas
  STEPS=approve,deposit,stake,wait,claim,apr  (comma list to run subset; default all)
*/

const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));

interface SendOptions { label:string; build:()=>Promise<TransactionRequest>; }

async function buildGas() {
  const fd = await ethers.provider.getFeeData();
  const minPrio = ethers.parseUnits("2","gwei");
  const minMax = ethers.parseUnits("5","gwei");
  let priority = fd.maxPriorityFeePerGas || minPrio;
  let maxFee = fd.maxFeePerGas || minMax;
  if (process.env.ECONOMY === '1') {
    // Economy mode: baseFee + small tip (default 1 gwei) and 10% headroom
    const latest = await ethers.provider.getBlock('latest');
    const base = latest?.baseFeePerGas || maxFee;
    priority = ethers.parseUnits(process.env.ECONOMY_PRIORITY_GWEI || '1','gwei');
    // 10% headroom
    maxFee = base + (base / 10n) + priority;
    // Floor minimal values to avoid zero
    if (priority < 500_000_000n) priority = 500_000_000n; // 0.5 gwei safety
  }
  if (priority < minPrio) priority = minPrio;
  if (maxFee < minMax) maxFee = minMax;
  if (process.env.GAS_PRIORITY_GWEI) priority = ethers.parseUnits(process.env.GAS_PRIORITY_GWEI, "gwei");
  if (process.env.GAS_MAX_GWEI) maxFee = ethers.parseUnits(process.env.GAS_MAX_GWEI, "gwei");
  if (maxFee <= priority) maxFee = priority + ethers.parseUnits("1","gwei");
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
}

async function sendWithBump(signer: any, opts: SendOptions) {
  const auto = process.env.AUTO_BUMP === '1';
  const bumpInterval = parseInt(process.env.BUMP_INTERVAL_SECONDS || '40',10);
  const bumpPct = BigInt(parseInt(process.env.BUMP_PERCENT || '25',10));
  const maxBumps = parseInt(process.env.MAX_BUMPS || '5',10);

  let overrides = await buildGas();
  let txReq = await opts.build();
  if (!txReq.gasLimit) {
    try { txReq.gasLimit = (await signer.estimateGas({ ...txReq, ...overrides })) * 120n / 100n; } catch { /* ignore */ }
  }
  let nonce = txReq.nonce ?? await signer.getNonce();
  txReq = { ...txReq, ...overrides, nonce };
  let attempt = 0;
  let sent = await signer.sendTransaction(txReq);
  console.log(`[${opts.label}] sent nonce=${nonce} hash=${sent.hash} fee(gwei)`, {
    maxFee: Number(sent.maxFeePerGas)/1e9, maxPrio: Number(sent.maxPriorityFeePerGas)/1e9,
  });
  const start = Date.now();
  while (true) {
    const r = await ethers.provider.getTransactionReceipt(sent.hash);
    if (r) {
      console.log(`[${opts.label}] mined block=${r.blockNumber} gasUsed=${r.gasUsed?.toString()}`);
      return r;
    }
    const elapsed = (Date.now() - start)/1000;
    if (!auto) { await sleep(5000); continue; }
    if (elapsed >= bumpInterval * (attempt+1) && attempt < maxBumps) {
      attempt++;
      // Build higher fee replacement
      const inc = (n:bigint)=> n + (n * bumpPct)/100n + ethers.parseUnits("1","gwei");
      const curFee = sent.maxFeePerGas ?? overrides.maxFeePerGas!;
      const curPrio = sent.maxPriorityFeePerGas ?? overrides.maxPriorityFeePerGas!;
      const newMaxFee = inc(curFee);
      const newMaxPrio = inc(curPrio);
      console.log(`[${opts.label}] bump #${attempt}: new fees(gwei)`, { maxFee:Number(newMaxFee)/1e9, maxPrio:Number(newMaxPrio)/1e9 });
      const replReq = { ...txReq, maxFeePerGas: newMaxFee, maxPriorityFeePerGas: newMaxPrio, nonce };
      try {
        sent = await signer.sendTransaction(replReq);
        console.log(`[${opts.label}] replacement sent hash=${sent.hash}`);
      } catch (e:any) {
        console.log(`[${opts.label}] replacement failed:`, e.message || e);
      }
    }
    if (attempt >= maxBumps) {
      console.log(`[${opts.label}] max bumps reached; still pending. hash=${sent.hash}`);
    }
    await sleep(7000);
  }
}

async function main() {
  const stakingAddress = process.env.STAKING_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  if (!stakingAddress || !tokenAddress) throw new Error("Need STAKING_ADDRESS & TOKEN_ADDRESS");
  const amountEth = process.env.AMOUNT || '1';
  const waitSeconds = parseInt(process.env.WAIT_SECONDS || '60',10);
  const stepsRaw = (process.env.STEPS || 'approve,deposit,stake,wait,claim,apr').split(',').map(s=>s.trim());
  const runStep = (s:string)=> stepsRaw.includes(s);

  const staking = await ethers.getContractAt('InstitutionalStaking', stakingAddress);
  const token = await ethers.getContractAt('ERC20Mock', tokenAddress);
  const [signer] = await ethers.getSigners();
  const user = await signer.getAddress();
  const amount = ethers.parseEther(amountEth);
  console.log({ user, stakingAddress, tokenAddress, amount: amount.toString(), steps: stepsRaw });

  // Preflight gas cost estimation (rough) unless skipped
  if (process.env.SKIP_PREFLIGHT !== '1') {
    const balance = await ethers.provider.getBalance(user);
    const overrides = await buildGas();
    // Approximate gas per action (fallback constants used if estimation fails)
    const est = async (f:()=>Promise<bigint>, fallback: bigint)=>{ try { return await f(); } catch { return fallback; } };
    let totalGas = 0n;
    if (runStep('approve')) totalGas += await est(()=>signer.estimateGas({ to: tokenAddress, data: (token.interface.encodeFunctionData('approve',[stakingAddress, amount])) }), 60000n);
    if (runStep('deposit')) totalGas += await est(()=>signer.estimateGas({ to: stakingAddress, data: staking.interface.encodeFunctionData('deposit(uint256)',[amount]) }), 130000n);
    if (runStep('stake')) totalGas += await est(()=>signer.estimateGas({ to: stakingAddress, data: staking.interface.encodeFunctionData('stake',[amount]) }), 120000n);
    if (runStep('claim')) totalGas += 90000n; // withdraw(0,true) rough
    if (runStep('apr')) totalGas += 170000n;  // APR withdraw rough
    const maxFee = overrides.maxFeePerGas || 0n;
    const worstCaseCost = totalGas * maxFee;
    console.log('[preflight] balance wei=', balance.toString(), 'approxTotalGas=', totalGas.toString(), 'maxFeePerGas=', maxFee.toString(), 'worstCaseCost=', worstCaseCost.toString());
    if (balance < worstCaseCost) {
      console.log('[preflight] WARNING: Potential insufficient ETH for all selected steps. Consider funding account or reducing steps (e.g. STEPS=approve,deposit,stake). Set SKIP_PREFLIGHT=1 to bypass this check.');
    }
  }

  // Approve
  if (runStep('approve')) {
    const allowance: bigint = await token.allowance(user, stakingAddress);
    const force = process.env.FORCE_APPROVE==='1';
    const reset = process.env.RESET_ALLOWANCE==='1';
    if ((allowance < amount) || force) {
      if (reset && allowance>0n) {
        console.log('Reset allowance to 0');
        await sendWithBump(signer, { label:'approveReset0', build: async()=>{
          return await token.approve.populateTransaction(stakingAddress, 0n);
        }});
      }
      console.log('Approving new allowance');
      await sendWithBump(signer, { label:'approve', build: async()=>{
        return await token.approve.populateTransaction(stakingAddress, amount);
      }});
    } else {
      console.log('Approve skipped; allowance sufficient');
    }
  }

  // Deposit
  if (runStep('deposit')) {
    await sendWithBump(signer, { label:'deposit', build: async()=>{
      // overload
      return await staking["deposit(uint256)"].populateTransaction(amount);
    }});
  }

  // Stake
  if (runStep('stake')) {
    await sendWithBump(signer, { label:'stake', build: async()=>{
      return await staking.stake.populateTransaction(amount);
    }});
  }

  // Wait for rewards
  if (runStep('wait')) {
    console.log(`Waiting ${waitSeconds}s for rewards...`);
    const start = Date.now();
    let last = 0;
    while ((Date.now()-start)/1000 < waitSeconds) {
      await sleep(5000);
      const el = Math.floor((Date.now()-start)/1000);
      if (el - last >= 15 || el===waitSeconds) {
        last = el;
        const pending: bigint = await staking.pendingRewards(user);
        console.log(`t+${el}s pending=${pending.toString()}`);
      }
    }
  }

  // Claim emission rewards
  if (runStep('claim')) {
    await sendWithBump(signer, { label:'claim', build: async()=>{
      return await staking["withdraw(uint256,bool)"].populateTransaction(0, true);
    }});
  }

  // APR withdraw half
  if (runStep('apr')) {
    const acct = await staking.getAccount(user);
    if (acct.staked > 0n) {
      const half = acct.staked / 2n;
      if (half > 0n) {
        await sendWithBump(signer, { label:'aprWithdrawHalf', build: async()=>{
          return await staking["withdraw(uint256)"].populateTransaction(half);
        }});
      }
    }
  }

  const acctFinal = await staking.getAccount(user);
  console.log('Final account', {
    deposited: acctFinal.deposited.toString(),
    staked: acctFinal.staked.toString(),
    rewardsAccrued: acctFinal.rewardsAccrued.toString(),
    lastUpdate: acctFinal.lastUpdate.toString(),
    stakeStart: acctFinal.stakeStart.toString(),
    rewardRemainder: acctFinal.rewardRemainder.toString()
  });
  const bal = await token.balanceOf(user);
  console.log('User token balance', bal.toString());
}

main().catch(e=>{ console.error(e); process.exit(1); });
