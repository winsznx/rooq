// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {DeployGovernance, SafeV141} from "../../script/DeployGovernance.s.sol";
import {OracleAdapter} from "../../src/oracle/OracleAdapter.sol";
import {MockPriceFeed} from "../../src/oracle/MockPriceFeed.sol";
import {MockERC20} from "../../src/tokens/MockERC20.sol";
import {DeployPrivatePairs} from "../../script/DeployPrivatePairs.s.sol";
import {Grumpkin} from "../utils/Grumpkin.sol";
import {MockSafe, MockSafeProxyFactory} from "../utils/MockSafe.sol";

/// The deployed contracts are read through these rather than imported: importing PrivatePairs would put this file, and the
/// verifiers the deploy script imports, into the via-IR compilation.
/// @dev The fields of PairTypes.Market this test reads, in ABI order.
struct MarketView {
    address asset;
    bytes32 feedId;
    uint256 scale;
    uint256 imrWad;
    uint256 mmrWad;
    uint256 penaltyBps;
    uint256 maxFundingPerHourWad;
    uint256 takerFeeBps;
    uint256 maxOiUsdWad;
    uint256 maxPairSize;
    uint256 maxCloseSpreadBps;
}

interface ICustody {
    function oracle() external view returns (address);
    function deploymentId() external view returns (uint256);
    function market(uint256 id) external view returns (MarketView memory);
    function spotModule() external view returns (address);
    function marketsModule() external view returns (address);
    function moduleRegistry() external view returns (address);
    function isModule(address) external view returns (bool);
    function closeOnly(uint256) external view returns (bool);
}

interface IMarkets {
    error NotKeyGuardian();

    function keyScheduler() external view returns (address);
    function keyCanceller() external view returns (address);
    function keyGuardian() external view returns (address);
    function feedTaken(bytes32) external view returns (bool);
    function closeGenesisMarket(uint256 id) external;
}

interface IRegistry {
    function proposer() external view returns (address);
    function vetoer() external view returns (address);
    function delay() external view returns (uint256);
    function custody() external view returns (address);
}

