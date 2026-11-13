# Deployments

Addresses are keyed by environment and chain id. Only real broadcasts are recorded here; dry runs write `*.dryrun.json` and are never published.

## Robinhood Chain testnet (46630), private system

Deployed 2026-11-09 from block 150630822. Record: [contracts/deployments/privacy-46630.json](../contracts/deployments/privacy-46630.json). Source verified on Sourcify; `PrivatePairs` is also verified on the [testnet explorer](https://explorer.testnet.chain.robinhood.com/address/0x6b3dEA9d7C3FaCbFd8Eb78c101f0C0fF45648DF5?tab=contract).

| Contract | Address |
|---|---|
| PrivatePairs (custody, note tree, perps) | `0x6b3dEA9d7C3FaCbFd8Eb78c101f0C0fF45648DF5` |
| PrivateSpot | `0x0F792918dC1949de932AC11446fba82beBa32404` |
| PrivateMarkets | `0xDCec34FAECaFC1A988b8854521DaBBb1E40bC4af` |
| OracleAdapter | `0x696949Bd13565f3A8364543D6bC8aCfF1e928c79` |

| Market | Market and pool id | Price feed |
|---|---|---|
| TSLA | 1 | `0x6266a7d494fD35aEC096aBf2De04c2A814220BDf` |
| AMZN | 2 | `0xF40F0C617D2D02A06a0C39092A2FE4F4315E3A9d` |
| PLTR | 3 | `0x650dB349dc43053712f4F39c30d79461090f327e` |
| NFLX | 4 | `0x5790F932319Fa43938Db2AC50458F5844bd92210` |
| AMD | 5 | `0xFC4D029560eC1B461d8Dedd7e9a27f1343308ae0` |

Key guardian and price relay operator: `0xc1207E46F4F5322033685131a0E2640f2D3324da` and `0x109204c94872210cC9D666A284Ba4069c6DE2E55`.

The transparent reference build (`scripts/deploy-testnet.sh`) was never deployed to testnet.

### Third-party assets verified on 46630 (2026-11-07)
| Asset | Address | How verified |
|---|---|---|
| USDG (Global Dollar, testnet) | `0x7E955252E15c84f5768B83c41a71F9eba181802F` | Listed by Paxos as "Robinhood Testnet"; ERC-1967 proxy, decimals 6 |
| TSLA | `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E` | Deployed by StockFactory `0x2DD5b0Ea7c29006bA9450B9a4f3ADc234409e5Da`; `uiMultiplier()` 1e18; `uid()` set |
| AMZN | `0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02` | same factory |
| PLTR | `0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0` | same factory |
| NFLX | `0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93` | same factory |
| AMD | `0x71178BAc73cBeb415514eB542a8995b82669778d` | same factory |
| WETH | `0x7943e237c7F95DA44E0301572D358911207852Fa` | Onchain only (symbol WETH, decimals 18); not used for leverage |

Mainnet addresses (`0x5fc5…d168` USDG, `0x0Bd7…AD73` WETH) have no code on 46630 and are never used on testnet.

## Local anvil (31337), 2026-11-07
Fresh `anvil --chain-id 31337`, deployed with anvil dev account 0 by `script/Deploy.s.sol`, bootstrapped by `script/Bootstrap.s.sol`. Test fixtures only.

| Contract | Address |
|---|---|
| collateral | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| oracleAdapter | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| marginVault | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| spotFactory | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` |
| spotRouter | `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9` |
| marketRegistry | `0x5FC8d32690cc91D4c39d9d3abcBD16989F875707` |
| marketBackstop | `0x0165878A594ca255338adfa4d48449f69242Eb8F` |
| clearingHouse | `0xa513E6E4b8f2a923D98304ec87F64353C4D5C853` |
| marketPreflight | `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6` |
| perpLens | `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318` |

| Market | marketId | Base | Pool | Perps |
|---|---|---|---|---|
| mTSLA | `0x3a8c97516e1a9ba18c5573ed160678198372018473cb0ddf4143e38ec174bb69` | `0x68B1D87F95878fE05B998F19b66F4baba5De1aed` | `0xD6915b9f39236667134150501dCB663237a76B3A` | active via preflight |
| mAMZN | `0x30ad0553559a7ebcb9bb901976c58e6f5504586829680c422be3b3d21e488b67` | `0xa85233C63b9Ee964Add6F2cffe00Fd84eb32338f` | `0xa330b0354769dB6544FbfD74D3c13829B0245869` | active via preflight |
| mPLTR | `0xfd1363d669f5c6d9d33ac50fc7bb8abe024f3413a831d8f6250d0321f06c583c` | `0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E` | `0xA42bE2644166D4fA7C706CE453d58ae39b579107` | active via preflight |
| mNFLX | `0xf920aa89f28568e52b0b8be5c74bc6a913d999538195188c47636d511b13b073` | `0x851356ae760d987E095750cCeb3bC6014560891C` | `0xa990E9eaC9eaffe7E3Ab332a597aceAEfD4Eb07d` | active via preflight |
| mAMD | `0xa434da1f4a00447ccf32afe087f0c5c436027e66820a1eb31a74a30dbb3e736f` | `0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf` | `0x44d0f4Ae946862327fD0066F6aef5fA174c49F47` | active via preflight |
| mMEME | `0xf0e08433e25b51990b3ac1c8bd2aabf8ea6a2c1ae85a85a39f199941d66dcb5f` | `0x809d550fca64d94Bd9F66E60752A544199cfAC3D` | `0x592Dcb171A1cC4AD692733679AC60B64675a751f` | not activated (no approved feed) |
