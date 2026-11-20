// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {IHonkVerifier} from "../../src/privacy/ShieldedPool.sol";
import {IPriceSource, PrivatePairs} from "../../src/privacy/PrivatePairs.sol";
import {PairTypes} from "../../src/privacy/PairTypes.sol";
import {ModuleRegistry} from "../../src/privacy/ModuleRegistry.sol";
import {PrivacyVerifiers} from "../utils/PrivacyVerifiers.sol";
import {Grumpkin} from "../utils/Grumpkin.sol";
import {AcceptAllVerifier} from "../utils/MockVerifiers.sol";

contract NoPrices is IPriceSource {
    function getFreshPrice(bytes32) external pure returns (uint256) {
        revert("no price");
    }

    function getPrice(bytes32) external pure returns (uint256, uint256, bool) {
        return (0, 0, false);
    }
}

/// A module that tries everything custody might let it do.
contract ProbeModule {
    PrivatePairs public custody;

    constructor(PrivatePairs custody_) {
        custody = custody_;
    }

    function create(bytes32 commitment) external {
        custody.moduleCreate(1, commitment, new bytes32[](0));
    }

    function consume(bytes32 nf) external {
        custody.moduleConsume(nf);
    }

    function payBond() external {
        custody.payBond(1, address(this), 0);
    }

    function setKeys() external {
        custody.setOperatorKeys(PairTypes.KeySet(Grumpkin.point(5), Grumpkin.point(2), Grumpkin.point(3)));
    }

    function registerMarket() external {
        custody.registerMarket(PairTypes.MarketConfig(7, address(0), bytes32(0), 0.1e18, 0.05e18, 0, 0, 0, 1, 1, 0), 0);
    }

    function setCloseOnly() external {
        custody.setCloseOnly(1);
    }

    function setSweptHead() external {
        custody.setSweptHead(1, bytes32(0), new bytes32[](0));
    }
}

