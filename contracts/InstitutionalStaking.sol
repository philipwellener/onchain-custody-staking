// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title InstitutionalStaking
 * @notice Allows users to deposit an underlying ERC20 token, "stake" it to start accruing rewards,
 *         view accrued rewards, and withdraw principal + rewards. Admins can pause operations.
 *         Rewards are calculated using a simple per-second emission rate applied to each user's staked balance.
 */
contract InstitutionalStaking is ReentrancyGuard, AccessControl, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    IERC20 public immutable STAKING_TOKEN; // token being deposited & staked

    // Reward emission rate in tokens per second per 1e18 staked tokens
    uint256 public rewardRate; // scaled by 1e18 for precision (reward per second per token * 1e18)

    struct Account {
        uint256 deposited;    // total deposited (principal) currently held (not yet withdrawn)
        uint256 staked;       // amount currently staked and earning
        uint256 rewardsAccrued; // rewards accrued but not yet claimed (internal accounting)
        uint256 lastUpdate;   // timestamp of last reward update for this account
    uint256 stakeStart;   // timestamp when staking started (first time balance became >0 this cycle)
    uint256 rewardRemainder; // leftover scaled reward numerator (<1e18) carried to next update to eliminate drift
    }

    mapping(address => Account) private accounts;

    // Total staked for potential future use (e.g., global reward scaling)
    uint256 public totalStaked;

    // Events
    event Deposited(address indexed user, uint256 amount);
    event Deposit(address indexed user, address indexed token, uint256 amount);
    event Staked(address indexed user, uint256 amount); // existing event (backwards compatibility)
    event Stake(address indexed user, uint256 amount);  // new event per requirement wording
    event Withdrawn(address indexed user, uint256 principal, uint256 rewards);
    event RewardRateUpdated(uint256 oldRate, uint256 newRate);
    event RewardsAccrued(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Withdraw(address indexed user, uint256 principal, uint256 rewards);

    error InsufficientBalance(uint256 available, uint256 required);
    error InvalidAmount();
    error NothingStaked();
    error ZeroAddress();

    constructor(IERC20 _stakingToken, uint256 _rewardRate, address admin) {
        if (address(_stakingToken) == address(0)) revert ZeroAddress();
        STAKING_TOKEN = _stakingToken;
        rewardRate = _rewardRate; // expected scaled by 1e18 for precision
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // -------------------- External User Functions --------------------

    function deposit(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert InvalidAmount();
        Account storage acct = accounts[msg.sender];
        _updateRewards(acct, msg.sender);
    STAKING_TOKEN.safeTransferFrom(msg.sender, address(this), amount);
        acct.deposited += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Generic deposit of an arbitrary ERC20 token (not staked / no rewards tracking).
    function deposit(address token, uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert InvalidAmount();
    if (token == address(0)) revert ZeroAddress();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposit(msg.sender, token, amount);
    }

    function stake(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert InvalidAmount();
        Account storage acct = accounts[msg.sender];
        if (acct.deposited - acct.staked < amount) revert InsufficientBalance(acct.deposited - acct.staked, amount);
        _updateRewards(acct, msg.sender);
        if (acct.staked == 0) {
            // first stake of a (new) staking cycle
            acct.stakeStart = block.timestamp;
        }
        acct.staked += amount;
        totalStaked += amount;
        emit Staked(msg.sender, amount);
        emit Stake(msg.sender, amount);
    }

    function unstake(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert InvalidAmount();
        Account storage acct = accounts[msg.sender];
        if (acct.staked < amount) revert InsufficientBalance(acct.staked, amount);
        _updateRewards(acct, msg.sender);
        acct.staked -= amount;
        totalStaked -= amount;
        if (acct.staked == 0) {
            // reset stakeStart to 0 to mark end of cycle
            acct.stakeStart = 0;
        }
        emit Unstaked(msg.sender, amount);
    }

    function withdraw(uint256 amountPrincipal, bool claimRewards) external nonReentrant {
        Account storage acct = accounts[msg.sender];
        if (amountPrincipal > acct.deposited - acct.staked) {
            revert InsufficientBalance(acct.deposited - acct.staked, amountPrincipal);
        }
        _updateRewards(acct, msg.sender);

        uint256 rewardsOut = 0;
        if (claimRewards) {
            rewardsOut = acct.rewardsAccrued;
            acct.rewardsAccrued = 0;
        }
        if (amountPrincipal > 0) {
            acct.deposited -= amountPrincipal;
        }
    STAKING_TOKEN.safeTransfer(msg.sender, amountPrincipal + rewardsOut);
        emit Withdrawn(msg.sender, amountPrincipal, rewardsOut);
    }

    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant ANNUAL_RATE_BPS = 500; // 5%

    /// @notice Overloaded withdraw: withdraws staked principal with time-based annual-rate rewards.
    /// Independent of the per-second emission model (rewardRate accrual).
    function withdraw(uint256 amount) external nonReentrant {
        Account storage acct = accounts[msg.sender];
        if (amount == 0) revert InvalidAmount();
        if (acct.staked < amount) revert InsufficientBalance(acct.staked, amount);
        if (acct.staked == 0) revert NothingStaked();
        uint256 start = acct.stakeStart;
        if (start == 0) {
            // If not initialized, set and produce zero rewards this time
            acct.stakeStart = block.timestamp;
            start = block.timestamp;
        }
        uint256 duration = block.timestamp - start;
        uint256 rewards = (amount * ANNUAL_RATE_BPS * duration) / (SECONDS_PER_YEAR * 10000);
        acct.staked -= amount;
        totalStaked -= amount;
        acct.deposited -= amount; // remove principal
        if (acct.staked > 0) {
            acct.stakeStart = block.timestamp;
        } else {
            acct.stakeStart = 0;
        }
    STAKING_TOKEN.safeTransfer(msg.sender, amount + rewards);
        emit Withdraw(msg.sender, amount, rewards);
    }

    // View accrued rewards without mutating state (simulate what _updateRewards would do)
    function pendingRewards(address user) public view returns (uint256) {
        Account storage acct = accounts[user];
        if (acct.staked == 0) return acct.rewardsAccrued;
        uint256 delta = block.timestamp - acct.lastUpdate;
        uint256 raw = acct.staked * rewardRate * delta; // scaled by 1e18
        uint256 totalScaled = raw + acct.rewardRemainder; // include previous remainder
        uint256 newRewards = totalScaled / 1e18;
        return acct.rewardsAccrued + newRewards;
    }

    /// @notice Detailed pending view including the carried remainder numerator (scaled <1e18)
    function pendingRewardsDetailed(address user)
        external
        view
        returns (
            uint256 totalClaimable,
            uint256 newPortion,
            uint256 remainder
        )
    {
        Account storage acct = accounts[user];
        if (acct.staked == 0) {
            return (acct.rewardsAccrued, 0, acct.rewardRemainder);
        }
        uint256 delta = block.timestamp - acct.lastUpdate;
        uint256 raw = acct.staked * rewardRate * delta; // scaled by 1e18
        uint256 totalScaled = raw + acct.rewardRemainder;
        uint256 newRewards = totalScaled / 1e18;
        uint256 rem = totalScaled % 1e18;
        return (acct.rewardsAccrued + newRewards, newRewards, rem);
    }

    function getAccount(address user) external view returns (Account memory) {
        return accounts[user];
    }

    // -------------------- Admin Functions --------------------

    function setRewardRate(uint256 newRate) external onlyRole(ADMIN_ROLE) {
        uint256 old = rewardRate;
        rewardRate = newRate;
        emit RewardRateUpdated(old, newRate);
    }

    function pause() external onlyRole(ADMIN_ROLE) {
    _pause(); // OpenZeppelin Pausable emits Paused
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
    _unpause(); // OpenZeppelin Pausable emits Unpaused
    }

    // -------------------- Internal --------------------

    function _updateRewards(Account storage acct, address user) internal {
        if (acct.lastUpdate == 0) {
            acct.lastUpdate = block.timestamp;
            return;
        }
        if (acct.staked > 0) {
            uint256 delta = block.timestamp - acct.lastUpdate;
            if (delta > 0) {
                uint256 raw = acct.staked * rewardRate * delta; // scaled by 1e18
                uint256 totalScaled = raw + acct.rewardRemainder;
                uint256 rewards = totalScaled / 1e18;
                acct.rewardRemainder = totalScaled % 1e18; // store leftover numerator
                if (rewards > 0) {
                    acct.rewardsAccrued += rewards;
                    emit RewardsAccrued(user, rewards);
                }
            }
        }
        acct.lastUpdate = block.timestamp;
    }
}
