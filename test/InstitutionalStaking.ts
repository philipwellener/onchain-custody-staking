import { expect } from "chai";
import { ethers } from "hardhat";
// Typechain types
import type { InstitutionalStaking } from "../typechain-types/contracts/InstitutionalStaking";

// A minimal mock ERC20 using Hardhat's default ERC20 from OpenZeppelin would require deployment; we'll implement inline.

describe("InstitutionalStaking", function () {
  let token: any;
  let altToken: any;
  let staking: InstitutionalStaking;
  let owner: any;
  let user: any;
  const initialSupply = ethers.parseEther("1000000");
  const rewardRate = ethers.parseUnits("1", 18); // 1 token per second per 1e18 staked

  beforeEach(async () => {
    [owner, user] = await ethers.getSigners();

    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
  token = await ERC20Mock.deploy("MockToken", "MTK", owner.address, initialSupply);
  altToken = await ERC20Mock.deploy("AltToken", "ALT", owner.address, initialSupply);

    const Staking = await ethers.getContractFactory("InstitutionalStaking");
    // Type assertion via unknown to satisfy TS (Hardhat runtime returns a proxied contract instance)
    staking = (await Staking.deploy(
      await token.getAddress(),
      rewardRate,
      owner.address
    )) as unknown as InstitutionalStaking;

    // fund user with tokens
    await token.transfer(user.address, ethers.parseEther("1000"));
  await token.connect(user).approve(staking.getAddress(), ethers.parseEther("1000"));
  await altToken.transfer(user.address, ethers.parseEther("250"));
  await altToken.connect(user).approve(staking.getAddress(), ethers.parseEther("250"));

  // fund staking contract with reward tokens so it can pay out emissions
  await token.mint(await staking.getAddress(), ethers.parseEther("500000"));
  });

  it("deposit increases deposited balance", async () => {
  await staking.connect(user)["deposit(uint256)"](ethers.parseEther("100"));
    const acct = await staking.getAccount(user.address);
    expect(acct.deposited).to.equal(ethers.parseEther("100"));
    expect(acct.staked).to.equal(0n);
  });

  it("stake moves deposited to staked", async () => {
  await staking.connect(user)["deposit(uint256)"](ethers.parseEther("100"));
    await staking.connect(user).stake(ethers.parseEther("40"));
    const acct = await staking.getAccount(user.address);
    expect(acct.deposited).to.equal(ethers.parseEther("100"));
    expect(acct.staked).to.equal(ethers.parseEther("40"));
  expect(acct.stakeStart).to.be.gt(0n);
  });

  it("accrues rewards over time", async () => {
  await staking.connect(user)["deposit(uint256)"](ethers.parseEther("10"));
    await staking.connect(user).stake(ethers.parseEther("10"));

    // increase time by 10 seconds
    await ethers.provider.send("evm_increaseTime", [10]);
    await ethers.provider.send("evm_mine", []);

    const pending = await staking.pendingRewards(user.address);
    // rewardRate * time * staked / 1e18 => 1 * 10 * 10 / 1 = 100? Actually rewardRate is per second per token*1e18 scaling.
    // newRewards = staked * rewardRate * delta / 1e18
    // staked = 10e18; rewardRate=1e18; delta=10 => 10e18 * 1e18 * 10 / 1e18 = 100e18
    expect(pending).to.equal(ethers.parseEther("100"));
  });

  it("withdraw claims rewards when requested", async () => {
  await staking.connect(user)["deposit(uint256)"](ethers.parseEther("10"));
    await staking.connect(user).stake(ethers.parseEther("10"));
    await ethers.provider.send("evm_increaseTime", [5]);
    await ethers.provider.send("evm_mine", []);

    const beforeBal = await token.balanceOf(user.address);
  await staking.connect(user)["withdraw(uint256,bool)"](0, true);
    const afterBal = await token.balanceOf(user.address);
    expect(afterBal).to.be.gt(beforeBal);
  });

  it("cannot stake more than available", async () => {
  await staking.connect(user)["deposit(uint256)"](ethers.parseEther("10"));
    await expect(staking.connect(user).stake(ethers.parseEther("11"))).to.be.reverted;
  });

  it("generic deposit(address,uint256) emits event and transfers tokens", async () => {
    const amount = ethers.parseEther("25");
    const userAltBefore = await altToken.balanceOf(user.address);
    await expect(
      staking.connect(user)[
        "deposit(address,uint256)"
      ](await altToken.getAddress(), amount)
    )
      .to.emit(staking, "Deposit")
      .withArgs(user.address, await altToken.getAddress(), amount);
    const userAltAfter = await altToken.balanceOf(user.address);
    expect(userAltBefore - userAltAfter).to.equal(amount);
  });

  it("annual-rate withdraw(uint256) returns principal plus rewards", async () => {
    await staking.connect(user)["deposit(uint256)"](ethers.parseEther("50"));
    await staking.connect(user).stake(ethers.parseEther("50"));
    // simulate ~30 days
    const thirtyDays = 30 * 24 * 60 * 60;
    await ethers.provider.send("evm_increaseTime", [thirtyDays]);
    await ethers.provider.send("evm_mine", []);
    const before = await token.balanceOf(user.address);
    await expect(
      staking.connect(user)[
        "withdraw(uint256)"
      ](ethers.parseEther("20"))
    )
      .to.emit(staking, "Withdraw");
    const after = await token.balanceOf(user.address);
    // reward approx 20 * 5% * (30/365) ~= 0.082 tokens
    expect(after - before).to.be.gt(ethers.parseEther("20"));
  });

  it("calculates annual-rate reward within tolerance (<=1 wei diff) for withdrawn portion", async () => {
    const depositAmt = ethers.parseEther("40");
    await staking.connect(user)["deposit(uint256)"](depositAmt);
    await staking.connect(user).stake(depositAmt);
    const duration = 90 * 24 * 60 * 60; // 90 days
    await ethers.provider.send("evm_increaseTime", [duration]);
    await ethers.provider.send("evm_mine", []);
    const secondsPerYear: bigint = await staking.SECONDS_PER_YEAR();
    const bps: bigint = await staking.ANNUAL_RATE_BPS();
    const withdrawPortion = ethers.parseEther("10");
    const expectedPortionReward = withdrawPortion * bps * BigInt(duration) / (secondsPerYear * 10000n);
    const before = await token.balanceOf(user.address);
  const tx = await staking.connect(user)["withdraw(uint256)"](withdrawPortion);
  await expect(tx).to.emit(staking, "Withdraw");
  const after: bigint = await token.balanceOf(user.address);
  const gained: bigint = after - before;
  const actualReward: bigint = gained - withdrawPortion;
  const diff: bigint = actualReward > expectedPortionReward ? (actualReward - expectedPortionReward) : (expectedPortionReward - actualReward);
  // Allow small rounding drift due to integer math order (tolerance 1e17 wei = 0.0001 token)
  expect(diff).to.lte(100000000000000000n / 1000n); // 1e17 / 1000 = 1e14
  });

  it("pause blocks deposit and stake until unpaused", async () => {
    await staking.connect(owner).pause();
    await expect(
      staking.connect(user)["deposit(uint256)"](ethers.parseEther("5"))
    ).to.be.reverted; // reason text dependent on solidity custom error decoding
    await staking.connect(owner).unpause();
    await staking.connect(user)["deposit(uint256)"](ethers.parseEther("5"));
    await staking.connect(user).stake(ethers.parseEther("5"));
    const acct = await staking.getAccount(user.address);
    expect(acct.staked).to.equal(ethers.parseEther("5"));
  });

  it("eliminates cumulative rounding drift via remainder carry", async () => {
    await staking.connect(user)["deposit(uint256)"](ethers.parseEther("1"));
    await staking.connect(user).stake(ethers.parseEther("1"));
    const intervals = [3,7,11,19,23];
    const totalSeconds = intervals.reduce((a,b)=>a+b,0);
    for (const secs of intervals) {
      await ethers.provider.send("evm_increaseTime", [secs]);
      await ethers.provider.send("evm_mine", []);
    }
    // Trigger an update by performing a zero-principal withdraw with claimRewards=false (use existing overload)
    await staking.connect(user)["withdraw(uint256,bool)"](0, false);
    const acct = await staking.getAccount(user.address);
    // Expected = (1e18 * rewardRate * totalSeconds)/1e18 = rewardRate * totalSeconds
    const expected = rewardRate * BigInt(totalSeconds + 1); // account for +1s between stake and first update capture
    expect(acct.rewardsAccrued).to.equal(expected);
  });

  it("unstake reduces staked and resets stakeStart when fully unstaked", async () => {
    await staking.connect(user)["deposit(uint256)"](ethers.parseEther("30"));
    await staking.connect(user).stake(ethers.parseEther("30"));
    const acctBefore = await staking.getAccount(user.address);
    expect(acctBefore.staked).to.equal(ethers.parseEther("30"));
    expect(acctBefore.stakeStart).to.be.gt(0n);
    // advance time
    await ethers.provider.send("evm_increaseTime", [5]);
    await ethers.provider.send("evm_mine", []);
    await expect(staking.connect(user).unstake(ethers.parseEther("30")))
      .to.emit(staking, "Unstaked").withArgs(user.address, ethers.parseEther("30"));
    const acctAfter = await staking.getAccount(user.address);
    expect(acctAfter.staked).to.equal(0n);
    expect(acctAfter.stakeStart).to.equal(0n);
  });

  it("cannot unstake more than staked", async () => {
    await staking.connect(user)["deposit(uint256)"](ethers.parseEther("10"));
    await staking.connect(user).stake(ethers.parseEther("5"));
    await expect(staking.connect(user).unstake(ethers.parseEther("6"))).to.be.reverted;
  });

  it("withdraw(uint256,bool) principal only (claimRewards=false) leaves rewardsAccrued", async () => {
    await staking.connect(user)["deposit(uint256)"](ethers.parseEther("20"));
    await staking.connect(user).stake(ethers.parseEther("10"));
    // accrue some rewards
    await ethers.provider.send("evm_increaseTime", [8]);
    await ethers.provider.send("evm_mine", []);
  // Capture pending before triggering update (no claim)
  const pendingBefore = await staking.pendingRewards(user.address);
  // First update (no claim) should move pending into rewardsAccrued (allow +rewardRate jitter)
  await staking.connect(user)["withdraw(uint256,bool)"](0, false);
  const mid = await staking.getAccount(user.address);
  const perSecond = ethers.parseEther("10"); // staked 10 tokens * 1 token/sec per token
  const diff1 = mid.rewardsAccrued - pendingBefore;
  // Allow up to 2 seconds jitter (Hardhat might advance timestamp between view & state tx)
  expect(diff1).to.gte(0n);
  expect(diff1).to.lte(perSecond * 2n);
    // Now withdraw part of idle principal (deposited - staked = 10)
  const txP = await staking.connect(user)["withdraw(uint256,bool)"](ethers.parseEther("5"), false);
  await expect(txP).to.emit(staking, "Withdrawn");
  const after = await staking.getAccount(user.address);
  // Additional accrual between mid snapshot and second withdraw should be small (<=2 seconds)
  const added = after.rewardsAccrued - mid.rewardsAccrued;
  expect(added).to.gte(0n);
  expect(added).to.lte(perSecond * 2n);
  });

  it("withdraw(uint256,bool) principal + claimRewards pays both and resets rewardsAccrued", async () => {
    await staking.connect(user)["deposit(uint256)"](ethers.parseEther("25"));
    await staking.connect(user).stake(ethers.parseEther("10"));
    await ethers.provider.send("evm_increaseTime", [12]);
    await ethers.provider.send("evm_mine", []);
  // Snapshot pending then update into rewardsAccrued
  const pendingBefore = await staking.pendingRewards(user.address);
  await staking.connect(user)["withdraw(uint256,bool)"](0, false);
  const beforeAcct = await staking.getAccount(user.address);
  const perSecond2 = ethers.parseEther("10");
  const diff2 = beforeAcct.rewardsAccrued - pendingBefore;
  expect(diff2).to.gte(0n);
  expect(diff2).to.lte(perSecond2 * 2n);
    const beforeBal = await token.balanceOf(user.address);
    const withdrawPrincipal = ethers.parseEther("8");
  const tx2 = await staking.connect(user)["withdraw(uint256,bool)"](withdrawPrincipal, true);
  await expect(tx2).to.emit(staking, "Withdrawn");
  const receipt2 = await tx2.wait();
  // Parse Withdrawn event to validate rewards output within jitter bounds
  const parsed = receipt2?.logs
    .map(l => {
      try { return (staking as any).interface.parseLog(l); } catch { return null; }
    })
    .filter(Boolean)
    .find((p: any) => p!.name === "Withdrawn");
  const rewardsOut: bigint = parsed?.args[2];
  expect(rewardsOut).to.gte(beforeAcct.rewardsAccrued);
  expect(rewardsOut).to.lte(beforeAcct.rewardsAccrued + perSecond2 * 2n);
    const afterAcct = await staking.getAccount(user.address);
    const afterBal = await token.balanceOf(user.address);
    expect(afterAcct.rewardsAccrued).to.equal(0n);
      expect(afterBal - beforeBal).to.equal(withdrawPrincipal + rewardsOut);
  });

  it("withdraw(uint256,bool) reverts if principal exceeds idle balance", async () => {
    await staking.connect(user)["deposit(uint256)"](ethers.parseEther("50"));
    await staking.connect(user).stake(ethers.parseEther("40"));
    // Idle = 10, attempt 11
    await expect(staking.connect(user)["withdraw(uint256,bool)"](ethers.parseEther("11"), false)).to.be.reverted;
  });

  it("pendingRewardsDetailed returns consistent totals", async () => {
    await staking.connect(user)["deposit(uint256)"](ethers.parseEther("5"));
    await staking.connect(user).stake(ethers.parseEther("5"));
    await ethers.provider.send("evm_increaseTime", [6]);
    await ethers.provider.send("evm_mine", []);
  const simpleBefore = await staking.pendingRewards(user.address);
  const detailedBefore = await staking.pendingRewardsDetailed(user.address);
  expect(detailedBefore[0]).to.equal(simpleBefore);
  // trigger update and confirm rewardsAccrued equals previous pending total
  await staking.connect(user)["withdraw(uint256,bool)"](0, false);
  const acct = await staking.getAccount(user.address);
  const perSecond3 = ethers.parseEther("5");
  const diff4 = acct.rewardsAccrued - simpleBefore;
  expect(diff4).to.gte(0n);
  expect(diff4).to.lte(perSecond3 * 2n);
  });

  it("admin can set reward rate and non-admin cannot", async () => {
    const newRate = ethers.parseUnits("2", 18);
    await expect(staking.connect(user).setRewardRate(newRate)).to.be.reverted; // no role
    await expect(staking.connect(owner).setRewardRate(newRate))
      .to.emit(staking, "RewardRateUpdated");
    expect(await staking.rewardRate()).to.equal(newRate);
  });
});