/// Runs DeployGovernance and DeployPrivatePairs end to end, with Safe v1.4.1 stood in by MockSafe at the canonical addresses,
/// and checks every row of the governance table in spec-contracts.md section 2 against the deployed state.
contract GovernanceDeployTest is Test {
    uint256 internal constant DEPLOYER_KEY = 0xD3910;
    bytes32 internal constant FEED = keccak256("ROOQ:private-v1:TEST/USD");
    bytes32 internal constant OTHER_FEED = keccak256("OTHER/USD");
    bytes32 internal constant CREATABLE_FEED = keccak256("ROOQ:private-v1:CREATABLE/USD");

    address internal deployer = vm.addr(DEPLOYER_KEY);
    address internal ownerA = makeAddr("signer-1");
    address internal ownerB = makeAddr("signer-2");
    address internal ownerC = makeAddr("signer-3");
    TimelockController internal timelock;
    MockSafe internal safe;
    MockSafe internal vetoSafe;
    ICustody internal pool;
    address internal spot;
    IMarkets internal markets;
    IRegistry internal registry;
    OracleAdapter internal oracle;
    address internal predictedPool;
    uint256 internal predictedDeploymentId;

    function setUp() public {
        vm.etch(SafeV141.PROXY_FACTORY, type(MockSafeProxyFactory).runtimeCode);
        vm.etch(SafeV141.SAFE_L2, type(MockSafe).runtimeCode);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(bytes32(DEPLOYER_KEY)));
        vm.setEnv("SAFE_OWNERS", string.concat(vm.toString(ownerA), ",", vm.toString(ownerB), ",", vm.toString(ownerC)));
        vm.setEnv("GOVERNANCE_OUT", "deployments/governance.dryrun.json");
        (address t, address s, address v) = new DeployGovernance().run();
        timelock = TimelockController(payable(t));
        safe = MockSafe(s);
        vetoSafe = MockSafe(v);

        vm.setEnv("TIMELOCK", vm.toString(t));
        vm.setEnv("GUARDIAN_SAFE", vm.toString(s));
        vm.setEnv("VETO_SAFE", vm.toString(v));
        _setPoint("COORDINATOR", 1);
        _setPoint("RISK_A", 2);
        _setPoint("RISK_B", 3);
        _setPoint("FEE", 4);
        vm.setEnv("FEE_AUTH", "9");
        // Real key_pop proofs for points 1-4, bound to the custody address this deterministic run creates (0xaC33...9f72 on
        // 31337). A change to the script's deployment order moves that address, and the proofs must be made again for the new
        // deployment id with nargo execute and bb prove on zk/circuits/key_pop.
        vm.setEnv("PRIVACY_POP_DIR", "test/vectors/key_pop/governance");
        vm.setEnv("PRIVACY_OUT", "deployments/roles.dryrun.json");
        uint256 beforePrediction = vm.snapshotState();
        (address predicted, uint256 predictedId) = new DeployPrivatePairs().predictCustody();
        vm.revertToState(beforePrediction);
        (predictedPool, predictedDeploymentId) = (predicted, predictedId);
        (address p, address s2, address m, address r) = new DeployPrivatePairs().run();
        (pool, spot, markets, registry) = (ICustody(p), s2, IMarkets(m), IRegistry(r));
        oracle = OracleAdapter(pool.oracle());
    }

    function _setPoint(string memory name, uint256 i) internal {
        vm.setEnv(string.concat(name, "_X"), vm.toString(Grumpkin.point(i).x));
        vm.setEnv(string.concat(name, "_Y"), vm.toString(Grumpkin.point(i).y));
    }

    function test_roleManifest() public view {
        assertEq(safe.getThreshold(), 2, "governance Safe 2-of-3");
        assertEq(vetoSafe.getThreshold(), 1, "veto Safe 1-of-3");
        assertEq(safe.getOwners().length, 3);
        assertEq(vetoSafe.getOwners().length, 3);
        // 1-3: oracle admin is the timelock, revoke also sits with the Safe.
        assertEq(oracle.admin(), address(timelock));
        assertEq(oracle.guardian(), address(safe));
        // 4-6: key scheduling and genesis close through the timelock, cancel with the Safe.
        assertEq(markets.keyScheduler(), address(timelock));
        assertEq(markets.keyCanceller(), address(safe));
        assertEq(markets.keyGuardian(), address(timelock));
        // 7-8: registry proposals from the timelock, veto with the 1-of-3 Safe, 14-day delay.
        assertEq(registry.proposer(), address(timelock));
        assertEq(registry.vetoer(), address(vetoSafe));
        assertEq(registry.delay(), 14 days);
        // 11-12: custody controls stay with the fixed modules; the registry is the only adder.
        assertEq(pool.marketsModule(), address(markets));
        assertEq(pool.spotModule(), spot);
        assertEq(pool.moduleRegistry(), address(registry));
        assertEq(address(registry.custody()), address(pool));
        // Timelock: 48 hours, the Safe proposes, cancels and executes.
        assertEq(timelock.getMinDelay(), 48 hours);
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), address(safe)));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), address(safe)));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(safe)));
        assertFalse(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)), "execution is not open");
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), address(vetoSafe)));
    }

    function test_deployerHoldsNothing() public view {
        bytes32[4] memory roles = [timelock.DEFAULT_ADMIN_ROLE(), timelock.PROPOSER_ROLE(), timelock.EXECUTOR_ROLE(), timelock.CANCELLER_ROLE()];
        for (uint256 i; i < roles.length; i++) assertFalse(timelock.hasRole(roles[i], deployer));
        address[6] memory holders = [oracle.admin(), oracle.guardian(), markets.keyScheduler(), markets.keyCanceller(), registry.proposer(), registry.vetoer()];
        for (uint256 i; i < holders.length; i++) assertTrue(holders[i] != deployer);
        address[] memory owners = safe.getOwners();
        for (uint256 i; i < owners.length; i++) assertTrue(owners[i] != deployer);
        assertFalse(pool.isModule(deployer));
    }

    function test_timelockSelfAdministered() public {
        assertTrue(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(timelock)));
        bytes32 proposer = timelock.PROPOSER_ROLE();
        bytes32 admin = timelock.DEFAULT_ADMIN_ROLE();
        vm.prank(address(safe));
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, address(safe), admin));
        timelock.grantRole(proposer, ownerA);

        bytes memory grant = abi.encodeCall(timelock.grantRole, (proposer, ownerA));
        _schedule(address(timelock), grant);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        _execute(address(timelock), grant);
        assertTrue(timelock.hasRole(proposer, ownerA));
    }

    function _schedule(address target, bytes memory data) internal {
        vm.prank(ownerA);
        safe.exec(address(timelock), abi.encodeCall(timelock.schedule, (target, 0, data, bytes32(0), bytes32(0), 48 hours)));
    }

    function _execute(address target, bytes memory data) internal {
        vm.prank(ownerB);
        safe.exec(address(timelock), abi.encodeCall(timelock.execute, (target, 0, data, bytes32(0), bytes32(0))));
    }

    function test_closeGenesisMarketWaitsForTheTimelock() public {
        bytes memory close = abi.encodeCall(markets.closeGenesisMarket, (1));
        vm.prank(ownerA);
        vm.expectRevert(IMarkets.NotKeyGuardian.selector);
        safe.exec(address(markets), close);
        _schedule(address(markets), close);
        vm.warp(vm.getBlockTimestamp() + 48 hours - 1);
        vm.expectRevert();
        _execute(address(markets), close);
        vm.warp(vm.getBlockTimestamp() + 1);
        _execute(address(markets), close);
        assertTrue(pool.closeOnly(1));
    }

    function test_safeRevokesFeedInstantly() public {
        vm.prank(ownerA);
        safe.exec(address(oracle), abi.encodeCall(oracle.revokeFeed, (FEED)));
        assertFalse(oracle.isApproved(FEED));
        vm.prank(ownerA);
        vm.expectRevert(OracleAdapter.NotAdmin.selector);
        safe.exec(address(oracle), abi.encodeCall(oracle.reinstateFeed, (FEED)));
    }

    function test_deployRegistersPerpFeedsWithOneHourHeartbeat() public view {
        bytes32[3] memory feeds = [FEED, OTHER_FEED, CREATABLE_FEED];
        for (uint256 i; i < feeds.length; i++) {
            OracleAdapter.FeedConfig memory f = oracle.feedConfig(feeds[i]);
            assertTrue(f.approved);
            assertEq(f.heartbeat, 1 hours);
        }
    }

    /// Key holders prove possession against this prediction before the deploy, so it must be exactly what `run` creates.
    function test_predictCustodyMatchesTheDeployment() public view {
        assertEq(predictedPool, address(pool));
        assertEq(predictedDeploymentId, pool.deploymentId());
    }

    function test_genesisFeedsTakenAndCreatableFeedFree() public view {
        assertTrue(markets.feedTaken(FEED));
        assertTrue(markets.feedTaken(OTHER_FEED));
        assertFalse(markets.feedTaken(CREATABLE_FEED));
    }

    /// The 46630 branch: one-hour perp feeds approved in the oracle constructor, then handed to the relay, so the deployer keeps
    /// neither oracle admin nor a feed.
    function test_testnetBranchHandsFeedsToRelayAndKeepsGovernance() public {
        vm.chainId(46630);
        address relay = makeAddr("relay");
        address usdg = address(new MockERC20("USDG", "USDG", 6, 1));
        address tsla = address(new MockERC20("TSLA", "TSLA", 18, 1));
        address amzn = address(new MockERC20("AMZN", "AMZN", 18, 1));
        vm.setEnv("PRIVACY_ASSET", vm.toString(usdg));
        vm.setEnv("PRIVACY_SPOT_TOKENS", string.concat(vm.toString(tsla), ",", vm.toString(amzn)));
        vm.setEnv("PRIVACY_PERP_TOKENS", string.concat(vm.toString(tsla), ",", vm.toString(amzn)));
        vm.setEnv("PRIVACY_PERP_SYMBOLS", "TSLA,AMZN");
        vm.setEnv("PRIVACY_PERP_PRICES_8", "40000000000,20000000000");
        vm.setEnv("PRIVACY_RELAY_OPERATOR", vm.toString(relay));
        vm.setEnv("PRIVACY_TIER_COUNT", "4");
        vm.setEnv("PRIVACY_OUT", "deployments/roles-testnet.dryrun.json");
        // Bound to this run's custody, 0x4462...1C6e on 46630.
        vm.setEnv("PRIVACY_POP_DIR", "test/vectors/key_pop/governance_testnet");
        (address p, , address m,) = new DeployPrivatePairs().run();
        // spec-pairs #7: the pair size cap comes from tier B of config/risk-testnet.json, not a constant.
        uint256 tierB = vm.parseJsonUint(vm.readFile(string.concat(vm.projectRoot(), "/../config/risk-testnet.json")), ".tiers[1].maxPairSize");
        assertEq(tierB, 10e18);
        assertEq(ICustody(p).market(1).maxPairSize, tierB);
        assertEq(ICustody(p).market(2).maxPairSize, tierB);
        OracleAdapter o = OracleAdapter(ICustody(p).oracle());
        assertEq(o.admin(), address(timelock));
        assertEq(o.guardian(), address(safe));
        assertEq(IMarkets(m).keyScheduler(), address(timelock));
        string[3] memory ids = ["ROOQ:private-v1:TSLA/USD", "ROOQ:private-v1:AMZN/USD", "ROOQ:private-v1:CREATABLE/USD"];
        for (uint256 i; i < ids.length; i++) {
            OracleAdapter.FeedConfig memory f = o.feedConfig(keccak256(bytes(ids[i])));
            assertEq(f.heartbeat, 1 hours, ids[i]);
            assertEq(MockPriceFeed(f.aggregator).operator(), relay, ids[i]);
            assertEq(IMarkets(m).feedTaken(keccak256(bytes(ids[i]))), i < 2, ids[i]);
        }
    }

    /// A start price that makes one maximum-size pair worth more than a tenth of the tier's OI cap stops the deploy. Called on
    /// a harness rather than through `run`, because the environment is shared by tests running in parallel.
    function test_testnetDeployRefusesPairSizeAboveATenthOfMaxOi() public {
        PairSizeHarness h = new PairSizeHarness();
        string memory risk = vm.readFile(string.concat(vm.projectRoot(), "/../config/risk-testnet.json"));
        // Tier B: 10 shares against a $100,000 cap, so $1,000 a share is the most a market may start at.
        h.requirePairSizeFits(risk, 1, 1000e8, "TSLA");
        vm.expectRevert(bytes("max pair size above a tenth of max OI for TSLA"));
        h.requirePairSizeFits(risk, 1, 1000e8 + 1, "TSLA");
    }

    function _safe(address[] memory owners, uint256 threshold) internal returns (address s) {
        s = address(new MockSafe());
        MockSafe(s).setup(owners, threshold, address(0), "", address(0), address(0), 0, payable(address(0)));
    }

    function _owners(uint256 n) internal returns (address[] memory o) {
        o = new address[](n);
        for (uint256 i; i < n; i++) o[i] = makeAddr(string.concat("owner-", vm.toString(i)));
    }

    /// The governance Safe must be exactly 2-of-3 and the veto Safe exactly 1-of-3 over the three SAFE_OWNERS. A 2-of-4 or a
    /// 3-of-3 main Safe, a 2-of-3 veto Safe, or a SAFE_OWNERS list that is not three distinct owners stops the deploy.
    function test_testnetDeployRequiresTwoOfThreeAndOneOfThreeSafes() public {
        GovernanceShapeHarness h = new GovernanceShapeHarness();
        address[] memory three = _owners(3);
        address[] memory four = _owners(4);
        address[] memory two = new address[](2);
        (two[0], two[1]) = (three[0], three[1]);
        address[] memory repeated = new address[](3);
        (repeated[0], repeated[1], repeated[2]) = (three[0], three[1], three[0]);
        address main = _safe(three, 2);
        address veto = _safe(three, 1);
        h.requireSafes(main, veto, three);

        vm.expectRevert(bytes("SAFE_OWNERS must list 3 owners"));
        h.requireSafes(main, veto, four);
        vm.expectRevert(bytes("SAFE_OWNERS must list 3 owners"));
        h.requireSafes(main, veto, two);
        vm.expectRevert(bytes("SAFE_OWNERS repeats an owner"));
        h.requireSafes(main, veto, repeated);

        address twoOfFour = _safe(four, 2);
        address threeOfThree = _safe(three, 3);
        address twoOfThreeVeto = _safe(three, 2);
        address oneOfFour = _safe(four, 1);
        vm.expectRevert(bytes("Safe owner count differs from SAFE_OWNERS"));
        h.requireSafes(twoOfFour, veto, three);
        vm.expectRevert(bytes("governance Safe is not 2-of-3"));
        h.requireSafes(threeOfThree, veto, three);
        vm.expectRevert(bytes("veto Safe is not 1-of-3"));
        h.requireSafes(main, twoOfThreeVeto, three);
        vm.expectRevert(bytes("Safe owner count differs from SAFE_OWNERS"));
        h.requireSafes(main, oneOfFour, three);
    }
}

contract GovernanceShapeHarness is DeployPrivatePairs {
    function requireSafes(address main, address veto, address[] memory owners) external view {
        _requireSafes(main, veto, owners);
    }
}

contract PairSizeHarness is DeployPrivatePairs {
    function requirePairSizeFits(string memory json, uint256 tier, uint256 price8, string memory symbol) external pure {
        _requirePairSizeFits(_tierAt(json, tier), price8, symbol);
    }
}
