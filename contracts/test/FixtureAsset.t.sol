// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FixtureAsset} from "../src/fixtures/FixtureAsset.sol";
import {FixtureWrapper} from "../src/fixtures/FixtureWrapper.sol";

contract FixtureAssetTest is Test {
    FixtureAsset internal asset;
    FixtureWrapper internal wrapper;
    FixtureWrapper internal legacyWrapper;
    address internal admin = address(this);
    address internal other = address(0xB0B);

    function setUp() public {
        vm.chainId(1952);
        vm.warp(1_800_000_000);
        asset = new FixtureAsset("Fixture Asset", "FIXA", admin, 1e18);
        wrapper = new FixtureWrapper(address(asset), "Wrapped Fixture", "wFIXA", 2);
        legacyWrapper = new FixtureWrapper(address(asset), "Legacy Fixture", "lFIXA", 1);
    }

    // --- it says what it is ----------------------------------------------------

    function test_IdentifiesItselfAsAFixtureOnChain() public view {
        // An explorer viewer must not be able to mistake this for a production asset.
        assertEq(asset.FIXTURE_LABEL(), "TESTNET FIXTURE - NOT A REAL ASSET");
        assertEq(wrapper.FIXTURE_LABEL(), "TESTNET FIXTURE - NOT A REAL WRAPPER");
    }

    function test_RefusesToExistOnMainnet() public {
        vm.chainId(196);
        vm.expectRevert(abi.encodeWithSelector(FixtureAsset.WrongChain.selector, 196, 1952));
        new FixtureAsset("Bad", "BAD", admin, 1e18);
    }

    function test_WrapperRefusesToExistOnMainnet() public {
        vm.chainId(196);
        vm.expectRevert(abi.encodeWithSelector(FixtureWrapper.WrongChain.selector, 196, 1952));
        new FixtureWrapper(address(asset), "Bad", "BAD", 2);
    }

    // --- the verified read surface --------------------------------------------

    function test_ExposesTheVerifiedCorporateActionSurface() public view {
        // Matches what was verified live on the production token on 2026-09-03.
        assertEq(asset.getCurrentMultiplier(), 1e18);
        assertEq(asset.newMultiplier(), 1e18);
        assertEq(asset.newMultiplierNonce(), 0);
        assertEq(asset.newMultiplierActivationTime(), 0, "0 is the no-schedule sentinel");
    }

    function test_WrapperExposesAssetButNotTheMultiplierSurface() public view {
        // The production wrapper reverts on the multiplier functions. The fixture must not
        // expose a shape that does not exist in production, or the adapter could be
        // written against the wrong contract.
        assertEq(wrapper.asset(), address(asset));
        (bool ok,) = address(wrapper).staticcall(abi.encodeWithSignature("getCurrentMultiplier()"));
        assertFalse(ok, "the wrapper must not expose the multiplier surface");
    }

    // --- scheduling ------------------------------------------------------------

    function test_ScheduleAdvancesTheNonceImmediately() public {
        // Advancing the epoch at SCHEDULE time is what invalidates outstanding receipts —
        // before the change takes effect, not after.
        uint256 before = asset.newMultiplierNonce();
        asset.scheduleMultiplier(2e18, block.timestamp + 1_000);
        assertEq(asset.newMultiplierNonce(), before + 1);
        assertEq(asset.newMultiplier(), 2e18);
        assertEq(asset.getCurrentMultiplier(), 1e18, "current must not change until activation");
    }

    function test_ScheduleEmitsExactEventFields() public {
        vm.expectEmit(true, false, false, true, address(asset));
        emit FixtureAsset.MultiplierScheduled(1, 1e18, 2e18, block.timestamp + 1_000);
        asset.scheduleMultiplier(2e18, block.timestamp + 1_000);
    }

    function test_OverrideSupersedesAndAdvancesAgain() public {
        asset.scheduleMultiplier(2e18, block.timestamp + 1_000);
        uint256 supersededNonce = asset.newMultiplierNonce();

        vm.expectEmit(true, true, false, true, address(asset));
        emit FixtureAsset.MultiplierOverridden(supersededNonce, supersededNonce + 1, 3e18, block.timestamp + 2_000);
        asset.scheduleMultiplier(3e18, block.timestamp + 2_000);

        assertEq(asset.newMultiplier(), 3e18);
        assertEq(asset.newMultiplierNonce(), supersededNonce + 1);
    }

    function test_ScheduleInThePastIsRejected() public {
        // Scheduling backwards would let an operator skip the guard window entirely.
        vm.expectRevert(
            abi.encodeWithSelector(FixtureAsset.ActivationInPast.selector, block.timestamp, block.timestamp)
        );
        asset.scheduleMultiplier(2e18, block.timestamp);
    }

    function test_ZeroMultiplierIsRejected() public {
        vm.expectRevert(FixtureAsset.MultiplierMustBePositive.selector);
        asset.scheduleMultiplier(0, block.timestamp + 1_000);
    }

    function test_OnlyTheFixtureAdminMaySchedule() public {
        vm.prank(other);
        vm.expectRevert(FixtureAsset.NotFixtureAdmin.selector);
        asset.scheduleMultiplier(2e18, block.timestamp + 1_000);
    }

    // --- activation ------------------------------------------------------------

    function test_CannotApplyBeforeTheActivationTime() public {
        uint256 activation = block.timestamp + 1_000;
        asset.scheduleMultiplier(2e18, activation);
        vm.warp(activation - 1);
        vm.expectRevert(abi.encodeWithSelector(FixtureAsset.NotYetActive.selector, activation, block.timestamp));
        asset.applyScheduledMultiplier();
    }

    function test_AppliesExactlyAtTheActivationTime() public {
        uint256 activation = block.timestamp + 1_000;
        asset.scheduleMultiplier(2e18, activation);
        vm.warp(activation);
        asset.applyScheduledMultiplier();
        assertEq(asset.getCurrentMultiplier(), 2e18);
        assertEq(asset.newMultiplierActivationTime(), 0, "activation must clear to the sentinel");
    }

    function test_ApplyingIsPermissionlessButOnlyAfterTheCommittedTime() public {
        uint256 activation = block.timestamp + 1_000;
        asset.scheduleMultiplier(2e18, activation);
        vm.warp(activation + 1);
        // Anyone may push the state forward, but not earlier than the admin committed to.
        vm.prank(other);
        asset.applyScheduledMultiplier();
        assertEq(asset.getCurrentMultiplier(), 2e18);
    }

    function test_ApplyWithNoPendingScheduleIsRejected() public {
        vm.expectRevert(FixtureAsset.NoPendingMultiplier.selector);
        asset.applyScheduledMultiplier();
    }

    // --- faucet ----------------------------------------------------------------

    function test_FaucetIsCappedPerAddress() public {
        vm.startPrank(other);
        asset.faucet(asset.FAUCET_LIMIT_PER_ADDRESS());
        vm.expectRevert(abi.encodeWithSelector(FixtureAsset.FaucetLimitExceeded.selector, 1, 0));
        asset.faucet(1);
        vm.stopPrank();
    }

    // --- conversions -----------------------------------------------------------

    function test_ConversionsTrackTheCurrentMultiplier() public {
        assertEq(wrapper.convertToAssets(1e18), 1e18);
        asset.scheduleMultiplier(2e18, block.timestamp + 10);
        vm.warp(block.timestamp + 10);
        asset.applyScheduledMultiplier();
        assertEq(wrapper.convertToAssets(1e18), 2e18);
    }

    function test_LegacyWrapperIsDistinguishableOnChain() public view {
        assertEq(wrapper.wrapperVersion(), 2);
        assertEq(legacyWrapper.wrapperVersion(), 1);
        // Both point at the same asset; only the version distinguishes them.
        assertEq(legacyWrapper.asset(), wrapper.asset());
    }

    // --- invariants and fuzz ---------------------------------------------------

    function testFuzz_NonceIsStrictlyMonotonic(uint8 scheduleCount) public {
        scheduleCount = uint8(bound(scheduleCount, 1, 20));
        uint256 previous = asset.newMultiplierNonce();
        for (uint256 i = 0; i < scheduleCount; i++) {
            asset.scheduleMultiplier(1e18 + i + 1, block.timestamp + 1_000 + i);
            uint256 current = asset.newMultiplierNonce();
            assertGt(current, previous, "nonce must strictly increase, or an old receipt could revive");
            previous = current;
        }
    }

    function testFuzz_ConversionRoundTripsWithinOneUnit(uint128 amount, uint96 multiplier) public {
        vm.assume(multiplier > 0);
        uint256 m = uint256(multiplier) + 1e12;
        asset.scheduleMultiplier(m, block.timestamp + 10);
        vm.warp(block.timestamp + 10);
        asset.applyScheduledMultiplier();

        uint256 shares = wrapper.convertToShares(amount);
        uint256 back = wrapper.convertToAssets(shares);
        // Integer division loses at most one unit per conversion.
        assertLe(back, uint256(amount) + 1, "round trip gained value");
    }

    function testFuzz_CurrentMultiplierNeverChangesWithoutApply(uint96 newMult, uint32 delay) public {
        vm.assume(newMult > 0);
        delay = uint32(bound(delay, 1, 1_000_000));
        uint256 before = asset.getCurrentMultiplier();
        asset.scheduleMultiplier(uint256(newMult) + 1, block.timestamp + delay);
        assertEq(asset.getCurrentMultiplier(), before, "scheduling must not change the current multiplier");
    }
}
