import { ethers } from "hardhat";

/*
 readOnlyReport.ts

 Purpose: Produce a concise, read-only snapshot of the staking system state for demo/reporting.
 No transactions are sent; only eth_call is performed.

 Environment:
  STAKING_ADDRESS (required)
  TOKEN_ADDRESS   (required)
  ADDRESS         (optional) - user address to inspect; defaults to first signer

 Output sections:
  - Network / Block info
  - Contract addresses
  - Global staking stats (totalStaked, rewardRate)
  - Account (deposited, staked, rewardsAccrued, stakeStart, lastUpdate, rewardRemainder)
  - Emission rewards (pendingRewards + detailed breakdown with remainder)
  - Balances (user token balance, contract token balance)

 All numeric fields are shown as both raw wei (string) and human ether units (if relevant).
*/

function fmt(big: bigint | number | string, decimals = 18) {
  try {
    const b = BigInt(big.toString());
    return {
      raw: b.toString(),
      ether: Number(b) === 0 ? '0' : Number(Number(b) / 1e18).toString()
    };
  } catch {
    return { raw: String(big), ether: 'n/a' };
  }
}

async function main() {
  const stakingAddress = process.env.STAKING_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  if (!stakingAddress || !tokenAddress) throw new Error('Need STAKING_ADDRESS & TOKEN_ADDRESS');
  const isValid = (a:string)=> /^0x[0-9a-fA-F]{40}$/.test(a);
  if (!isValid(stakingAddress) || !isValid(tokenAddress)) throw new Error('Invalid address format supplied.');

  const [defaultSigner] = await ethers.getSigners();
  const target = process.env.ADDRESS || await defaultSigner.getAddress();

  const staking = await ethers.getContractAt('InstitutionalStaking', stakingAddress);
  const token = await ethers.getContractAt('ERC20Mock', tokenAddress);

  const network = await ethers.provider.getNetwork();
  const block = await ethers.provider.getBlock('latest');

  const rewardRate: bigint = await staking.rewardRate();
  const totalStaked: bigint = await staking.totalStaked();
  const acct = await staking.getAccount(target);
  const pending: bigint = await staking.pendingRewards(target);
  const detailed = await staking.pendingRewardsDetailed(target);
  const userBal: bigint = await token.balanceOf(target);
  const contractBal: bigint = await token.balanceOf(stakingAddress);

  console.log('--- Staking Read-Only Report ---');
  console.log('network', { name: network.name, chainId: network.chainId });
  console.log('block', { number: block?.number, timestamp: block?.timestamp });
  console.log('contracts', { staking: stakingAddress, token: tokenAddress });
  console.log('global', { totalStaked: fmt(totalStaked), rewardRate: fmt(rewardRate) });
  console.log('accountRaw', {
    address: target,
    deposited: acct.deposited.toString(),
    staked: acct.staked.toString(),
    rewardsAccrued: acct.rewardsAccrued.toString(),
    lastUpdate: acct.lastUpdate.toString(),
    stakeStart: acct.stakeStart.toString(),
    rewardRemainder: acct.rewardRemainder?.toString?.() || '0'
  });
  console.log('account', {
    deposited: fmt(acct.deposited),
    staked: fmt(acct.staked),
    rewardsAccrued: fmt(acct.rewardsAccrued),
    lastUpdate: acct.lastUpdate,
    stakeStart: acct.stakeStart,
    rewardRemainder: fmt(acct.rewardRemainder || 0n)
  });
  console.log('emission', {
    pending: fmt(pending),
    detailed: {
      totalClaimable: fmt(detailed[0]),
      newPortion: fmt(detailed[1]),
      remainder: fmt(detailed[2])
    }
  });
  console.log('balances', {
    userToken: fmt(userBal),
    contractToken: fmt(contractBal)
  });
  console.log('--- End Report ---');
}

main().catch(e=>{ console.error(e); process.exit(1); });
