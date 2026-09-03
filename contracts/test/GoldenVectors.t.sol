// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ActionGuardAdapter} from "../src/ActionGuardAdapter.sol";
import {FixtureAsset} from "../src/fixtures/FixtureAsset.sol";
import {FixtureWrapper} from "../src/fixtures/FixtureWrapper.sol";

/// @notice Proves the Solidity digest matches the TypeScript signer, byte for byte.
///
/// @dev Reads the SAME committed file the TypeScript suite reads
/// (packages/receipts/vectors/operation-digests.json), so neither implementation can be
/// "fixed" to match itself. If these drift, every receipt the service issues is rejected on
/// chain — and the failure would otherwise surface at execution time, not build time.
contract GoldenVectorsTest is Test {
    ActionGuardAdapter private adapter;

    function setUp() public {
        vm.chainId(1952);
        FixtureAsset asset = new FixtureAsset("Fixture", "FIX", address(this), 1e18);
        FixtureWrapper wrapper = new FixtureWrapper(address(asset), "Wrapped Fixture", "wFIX", 2);
        adapter = new ActionGuardAdapter(address(this), address(asset), address(wrapper), 900, 900);
    }

    function test_DigestTagMatchesTypeScript() public view {
        string memory json = vm.readFile("../packages/receipts/vectors/operation-digests.json");
        bytes32 expected = abi.decode(vm.parseJson(json, ".digestTag"), (bytes32));
        assertEq(adapter.OPERATION_DIGEST_TAG(), expected, "operation digest tag drifted from TypeScript");
    }

    function test_SchemaVersionMatchesTypeScript() public view {
        string memory json = vm.readFile("../packages/receipts/vectors/operation-digests.json");
        uint256 expected = abi.decode(vm.parseJson(json, ".schemaVersion"), (uint256));
        assertEq(uint256(adapter.SCHEMA_VERSION()), expected, "schema version drifted from TypeScript");
    }

    /// @dev One decoded vector. Grouped into a struct because ten separate locals in the
    /// loop body exceeds the EVM stack depth.
    struct Vector {
        uint256 chainId;
        address verifyingContract;
        address caller;
        address target;
        address asset;
        address wrapper;
        uint8 actionType;
        address recipient;
        uint256 amount;
        uint256 nonce;
        bytes32 expectedDigest;
    }

    function _readVector(string memory json, uint256 index) private pure returns (Vector memory v) {
        string memory base = string.concat(".vectors[", vm.toString(index), "]");
        v.chainId = abi.decode(vm.parseJson(json, string.concat(base, ".operation.chainId")), (uint256));
        v.verifyingContract =
            abi.decode(vm.parseJson(json, string.concat(base, ".operation.verifyingContract")), (address));
        v.caller = abi.decode(vm.parseJson(json, string.concat(base, ".operation.caller")), (address));
        v.target = abi.decode(vm.parseJson(json, string.concat(base, ".operation.target")), (address));
        v.asset = abi.decode(vm.parseJson(json, string.concat(base, ".operation.asset")), (address));
        v.wrapper = abi.decode(vm.parseJson(json, string.concat(base, ".operation.wrapper")), (address));
        v.actionType = uint8(abi.decode(vm.parseJson(json, string.concat(base, ".operation.actionType")), (uint256)));
        v.recipient = abi.decode(vm.parseJson(json, string.concat(base, ".operation.recipient")), (address));
        // Amounts are JSON strings so a uint256 maximum survives without passing through a
        // float. parseJsonString is used explicitly rather than parseJson + abi.decode,
        // because the generic parser infers a type and a 78-digit numeric string is not
        // reliably returned as a string.
        v.amount = vm.parseUint(vm.parseJsonString(json, string.concat(base, ".operation.amount")));
        v.nonce = vm.parseUint(vm.parseJsonString(json, string.concat(base, ".operation.expectedMultiplierNonce")));
        v.expectedDigest = abi.decode(vm.parseJson(json, string.concat(base, ".expectedDigest")), (bytes32));
    }

    /// @dev Every committed vector must reproduce exactly.
    function test_EveryVectorReproducesInSolidity() public view {
        string memory json = vm.readFile("../packages/receipts/vectors/operation-digests.json");
        uint256 count = abi.decode(vm.parseJson(json, ".count"), (uint256));
        assertGt(count, 0, "no vectors found");

        for (uint256 i = 0; i < count; i++) {
            Vector memory v = _readVector(json, i);
            bytes32 actual = adapter.computeOperationDigest(
                v.chainId,
                v.verifyingContract,
                v.caller,
                v.target,
                v.asset,
                v.wrapper,
                v.actionType,
                v.recipient,
                v.amount,
                v.nonce
            );
            assertEq(actual, v.expectedDigest, "digest mismatch against the TypeScript golden vector");
        }
    }

    /// @dev Changing any bound field must change the digest, in Solidity too.
    function testFuzz_EveryBoundFieldAffectsTheDigest(
        uint256 chainId,
        address verifying,
        address caller,
        address target,
        address asset_,
        address wrapper_,
        uint8 actionType,
        address recipient,
        uint256 amount,
        uint256 nonce
    ) public view {
        // Bounded so the "+1" perturbations below cannot overflow. The digest itself
        // handles the full uint256 range; the golden vectors cover the maximum.
        chainId = bound(chainId, 0, type(uint256).max - 1);
        amount = bound(amount, 0, type(uint256).max - 1);
        nonce = bound(nonce, 0, type(uint256).max - 1);

        bytes32 base = adapter.computeOperationDigest(
            chainId, verifying, caller, target, asset_, wrapper_, actionType, recipient, amount, nonce
        );

        // A single altered field always yields a different digest.
        assertTrue(
            base
                != adapter.computeOperationDigest(
                    chainId, verifying, caller, target, asset_, wrapper_, actionType, recipient, amount, nonce + 1
                ),
            "nonce change did not affect digest"
        );
        assertTrue(
            base
                != adapter.computeOperationDigest(
                    chainId, verifying, caller, target, asset_, wrapper_, actionType, recipient, amount + 1, nonce
                ),
            "amount change did not affect digest"
        );
        assertTrue(
            base
                != adapter.computeOperationDigest(
                    chainId + 1, verifying, caller, target, asset_, wrapper_, actionType, recipient, amount, nonce
                ),
            "chain id change did not affect digest"
        );
    }
}
