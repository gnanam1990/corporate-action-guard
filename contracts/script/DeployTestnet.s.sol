// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ActionGuardAdapter} from "../src/ActionGuardAdapter.sol";
import {ProtectedVault} from "../src/ProtectedVault.sol";
import {FixtureAsset} from "../src/fixtures/FixtureAsset.sol";
import {FixtureWrapper} from "../src/fixtures/FixtureWrapper.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Deploys the fixture, adapter, and vault to X Layer testnet.
///
/// @dev Guarantees, in order of importance:
///  1. It refuses any chain other than 1952. Mainnet is not merely discouraged here.
///  2. It contains no private key. The broadcaster comes from the environment.
///  3. It prints every planned address and the chain before broadcasting.
///  4. It verifies bytecode exists at each address AFTER broadcast.
///  5. It writes the deployment artifact only once all of the above have passed.
///
/// Run:
///   forge script script/DeployTestnet.s.sol --rpc-url $XLAYER_TESTNET_RPC_URL --broadcast
contract DeployTestnet is Script {
    uint256 internal constant REQUIRED_CHAIN_ID = 1952;
    uint256 internal constant FORBIDDEN_CHAIN_ID = 196;

    error WrongChain(uint256 actual, uint256 required);
    error MainnetDeploymentForbidden();
    error NoBytecodeAfterDeploy(string what, address at);

    function run() external {
        // (1) Chain gate, before anything else happens.
        if (block.chainid == FORBIDDEN_CHAIN_ID) revert MainnetDeploymentForbidden();
        if (block.chainid != REQUIRED_CHAIN_ID) revert WrongChain(block.chainid, REQUIRED_CHAIN_ID);

        // (2) The broadcaster is supplied by the environment. No key appears in source.
        uint256 deployerKey = vm.envUint("TESTNET_DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address receiptSigner = vm.envAddress("RECEIPT_SIGNER_ADDRESS");
        uint64 guardBefore = uint64(vm.envOr("GUARD_WINDOW_BEFORE_SECONDS", uint256(900)));
        uint64 guardAfter = uint64(vm.envOr("GUARD_WINDOW_AFTER_SECONDS", uint256(900)));

        // (3) Announce the plan before broadcasting anything.
        console.log("chain id        ", block.chainid);
        console.log("deployer        ", deployer);
        console.log("receipt signer  ", receiptSigner);
        console.log("guard window    ", guardBefore, guardAfter);
        console.log("--- broadcasting ---");

        vm.startBroadcast(deployerKey);

        FixtureAsset asset = new FixtureAsset("Guard Fixture Asset", "GFIX", deployer, 1e18);
        FixtureWrapper wrapper = new FixtureWrapper(address(asset), "Wrapped Guard Fixture", "wGFIX", 2);
        FixtureWrapper legacyWrapper = new FixtureWrapper(address(asset), "Legacy Guard Fixture", "lGFIX", 1);

        ActionGuardAdapter adapter =
            new ActionGuardAdapter(deployer, address(asset), address(wrapper), guardBefore, guardAfter);
        ProtectedVault vault = new ProtectedVault(IERC20(address(asset)), address(adapter));

        adapter.setAuthorizedSigner(receiptSigner, true);
        adapter.setAllowedTarget(address(vault), true);

        vm.stopBroadcast();

        // (4) Verify bytecode landed. A receipt is not proof a contract exists.
        _requireCode("FixtureAsset", address(asset));
        _requireCode("FixtureWrapper", address(wrapper));
        _requireCode("LegacyFixtureWrapper", address(legacyWrapper));
        _requireCode("ActionGuardAdapter", address(adapter));
        _requireCode("ProtectedVault", address(vault));

        // (5) Only now write the artifact.
        _writeArtifact(
            Deployed({
                deployer: deployer,
                asset: address(asset),
                wrapper: address(wrapper),
                legacyWrapper: address(legacyWrapper),
                adapter: address(adapter),
                vault: address(vault),
                receiptSigner: receiptSigner
            })
        );
    }

    /// @dev Grouped into a struct: assembling the artifact from separate locals exceeds
    /// the EVM stack depth.
    struct Deployed {
        address deployer;
        address asset;
        address wrapper;
        address legacyWrapper;
        address adapter;
        address vault;
        address receiptSigner;
    }

    function _writeArtifact(Deployed memory d) private {
        string memory artifact = string.concat(
            '{\n  "chainId": ',
            vm.toString(block.chainid),
            ',\n  "deployedAtBlock": ',
            vm.toString(block.number),
            ',\n  "deployer": "',
            vm.toString(d.deployer),
            '",\n  "fixtureAsset": "',
            vm.toString(d.asset),
            '",\n  "fixtureWrapper": "',
            vm.toString(d.wrapper),
            '",\n  "legacyFixtureWrapper": "',
            vm.toString(d.legacyWrapper),
            '",\n  "actionGuardAdapter": "',
            vm.toString(d.adapter),
            '",\n  "protectedVault": "',
            vm.toString(d.vault),
            '",\n  "receiptSigner": "',
            vm.toString(d.receiptSigner),
            '"\n}\n'
        );

        vm.writeFile("./deployments/xlayer-testnet.json", artifact);
        console.log("--- deployment artifact written ---");
        console.log(artifact);
    }

    function _requireCode(string memory what, address at) private view {
        if (at.code.length == 0) revert NoBytecodeAfterDeploy(what, at);
        console.log("verified bytecode", what, at);
    }
}
