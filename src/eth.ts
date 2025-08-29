import { ethers } from "ethers";
import * as dotenv from "dotenv";
import { InstitutionalStaking__factory, ERC20Mock__factory } from "../typechain-types";

dotenv.config();

const rpcUrl = process.env.RPC_URL;
if (!rpcUrl) throw new Error("RPC_URL not set");

export const provider = new ethers.JsonRpcProvider(rpcUrl, Number(process.env.CHAIN_ID) || undefined);

const pk = process.env.PRIVATE_KEY;
if (!pk) throw new Error("PRIVATE_KEY not set");
export const signer = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);

const stakingAddress = process.env.STAKING_ADDRESS;
if (!stakingAddress) throw new Error("STAKING_ADDRESS not set");

const tokenAddress = process.env.TOKEN_ADDRESS; // optional for read endpoints

export const stakingContract = InstitutionalStaking__factory.connect(stakingAddress, signer);

export const tokenContract = tokenAddress ? ERC20Mock__factory.connect(tokenAddress, signer) : undefined;

export async function getAccountComposite(address: string) {
  const acct = await stakingContract.getAccount(address);
  const pending: bigint = await stakingContract.pendingRewards(address);
  return {
    address,
    deposited: acct.deposited as bigint,
    staked: acct.staked as bigint,
    rewardsAccrued: acct.rewardsAccrued as bigint,
    pendingRewards: pending,
    stakeStart: acct.stakeStart as bigint
  };
}
