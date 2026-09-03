// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployTestnet} from "../script/DeployTestnet.s.sol";
import {ActionGuardAdapter} from "../src/ActionGuardAdapter.sol";

/// @notice The chain gates are the part of deployment that must never regress.
contract DeployGuardsTest is Test {
    function test_DeployScriptRefusesMainnet() public {
        vm.chainId(196);
        DeployTestnet script = new DeployTestnet();
        vm.expectRevert(DeployTestnet.MainnetDeploymentForbidden.selector);
        script.run();
    }

    function test_DeployScriptRefusesAnUnknownChain() public {
        vm.chainId(31337);
        DeployTestnet script = new DeployTestnet();
        vm.expectRevert(abi.encodeWithSelector(DeployTestnet.WrongChain.selector, 31337, 1952));
        script.run();
    }

    function test_AdapterConstructorRefusesMainnet() public {
        vm.chainId(196);
        vm.expectRevert(ActionGuardAdapter.DeploymentOnMainnetForbidden.selector);
        new ActionGuardAdapter(address(this), address(0x1), address(0x2), 900, 900);
    }

    function test_AdapterRejectsZeroAddressPair() public {
        vm.chainId(1952);
        vm.expectRevert(ActionGuardAdapter.ZeroAddress.selector);
        new ActionGuardAdapter(address(this), address(0), address(0x2), 900, 900);
    }
}
