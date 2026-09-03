// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

/// @notice Baseline toolchain test. Proves the Foundry profile builds and executes before any
/// product contract exists. Superseded in substance by the fixture, adapter, and vault suites.
contract BaselineTest is Test {
  function test_ToolchainIsWired() public pure {
    assertEq(uint256(1), uint256(1), "foundry profile is not executing tests");
  }

  /// @dev Chain 196 (X Layer mainnet) is never a broadcast or test target in this repository.
  function test_MainnetChainIdIsNotTheTestChain() public view {
    assertTrue(block.chainid != 196, "tests must never run against X Layer mainnet");
  }
}
