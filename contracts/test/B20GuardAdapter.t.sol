// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {B20GuardAdapter} from "../src/B20GuardAdapter.sol";
import {B20ProtectedVault} from "../src/B20ProtectedVault.sol";
import {B20FixtureAsset} from "../src/fixtures/B20FixtureAsset.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title B20GuardAdapterTest
/// @notice Adversarial tests for the B20 guard.
///
/// @dev The suite is organised around what an attacker, or an honest client with a stale
/// receipt, would actually try: present it twice, present it late, present it for a different
/// amount, present it after the multiplier moved, present it after a corporate action was
/// scheduled. Each has to fail with a named reason rather than an opaque revert.
///
/// The last test is the one that keeps the product honest: it asserts that a holder can
/// bypass the adapter entirely by calling the token directly. That is a *passing* test,
/// because the boundary is real and pretending otherwise would be the most expensive lie
/// this repository could tell.
contract B20GuardAdapterTest is Test {
    B20GuardAdapter internal adapter;
    B20ProtectedVault internal vault;
    B20FixtureAsset internal asset;

    uint256 internal constant SIGNER_KEY = 0xA11CE;
    address internal signer;
    address internal owner = address(0xB0B);
    address internal operator = address(0x09E);
    address internal alice = address(0xA11CE0);
    address internal bob = address(0xB0B0B0);
    address internal pauser = address(0xBA05E);
    address internal unpauser = address(0x0FF);

    uint256 internal constant ONE = 1e18;
    uint256 internal constant RAW = 100_000_000; // 1.0 token at 8 decimals

    function setUp() public {
        signer = vm.addr(SIGNER_KEY);
        vm.warp(1_788_776_091);

        vm.prank(operator);
        asset = new B20FixtureAsset(operator, 8);

        adapter = new B20GuardAdapter(owner, address(asset));
        vault = new B20ProtectedVault(IERC20(address(asset)), address(adapter), pauser, unpauser);

        vm.startPrank(owner);
        adapter.setAuthorizedSigner(signer, true);
        adapter.setAllowedTarget(address(vault), true);
        vm.stopPrank();

        vm.startPrank(operator);
        asset.mint(alice, RAW * 10);
        vm.stopPrank();

        vm.prank(alice);
        asset.approve(address(vault), type(uint256).max);
    }

    /* ------------------------------------------------------------------ */
    /* Helpers                                                             */
    /* ------------------------------------------------------------------ */

    function _receipt() internal view returns (B20GuardAdapter.Receipt memory r) {
        r = B20GuardAdapter.Receipt({
            schemaVersion: 1,
            receiptId: keccak256("receipt-1"),
            asset: address(asset),
            sender: alice,
            recipient: alice,
            actionClass: 4, // VAULT_DEPOSIT
            rawAmount: RAW,
            operationDigest: bytes32(0),
            activeMultiplierWad: ONE,
            pendingEffectiveAt: 0,
            feedProxy: address(0xFEED),
            feedRoundId: 42,
            priceBasis: 1, // TOTAL_RETURN_TOKEN_PRICE
            policyVersionHash: keccak256("2026-09-07.1"),
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 300)
        });
        r.operationDigest = adapter.computeOperationDigest(
            r.asset,
            r.sender,
            r.recipient,
            r.actionClass,
            r.rawAmount,
            address(vault),
            r.activeMultiplierWad,
            r.policyVersionHash
        );
    }

    function _sign(B20GuardAdapter.Receipt memory r) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(SIGNER_KEY, adapter.hashReceipt(r));
        return abi.encodePacked(rr, ss, v);
    }

    /// @dev The signature is computed *before* the prank. `_sign` calls `hashReceipt`, and a
    /// `vm.prank` applies to the next call — so signing inside the pranked expression would
    /// spend the prank on the hash read and send the execute from the test contract.
    function _execute(B20GuardAdapter.Receipt memory r) internal {
        bytes memory sig = _sign(r);
        vm.prank(r.sender);
        adapter.execute(r, sig, address(vault));
    }

    /* ------------------------------------------------------------------ */
    /* The happy path exists, so the refusals mean something                */
    /* ------------------------------------------------------------------ */

    function test_ValidReceiptExecutesExactlyOnce() public {
        B20GuardAdapter.Receipt memory r = _receipt();
        _execute(r);
        assertEq(vault.rawBalanceOf(alice), RAW, "raw units credited");
        assertTrue(adapter.consumed(r.receiptId), "receipt consumed");
    }

    function test_ReplayIsRefused() public {
        B20GuardAdapter.Receipt memory r = _receipt();
        _execute(r);
        bytes memory sig = _sign(r);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(B20GuardAdapter.ReceiptAlreadyConsumed.selector, r.receiptId));
        adapter.execute(r, sig, address(vault));
    }

    /* ------------------------------------------------------------------ */
    /* The corporate action that lands mid-flight                           */
    /* ------------------------------------------------------------------ */

    function test_MultiplierChangeAfterIssuanceRefusesTheReceipt() public {
        // The whole reason this product exists. The receipt authorized an operation sized
        // against multiplier 1.0; a split landed; the operation now means something else.
        B20GuardAdapter.Receipt memory r = _receipt();
        bytes memory sig = _sign(r);

        vm.prank(operator);
        asset.updateMultiplier(ONE * 10);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(B20GuardAdapter.MultiplierChanged.selector, ONE, ONE * 10));
        adapter.execute(r, sig, address(vault));
    }

    function test_ScheduleAppearingAfterIssuanceRefusesTheReceipt() public {
        // The receipt committed to "nothing was pending". That zero is a claim, and a
        // schedule that appeared since contradicts it even though the multiplier still matches.
        vm.prank(operator);
        asset.setScheduledSurfaceDialed(true);

        B20GuardAdapter.Receipt memory r = _receipt();
        bytes memory sig = _sign(r);

        uint256 effectiveAt = block.timestamp + 10_000;
        vm.prank(operator);
        asset.updateUIMultiplier(ONE * 2, effectiveAt);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(B20GuardAdapter.ScheduleAppeared.selector, uint64(0), effectiveAt));
        adapter.execute(r, sig, address(vault));
    }

    function test_UndialedScheduleSurfaceDoesNotBlockExecution() public {
        // Base mainnet today. The staticcall fails, which means the chain cannot answer —
        // not that a schedule exists. Refusing every receipt here would make the product
        // unusable on the only chain it targets; the short lifetime bounds the risk instead.
        assertFalse(asset.scheduledSurfaceDialed(), "surface starts undialed");
        assertFalse(adapter.scheduledSurfaceAvailable(), "adapter reports it unavailable");
        _execute(_receipt());
        assertEq(vault.rawBalanceOf(alice), RAW);
    }

    function test_PausedTransfersRefuseTheReceipt() public {
        B20GuardAdapter.Receipt memory r = _receipt();
        bytes memory sig = _sign(r);

        vm.prank(operator);
        asset.setPaused(0, true);

        vm.prank(alice);
        vm.expectRevert(B20GuardAdapter.TransfersPaused.selector);
        adapter.execute(r, sig, address(vault));
    }

    /* ------------------------------------------------------------------ */
    /* Every bound field                                                    */
    /* ------------------------------------------------------------------ */

    function test_ChangedAmountBreaksTheDigest() public {
        B20GuardAdapter.Receipt memory r = _receipt();
        bytes memory sig = _sign(r);
        r.rawAmount = RAW * 2;
        vm.prank(alice);
        vm.expectRevert();
        adapter.execute(r, sig, address(vault));
    }

    function test_ChangedRecipientBreaksTheDigest() public {
        B20GuardAdapter.Receipt memory r = _receipt();
        bytes memory sig = _sign(r);
        r.recipient = bob;
        vm.prank(alice);
        vm.expectRevert();
        adapter.execute(r, sig, address(vault));
    }

    function test_ChangedActionClassBreaksTheDigest() public {
        B20GuardAdapter.Receipt memory r = _receipt();
        bytes memory sig = _sign(r);
        r.actionClass = 5; // VAULT_WITHDRAW
        vm.prank(alice);
        vm.expectRevert();
        adapter.execute(r, sig, address(vault));
    }

    function test_WrongSchemaVersionIsRefused() public {
        B20GuardAdapter.Receipt memory r = _receipt();
        r.schemaVersion = 2;
        bytes memory sig = _sign(r);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(B20GuardAdapter.UnsupportedSchemaVersion.selector, uint16(2), uint16(1)));
        adapter.execute(r, sig, address(vault));
    }

    function test_UnauthorizedSignerIsRefused() public {
        B20GuardAdapter.Receipt memory r = _receipt();
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(0xBADBAD, adapter.hashReceipt(r));
        bytes memory sig = abi.encodePacked(rr, ss, v);
        vm.prank(alice);
        vm.expectRevert();
        adapter.execute(r, sig, address(vault));
    }

    function test_RevokedSignerIsRefusedImmediately() public {
        B20GuardAdapter.Receipt memory r = _receipt();
        bytes memory sig = _sign(r);
        vm.prank(owner);
        adapter.setAuthorizedSigner(signer, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(B20GuardAdapter.UnauthorizedSigner.selector, signer));
        adapter.execute(r, sig, address(vault));
    }

    function test_SomeoneElsePresentingTheReceiptIsRefused() public {
        // A receipt names its sender. Letting anyone present it would make it a bearer
        // instrument, and a leaked receipt would be a leaked authorization.
        B20GuardAdapter.Receipt memory r = _receipt();
        bytes memory sig = _sign(r);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(B20GuardAdapter.CallerIsNotSender.selector, bob, alice));
        adapter.execute(r, sig, address(vault));
    }

    function test_DisallowedTargetIsRefused() public {
        // Without the allowlist the adapter is an arbitrary-call proxy holding a signer.
        B20GuardAdapter.Receipt memory r = _receipt();
        bytes memory sig = _sign(r);
        vm.prank(owner);
        adapter.setAllowedTarget(address(vault), false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(B20GuardAdapter.TargetNotAllowed.selector, address(vault)));
        adapter.execute(r, sig, address(vault));
    }

    function test_WrongAssetIsRefused() public {
        vm.prank(operator);
        B20FixtureAsset other = new B20FixtureAsset(operator, 8);
        B20GuardAdapter.Receipt memory r = _receipt();
        r.asset = address(other);
        bytes memory sig = _sign(r);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(B20GuardAdapter.AssetMismatch.selector, address(other), address(asset)));
        adapter.execute(r, sig, address(vault));
    }

    /* ------------------------------------------------------------------ */
    /* The validity window                                                  */
    /* ------------------------------------------------------------------ */

    function test_ExpiredReceiptIsRefused() public {
        B20GuardAdapter.Receipt memory r = _receipt();
        bytes memory sig = _sign(r);
        vm.warp(r.expiresAt);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(B20GuardAdapter.ReceiptExpired.selector, r.expiresAt));
        adapter.execute(r, sig, address(vault));
    }

    function test_ValidOneSecondBeforeExpiry() public {
        B20GuardAdapter.Receipt memory r = _receipt();
        bytes memory sig = _sign(r);
        vm.warp(r.expiresAt - 1);
        vm.prank(alice);
        adapter.execute(r, sig, address(vault));
        assertEq(vault.rawBalanceOf(alice), RAW);
    }

    function test_ZeroAmountIsRefused() public {
        B20GuardAdapter.Receipt memory r = _receipt();
        r.rawAmount = 0;
        bytes memory sig = _sign(r);
        vm.prank(alice);
        vm.expectRevert(B20GuardAdapter.ZeroAmount.selector);
        adapter.execute(r, sig, address(vault));
    }

    function test_ZeroRecipientIsRefused() public {
        B20GuardAdapter.Receipt memory r = _receipt();
        r.recipient = address(0);
        bytes memory sig = _sign(r);
        vm.prank(alice);
        vm.expectRevert(B20GuardAdapter.ZeroRecipient.selector);
        adapter.execute(r, sig, address(vault));
    }

    /* ------------------------------------------------------------------ */
    /* Deployment boundary                                                  */
    /* ------------------------------------------------------------------ */

    function test_RefusesToDeployOnBaseMainnet() public {
        // A deployed contract that merely refused to execute would still be a mainnet
        // deployment claiming a boundary it did not hold.
        vm.chainId(8453);
        vm.expectRevert(abi.encodeWithSelector(B20GuardAdapter.MainnetDeploymentForbidden.selector, uint256(8453)));
        new B20GuardAdapter(owner, address(asset));
    }

    function test_DeploysOnBaseSepolia() public {
        vm.chainId(84_532);
        B20GuardAdapter fresh = new B20GuardAdapter(owner, address(asset));
        assertEq(fresh.protectedAsset(), address(asset));
    }

    /* ------------------------------------------------------------------ */
    /* The boundary this product must never overstate                       */
    /* ------------------------------------------------------------------ */

    function test_DirectTransferBypassesTheAdapter() public {
        // A PASSING test asserting the guard can be bypassed. A holder calling the token
        // directly never touches the adapter, and no receipt is required or checked.
        //
        // This is here so nobody can read the rest of the suite and conclude the product
        // blocks transfers on Base. It does not, it cannot, and claiming otherwise would be
        // the most expensive lie this repository could tell.
        uint256 before = asset.balanceOf(bob);
        vm.prank(alice);
        asset.transfer(bob, RAW);
        assertEq(asset.balanceOf(bob), before + RAW, "the direct transfer succeeded");
        assertEq(vault.rawBalanceOf(bob), 0, "and the vault never saw it");
    }
}
