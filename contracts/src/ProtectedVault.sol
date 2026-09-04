// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IProtectedTarget} from "./ActionGuardAdapter.sol";

/// @title ProtectedVault
/// @notice One economically meaningful but deliberately small operation, routed through
/// the guard: deposit and withdraw of a fixture asset. An account can always withdraw its
/// own credited balance directly, so an adapter pause or signer outage cannot trap funds.
///
/// @dev The financial surface is kept minimal on purpose. The product being demonstrated
/// is the *guard*, and every extra vault feature is extra attack surface that proves
/// nothing about it.
///
/// **Amount semantics:** amounts are underlying asset base units throughout. The vault does
/// not mint shares and does not apply the multiplier, so there is no share/asset unit
/// ambiguity to get wrong. Balances are credited in the same units deposited.
contract ProtectedVault is IProtectedTarget, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant ACTION_DEPOSIT = 1;
    uint8 public constant ACTION_WITHDRAW = 2;

    IERC20 public immutable asset;
    address public immutable adapter;

    mapping(address => uint256) public balanceOf;
    uint256 public totalDeposited;

    event Deposited(address indexed caller, address indexed recipient, uint256 amount);
    event Withdrawn(address indexed caller, address indexed recipient, uint256 amount);

    error OnlyAdapter(address caller);
    error UnsupportedAction(uint8 actionType);
    error InsufficientBalance(uint256 requested, uint256 available);
    error ZeroAmount();
    error ZeroAddress();
    error FeeOnTransferNotSupported(uint256 expected, uint256 received);

    modifier onlyAdapter() {
        // The whole point: protected state changes are reachable only through the guard.
        if (msg.sender != adapter) revert OnlyAdapter(msg.sender);
        _;
    }

    constructor(IERC20 asset_, address adapter_) {
        asset = asset_;
        adapter = adapter_;
    }

    /// @inheritdoc IProtectedTarget
    function performProtectedAction(uint8 actionType, address caller, address recipient, uint256 amount)
        external
        onlyAdapter
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();

        if (actionType == ACTION_DEPOSIT) {
            _deposit(caller, recipient, amount);
        } else if (actionType == ACTION_WITHDRAW) {
            _withdraw(caller, recipient, amount);
        } else {
            revert UnsupportedAction(actionType);
        }
    }

    /// @notice Withdraw the caller's own credited balance without adapter authorization.
    /// @dev This is an intentionally narrow escape hatch: the caller cannot debit another
    /// account, redirect another account's assets, or deposit through it.
    function withdraw(uint256 amount, address recipient) external nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _withdraw(msg.sender, recipient, amount);
    }

    function _deposit(address caller, address recipient, uint256 amount) private {
        uint256 before = asset.balanceOf(address(this));
        asset.safeTransferFrom(caller, address(this), amount);
        uint256 received = asset.balanceOf(address(this)) - before;

        // A fee-on-transfer token would credit more than it delivered. Rather than silently
        // crediting the smaller amount, refuse: this vault's accounting assumes 1:1, and a
        // token that breaks that assumption should be rejected loudly.
        if (received != amount) revert FeeOnTransferNotSupported(amount, received);

        balanceOf[recipient] += amount;
        totalDeposited += amount;
        emit Deposited(caller, recipient, amount);
    }

    function _withdraw(address caller, address recipient, uint256 amount) private {
        uint256 available = balanceOf[caller];
        if (available < amount) revert InsufficientBalance(amount, available);

        // Effects before interactions.
        balanceOf[caller] = available - amount;
        totalDeposited -= amount;

        asset.safeTransfer(recipient, amount);
        emit Withdrawn(caller, recipient, amount);
    }
}
