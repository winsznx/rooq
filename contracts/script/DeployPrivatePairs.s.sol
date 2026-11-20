// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ISafe} from "./DeployGovernance.s.sol";
import {MockERC20} from "../src/tokens/MockERC20.sol";
import {MockPriceFeed} from "../src/oracle/MockPriceFeed.sol";
import {OracleAdapter} from "../src/oracle/OracleAdapter.sol";
import {IHonkVerifier} from "../src/privacy/ShieldedPool.sol";
import {PairInputs} from "../src/privacy/PairInputs.sol";
import {PairTypes} from "../src/privacy/PairTypes.sol";
import {AppendVerifier} from "../src/privacy/verifiers/AppendVerifier.sol";
import {SpendVerifier} from "../src/privacy/verifiers/SpendVerifier.sol";
import {BondReleaseVerifier} from "../src/privacy/verifiers/BondReleaseVerifier.sol";
import {RedeemClaimVerifier} from "../src/privacy/verifiers/RedeemClaimVerifier.sol";
import {InsuranceSweepVerifier} from "../src/privacy/verifiers/InsuranceSweepVerifier.sol";
import {KeyPopVerifier} from "../src/privacy/verifiers/KeyPopVerifier.sol";
import {LockVerifier} from "../src/privacy/verifiers/LockVerifier.sol";
import {OpenPairVerifier} from "../src/privacy/verifiers/OpenPairVerifier.sol";
import {LiquidateVerifier} from "../src/privacy/verifiers/LiquidateVerifier.sol";
import {ReleaseVerifier} from "../src/privacy/verifiers/ReleaseVerifier.sol";
import {FundingEpochVerifier} from "../src/privacy/verifiers/FundingEpochVerifier.sol";
import {ClosePairVerifier} from "../src/privacy/verifiers/ClosePairVerifier.sol";
import {ExitRequestVerifier} from "../src/privacy/verifiers/ExitRequestVerifier.sol";
import {PairUpdateVerifier} from "../src/privacy/verifiers/PairUpdateVerifier.sol";
import {SwapVerifier} from "../src/privacy/verifiers/SwapVerifier.sol";
import {LpAddVerifier} from "../src/privacy/verifiers/LpAddVerifier.sol";
import {LpSetVerifier} from "../src/privacy/verifiers/LpSetVerifier.sol";
import {LpRemoveVerifier} from "../src/privacy/verifiers/LpRemoveVerifier.sol";
import {SweepProtocolVerifier} from "../src/privacy/verifiers/SweepProtocolVerifier.sol";

/// @dev The views this script reads back from contracts it deploys from artifacts (see `_deployArtifact`).
interface IDeployedCustody {
    function deploymentId() external view returns (uint256);
    function spotModule() external view returns (address);
    function marketsModule() external view returns (address);
    function moduleRegistry() external view returns (address);
}

interface IDeployedMarkets {
    function keyScheduler() external view returns (address);
    function keyCanceller() external view returns (address);
}

interface IDeployedRegistry {
    function delay() external view returns (uint256);
}

