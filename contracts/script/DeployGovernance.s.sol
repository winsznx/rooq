// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce) external returns (address proxy);
}

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

/// @notice Canonical Safe v1.4.1 deployments, checked on 46630 with `cast codesize` and `VERSION()` (spec-contracts.md section 2).
library SafeV141 {
    address internal constant SAFE_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
}

/// Creates the governance holders once per chain, reused across privacy deployments: a 2-of-3 governance Safe, a 1-of-3
/// veto Safe with the same owners, and a TimelockController (48 hours) that the governance Safe proposes to, cancels on and
/// executes from. The timelock administers itself, so changing its roles or delay is itself a 48-hour operation.
///   SAFE_OWNERS:     the three owner addresses, comma separated. Public addresses only; signer keys never touch this script.
///   GOVERNANCE_OUT:  output path, default deployments/governance-<chainid>.json.
/// On 31337 the Safe v1.4.1 contracts must already be at their canonical addresses (anvil_setCode); nothing here fakes them.
contract DeployGovernance is Script {
    uint256 public constant TIMELOCK_DELAY = 48 hours;
    uint256 public constant GOVERNANCE_THRESHOLD = 2;
    uint256 public constant VETO_THRESHOLD = 1;
    uint256 internal constant SALT_GOVERNANCE = uint256(keccak256("rooq.governance.safe.v1"));
    uint256 internal constant SALT_VETO = uint256(keccak256("rooq.governance.veto.v1"));

    function run() external returns (address timelock, address safe, address vetoSafe) {
        require(block.chainid == 31337 || block.chainid == 46630, "unsupported chain");
        require(SafeV141.SAFE_L2.code.length != 0 && SafeV141.PROXY_FACTORY.code.length != 0, "no Safe v1.4.1 at the canonical addresses");
        address[] memory owners = vm.envAddress("SAFE_OWNERS", ",");
        require(owners.length == 3, "SAFE_OWNERS must list three addresses");

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        safe = _safe(owners, GOVERNANCE_THRESHOLD, SALT_GOVERNANCE);
        vetoSafe = _safe(owners, VETO_THRESHOLD, SALT_VETO);
        address[] memory holders = new address[](1);
        holders[0] = safe;
        timelock = address(new TimelockController(TIMELOCK_DELAY, holders, holders, address(0)));
        vm.stopBroadcast();

        require(ISafe(safe).getThreshold() == GOVERNANCE_THRESHOLD && ISafe(vetoSafe).getThreshold() == VETO_THRESHOLD, "threshold mismatch");
        _write(timelock, safe, vetoSafe, owners);
        console2.log("TimelockController", timelock);
        console2.log("Governance Safe", safe);
        console2.log("Veto Safe", vetoSafe);
    }

    function _safe(address[] memory owners, uint256 threshold, uint256 salt) internal returns (address) {
        bytes memory init = abi.encodeCall(ISafe.setup, (owners, threshold, address(0), "", SafeV141.FALLBACK_HANDLER, address(0), 0, payable(address(0))));
        return ISafeProxyFactory(SafeV141.PROXY_FACTORY).createProxyWithNonce(SafeV141.SAFE_L2, init, salt);
    }

    function _write(address timelock, address safe, address vetoSafe, address[] memory owners) internal {
        string memory o = "governance";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "timelock", timelock);
        vm.serializeUint(o, "minDelay", TimelockController(payable(timelock)).getMinDelay());
        vm.serializeAddress(o, "safe", safe);
        vm.serializeUint(o, "safeThreshold", GOVERNANCE_THRESHOLD);
        vm.serializeAddress(o, "vetoSafe", vetoSafe);
        vm.serializeUint(o, "vetoThreshold", VETO_THRESHOLD);
        vm.serializeAddress(o, "safeSingleton", SafeV141.SAFE_L2);
        string memory json = vm.serializeAddress(o, "safeOwners", owners);
        string memory fallbackOut = string.concat("deployments/governance-", vm.toString(block.chainid), ".json");
        vm.writeJson(json, vm.envOr("GOVERNANCE_OUT", fallbackOut));
    }
}