contract ModuleRegistryTest is Test {
    uint256 internal constant DELAY = 14 days;
    PrivatePairs internal custody;
    ModuleRegistry internal registry;
    MockERC20 internal usd;
    ProbeModule internal module;
    address internal timelock = makeAddr("timelock");
    address internal vetoSafe = makeAddr("vetoSafe");
    address internal markets = makeAddr("markets");
    address internal spot = makeAddr("spot");
    bytes32 internal constant MANIFEST = keccak256("manifest.json");

    function setUp() public {
        vm.warp(1_800_000_000);
        usd = new MockERC20("Test USDG", "tUSDG", 6, type(uint256).max);
        address[] memory assets = new address[](1);
        assets[0] = address(usd);
        PairTypes.Verifiers memory v = PrivacyVerifiers.pairs();
        v.exitRequest = IHonkVerifier(address(new AcceptAllVerifier()));
        IHonkVerifier app = PrivacyVerifiers.deploy("AppendVerifier");
        IHonkVerifier spend = PrivacyVerifiers.deploy("SpendVerifier");
        IPriceSource prices = new NoPrices();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        custody = new PrivatePairs(
            app, spend, assets, v, prices, Grumpkin.point(1), [Grumpkin.point(2), Grumpkin.point(3)], PairTypes.FeeRecipient(9, Grumpkin.point(4)),
            new PairTypes.MarketConfig[](0), PairTypes.Modules(spot, markets, predicted)
        );
        registry = new ModuleRegistry(custody, timelock, vetoSafe, DELAY);
        module = new ProbeModule(custody);
    }

    function _propose(address m) internal {
        vm.prank(timelock);
        registry.propose(m, MANIFEST);
    }

    function _activate(address m) internal {
        _propose(m);
        vm.warp(block.timestamp + DELAY);
        registry.activate(m);
    }

    function test_constructorRejectsDelayBelowFloor() public {
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.DelayTooShort.selector, 14 days - 1));
        new ModuleRegistry(custody, timelock, vetoSafe, 14 days - 1);
    }

    function test_constructorRejectsCustodyBuiltForAnotherRegistry() public {
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.WrongRegistry.selector, address(registry)));
        new ModuleRegistry(custody, timelock, vetoSafe, DELAY);
    }

    function test_proposeOnlyByProposer() public {
        vm.prank(vetoSafe);
        vm.expectRevert(ModuleRegistry.NotProposer.selector);
        registry.propose(address(module), MANIFEST);
        _propose(address(module));
        (bytes32 codehash, bytes32 manifest, uint64 activatesAt) = registry.pending(address(module));
        assertEq(codehash, address(module).codehash);
        assertEq(manifest, MANIFEST);
        assertEq(activatesAt, block.timestamp + DELAY);
    }

    function test_proposeRejectsCodelessOrForeignCustody() public {
        vm.startPrank(timelock);
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.NoCode.selector, address(0x1234)));
        registry.propose(address(0x1234), MANIFEST);
        ProbeModule foreign = new ProbeModule(PrivatePairs(address(0xbad)));
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.ForeignCustody.selector, address(foreign)));
        registry.propose(address(foreign), MANIFEST);
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.ForeignCustody.selector, address(usd)));
        registry.propose(address(usd), MANIFEST);
        vm.stopPrank();
    }

    function test_proposeRejectsDuplicatesAndExistingModules() public {
        _propose(address(module));
        vm.startPrank(timelock);
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.AlreadyPending.selector, address(module)));
        registry.propose(address(module), MANIFEST);
        vm.etch(markets, address(module).code);
        vm.store(markets, bytes32(0), bytes32(uint256(uint160(address(custody)))));
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.AlreadyModule.selector, markets));
        registry.propose(markets, MANIFEST);
        vm.stopPrank();
        vm.warp(block.timestamp + DELAY);
        registry.activate(address(module));
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.AlreadyModule.selector, address(module)));
        registry.propose(address(module), MANIFEST);
    }

    function test_activateBeforeDelayReverts() public {
        _propose(address(module));
        uint256 due = block.timestamp + DELAY;
        vm.warp(due - 1);
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.NotDue.selector, due, due - 1));
        registry.activate(address(module));
        assertFalse(custody.isModule(address(module)));
    }

    function test_activateAfterDelayAddsModule() public {
        _propose(address(module));
        vm.warp(block.timestamp + DELAY);
        vm.expectEmit(address(custody));
        emit PrivatePairs.ModuleAdded(address(module));
        registry.activate(address(module));
        assertTrue(custody.isModule(address(module)));
        assertEq(registry.moduleCount(), 1);
        assertEq(registry.modules(0), address(module));
        (,, uint64 activatesAt) = registry.pending(address(module));
        assertEq(activatesAt, 0);
    }

    function test_activateIsPermissionless() public {
        _propose(address(module));
        vm.warp(block.timestamp + DELAY);
        vm.prank(makeAddr("anyone"));
        registry.activate(address(module));
        assertTrue(custody.isModule(address(module)));
    }

    function test_activateRequiresAProposal() public {
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.NotPending.selector, address(module)));
        registry.activate(address(module));
    }

    function test_withdrawOnlyByProposer() public {
        _propose(address(module));
        vm.prank(vetoSafe);
        vm.expectRevert(ModuleRegistry.NotProposer.selector);
        registry.withdraw(address(module));
        vm.prank(timelock);
        registry.withdraw(address(module));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.NotPending.selector, address(module)));
        registry.activate(address(module));
        _propose(address(module));
    }

    function test_vetoBlocksActivation() public {
        _propose(address(module));
        vm.prank(timelock);
        vm.expectRevert(ModuleRegistry.NotVetoer.selector);
        registry.veto(address(module));
        vm.prank(vetoSafe);
        registry.veto(address(module));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.NotPending.selector, address(module)));
        registry.activate(address(module));
        assertFalse(custody.isModule(address(module)));
    }

    function test_vetoedAddressCannotBeReproposed() public {
        _propose(address(module));
        vm.prank(vetoSafe);
        registry.veto(address(module));
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.Vetoed.selector, address(module)));
        registry.propose(address(module), MANIFEST);
    }

    function test_activateRejectsChangedCodehash() public {
        _propose(address(module));
        bytes32 pinned = address(module).codehash;
        vm.etch(address(module), address(usd).code);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.CodeChanged.selector, address(module), pinned, address(usd).codehash));
        registry.activate(address(module));
    }

    /// Audit re-check: an EIP-7702 delegated EOA has 23 bytes of code naming a reviewed contract and answers `custody()`, but its
    /// code hash pins only the designator and its key holder can call custody directly. The registry refuses it.
    function test_proposeRejectsEip7702DelegatedAccount() public {
        vm.setEvmVersion("prague");
        (address eoa, uint256 pk) = makeAddrAndKey("eoa-module");
        vm.signAndAttachDelegation(address(module), pk);
        assertEq(eoa.code.length, 23, "7702 designator");
        assertEq(address(ProbeModule(eoa).custody()), address(0), "delegate storage is the EOA's");
        vm.store(eoa, bytes32(0), bytes32(uint256(uint160(address(custody)))));
        assertEq(address(ProbeModule(eoa).custody()), address(custody), "answers custody() like the reviewed module");
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.DelegatedAccount.selector, eoa));
        registry.propose(eoa, MANIFEST);
        (,, uint64 activatesAt) = registry.pending(eoa);
        assertEq(activatesAt, 0);
        assertFalse(custody.isModule(eoa));
    }

    /// The same check runs at activation, so a designator that appears at a pending address after proposal cannot activate.
    function test_activateRejectsEip7702Designator() public {
        _propose(address(module));
        vm.etch(address(module), abi.encodePacked(hex"ef0100", address(module)));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.DelegatedAccount.selector, address(module)));
        registry.activate(address(module));
        assertFalse(custody.isModule(address(module)));
    }

    /// 23 bytes of ordinary code that do not start with the designator prefix are not refused as delegation.
    function test_proposeAccepts23ByteCodeWithoutDesignatorPrefix() public {
        bytes memory code = abi.encodePacked(hex"ef0200", address(module));
        address odd = makeAddr("odd");
        vm.etch(odd, code);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.ForeignCustody.selector, odd));
        registry.propose(odd, MANIFEST);
    }

    function test_registryHasNoRemoveOrPauseSelector() public {
        string[6] memory absent = ["remove(address)", "removeModule(address)", "pause()", "unpause()", "setDelay(uint256)", "deactivate(address)"];
        for (uint256 i; i < absent.length; i++) {
            vm.prank(timelock);
            (bool ok,) = address(registry).call(abi.encodeWithSignature(absent[i], address(module)));
            assertFalse(ok, absent[i]);
        }
        (bool removed,) = address(custody).call(abi.encodeWithSignature("removeModule(address)", address(module)));
        assertFalse(removed);
    }

    function test_addModuleOnlyFromRegistry() public {
        for (uint256 i; i < 3; i++) {
            vm.prank([timelock, markets, spot][i]);
            vm.expectRevert(PrivatePairs.NotModule.selector);
            custody.addModule(address(module));
        }
    }

    function test_addedModuleCanConsumeAndCreate() public {
        _activate(address(module));
        uint256 before = custody.queueLength();
        module.create(bytes32(uint256(3)));
        assertEq(custody.queueLength(), before + 1);
        module.consume(bytes32(uint256(4)));
        assertTrue(custody.nullifierSpent(bytes32(uint256(4))));
    }

    function test_addedModuleCannotPayBondOrSetKeysOrRegisterMarket() public {
        _activate(address(module));
        vm.expectRevert(PrivatePairs.NotModule.selector);
        module.payBond();
        vm.expectRevert(PrivatePairs.NotModule.selector);
        module.setKeys();
        vm.expectRevert(PrivatePairs.NotModule.selector);
        module.registerMarket();
        vm.expectRevert(PrivatePairs.NotModule.selector);
        module.setCloseOnly();
        vm.expectRevert(PrivatePairs.NotModule.selector);
        module.setSweptHead();
    }

    /// A pending module has no power over custody, and owner exits do not consult the registry.
    function test_exitsWorkWhileMaliciousModulePending() public {
        _propose(address(module));
        vm.expectRevert(PrivatePairs.NotSpotModule.selector);
        module.create(bytes32(uint256(3)));
        vm.expectRevert(PrivatePairs.NotSpotModule.selector);
        module.consume(bytes32(uint256(4)));
        address owner = makeAddr("owner");
        vm.deal(owner, 1 ether);
        bytes32 pairNullifier = bytes32(uint256(11));
        bytes32 root = custody.EMPTY_ROOT();
        uint256 bond = custody.EXIT_BOND();
        vm.prank(owner);
        custody.requestExit{value: bond}("", root, pairNullifier);
        (address requester, uint64 matureAt) = custody.exitRequests(pairNullifier);
        assertEq(requester, owner);
        assertLt(matureAt, block.timestamp + DELAY, "a forced exit matures before the module can activate");
    }
}
