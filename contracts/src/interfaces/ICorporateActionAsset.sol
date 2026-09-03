// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ICorporateActionAsset
/// @notice The narrow multiplier surface the guard depends on.
///
/// @dev This interface is deliberately minimal. It contains exactly the four functions
/// that were **verified live on X Layer mainnet on 2026-09-03** against the AAPLx token at
/// `0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a`:
///
/// ```text
/// getCurrentMultiplier()        -> 1003269012539818700
/// newMultiplier()               -> 1003269012539818700
/// newMultiplierNonce()          -> 5
/// newMultiplierActivationTime() -> 0        (the "no schedule" sentinel)
/// ```
///
/// **Production compatibility gap.** These selectors match the production xStocks token,
/// but the production token's full source is not published in a form this build could
/// verify, and the fixture implements this interface rather than the production contract.
/// Compatibility of the *read* surface is evidenced; compatibility of scheduling semantics
/// is not, and must not be claimed. See docs/testnet-fixture.md.
///
/// The multiplier surface lives on the **token**, not the wrapper. Calling any of these on
/// the production wrapper reverts.
interface ICorporateActionAsset {
    /// @notice The multiplier currently in force, scaled by 1e18.
    function getCurrentMultiplier() external view returns (uint256);

    /// @notice The multiplier that will take effect at `newMultiplierActivationTime()`.
    function newMultiplier() external view returns (uint256);

    /// @notice Monotonic epoch counter. Any change invalidates every outstanding receipt.
    function newMultiplierNonce() external view returns (uint256);

    /// @notice Unix seconds at which the pending multiplier activates. `0` means none.
    function newMultiplierActivationTime() external view returns (uint256);
}

/// @title IWrapperAsset
/// @notice The wrapper-to-asset relation, verified live on the production wrapper.
interface IWrapperAsset {
    /// @notice The underlying token this wrapper wraps.
    function asset() external view returns (address);
}
