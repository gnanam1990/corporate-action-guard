// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IB20Multiplier
/// @notice The Beryl multiplier surface, transcribed from the pinned `base/base-std`
///         snapshot at commit `be6d0450` — see `provenance/base-b20/base-std/`.
///
/// @dev Deliberately narrow. The adapter needs the current multiplier and the pause state to
///      decide, and nothing else; a wider interface would invite reading state the decision
///      does not depend on and cannot verify.
interface IB20Multiplier {
    /// @notice The current multiplier, scaled to 1e18.
    function multiplier() external view returns (uint256);

    /// @notice `1e18`. Read rather than assumed, so a token with a different scale is caught.
    function WAD_PRECISION() external view returns (uint256);
}

/// @title IB20Pausable
/// @notice `PausableFeature` is declared in `IB20.sol` as `{TRANSFER, MINT, BURN, SEIZE}`,
///         so `TRANSFER` is `0`.
interface IB20Pausable {
    function isPaused(uint8 feature) external view returns (bool);
}

/// @title IB20Scheduled
/// @notice The ERC-8056 scheduling surface added in the Cobalt hardfork.
///
/// @dev **Not dialed on Base mainnet** at the recorded provenance block: `newUIMultiplier()`
///      and `effectiveAt()` revert with their own four-byte selectors. The adapter therefore
///      probes for it rather than calling it, and treats an undialed selector as "the chain
///      cannot answer" rather than as "nothing is scheduled" — the difference between an
///      honest refusal and a false negative on the most safety-critical question there is.
interface IB20Scheduled {
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
}

/// @title IB20Transfer
/// @notice The ERC-20 surface the vault uses. Raw units only.
interface IB20Transfer {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
