// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IB20ProtectedTarget} from "./B20GuardAdapter.sol";
import {IB20Multiplier} from "./interfaces/IB20Asset.sol";

/// @title B20ProtectedVault
/// @notice Custody for one B20 test asset, reachable only through the guard adapter.
///
/// @dev **Everything here is denominated in raw token units.** The vault never applies the
/// multiplier and never stores a share-equivalent. That is not a simplification, it is the
/// point: a corporate action changes what a holder's raw units are *worth* without moving a
/// single unit, so a vault that credited share-equivalents would silently restate every
/// depositor's claim on the next multiplier change. Raw units are conserved; meaning is
/// derived above.
///
/// `sharesOf` exists as a **view**, computed from the live multiplier, precisely so nobody
/// is tempted to store one.
///
/// The financial surface is deliberately minimal. The product being demonstrated is the
/// guard, and every extra vault feature is attack surface that proves nothing about it. There
/// is no arbitrary call, no delegatecall, and no upgrade path.
///
/// **A holder can transfer the B20 token directly and never touch this vault.** Only funds
/// routed through it are protected, and the test suite asserts that bypass exists.
contract B20ProtectedVault is IB20ProtectedTarget, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Mirrors `B20_ACTION_CLASS_CODE` in packages/receipts/src/b20-schema.ts.
    uint8 public constant ACTION_VAULT_DEPOSIT = 4;
    uint8 public constant ACTION_VAULT_WITHDRAW = 5;

    IERC20 public immutable asset;
    address public immutable adapter;

    /// @notice Pause and unpause are separate roles on purpose: the ability to stop the
    /// world should not carry the ability to restart it, so one compromised key cannot
    /// pause, drain and unpause.
    address public immutable pauser;
    address public immutable unpauser;

    bool public paused;

    /// @notice Raw units credited to each account. Never share-equivalents.
    mapping(address => uint256) public rawBalanceOf;
    uint256 public totalRawDeposited;

    event Deposited(address indexed sender, address indexed recipient, uint256 rawAmount);
    event Withdrawn(address indexed sender, address indexed recipient, uint256 rawAmount);
    event PauseChanged(address indexed actor, bool paused);

    error OnlyAdapter(address caller);
    error OnlyPauser(address caller);
    error OnlyUnpauser(address caller);
    error UnsupportedAction(uint8 actionClass);
    error InsufficientBalance(uint256 requested, uint256 available);
    error ZeroAmount();
    error ZeroAddress();
    error VaultPaused();
    error FeeOnTransferNotSupported(uint256 expected, uint256 received);

    modifier onlyAdapter() {
        // The whole point: protected state changes are reachable only through the guard.
        if (msg.sender != adapter) revert OnlyAdapter(msg.sender);
        _;
    }

    constructor(IERC20 asset_, address adapter_, address pauser_, address unpauser_) {
        // Checked one at a time rather than as one long disjunction: a combined condition
        // formats badly and, more importantly, tells a deployer only that *something* was
        // zero.
        if (address(asset_) == address(0)) revert ZeroAddress();
        if (adapter_ == address(0)) revert ZeroAddress();
        if (pauser_ == address(0)) revert ZeroAddress();
        if (unpauser_ == address(0)) revert ZeroAddress();
        asset = asset_;
        adapter = adapter_;
        pauser = pauser_;
        unpauser = unpauser_;
    }

    function pause() external {
        if (msg.sender != pauser) revert OnlyPauser(msg.sender);
        paused = true;
        emit PauseChanged(msg.sender, true);
    }

    function unpause() external {
        if (msg.sender != unpauser) revert OnlyUnpauser(msg.sender);
        paused = false;
        emit PauseChanged(msg.sender, false);
    }

    /// @inheritdoc IB20ProtectedTarget
    function performB20Action(uint8 actionClass, address sender, address recipient, uint256 rawAmount)
        external
        onlyAdapter
        nonReentrant
    {
        if (paused) revert VaultPaused();
        if (rawAmount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        if (actionClass == ACTION_VAULT_DEPOSIT) {
            _deposit(sender, recipient, rawAmount);
        } else if (actionClass == ACTION_VAULT_WITHDRAW) {
            _withdraw(sender, recipient, rawAmount);
        } else {
            revert UnsupportedAction(actionClass);
        }
    }

    function _deposit(address sender, address recipient, uint256 rawAmount) private {
        // Measured rather than assumed. A fee-on-transfer token would credit more than
        // arrived, and the shortfall would be paid by whoever withdrew last.
        uint256 before = asset.balanceOf(address(this));
        IERC20(asset).safeTransferFrom(sender, address(this), rawAmount);
        uint256 received = asset.balanceOf(address(this)) - before;
        if (received != rawAmount) revert FeeOnTransferNotSupported(rawAmount, received);

        rawBalanceOf[recipient] += rawAmount;
        totalRawDeposited += rawAmount;
        emit Deposited(sender, recipient, rawAmount);
    }

    function _withdraw(address sender, address recipient, uint256 rawAmount) private {
        uint256 available = rawBalanceOf[sender];
        if (rawAmount > available) revert InsufficientBalance(rawAmount, available);

        rawBalanceOf[sender] = available - rawAmount;
        totalRawDeposited -= rawAmount;
        IERC20(asset).safeTransfer(recipient, rawAmount);
        emit Withdrawn(sender, recipient, rawAmount);
    }

    /// @notice The share-equivalent of a credited balance, at the *current* multiplier.
    ///
    /// @dev A view, never state. Storing this would freeze a number that the next corporate
    /// action invalidates, and every reader would then see a stale share count with no way to
    /// tell it was stale. Computed with the same floor semantics as `toScaledBalance`.
    function sharesOf(address account) external view returns (uint256) {
        uint256 wad = IB20Multiplier(address(asset)).WAD_PRECISION();
        return (rawBalanceOf[account] * IB20Multiplier(address(asset)).multiplier()) / wad;
    }

    /// @notice Assets held must always cover every internal claim.
    ///
    /// @dev The invariant a fuzz test asserts. It holds in raw units and would not hold in
    /// share-equivalents, because the multiplier moves under a stored share count.
    function solvent() external view returns (bool) {
        return asset.balanceOf(address(this)) >= totalRawDeposited;
    }
}
