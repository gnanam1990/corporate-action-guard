// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title B20FixtureAsset
/// @notice A controllable local stand-in for a B20 asset. **Not a Coinbase stock.**
///
/// @dev The name and symbol carry the label so it is unmistakable in a block explorer, a log
/// line, an API response and a UI — anywhere someone might glance at it and assume otherwise.
/// It has no issuer, no backing, no prospectus and no eligibility for anything.
///
/// It exists because the behaviours worth testing cannot be produced on demand against a real
/// asset: a corporate action landing mid-flight, a pause opening and closing around it, a
/// scheduling surface that is present on one chain and absent on another. Those are the cases
/// the guard exists for, and a fixture is the only way to reach them deterministically.
///
/// The scheduling surface is *toggleable* on purpose. Base mainnet does not dial it today —
/// `newUIMultiplier()` and `effectiveAt()` revert with their own selectors — so the adapter
/// has to behave correctly both with and without it, and only a fixture can present both.
contract B20FixtureAsset is ERC20 {
    /// @dev Anyone reading this string should immediately know what it is not.
    string public constant DISCLAIMER = "TESTNET FIXTURE - NOT COINBASE STOCK";

    uint256 public constant WAD_PRECISION = 1e18;

    address public immutable operator;
    uint8 private immutable _decimals;

    uint256 private _multiplier = 1e18;
    uint256 private _newUIMultiplier;
    uint256 private _effectiveAt;

    /// @dev When false, the ERC-8056 reads revert — the shape Base mainnet presents today.
    bool public scheduledSurfaceDialed;

    mapping(uint8 => bool) private _paused;

    event MultiplierUpdated(uint256 multiplier);
    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp);
    event UIMultiplierUpdateCancelled(uint256 cancelledMultiplier, uint256 cancelledEffectiveAt);

    error OnlyOperator(address caller);
    error ScheduledSurfaceNotDialed();
    error InvalidMultiplier();
    error EffectiveAtInPast(uint256 effectiveAt);
    error UIMultiplierUpdateExists(uint256 effectiveAt);
    error UIMultiplierUpdateDoesNotExist();

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator(msg.sender);
        _;
    }

    constructor(address operator_, uint8 decimals_) ERC20("TESTNET FIXTURE - NOT COINBASE STOCK", "CAGB20c") {
        operator = operator_;
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 rawAmount) external onlyOperator {
        _mint(to, rawAmount);
    }

    /// @notice The current multiplier, scaled to WAD.
    ///
    /// @dev Lazy activation: a schedule whose `effectiveAt` has passed is active with no
    /// event having been emitted at that moment. That is the upstream behaviour and it is the
    /// single most-missed detail in an integration, so the fixture reproduces it exactly.
    function multiplier() public view returns (uint256) {
        if (_effectiveAt != 0 && block.timestamp >= _effectiveAt) return _newUIMultiplier;
        return _multiplier;
    }

    function isPaused(uint8 feature) external view returns (bool) {
        return _paused[feature];
    }

    function setPaused(uint8 feature, bool value) external onlyOperator {
        _paused[feature] = value;
    }

    function setScheduledSurfaceDialed(bool dialed) external onlyOperator {
        scheduledSurfaceDialed = dialed;
    }

    /// @notice The instant, deprecated setter. Clears any live pending update.
    function updateMultiplier(uint256 newMultiplier) external onlyOperator {
        if (newMultiplier == 0 || newMultiplier > type(uint128).max) revert InvalidMultiplier();
        if (_effectiveAt != 0) {
            emit UIMultiplierUpdateCancelled(_newUIMultiplier, _effectiveAt);
            _newUIMultiplier = 0;
            _effectiveAt = 0;
        }
        _multiplier = newMultiplier;
        // Both topics, exactly as upstream: one business fact, two events.
        emit MultiplierUpdated(newMultiplier);
        emit UIMultiplierUpdated(_multiplier, newMultiplier, block.timestamp);
    }

    /// @notice Schedule an update. Reverts if one is already live, matching `IB20Asset`.
    function updateUIMultiplier(uint256 newMultiplier, uint256 effectiveAt_) external onlyOperator {
        if (newMultiplier == 0 || newMultiplier > type(uint128).max) revert InvalidMultiplier();
        if (effectiveAt_ <= block.timestamp) revert EffectiveAtInPast(effectiveAt_);
        // The upstream interface reverts here rather than replacing. The events table says
        // otherwise; the interface wins, and the disagreement is recorded in
        // docs/base-b20/sources.md.
        if (_effectiveAt != 0) revert UIMultiplierUpdateExists(_effectiveAt);
        _newUIMultiplier = newMultiplier;
        _effectiveAt = effectiveAt_;
        emit UIMultiplierUpdated(_multiplier, newMultiplier, effectiveAt_);
    }

    function cancelUIMultiplierUpdate() external onlyOperator {
        if (_effectiveAt == 0) revert UIMultiplierUpdateDoesNotExist();
        emit UIMultiplierUpdateCancelled(_newUIMultiplier, _effectiveAt);
        _newUIMultiplier = 0;
        _effectiveAt = 0;
    }

    /// @notice ERC-8056. Reverts when the surface is not dialed, like Base mainnet today.
    function newUIMultiplier() external view returns (uint256) {
        if (!scheduledSurfaceDialed) revert ScheduledSurfaceNotDialed();
        return _newUIMultiplier;
    }

    function effectiveAt() external view returns (uint256) {
        if (!scheduledSurfaceDialed) revert ScheduledSurfaceNotDialed();
        return _effectiveAt;
    }

    /// @notice `toScaledBalance` — floor, exactly as the official helper.
    function toScaledBalance(uint256 rawBalance) external view returns (uint256) {
        return (rawBalance * multiplier()) / WAD_PRECISION;
    }

    /// @dev Transfers respect the pause, so a paused fixture behaves like a paused B20.
    function _update(address from, address to, uint256 value) internal override {
        if (_paused[0] && from != address(0) && to != address(0)) revert("TRANSFER_PAUSED");
        super._update(from, to, value);
    }
}