/// Deploys the private candidate. Keys come from the environment as Grumpkin public coordinates: COORDINATOR_X/Y,
/// RISK_A_X/Y, RISK_B_X/Y, and FEE_AUTH with FEE_X/Y for the fee address. Each of those four key holders proves possession on
/// its own host with zk/circuits/key_pop (epoch 0, slots coordinator 0, risk A 1, risk B 2, fee 3, bound to the deployment id
/// of the PrivatePairs address this script will create) and hands over only the proof. PRIVACY_POP_DIR, relative to
/// contracts/ and inside an fs_permissions read path, holds them as bb writes them: {coordinator,risk_a,risk_b,fee}/proof.
/// Governance comes from DeployGovernance.s.sol: TIMELOCK, GUARDIAN_SAFE (2-of-3), VETO_SAFE (1-of-3) and SAFE_OWNERS. The
/// timelock holds oracle admin, key scheduling, genesis market closing and module proposals; the governance Safe holds feed
/// revoke and key-rotation cancel; the veto Safe holds module veto. The deployer keeps no role.
///   local (31337):   deploys labelled test tokens. Without TIMELOCK it stands up an explicit local stand-in: a zero-delay
///                    timelock run by the deployer, which also plays both Safes. PRIVACY_HEARTBEAT overrides the one-hour
///                    feed heartbeat for runs that warp.
///   testnet (46630): PRIVACY_ASSET is the canonical collateral and PRIVACY_SPOT_TOKENS the tokens with a pool against it.
///                    PRIVACY_PERP_TOKENS, PRIVACY_PERP_SYMBOLS and PRIVACY_PERP_PRICES_8 list one perps market each, on tier B
///                    of config/risk-testnet.json. Each has its own single-operator TEST relay feed (blocker 2 in
///                    IMPLEMENTATION_STATUS.md), handed to PRIVACY_RELAY_OPERATOR after its start price is written.
/// @dev PrivatePairs compiles via IR (foundry.toml) and anything importing it joins that compilation, which the generated
///      verifiers do not survive. So this script imports the verifiers and deploys PrivatePairs, PrivateSpot, PrivateMarkets and
///      ModuleRegistry from their artifacts, encoding constructor arguments against the mirror structs below. The verifiers are
///      created with `new` rather than from artifacts: a script run links only the libraries its own code references, and each
///      verifier links the libraries in its file.
contract DeployPrivatePairs is Script {
    /// @dev ABI mirrors of PrivateMarkets.Tier, PrivateMarkets.Verifiers, PrivateSpot.Verifiers and PrivateSpot.PoolConfig.
    struct Tier {
        uint256 imrWad;
        uint256 mmrWad;
        uint256 maxOiUsdWad;
        uint256 takerFeeBps;
        uint256 penaltyBps;
        uint256 maxFundingPerHourWad;
        uint256 maxPairSize;
        uint256 minBond;
        uint256 maxCloseSpreadBps;
    }

    struct MarketsVerifiers {
        IHonkVerifier bondRelease;
        IHonkVerifier redeem;
        IHonkVerifier sweep;
        IHonkVerifier pop;
    }

    struct SpotVerifiers {
        IHonkVerifier swap;
        IHonkVerifier lpAdd;
        IHonkVerifier lpSet;
        IHonkVerifier lpRemove;
        IHonkVerifier sweepProtocol;
    }

    struct PoolConfig {
        uint256 id;
        address token0;
        address token1;
        uint256 feeBps;
        uint256 protocolBps;
    }

    uint256 internal constant MARKET_ID = 1;
    uint256 internal constant OTHER_MARKET_ID = 2;
    uint256 internal constant SPOT_FEE_BPS = 30;
    /// @dev Founder decision: the protocol share of pool fees ships at zero and is turned on, if ever, through the timelock.
    uint256 internal constant SPOT_PROTOCOL_BPS = 0;
    /// @dev spec-pairs.md open question 3: tier B close spread cap, also used for the local tier.
    uint256 internal constant LOCAL_CLOSE_SPREAD_BPS = 50;
    /// @dev Tier B in config/risk-testnet.json. Checked by name when it is read.
    uint256 internal constant TESTNET_PERP_TIER = 1;
    /// @dev ADR-005. Closes and opens pause once the reference source has been quiet this long (audit #22).
    uint32 internal constant PERP_HEARTBEAT = 1 hours;
    uint256 internal constant MODULE_DELAY = 14 days;
    uint256 internal constant MIN_TIMELOCK_DELAY = 48 hours;
    uint256 internal constant SAFE_OWNER_COUNT = 3;

    bool internal local;
    address internal deployer;
    address internal asset;
    address[] internal spotTokens;
    OracleAdapter internal oracle;
    MockPriceFeed internal feed;
    MockPriceFeed internal otherFeed;
    IHonkVerifier internal appendV;
    IHonkVerifier internal spendV;
    PairTypes.Verifiers internal pairVerifiers;
    PairTypes.MarketConfig[] internal marketConfigs;
    address internal spotAddress;
    address internal marketsAddress;
    MarketsVerifiers internal marketsVerifiers;
    SpotVerifiers internal spotVerifiers;
    string[] internal verifierCircuits;
    address[] internal verifierAddresses;
    MockPriceFeed internal thirdFeed;
    bytes32 internal thirdFeedId;
    string[] internal perpSymbols;
    address[] internal perpTokens;
    address[] internal perpFeeds;
    bytes32[] internal perpFeedIds;
    uint256[] internal perpMarketIds;
    address internal relayOperator;
    address internal registryAddress;
    address internal timelock;
    address internal safe;
    address internal vetoSafe;
    address[] internal safeOwners;
    uint32 internal heartbeat;
    OracleAdapter.FeedInit[] internal genesisFeeds;

    function run() external returns (address pool, address spot, address marketsModule, address registry) {
        _prepare();
        pool = _deployCustody();
        spot = _deployArtifact("PrivateSpot", abi.encode(pool, spotVerifiers, _pools(), timelock));
        require(spot == IDeployedCustody(pool).spotModule(), "spot address prediction failed");
        marketsModule = _deployArtifact("PrivateMarkets", abi.encode(pool, marketsVerifiers, asset, _tiers(), timelock, safe, _genesisPops()));
        require(marketsModule == IDeployedCustody(pool).marketsModule(), "markets address prediction failed");
        registry = _deployArtifact("ModuleRegistry", abi.encode(pool, timelock, vetoSafe, MODULE_DELAY));
        require(registry == IDeployedCustody(pool).moduleRegistry(), "registry address prediction failed");
        vm.stopBroadcast();
        _writeOutput(pool, spot, marketsModule, registry);
        console2.log("PrivatePairs", pool);
        console2.log("PrivateSpot", spot);
    }

    /// @notice The PrivatePairs address and deployment id `run` will create from the current chain state and environment. Key
    ///         holders bind their possession proofs to that id, so the deployer runs this first (no broadcast), hands each holder
    ///         the id, and then runs `run` with nothing else sent from the deployer key in between.
    function predictCustody() external returns (address pool, uint256 deploymentId) {
        _prepare();
        pool = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
        vm.stopBroadcast();
        deploymentId = (block.chainid << 160) | uint256(uint160(pool));
        console2.log("PrivatePairs", pool);
        console2.log("deploymentId", deploymentId);
    }

    /// @dev Everything `run` creates before custody, in the same order, so `predictCustody` sees the same deployer nonce.
    function _prepare() internal {
        require(block.chainid == 31337 || block.chainid == 46630, "unsupported chain");
        local = block.chainid == 31337;
        deployer = vm.addr(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        heartbeat = local ? uint32(vm.envOr("PRIVACY_HEARTBEAT", uint256(PERP_HEARTBEAT))) : PERP_HEARTBEAT;
        bool standIn = local && vm.envOr("TIMELOCK", address(0)) == address(0);
        if (!standIn) _requireGovernance();
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        if (standIn) _localGovernance();
        _tokens();
        _markets();
        spotVerifiers = _spotVerifiers();
        appendV = _verifier("append", address(new AppendVerifier()));
        spendV = _verifier("spend", address(new SpendVerifier()));
        pairVerifiers = _pairVerifiers();
        marketsVerifiers = MarketsVerifiers(
            _verifier("bond_release", address(new BondReleaseVerifier())),
            _verifier("redeem_claim", address(new RedeemClaimVerifier())),
            _verifier("insurance_sweep", address(new InsuranceSweepVerifier())),
            _verifier("key_pop", address(new KeyPopVerifier()))
        );
    }

    function _deployArtifact(string memory name, bytes memory args) internal returns (address) {
        return vm.deployCode(string.concat(name, ".sol:", name), args);
    }

    /// @dev Refuses to deploy custody behind holders that are not what DeployGovernance created.
    function _requireGovernance() internal {
        timelock = vm.envAddress("TIMELOCK");
        safe = vm.envAddress("GUARDIAN_SAFE");
        vetoSafe = vm.envAddress("VETO_SAFE");
        address[] memory owners = vm.envAddress("SAFE_OWNERS", ",");
        for (uint256 i; i < owners.length; i++) safeOwners.push(owners[i]);
        require(timelock.code.length != 0, "governance contract missing");
        _requireSafes(safe, vetoSafe, owners);
        TimelockController t = TimelockController(payable(timelock));
        require(t.getMinDelay() >= MIN_TIMELOCK_DELAY, "timelock delay below 48 hours");
        require(t.hasRole(t.PROPOSER_ROLE(), safe) && t.hasRole(t.EXECUTOR_ROLE(), safe) && t.hasRole(t.CANCELLER_ROLE(), safe), "Safe lacks a timelock role");
        require(t.hasRole(t.DEFAULT_ADMIN_ROLE(), timelock), "timelock does not administer itself");
        require(!_holdsTimelockRole(t, deployer), "deployer holds a timelock role");
    }

    /// @dev The governance Safe is exactly 2-of-3 and the veto Safe exactly 1-of-3, both over the three SAFE_OWNERS.
    function _requireSafes(address main, address veto, address[] memory owners) internal view {
        require(owners.length == SAFE_OWNER_COUNT, "SAFE_OWNERS must list 3 owners");
        require(owners[0] != owners[1] && owners[0] != owners[2] && owners[1] != owners[2], "SAFE_OWNERS repeats an owner");
        require(main.code.length != 0 && veto.code.length != 0, "governance contract missing");
        require(ISafe(main).getThreshold() == 2, "governance Safe is not 2-of-3");
        require(ISafe(veto).getThreshold() == 1, "veto Safe is not 1-of-3");
        _requireOwners(main, owners);
        _requireOwners(veto, owners);
    }

    function _requireOwners(address s, address[] memory expected) internal view {
        address[] memory actual = ISafe(s).getOwners();
        require(actual.length == expected.length, "Safe owner count differs from SAFE_OWNERS");
        for (uint256 i; i < expected.length; i++) {
            bool found;
            for (uint256 j; j < actual.length; j++) if (actual[j] == expected[i]) found = true;
            require(found, "Safe owners differ from SAFE_OWNERS");
        }
    }

    function _holdsTimelockRole(TimelockController t, address a) internal view returns (bool) {
        return t.hasRole(t.DEFAULT_ADMIN_ROLE(), a) || t.hasRole(t.PROPOSER_ROLE(), a) || t.hasRole(t.EXECUTOR_ROLE(), a) || t.hasRole(t.CANCELLER_ROLE(), a);
    }

    /// @dev Anvil has no Safe. The deployer stands in for both Safes behind a zero-delay timelock, so local flows exercise the
    ///      same call paths without waiting. Never used on 46630.
    function _localGovernance() internal {
        address[] memory holders = new address[](1);
        holders[0] = deployer;
        timelock = address(new TimelockController(0, holders, holders, address(0)));
        safe = deployer;
        vetoSafe = deployer;
        safeOwners.push(deployer);
    }

    function _tokens() internal {
        if (local) {
            asset = address(new MockERC20("Test USDG (local fixture)", "tUSDG", 6, 1_000_000e6));
            spotTokens.push(address(new MockERC20("Test Stock A (local fixture)", "tSTKA", 18, type(uint128).max)));
            spotTokens.push(address(new MockERC20("Test Stock B (local fixture)", "tSTKB", 18, type(uint128).max)));
        } else {
            asset = vm.envAddress("PRIVACY_ASSET");
            address[] memory t = vm.envAddress("PRIVACY_SPOT_TOKENS", ",");
            for (uint256 i; i < t.length; i++) spotTokens.push(t[i]);
        }
    }

    function _markets() internal {
        if (local) _localMarkets();
        else _testnetMarkets();
    }

    function _localMarkets() internal {
        address base = asset;
        int256 start = int256(250e8);
        feed = new MockPriceFeed(8, "TEST relay / USD", deployer);
        feed.setAnswer(start);
        otherFeed = new MockPriceFeed(8, "TEST relay second market / USD", deployer);
        otherFeed.setAnswer(int256(218e8));
        bytes32 feedId = keccak256("ROOQ:private-v1:TEST/USD");
        bytes32 otherFeedId = keccak256("OTHER/USD");
        _genesisFeed(feedId, address(feed), base);
        _genesisFeed(otherFeedId, address(otherFeed), base);
        thirdFeed = new MockPriceFeed(8, "TEST relay creatable market / USD", deployer);
        thirdFeed.setAnswer(int256(100e8));
        thirdFeedId = keccak256("ROOQ:private-v1:CREATABLE/USD");
        _genesisFeed(thirdFeedId, address(thirdFeed), base);
        _deployOracle();
        marketConfigs.push(
            PairTypes.MarketConfig(MARKET_ID, asset, feedId, 0.1e18, 0.05e18, 100, 0.05e18, 0, 1_000_000_000e18, 100e18, LOCAL_CLOSE_SPREAD_BPS)
        );
        marketConfigs.push(
            PairTypes.MarketConfig(OTHER_MARKET_ID, asset, otherFeedId, 0.1e18, 0.05e18, 100, 0.05e18, 10, 1_000_000_000e18, 100e18, LOCAL_CLOSE_SPREAD_BPS)
        );
    }

    function _testnetMarkets() internal {
        relayOperator = vm.envAddress("PRIVACY_RELAY_OPERATOR");
        address[] memory tokens = vm.envAddress("PRIVACY_PERP_TOKENS", ",");
        string[] memory symbols = vm.envString("PRIVACY_PERP_SYMBOLS", ",");
        uint256[] memory prices = vm.envUint("PRIVACY_PERP_PRICES_8", ",");
        require(tokens.length == symbols.length && tokens.length == prices.length && tokens.length >= 2, "perp market lists differ");
        string memory risk = _riskConfig();
        require(keccak256(bytes(vm.parseJsonString(risk, string.concat(_tierPath(TESTNET_PERP_TIER), ".name")))) == keccak256("B"), "tier index is not B");
        Tier memory tier = _tierAt(risk, TESTNET_PERP_TIER);
        _requireWithinGlobalBounds(risk, tier);
        for (uint256 i; i < tokens.length; i++) {
            _requirePairSizeFits(tier, prices[i], symbols[i]);
            bytes32 feedId = keccak256(bytes(string.concat("ROOQ:private-v1:", symbols[i], "/USD")));
            MockPriceFeed f = _testnetFeed(string.concat("TEST relay ", symbols[i], " / USD"), prices[i], feedId, tokens[i]);
            perpSymbols.push(symbols[i]);
            perpTokens.push(tokens[i]);
            perpFeeds.push(address(f));
            perpFeedIds.push(feedId);
            perpMarketIds.push(i + 1);
            marketConfigs.push(
                PairTypes.MarketConfig(
                    i + 1, asset, feedId, tier.imrWad, tier.mmrWad, tier.penaltyBps, tier.maxFundingPerHourWad, tier.takerFeeBps, tier.maxOiUsdWad,
                    tier.maxPairSize, tier.maxCloseSpreadBps
                )
            );
        }
        feed = MockPriceFeed(perpFeeds[0]);
        otherFeed = MockPriceFeed(perpFeeds[1]);
        thirdFeedId = keccak256("ROOQ:private-v1:CREATABLE/USD");
        thirdFeed = _testnetFeed("TEST relay creatable market / USD", prices[0], thirdFeedId, tokens[0]);
        _deployOracle();
        for (uint256 i; i < genesisFeeds.length; i++) MockPriceFeed(genesisFeeds[i].aggregator).transferOperator(relayOperator);
    }

    /// @dev The deployer writes the start price, then hands the feed to the relay once the oracle exists, so the deployer key
    ///      can stay off the server.
    function _testnetFeed(string memory description, uint256 price8, bytes32 feedId, address base) internal returns (MockPriceFeed f) {
        f = new MockPriceFeed(8, description, deployer);
        f.setAnswer(int256(price8));
        _genesisFeed(feedId, address(f), base);
    }

    function _genesisFeed(bytes32 feedId, address aggregator, address base) internal {
        genesisFeeds.push(OracleAdapter.FeedInit(feedId, aggregator, base, heartbeat, 1e18, 100_000e18));
    }

    /// @dev Feeds are approved in the constructor, so the deployer never holds oracle admin.
    function _deployOracle() internal {
        oracle = new OracleAdapter(timelock, safe, address(0), 0, genesisFeeds);
    }

    /// @dev Deploys the generated verifier for `circuit` and remembers it for the deployment record. Its runtime code holds
    ///      constructor-set immutables, so it can't be compared with the artifact here; the recorded code hash is what a rebuild
    ///      from source (M40) deploys and compares against.
    function _verifier(string memory circuit, address deployed) internal returns (IHonkVerifier v) {
        v = IHonkVerifier(deployed);
        verifierCircuits.push(circuit);
        verifierAddresses.push(address(v));
    }

    function _pairVerifiers() internal returns (PairTypes.Verifiers memory) {
        return PairTypes.Verifiers(
            _verifier("lock", address(new LockVerifier())),
            _verifier("open_pair", address(new OpenPairVerifier())),
            _verifier("liquidate", address(new LiquidateVerifier())),
            _verifier("release", address(new ReleaseVerifier())),
            _verifier("funding_epoch", address(new FundingEpochVerifier())),
            _verifier("close_pair", address(new ClosePairVerifier())),
            _verifier("exit_request", address(new ExitRequestVerifier())),
            _verifier("pair_update", address(new PairUpdateVerifier()))
        );
    }

    function _spotVerifiers() internal returns (SpotVerifiers memory) {
        return SpotVerifiers(
            _verifier("swap", address(new SwapVerifier())),
            _verifier("lp_add", address(new LpAddVerifier())),
            _verifier("lp_set", address(new LpSetVerifier())),
            _verifier("lp_remove", address(new LpRemoveVerifier())),
            _verifier("sweep_protocol", address(new SweepProtocolVerifier()))
        );
    }

    function _genesisPops() internal view returns (bytes[4] memory pops) {
        string memory dir = string.concat(vm.projectRoot(), "/", vm.envString("PRIVACY_POP_DIR"), "/");
        string[4] memory slots = ["coordinator", "risk_a", "risk_b", "fee"];
        for (uint256 i; i < 4; i++) pops[i] = vm.readFileBinary(string.concat(dir, slots[i], "/proof"));
    }

    function _deployCustody() internal returns (address) {
        // Taking the library's address makes forge deploy and link PairInputs for this script, which the PrivatePairs and
        // PrivateMarkets artifacts link against.
        require(address(PairInputs).code.length != 0, "PairInputs not linked");
        // A genesis id at or above FIRST_MARKET_ID would make every createMarket revert in registerMarket.
        for (uint256 i; i < marketConfigs.length; i++) require(marketConfigs[i].id < 100, "genesis market id must be below 100");
        // PrivateSpot, PrivateMarkets and ModuleRegistry are created right after this contract, so their addresses can be
        // fixed immutably here.
        spotAddress = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        marketsAddress = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 2);
        registryAddress = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 3);
        return _deployArtifact(
            "PrivatePairs",
            abi.encode(
                appendV, spendV, _assets(), pairVerifiers, address(oracle), _point("COORDINATOR"), _risk(), _feeTo(), marketConfigs,
                PairTypes.Modules(spotAddress, marketsAddress, registryAddress)
            )
        );
    }

    function _assets() internal view returns (address[] memory assets) {
        assets = new address[](spotTokens.length + 1);
        assets[0] = asset;
        for (uint256 i; i < spotTokens.length; i++) assets[i + 1] = spotTokens[i];
    }

    function _risk() internal view returns (PairTypes.Point[2] memory) {
        return [_point("RISK_A"), _point("RISK_B")];
    }

    function _feeTo() internal view returns (PairTypes.FeeRecipient memory) {
        return PairTypes.FeeRecipient(vm.envUint("FEE_AUTH"), PairTypes.Point(vm.envUint("FEE_X"), vm.envUint("FEE_Y")));
    }

    /// @dev Testnet risk tiers come from config/risk-testnet.json; local tests use one fixed tier.
    function _tiers() internal view returns (Tier[] memory tiers) {
        if (local) {
            tiers = new Tier[](1);
            tiers[0] = Tier(0.1e18, 0.05e18, 1_000_000_000e18, 0, 100, 0.05e18, 100e18, 10e6, LOCAL_CLOSE_SPREAD_BPS);
            return tiers;
        }
        string memory json = _riskConfig();
        uint256 count = vm.envUint("PRIVACY_TIER_COUNT");
        tiers = new Tier[](count);
        for (uint256 i; i < count; i++) tiers[i] = _tierAt(json, i);
    }

    function _riskConfig() internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../config/risk-testnet.json"));
    }

    function _tierPath(uint256 i) internal pure returns (string memory) {
        return string.concat(".tiers[", vm.toString(i), "]");
    }

    function _tierAt(string memory json, uint256 i) internal pure returns (Tier memory) {
        string memory k = _tierPath(i);
        return Tier(
            vm.parseJsonUint(json, string.concat(k, ".imrWad")),
            vm.parseJsonUint(json, string.concat(k, ".mmrWad")),
            vm.parseJsonUint(json, string.concat(k, ".maxOiUsdWad")),
            vm.parseJsonUint(json, string.concat(k, ".takerFeeBps")),
            vm.parseJsonUint(json, string.concat(k, ".liqPenaltyBps")),
            vm.parseJsonUint(json, string.concat(k, ".maxFundingRatePerHourWad")),
            vm.parseJsonUint(json, string.concat(k, ".maxPairSize")),
            vm.parseJsonUint(json, string.concat(k, ".minBond")),
            vm.parseJsonUint(json, string.concat(k, ".maxCloseSpreadBps"))
        );
    }

    function _requireWithinGlobalBounds(string memory json, Tier memory t) internal pure {
        require(t.imrWad >= vm.parseJsonUint(json, ".globalBounds.minImrWad"), "IMR below global bound");
        require(t.mmrWad >= vm.parseJsonUint(json, ".globalBounds.minMmrWad"), "MMR below global bound");
        require(t.maxOiUsdWad <= vm.parseJsonUint(json, ".globalBounds.maxOiUsdWad"), "OI above global bound");
        require(t.takerFeeBps <= vm.parseJsonUint(json, ".globalBounds.maxTakerFeeBps"), "fee above global bound");
        require(t.penaltyBps <= vm.parseJsonUint(json, ".globalBounds.maxLiqPenaltyBps"), "penalty above global bound");
        require(t.maxFundingPerHourWad <= vm.parseJsonUint(json, ".globalBounds.maxFundingRatePerHourWad"), "funding above global bound");
        require(t.maxCloseSpreadBps <= vm.parseJsonUint(json, ".globalBounds.maxCloseSpreadBps"), "close spread above global bound");
        require(t.maxPairSize != 0 && t.maxPairSize <= vm.parseJsonUint(json, ".globalBounds.maxPairSize"), "pair size outside global bound");
    }

    /// @dev Every unfolded open counts at the maximum pair size against the OI cap (spec-pairs #7), so a pair worth more than a
    ///      tenth of the cap at the start price would let ten pending opens fill the market.
    function _requirePairSizeFits(Tier memory t, uint256 price8, string memory symbol) internal pure {
        require(t.maxPairSize * price8 * 1e10 * 10 <= t.maxOiUsdWad * 1e18, string.concat("max pair size above a tenth of max OI for ", symbol));
    }

    function _point(string memory name) internal view returns (PairTypes.Point memory) {
        return PairTypes.Point(vm.envUint(string.concat(name, "_X")), vm.envUint(string.concat(name, "_Y")));
    }

    function _pools() internal view returns (PoolConfig[] memory pools) {
        pools = new PoolConfig[](spotTokens.length);
        for (uint256 i; i < spotTokens.length; i++) {
            // Pool i + 1 pairs the collateral with token i. Locally the last pool links the two fixtures, for routed swaps.
            bool link = local && i == spotTokens.length - 1;
            pools[i] = PoolConfig(i + 1, link ? spotTokens[0] : asset, spotTokens[i], SPOT_FEE_BPS, SPOT_PROTOCOL_BPS);
        }
    }

    /// @dev What the relay, the launcher and the web app's NEXT_PUBLIC_PRIVATE_MARKET_MAP and _POOL_MAP are built from.
    function _serializeTestnet(string memory o) internal {
        vm.serializeAddress(o, "relayOperator", relayOperator);
        vm.serializeString(o, "perpSymbols", perpSymbols);
        vm.serializeAddress(o, "perpTokens", perpTokens);
        vm.serializeAddress(o, "perpFeeds", perpFeeds);
        vm.serializeBytes32(o, "perpFeedIds", perpFeedIds);
        vm.serializeUint(o, "perpMarketIds", perpMarketIds);
        vm.serializeString(o, "marketMap", _keyMap(false));
        vm.serializeString(o, "poolMap", _keyMap(true));
    }

    /// @dev Key:id pairs. Pool i + 1 pairs the collateral with spot token i, so a pool id is found by token, never by position.
    function _keyMap(bool pools) internal view returns (string memory map) {
        for (uint256 i; i < perpSymbols.length; i++) {
            uint256 id = pools ? _poolOf(perpTokens[i]) : perpMarketIds[i];
            map = string.concat(map, i == 0 ? "" : ",", perpSymbols[i], ":", vm.toString(id));
        }
    }

    function _poolOf(address token) internal view returns (uint256) {
        for (uint256 i; i < spotTokens.length; i++) if (spotTokens[i] == token) return i + 1;
        revert("perp token has no spot pool");
    }

    function _writeOutput(address pool, address spot, address marketsModule, address registry) internal {
        string memory o = "pairs";
        vm.serializeString(o, "status", "Testnet. TEST oracle relay. Not audited.");
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "startBlock", block.number);
        vm.serializeUint(o, "deploymentId", IDeployedCustody(pool).deploymentId());
        vm.serializeUint(o, "market", MARKET_ID);
        vm.serializeAddress(o, "asset", asset);
        vm.serializeAddress(o, "feed", address(feed));
        vm.serializeAddress(o, "otherFeed", address(otherFeed));
        vm.serializeAddress(o, "oracle", address(oracle));
        vm.serializeAddress(o, "spot", spot);
        vm.serializeAddress(o, "markets", marketsModule);
        vm.serializeAddress(o, "thirdFeed", address(thirdFeed));
        vm.serializeBytes32(o, "thirdFeedId", thirdFeedId);
        vm.serializeAddress(o, "spotTokens", spotTokens);
        _serializeRoles(o, marketsModule, registry);
        vm.serializeString(o, "verifiers", _verifiersJson());
        if (!local) _serializeTestnet(o);
        string memory json = vm.serializeAddress(o, "pool", pool);
        vm.writeJson(json, vm.envString("PRIVACY_OUT"));
    }

    /// @dev Every privileged holder and delay, so the role manifest can be checked against chain state.
    function _serializeRoles(string memory o, address marketsModule, address registry) internal {
        vm.serializeString(o, "governance", _governanceJson());
        vm.serializeAddress(o, "oracleAdmin", oracle.admin());
        vm.serializeAddress(o, "oracleGuardian", oracle.guardian());
        vm.serializeUint(o, "heartbeat", heartbeat);
        vm.serializeAddress(o, "keyScheduler", IDeployedMarkets(marketsModule).keyScheduler());
        vm.serializeAddress(o, "keyCanceller", IDeployedMarkets(marketsModule).keyCanceller());
        // Alias for readers of the role before it was split.
        vm.serializeAddress(o, "keyGuardian", IDeployedMarkets(marketsModule).keyScheduler());
        vm.serializeAddress(o, "registry", registry);
        vm.serializeUint(o, "moduleDelay", IDeployedRegistry(registry).delay());
    }

    /// @dev Per circuit: the verifier address, the VK hash bb wrote next to the key, and the verifier's runtime code hash.
    function _verifiersJson() internal returns (string memory json) {
        string memory keys = string.concat(vm.projectRoot(), "/../zk/circuits/keys/");
        for (uint256 i; i < verifierCircuits.length; i++) {
            string memory c = verifierCircuits[i];
            address v = verifierAddresses[i];
            vm.serializeAddress(c, "verifier", v);
            vm.serializeBytes32(c, "runtimeCodehash", v.codehash);
            string memory entry = vm.serializeBytes32(c, "vkHash", bytes32(vm.readFileBinary(string.concat(keys, c, "/vk_hash"))));
            json = vm.serializeString("verifierRecord", c, entry);
        }
    }

    function _governanceJson() internal returns (string memory) {
        string memory g = "governanceRecord";
        vm.serializeAddress(g, "timelock", timelock);
        vm.serializeUint(g, "minDelay", TimelockController(payable(timelock)).getMinDelay());
        vm.serializeAddress(g, "safe", safe);
        vm.serializeAddress(g, "vetoSafe", vetoSafe);
        vm.serializeBool(g, "localStandIn", safe == deployer);
        return vm.serializeAddress(g, "safeOwners", safeOwners);
    }
}
