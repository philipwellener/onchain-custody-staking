import express, { Request, Response } from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import { ethers } from 'ethers';
import { stakingContract, tokenContract, signer, getAccountComposite } from './eth';
import { ERC20Mock__factory } from '../typechain-types';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Simple health check
app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

// GET /balance/:address -> { deposited, staked, rewards }
// rewards = current pending emission-based rewards at this block timestamp
app.get('/balance/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    if (!ethers.isAddress(address)) return res.status(400).json({ error: 'Invalid address' });
    const acct = await stakingContract.getAccount(address);
    const pending: bigint = await stakingContract.pendingRewards(address);
    res.json({
      deposited: (acct.deposited as bigint).toString(),
      staked: (acct.staked as bigint).toString(),
      rewards: pending.toString()
    });
  } catch (err: any) {
    console.error('GET /balance error', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// POST /deposit { amount } or { amount, tokenAddress }
app.post('/deposit', async (req: Request, res: Response) => {
  try {
    const { address, tokenAddress, amount } = req.body || {};
    if (!address) return res.status(400).json({ error: 'address required' });
    if (!ethers.isAddress(address)) return res.status(400).json({ error: 'Invalid address' });
    if (!amount) return res.status(400).json({ error: 'amount required' });
    // Server signs tx; ensure caller intends to use server signer
    if (address.toLowerCase() !== signer.address.toLowerCase()) {
      return res.status(400).json({ error: 'address must match server signer' });
    }
    let bnAmount: bigint;
    try { bnAmount = BigInt(amount); } catch { return res.status(400).json({ error: 'amount must be bigint-compatible string' }); }
    if (bnAmount <= 0n) return res.status(400).json({ error: 'amount must be > 0' });
    let tx;
    if (tokenAddress) {
      if (!ethers.isAddress(tokenAddress)) return res.status(400).json({ error: 'Invalid tokenAddress' });
      tx = await stakingContract["deposit(address,uint256)"](tokenAddress, bnAmount);
    } else {
      tx = await stakingContract["deposit(uint256)"](bnAmount);
    }
    const receipt = await tx.wait();
    res.json({ hash: tx.hash, status: receipt?.status });
  } catch (err: any) {
    console.error('POST /deposit error', err);
    res.status(500).json({ error: parseEthersError(err) });
  }
});

// POST /stake { amount }
app.post('/stake', async (req: Request, res: Response) => {
  try {
    const { address, tokenAddress, amount } = req.body || {};
    if (!address) return res.status(400).json({ error: 'address required' });
    if (!ethers.isAddress(address)) return res.status(400).json({ error: 'Invalid address' });
    if (!amount) return res.status(400).json({ error: 'amount required' });
    if (address.toLowerCase() !== signer.address.toLowerCase()) {
      return res.status(400).json({ error: 'address must match server signer' });
    }
    let bnAmount: bigint;
    try { bnAmount = BigInt(amount); } catch { return res.status(400).json({ error: 'amount must be bigint-compatible string' }); }
    if (bnAmount <= 0n) return res.status(400).json({ error: 'amount must be > 0' });
    // tokenAddress is accepted for interface consistency but not used (stake acts on already deposited principal)
    const tx = await stakingContract.stake(bnAmount);
    const receipt = await tx.wait();
    res.json({ hash: tx.hash, status: receipt?.status });
  } catch (err: any) {
    console.error('POST /stake error', err);
    res.status(500).json({ error: parseEthersError(err) });
  }
});

// POST /withdraw { address, tokenAddress, amount }
// Implements staked principal + APR rewards withdrawal using withdraw(uint256) overload.
// Returns tx hash, withdrawn principal amount, and reward amount.
app.post('/withdraw', async (req: Request, res: Response) => {
  try {
    const { address, tokenAddress, amount } = req.body || {};
    if (!address) return res.status(400).json({ error: 'address required' });
    if (!ethers.isAddress(address)) return res.status(400).json({ error: 'Invalid address' });
    if (address.toLowerCase() !== signer.address.toLowerCase()) {
      return res.status(400).json({ error: 'address must match server signer' });
    }
    if (amount === undefined) return res.status(400).json({ error: 'amount required' });
    let bnAmount: bigint;
    try { bnAmount = BigInt(amount); } catch { return res.status(400).json({ error: 'amount must be bigint-compatible string' }); }
    if (bnAmount <= 0n) return res.status(400).json({ error: 'amount must be > 0' });

    // Determine ERC20 token contract used for balance diff (prefer provided tokenAddress, else env tokenContract, else staking STAKING_TOKEN)
    let token = tokenContract;
    let tokenAddr = tokenAddress;
    if (tokenAddress && !ethers.isAddress(tokenAddress)) return res.status(400).json({ error: 'Invalid tokenAddress' });
    if (!token) {
      if (!tokenAddr) tokenAddr = await stakingContract.STAKING_TOKEN();
  token = ERC20Mock__factory.connect(tokenAddr, signer);
    } else if (tokenAddress && tokenAddress.toLowerCase() !== (await token.getAddress()).toLowerCase()) {
      // Override with requested token
  token = ERC20Mock__factory.connect(tokenAddress, signer);
    }

    const balBefore: bigint = await token.balanceOf(address);
    const tx = await stakingContract["withdraw(uint256)"](bnAmount);
    const receipt = await tx.wait();
    const balAfter: bigint = await token.balanceOf(address);
    const totalOut = balAfter - balBefore;
    const rewards = totalOut > bnAmount ? totalOut - bnAmount : 0n;
    res.json({ hash: tx.hash, status: receipt?.status, withdrawn: bnAmount.toString(), rewards: rewards.toString() });
  } catch (err: any) {
    console.error('POST /withdraw error', err);
    res.status(500).json({ error: parseEthersError(err) });
  }
});

function parseEthersError(err: any): string {
  if (err?.error?.message) return err.error.message;
  if (err?.reason) return err.reason;
  if (err?.message) return err.message;
  return 'Transaction failed';
}

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
  console.log(`Signer: ${signer.address}`);
});
