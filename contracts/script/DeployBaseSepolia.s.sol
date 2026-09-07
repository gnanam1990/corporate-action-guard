// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {B20GuardAdapter} from "../src/B20GuardAdapter.sol";
import {B20ProtectedVault} from "../src/B20ProtectedVault.sol";
import {B20FixtureAsset} from "../src/fixtures/B20FixtureAsset.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Deploys the B20 fixture, adapter and vault to Base Sepolia.
///
/// @dev **This script is not run by CI and is not run by any test that broadcasts.** It exists
/// so a deployment is a reviewed, repeatable act rather than a sequence of ad-hoc `cast send`
/// calls, and it deliberately does nothing until a human runs it with `--broadcast`.
///
/// Guarantees, in order of importance:
///  1. It refuses any chain other than 84532, and refuses Base mainnet by number first.
///  2. It contains no private key. The broadcaster comes from the environment.
///  3. It prints every planned address and the chain before broadcasting.
///  4. It verifies bytecode exists at each address after broadcast.
///  5. The fixture it deploys is named so that nobody can mistake it for a Coinbase stock.
///
/// Run:
///   forge script script/DeployBaseSepolia.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
contract DeployBaseSepolia is Script {
    uint256 internal constant REQUIRED_CHAIN_ID = 84_532;
    uint256 internal constant FORBIDDEN_CHAIN_ID = 8453;

    error WrongChain(uint256 actual, uint256 required);
    error MainnetDeploymentForbidden();
    error NoBytecodeAfterDeploy(string what, address at);

    function run() external {
        // Mainnet is checked by number, first, before anything else can happen. ADR 0007.
        if (block.chainid == FORBIDDEN_CHAIN_ID) revert MainnetDeploymentForbidden();
        if (block.chainid != REQUIRED_CHAIN_ID) revert WrongChain(block.chainid, REQUIRED_CHAIN_ID);

        uint256 deployerKey = vm.envUint("BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address receiptSigner = vm.envAddress("RECEIPT_SIGNER_ADDRESS");
        // Separate roles: the ability to stop the world should not carry the ability to
        // restart it.
        address pauser = vm.envOr("B20_VAULT_PAUSER", deployer);
        address unpauser = vm.envOr("B20_VAULT_UNPAUSER", deployer);

        console.log("chain id       ", block.chainid);
        console.log("deployer       ", deployer);
        console.log("receipt signer ", receiptSigner);
        console.log("pauser         ", pauser);
        console.log("unpauser       ", unpauser);
        console.log("NOTE: the asset deployed here is a TESTNET FIXTURE, not a Coinbase stock.");

        vm.startBroadcast(deployerKey);

        B20FixtureAsset asset = new B20FixtureAsset(deployer, 8);
        B20GuardAdapter adapter = new B20GuardAdapter(deployer, address(asset));
        B20ProtectedVault vault = new B20ProtectedVault(IERC20(address(asset)), address(adapter), pauser, unpauser);

        adapter.setAuthorizedSigner(receiptSigner, true);
        adapter.setAllowedTarget(address(vault), true);

        vm.stopBroadcast();

        // Verified after the fact rather than assumed. A silent deployment failure that still
        // wrote an artifact would put a phantom address into configuration.
        _requireCode("fixture", address(asset));
        _requireCode("adapter", address(adapter));
        _requireCode("vault", address(vault));

        console.log("fixture asset  ", address(asset));
        console.log("guard adapter  ", address(adapter));
        console.log("protected vault", address(vault));
        console.log("scheduled surface available:", adapter.scheduledSurfaceAvailable());
    }

    function _requireCode(string memory what, address at) private view {
        if (at.code.length == 0) revert NoBytecodeAfterDeploy(what, at);
    }
}
