// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ActionGuardAdapter} from "../src/ActionGuardAdapter.sol";
import {ProtectedVault} from "../src/ProtectedVault.sol";
import {FixtureAsset} from "../src/fixtures/FixtureAsset.sol";
import {FixtureWrapper} from "../src/fixtures/FixtureWrapper.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Adversarial tests for the guard.
///
/// @dev The valid path gets one test. Everything else here is an attempt to move funds it
/// should not be able to move — that asymmetry is deliberate, because the product's only
/// real claim is about what it refuses.
contract ActionGuardAdapterTest is Test {
    ActionGuardAdapter internal adapter;
    ProtectedVault internal vault;
    FixtureAsset internal asset;
    FixtureWrapper internal wrapper;

    uint256 internal signerKey = 0xA11CE;
    address internal signerAddr;
    uint256 internal callerKey = 0xB0B;
    address internal caller;
    address internal recipient = address(0xBEEF);
    address internal admin = address(this);

    uint64 internal constant GUARD_BEFORE = 900;
    uint64 internal constant GUARD_AFTER = 900;
    uint256 internal constant AMOUNT = 100e18;

    function setUp() public {
        vm.chainId(1952);
        vm.warp(1_800_000_000);

        signerAddr = vm.addr(signerKey);
        caller = vm.addr(callerKey);

        asset = new FixtureAsset("Fixture Asset", "FIXA", admin, 1e18);
        wrapper = new FixtureWrapper(address(asset), "Wrapped Fixture", "wFIXA", 2);
        adapter = new ActionGuardAdapter(admin, address(asset), address(wrapper), GUARD_BEFORE, GUARD_AFTER);
        vault = new ProtectedVault(IERC20(address(asset)), address(adapter));

        adapter.setAuthorizedSigner(signerAddr, true);
        adapter.setAllowedTarget(address(vault), true);

        vm.startPrank(caller);
        asset.faucet(1_000e18);
        asset.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    // --- helpers ---------------------------------------------------------------

    function _receipt(bytes32 id) internal view returns (ActionGuardAdapter.Receipt memory r) {
        r.schemaVersion = 1;
        r.receiptId = id;
        r.caller = caller;
        r.target = address(vault);
        r.asset = address(asset);
        r.wrapper = address(wrapper);
        r.actionType = 1; // DEPOSIT
        r.recipient = recipient;
        r.amount = AMOUNT;
        r.expectedMultiplierNonce = asset.newMultiplierNonce();
        r.validAfter = uint64(block.timestamp - 1);
        r.validUntil = uint64(block.timestamp + 300);
        r.operationDigest = adapter.computeOperationDigest(
            block.chainid,
            address(adapter),
            r.caller,
            r.target,
            r.asset,
            r.wrapper,
            r.actionType,
            r.recipient,
            r.amount,
            r.expectedMultiplierNonce
        );
    }

    function _sign(ActionGuardAdapter.Receipt memory r, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(key, adapter.hashReceipt(r));
        return abi.encodePacked(rr, ss, v);
    }

    /// @dev The signature MUST be computed before `vm.prank`: `_sign` makes a view call to
    /// the adapter, and a prank applies to the next call of any kind — including that one.
    function _execute(ActionGuardAdapter.Receipt memory r) internal {
        _executeAs(caller, r, signerKey);
    }

    /// @dev Sign, then prank, then execute — in that order, always. Encapsulated so no
    /// test can reintroduce the ordering bug.
    function _executeAs(address who, ActionGuardAdapter.Receipt memory r, uint256 key) internal {
        bytes memory sig = _sign(r, key);
        vm.prank(who);
        adapter.execute(r, sig);
    }

    /// @dev Expect any revert from a guarded execution.
    function _expectRevert(ActionGuardAdapter.Receipt memory r, uint256 key) internal {
        bytes memory sig = _sign(r, key);
        vm.prank(caller);
        vm.expectRevert();
        adapter.execute(r, sig);
    }

    /// @dev Expect a specific custom error from a guarded execution.
    function _expectRevertWith(ActionGuardAdapter.Receipt memory r, uint256 key, bytes memory err) internal {
        bytes memory sig = _sign(r, key);
        vm.prank(caller);
        vm.expectRevert(err);
        adapter.execute(r, sig);
    }

    /// @dev Execute with a signature produced from a DIFFERENT receipt, modelling a payload
    /// mutated after issuance.
    function _expectRevertWithStaleSig(ActionGuardAdapter.Receipt memory mutated, bytes memory sig) internal {
        vm.prank(caller);
        vm.expectRevert();
        adapter.execute(mutated, sig);
    }

    // --- the one valid path ----------------------------------------------------

    function test_ValidReceiptSucceedsExactlyOnce() public {
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(1)));
        _execute(r);

        assertEq(vault.balanceOf(recipient), AMOUNT, "deposit was not credited");
        assertTrue(adapter.consumed(r.receiptId), "receipt was not marked consumed");

        // The same receipt a second time is a replay.
        _expectRevertWith(
            r, signerKey, abi.encodeWithSelector(ActionGuardAdapter.ReceiptAlreadyConsumed.selector, r.receiptId)
        );
    }

    // --- mutation after issuance ----------------------------------------------

    function test_MutatedRecipientIsRejected() public {
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(2)));
        bytes memory sig = _sign(r, signerKey);
        r.recipient = address(0xDEAD); // changed after signing
        _expectRevert(r, signerKey);
    }

    function test_MutatedAmountIsRejected() public {
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(3)));
        bytes memory sig = _sign(r, signerKey);
        r.amount = AMOUNT * 2;
        vm.prank(caller);
        vm.expectRevert();
        adapter.execute(r, sig);
    }

    function test_MutatedActionTypeIsRejected() public {
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(4)));
        bytes memory sig = _sign(r, signerKey);
        r.actionType = 2;
        vm.prank(caller);
        vm.expectRevert();
        adapter.execute(r, sig);
    }

    function test_DigestNotMatchingFieldsIsRejected() public {
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(5)));
        r.operationDigest = keccak256("a digest for some other operation");
        _expectRevert(r, signerKey);
    }

    // --- cross-context replay --------------------------------------------------

    function test_AnotherCallerCannotSpendTheReceipt() public {
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(6)));
        bytes memory sig = _sign(r, signerKey);
        address thief = address(0xBAD);
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(ActionGuardAdapter.CallerMismatch.selector, caller, thief));
        adapter.execute(r, sig);
    }

    function test_DisallowedTargetIsRejected() public {
        // Without a target allowlist the adapter would be an arbitrary-call proxy.
        ProtectedVault rogue = new ProtectedVault(IERC20(address(asset)), address(adapter));
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(7)));
        r.target = address(rogue);
        r.operationDigest = adapter.computeOperationDigest(
            block.chainid,
            address(adapter),
            r.caller,
            r.target,
            r.asset,
            r.wrapper,
            r.actionType,
            r.recipient,
            r.amount,
            r.expectedMultiplierNonce
        );
        _expectRevertWith(
            r, signerKey, abi.encodeWithSelector(ActionGuardAdapter.TargetNotAllowed.selector, address(rogue))
        );
    }

    function test_UnauthorizedSignerIsRejected() public {
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(8)));
        uint256 rogueKey = 0xDEAD;
        bytes memory sig = _sign(r, rogueKey);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(ActionGuardAdapter.UnauthorizedSigner.selector, vm.addr(rogueKey)));
        adapter.execute(r, sig);
    }

    function test_RevokedSignerIsRejected() public {
        adapter.setAuthorizedSigner(signerAddr, false);
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(9)));
        _expectRevertWith(
            r, signerKey, abi.encodeWithSelector(ActionGuardAdapter.UnauthorizedSigner.selector, signerAddr)
        );
    }

    // --- validity window -------------------------------------------------------

    function test_ExpiredReceiptIsRejected() public {
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(10)));
        vm.warp(uint256(r.validUntil) + 1);
        _expectRevert(r, signerKey);
    }

    function test_ExpiryBoundIsInclusive() public {
        // At exactly validUntil the receipt is already expired. Ties block.
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(11)));
        vm.warp(uint256(r.validUntil));
        bytes memory sig = _sign(r, signerKey);
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(ActionGuardAdapter.ReceiptExpired.selector, r.validUntil, block.timestamp)
        );
        adapter.execute(r, sig);
    }

    function test_ValidOneSecondBeforeExpiry() public {
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(12)));
        vm.warp(uint256(r.validUntil) - 1);
        _execute(r);
        assertTrue(adapter.consumed(r.receiptId));
    }

    function test_NotYetValidReceiptIsRejected() public {
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(13)));
        r.validAfter = uint64(block.timestamp + 100);
        r.validUntil = uint64(block.timestamp + 400);
        r.operationDigest = adapter.computeOperationDigest(
            block.chainid,
            address(adapter),
            r.caller,
            r.target,
            r.asset,
            r.wrapper,
            r.actionType,
            r.recipient,
            r.amount,
            r.expectedMultiplierNonce
        );
        _expectRevert(r, signerKey);
    }

    // --- the corporate action itself -------------------------------------------

    function test_ScheduleInvalidatesAnOutstandingReceipt() public {
        // The whole product in one test: a receipt issued before a corporate action is
        // scheduled must stop working the moment the epoch advances.
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(14)));
        // Signed BEFORE the schedule, exactly as an integrator's receipt would be.
        bytes memory sig = _sign(r, signerKey);

        asset.scheduleMultiplier(2e18, block.timestamp + 10_000);

        // Read the new nonce BEFORE pranking: a call made while building the expectRevert
        // argument would consume the prank, which is the same trap as signing inline.
        uint256 advancedNonce = asset.newMultiplierNonce();
        assertEq(advancedNonce, r.expectedMultiplierNonce + 1, "scheduling must advance the epoch");

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                ActionGuardAdapter.MultiplierNonceMismatch.selector, r.expectedMultiplierNonce, advancedNonce
            )
        );
        adapter.execute(r, sig);
    }

    function test_OverrideInvalidatesTheReceiptAgain() public {
        asset.scheduleMultiplier(2e18, block.timestamp + 10_000);
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(15)));
        bytes memory sig = _sign(r, signerKey);

        // An override supersedes the pending schedule and advances the nonce again.
        asset.scheduleMultiplier(3e18, block.timestamp + 20_000);

        vm.prank(caller);
        vm.expectRevert();
        adapter.execute(r, sig);
    }

    function test_InsideGuardWindowIsRejected() public {
        uint256 activation = block.timestamp + 5_000;
        asset.scheduleMultiplier(2e18, activation);
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(16)));

        // Step into the window.
        vm.warp(activation - GUARD_BEFORE + 1);
        r.validAfter = uint64(block.timestamp - 1);
        r.validUntil = uint64(block.timestamp + 300);
        r.operationDigest = adapter.computeOperationDigest(
            block.chainid,
            address(adapter),
            r.caller,
            r.target,
            r.asset,
            r.wrapper,
            r.actionType,
            r.recipient,
            r.amount,
            r.expectedMultiplierNonce
        );

        _expectRevert(r, signerKey);
    }

    function test_GuardWindowStartIsInclusive() public {
        uint256 activation = block.timestamp + 5_000;
        asset.scheduleMultiplier(2e18, activation);
        vm.warp(activation - GUARD_BEFORE);

        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(17)));
        _expectRevert(r, signerKey);
    }

    function test_JustOutsideTheWindowSucceeds() public {
        uint256 activation = block.timestamp + 5_000;
        asset.scheduleMultiplier(2e18, activation);
        vm.warp(activation - GUARD_BEFORE - 1);

        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(18)));
        _execute(r);
        assertTrue(adapter.consumed(r.receiptId));
    }

    function test_PastWindowStillBlocksUntilScheduleIsApplied() public {
        uint256 activation = block.timestamp + 5_000;
        asset.scheduleMultiplier(2e18, activation);
        vm.warp(activation + GUARD_AFTER + 1);

        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(181)));
        _expectRevertWith(
            r,
            signerKey,
            abi.encodeWithSelector(ActionGuardAdapter.CorporateActionStillPending.selector, block.timestamp, activation)
        );

        asset.applyScheduledMultiplier();
        r = _receipt(bytes32(uint256(182)));
        _execute(r);
        assertTrue(adapter.consumed(r.receiptId));
    }

    function test_NoScheduleMeansNoWindow() public {
        // activation == 0 is the "no schedule" sentinel. Reading it as an instant would
        // place every action inside a window at the epoch and block everything.
        assertEq(asset.newMultiplierActivationTime(), 0);
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(19)));
        _execute(r);
        assertTrue(adapter.consumed(r.receiptId));
    }

    // --- wrapper relation ------------------------------------------------------

    function test_WrapperPointingAtAnotherAssetIsRejected() public {
        FixtureAsset other = new FixtureAsset("Other", "OTH", admin, 1e18);
        FixtureWrapper badWrapper = new FixtureWrapper(address(other), "Bad", "BAD", 2);
        adapter.setProtectedPair(address(asset), address(badWrapper));

        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(20)));
        r.wrapper = address(badWrapper);
        r.operationDigest = adapter.computeOperationDigest(
            block.chainid,
            address(adapter),
            r.caller,
            r.target,
            r.asset,
            r.wrapper,
            r.actionType,
            r.recipient,
            r.amount,
            r.expectedMultiplierNonce
        );

        bytes memory sig = _sign(r, signerKey);
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(ActionGuardAdapter.WrapperAssetMismatch.selector, address(other), address(asset))
        );
        adapter.execute(r, sig);
    }

    // --- shape and administration ---------------------------------------------

    function test_ZeroAmountIsRejected() public {
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(21)));
        r.amount = 0;
        _expectRevertWith(r, signerKey, abi.encodeWithSelector(ActionGuardAdapter.ZeroAmount.selector));
    }

    function test_ZeroRecipientIsRejected() public {
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(22)));
        r.recipient = address(0);
        _expectRevertWith(r, signerKey, abi.encodeWithSelector(ActionGuardAdapter.ZeroAddress.selector));
    }

    function test_WrongSchemaVersionIsRejected() public {
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(23)));
        r.schemaVersion = 2;
        _expectRevertWith(r, signerKey, abi.encodeWithSelector(ActionGuardAdapter.SchemaVersionMismatch.selector, 2, 1));
    }

    function test_PauseBlocksNewActions() public {
        adapter.setPaused(true);
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(24)));
        _expectRevertWith(r, signerKey, abi.encodeWithSelector(ActionGuardAdapter.Paused.selector));
    }

    function test_PauseDoesNotTrapExistingVaultBalances() public {
        // An emergency stop that confiscates converts an availability incident into a
        // solvency one. The balance owner retains a direct, narrowly scoped escape path.
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(25)));
        _execute(r);
        uint256 credited = vault.balanceOf(recipient);

        adapter.setPaused(true);
        vm.prank(recipient);
        vault.withdraw(credited, recipient);

        assertEq(vault.balanceOf(recipient), 0, "withdrawal did not debit the owner");
        assertEq(asset.balanceOf(recipient), credited, "paused escape withdrawal did not transfer assets");
        assertEq(asset.balanceOf(address(vault)), 0, "vault retained withdrawn assets");
    }

    function test_OwnershipTransferIsTwoStep() public {
        address newOwner = address(0xC0FFEE);
        adapter.transferOwnership(newOwner);
        // Not yet the owner: a single-step transfer to a wrong address is unrecoverable.
        assertEq(adapter.owner(), admin);
        vm.prank(newOwner);
        adapter.acceptOwnership();
        assertEq(adapter.owner(), newOwner);
    }

    function test_OnlyOwnerCanAuthorizeASigner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert();
        adapter.setAuthorizedSigner(address(0xBAD), true);
    }

    // --- direct-call bypass ----------------------------------------------------

    function test_VaultRejectsDirectCalls() public {
        // Protected state changes are reachable only through the guard.
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(ProtectedVault.OnlyAdapter.selector, caller));
        vault.performProtectedAction(1, caller, recipient, AMOUNT);
    }

    function test_DirectErc20TransferBypassesTheGuardEntirely() public {
        // This is the honest boundary, asserted rather than merely documented: a holder
        // can move the token without touching the adapter. The guard protects paths that
        // route through it, and nothing else.
        uint256 before = asset.balanceOf(address(0xF00D));
        vm.prank(caller);
        asset.transfer(address(0xF00D), 1e18);
        assertEq(asset.balanceOf(address(0xF00D)), before + 1e18, "direct transfer should succeed");
    }

    // --- invariants ------------------------------------------------------------

    function test_ConsumedReceiptCanNeverBecomeUnconsumed() public {
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(26)));
        _execute(r);
        assertTrue(adapter.consumed(r.receiptId));

        // There is no function that clears the flag. Re-running every admin path leaves it.
        adapter.setPaused(true);
        adapter.setPaused(false);
        adapter.setGuardWindow(1, 1);
        adapter.setAuthorizedSigner(signerAddr, false);
        adapter.setAuthorizedSigner(signerAddr, true);
        assertTrue(adapter.consumed(r.receiptId), "a consumed receipt became unconsumed");
    }

    function test_NoStateChangeAfterAFailedGuard() public {
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(27)));
        asset.scheduleMultiplier(2e18, block.timestamp + 10_000);

        uint256 vaultBefore = asset.balanceOf(address(vault));
        uint256 balanceBefore = vault.balanceOf(recipient);

        _expectRevert(r, signerKey);

        assertEq(asset.balanceOf(address(vault)), vaultBefore, "assets moved despite a failed guard");
        assertEq(vault.balanceOf(recipient), balanceBefore, "balance changed despite a failed guard");
        assertFalse(adapter.consumed(r.receiptId), "receipt consumed despite a failed guard");
    }

    // --- fuzz ------------------------------------------------------------------

    function testFuzz_AnyMutatedAmountIsRejected(uint256 mutatedAmount) public {
        vm.assume(mutatedAmount != AMOUNT && mutatedAmount != 0);
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(28)));
        bytes memory sig = _sign(r, signerKey);
        r.amount = mutatedAmount;
        vm.prank(caller);
        vm.expectRevert();
        adapter.execute(r, sig);
    }

    function testFuzz_AnyMutatedRecipientIsRejected(address mutatedRecipient) public {
        vm.assume(mutatedRecipient != recipient && mutatedRecipient != address(0));
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(29)));
        bytes memory sig = _sign(r, signerKey);
        r.recipient = mutatedRecipient;
        vm.prank(caller);
        vm.expectRevert();
        adapter.execute(r, sig);
    }

    function testFuzz_AnyUnauthorizedKeyIsRejected(uint256 rogueKey) public {
        rogueKey = bound(rogueKey, 1, type(uint128).max);
        vm.assume(vm.addr(rogueKey) != signerAddr);
        ActionGuardAdapter.Receipt memory r = _receipt(bytes32(uint256(30)));
        _expectRevert(r, rogueKey);
    }
}
