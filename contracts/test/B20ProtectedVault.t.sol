// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {B20ProtectedVault} from "../src/B20ProtectedVault.sol";
import {B20FixtureAsset} from "../src/fixtures/B20FixtureAsset.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title B20ProtectedVaultTest
/// @notice The vault's one job is to conserve raw units while the meaning of those units
/// changes underneath it.
///
/// @dev The fuzz test is the important one: a corporate action multiplies every holder's
/// share-equivalent by ten and moves not a single raw unit, and the vault must stay solvent
/// across that. A vault that stored share-equivalents would fail it, which is exactly why it
/// stores raw units and computes shares as a view.
contract B20ProtectedVaultTest is Test {
    B20ProtectedVault internal vault;
    B20FixtureAsset internal asset;

    address internal adapter = address(0xADA9);
    address internal operator = address(0x09E);
    address internal alice = address(0xA11CE0);
    address internal bob = address(0xB0B0B0);
    address internal pauser = address(0xBA05E);
    address internal unpauser = address(0x0FF);

    uint256 internal constant ONE = 1e18;
    uint256 internal constant RAW = 100_000_000;

    function setUp() public {
        vm.prank(operator);
        asset = new B20FixtureAsset(operator, 8);
        vault = new B20ProtectedVault(IERC20(address(asset)), adapter, pauser, unpauser);

        vm.prank(operator);
        asset.mint(alice, RAW * 100);
        vm.prank(alice);
        asset.approve(address(vault), type(uint256).max);
    }

    function _deposit(address who, uint256 amount) internal {
        vm.prank(adapter);
        vault.performB20Action(4, who, who, amount);
    }

    function test_OnlyTheAdapterCanMoveProtectedState() public {
        // The whole point of routing through the guard. A direct call skips every check the
        // adapter performs, so the vault must refuse it.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(B20ProtectedVault.OnlyAdapter.selector, alice));
        vault.performB20Action(4, alice, alice, RAW);
    }

    function test_DepositCreditsRawUnits() public {
        _deposit(alice, RAW);
        assertEq(vault.rawBalanceOf(alice), RAW);
        assertEq(vault.totalRawDeposited(), RAW);
        assertTrue(vault.solvent());
    }

    function test_ACorporateActionMovesNoRawUnits() public {
        // The defining behaviour. Shares go up tenfold; raw units and solvency do not move.
        _deposit(alice, RAW);
        uint256 rawBefore = vault.rawBalanceOf(alice);
        uint256 sharesBefore = vault.sharesOf(alice);

        vm.prank(operator);
        asset.updateMultiplier(ONE * 10);

        assertEq(vault.rawBalanceOf(alice), rawBefore, "raw units unchanged by the split");
        assertEq(vault.sharesOf(alice), sharesBefore * 10, "share equivalent scaled");
        assertTrue(vault.solvent(), "still solvent");
    }

    function test_WithdrawReturnsRawUnits() public {
        _deposit(alice, RAW);
        vm.prank(adapter);
        vault.performB20Action(5, alice, alice, RAW);
        assertEq(vault.rawBalanceOf(alice), 0);
        assertTrue(vault.solvent());
    }

    function test_CannotWithdrawMoreThanCredited() public {
        _deposit(alice, RAW);
        vm.prank(adapter);
        vm.expectRevert(abi.encodeWithSelector(B20ProtectedVault.InsufficientBalance.selector, RAW + 1, RAW));
        vault.performB20Action(5, alice, alice, RAW + 1);
    }

    function test_CannotWithdrawAnotherAccountsBalance() public {
        _deposit(alice, RAW);
        vm.prank(adapter);
        vm.expectRevert(abi.encodeWithSelector(B20ProtectedVault.InsufficientBalance.selector, RAW, 0));
        vault.performB20Action(5, bob, bob, RAW);
    }

    function test_UnsupportedActionClassIsRefused() public {
        vm.prank(adapter);
        vm.expectRevert(abi.encodeWithSelector(B20ProtectedVault.UnsupportedAction.selector, uint8(3)));
        vault.performB20Action(3, alice, alice, RAW);
    }

    function test_PauseAndUnpauseAreSeparateRoles() public {
        // One compromised key must not be able to pause, drain and unpause.
        vm.prank(pauser);
        vault.pause();
        assertTrue(vault.paused());

        vm.prank(pauser);
        vm.expectRevert(abi.encodeWithSelector(B20ProtectedVault.OnlyUnpauser.selector, pauser));
        vault.unpause();

        vm.prank(unpauser);
        vault.unpause();
        assertFalse(vault.paused());
    }

    function test_PausedVaultRefusesEverything() public {
        vm.prank(pauser);
        vault.pause();
        vm.prank(adapter);
        vm.expectRevert(B20ProtectedVault.VaultPaused.selector);
        vault.performB20Action(4, alice, alice, RAW);
    }

    /// @notice Assets held always cover every internal claim, across arbitrary activity.
    ///
    /// @dev Holds in raw units and would not hold in share-equivalents: the multiplier moves
    /// under a stored share count, and a vault crediting shares would become insolvent on the
    /// first reverse split without a single token leaving it.
    function testFuzz_SolventAcrossDepositsWithdrawalsAndCorporateActions(
        uint96 depositAmount,
        uint96 withdrawAmount,
        uint96 newMultiplier
    ) public {
        uint256 deposit = bound(uint256(depositAmount), 1, RAW * 50);
        _deposit(alice, deposit);

        uint256 multiplierWad = bound(uint256(newMultiplier), 1, ONE * 1000);
        vm.prank(operator);
        asset.updateMultiplier(multiplierWad);
        assertTrue(vault.solvent(), "a corporate action alone never breaks solvency");

        uint256 withdrawal = bound(uint256(withdrawAmount), 0, deposit);
        if (withdrawal > 0) {
            vm.prank(adapter);
            vault.performB20Action(5, alice, alice, withdrawal);
        }

        assertTrue(vault.solvent(), "solvent after withdrawal");
        assertEq(vault.rawBalanceOf(alice), deposit - withdrawal, "raw accounting exact");
        assertEq(vault.totalRawDeposited(), deposit - withdrawal, "total matches the sum");
    }
}
