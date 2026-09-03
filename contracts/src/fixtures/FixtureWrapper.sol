// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICorporateActionAsset, IWrapperAsset} from "../interfaces/ICorporateActionAsset.sol";

/// @title FixtureWrapper — TESTNET FIXTURE
/// @notice Reproduces the verified wrapper surface: `asset()` plus conversions.
///
/// @dev Mirrors what was verified on the production wrapper on 2026-09-03: it exposes
/// `asset()` and the conversion functions, and deliberately does **not** expose the
/// multiplier surface, because calling those on the production wrapper reverts. A fixture
/// that exposed them would let the adapter be written against a shape that does not exist
/// in production.
contract FixtureWrapper is IWrapperAsset {
    string public constant FIXTURE_LABEL = "TESTNET FIXTURE - NOT A REAL WRAPPER";
    uint256 public constant MULTIPLIER_SCALE = 1e18;

    address private immutable _asset;
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    /// @notice Version marker so a legacy wrapper is distinguishable on chain.
    uint256 public immutable wrapperVersion;

    error WrongChain(uint256 actual, uint256 expected);

    constructor(address asset_, string memory name_, string memory symbol_, uint256 version_) {
        if (block.chainid != 1952) revert WrongChain(block.chainid, 1952);
        _asset = asset_;
        name = name_;
        symbol = symbol_;
        wrapperVersion = version_;
    }

    /// @inheritdoc IWrapperAsset
    function asset() external view returns (address) {
        return _asset;
    }

    /// @notice Shares to underlying units, at the multiplier currently in force.
    function convertToAssets(uint256 shares) external view returns (uint256) {
        return (shares * ICorporateActionAsset(_asset).getCurrentMultiplier()) / MULTIPLIER_SCALE;
    }

    /// @notice Underlying units to shares.
    function convertToShares(uint256 assets) external view returns (uint256) {
        uint256 multiplier = ICorporateActionAsset(_asset).getCurrentMultiplier();
        return (assets * MULTIPLIER_SCALE) / multiplier;
    }

    /// @notice Underlying balance held by this wrapper. Used only for test assertions.
    function underlyingBalance() external view returns (uint256) {
        return IERC20(_asset).balanceOf(address(this));
    }
}
