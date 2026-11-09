// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {CLAIM_KEYS, CT_CLAIM, CT_LOCK, CT_MARKET, CT_NOTE, CT_PAIR, MARKET_KEYS, OI_SLOTS, PAIR_KEYS, PairTypes} from "./PairTypes.sol";

/// @title PairInputs
/// @notice Builds verifier public inputs for PrivatePairs, in exactly the order of the `pub` parameters in
///         zk/circuits/*/src/main.nr. A separate library so the contract stays under the EIP-170 size limit.
library PairInputs {
    /// @dev BN254 scalar field modulus. Non-canonical encodings would let one value occupy two storage keys.
    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    error NotAFieldElement();

    function _field(bytes32 x) private pure returns (bytes32) {
        if (uint256(x) >= FIELD) revert NotAFieldElement();
        return x;
    }

    function funding(PairTypes.FundingPublic calldata p, PairTypes.Market memory m, PairTypes.Keys memory c, bytes32[] memory deltas, PairTypes.EpochContext memory e)
        external
        pure
        returns (bytes32[] memory inputs)
    {
        inputs = new bytes32[](5 + OI_SLOTS + 7 + 2 * MARKET_KEYS + MARKET_KEYS * CT_MARKET);
        uint256 k;
        inputs[k++] = bytes32(c.deploymentId);
        inputs[k++] = bytes32(p.market);
        inputs[k++] = e.head;
        inputs[k++] = _field(p.newHead);
        inputs[k++] = bytes32(deltas.length);
        for (uint256 i; i < deltas.length; i++) inputs[k + i] = deltas[i];
        k += OI_SLOTS;
        inputs[k++] = bytes32(e.dt);
        inputs[k++] = bytes32(e.mark);
        inputs[k++] = bytes32(m.maxFundingPerHourWad);
        inputs[k++] = _field(bytes32(p.indexMag));
        inputs[k++] = _field(bytes32(p.indexNeg));
        inputs[k++] = _field(bytes32(p.claimRatio));
        inputs[k++] = bytes32(e.bond);
        inputs[k++] = bytes32(c.coordinatorX);
        inputs[k++] = bytes32(c.coordinatorY);
        inputs[k++] = bytes32(c.riskAX);
        inputs[k++] = bytes32(c.riskAY);
        inputs[k++] = bytes32(c.riskBX);
        inputs[k++] = bytes32(c.riskBY);
        for (uint256 i; i < MARKET_KEYS; i++) {
            for (uint256 j; j < CT_MARKET; j++) inputs[k++] = _field(p.ciphertexts[i][j]);
        }
    }

    function open(PairTypes.OpenPublic calldata p, PairTypes.Market memory m, PairTypes.Keys memory c, uint256 mark, uint256 index, bytes32 head, uint256 pending)
        external
        pure
        returns (bytes32[] memory inputs)
    {
        inputs = new bytes32[](5 + PAIR_KEYS * CT_PAIR + CT_NOTE + 7 + 4 + 2 + 1 + CT_NOTE + 8);
        uint256 k;
        inputs[k++] = p.root;
        inputs[k++] = _field(p.nullifiers[0]);
        inputs[k++] = _field(p.nullifiers[1]);
        inputs[k++] = _field(p.pairCommitment);
        inputs[k++] = _field(p.refundCommitment);
        for (uint256 i; i < PAIR_KEYS; i++) {
            for (uint256 j; j < CT_PAIR; j++) inputs[k++] = _field(p.pairCt[i][j]);
        }
        for (uint256 i; i < CT_NOTE; i++) inputs[k++] = _field(p.refundCt[i]);
        inputs[k++] = bytes32(c.deploymentId);
        inputs[k++] = bytes32(p.market);
        inputs[k++] = bytes32(uint256(uint160(m.asset)));
        inputs[k++] = bytes32(mark);
        inputs[k++] = _field(bytes32(p.asOf));
        inputs[k++] = bytes32(m.imrWad);
        inputs[k++] = bytes32(m.scale);
        inputs[k++] = bytes32(c.riskAX);
        inputs[k++] = bytes32(c.riskAY);
        inputs[k++] = bytes32(c.riskBX);
        inputs[k++] = bytes32(c.riskBY);
        inputs[k++] = bytes32(index);
        inputs[k++] = _field(p.deltaCommitment);
        inputs[k++] = _field(p.feeCommitment);
        for (uint256 i; i < CT_NOTE; i++) inputs[k++] = _field(p.feeCt[i]);
        inputs[k++] = bytes32(m.takerFeeBps);
        inputs[k++] = bytes32(c.feeAuth);
        inputs[k++] = bytes32(c.feeX);
        inputs[k++] = bytes32(c.feeY);
        inputs[k++] = head;
        inputs[k++] = bytes32(pending);
        inputs[k++] = bytes32(m.maxOiUsdWad);
        inputs[k] = bytes32(m.maxPairSize);
    }

    function update(PairTypes.UpdatePublic calldata p, PairTypes.Market memory m, PairTypes.Keys memory c, uint256 mark, uint256 index)
        external
        pure
        returns (bytes32[] memory inputs)
    {
        inputs = new bytes32[](6 + PAIR_KEYS * CT_PAIR + 2 * CT_NOTE + 9 + 4 + 3 + 1);
        uint256 k;
        inputs[k++] = p.root;
        inputs[k++] = _field(p.nullifiers[0]);
        inputs[k++] = _field(p.nullifiers[1]);
        inputs[k++] = _field(p.pairCommitment);
        inputs[k++] = _field(p.outCommitment);
        inputs[k++] = _field(p.feeCommitment);
        for (uint256 i; i < PAIR_KEYS; i++) {
            for (uint256 j; j < CT_PAIR; j++) inputs[k++] = _field(p.pairCt[i][j]);
        }
        for (uint256 i; i < CT_NOTE; i++) inputs[k++] = _field(p.outCt[i]);
        for (uint256 i; i < CT_NOTE; i++) inputs[k++] = _field(p.feeCt[i]);
        inputs[k++] = bytes32(c.deploymentId);
        inputs[k++] = bytes32(p.market);
        inputs[k++] = bytes32(uint256(uint160(m.asset)));
        inputs[k++] = bytes32(mark);
        inputs[k++] = bytes32(m.imrWad);
        inputs[k++] = bytes32(m.scale);
        inputs[k++] = bytes32(m.takerFeeBps);
        inputs[k++] = bytes32(index);
        inputs[k++] = _field(p.deltaCommitment);
        inputs[k++] = bytes32(c.riskAX);
        inputs[k++] = bytes32(c.riskAY);
        inputs[k++] = bytes32(c.riskBX);
        inputs[k++] = bytes32(c.riskBY);
        inputs[k++] = bytes32(c.feeAuth);
        inputs[k++] = bytes32(c.feeX);
        inputs[k++] = bytes32(c.feeY);
        inputs[k] = _field(p.carriedNullifier);
    }

    function close(PairTypes.ClosePublic calldata p, PairTypes.Market memory m, PairTypes.Keys memory c, uint256 mark, uint256 index)
        external
        pure
        returns (bytes32[] memory inputs)
    {
        inputs = new bytes32[](5 + 3 * CT_NOTE + 12);
        uint256 k;
        inputs[k++] = p.root;
        inputs[k++] = _field(p.nullifier);
        inputs[k++] = _field(p.commitments[0]);
        inputs[k++] = _field(p.commitments[1]);
        inputs[k++] = _field(p.commitments[2]);
        for (uint256 i; i < 3; i++) {
            for (uint256 j; j < CT_NOTE; j++) inputs[k++] = _field(p.ciphertexts[i][j]);
        }
        inputs[k++] = bytes32(c.deploymentId);
        inputs[k++] = bytes32(p.market);
        inputs[k++] = bytes32(uint256(uint160(m.asset)));
        inputs[k++] = bytes32(mark);
        inputs[k++] = bytes32(m.scale);
        inputs[k++] = bytes32(index);
        inputs[k++] = _field(p.deltaCommitment);
        inputs[k++] = bytes32(p.mode);
        inputs[k++] = bytes32(m.takerFeeBps);
        inputs[k++] = bytes32(c.feeAuth);
        inputs[k++] = bytes32(c.feeX);
        inputs[k] = bytes32(c.feeY);
    }

    function liquidate(PairTypes.LiquidatePublic calldata p, PairTypes.Market memory m, PairTypes.Keys memory c, uint256 mark, uint256 index)
        external
        pure
        returns (bytes32[] memory inputs)
    {
        inputs = new bytes32[](5 + 3 * CT_NOTE + 10 + CLAIM_KEYS * CT_CLAIM + 4);
        uint256 k;
        inputs[k++] = p.root;
        inputs[k++] = _field(p.nullifier);
        inputs[k++] = _field(p.commitments[0]);
        inputs[k++] = _field(p.commitments[1]);
        inputs[k++] = _field(p.commitments[2]);
        for (uint256 i; i < 3; i++) {
            for (uint256 j; j < CT_NOTE; j++) inputs[k++] = _field(p.ciphertexts[i][j]);
        }
        inputs[k++] = bytes32(c.deploymentId);
        inputs[k++] = bytes32(p.market);
        inputs[k++] = bytes32(uint256(uint160(m.asset)));
        inputs[k++] = bytes32(mark);
        inputs[k++] = bytes32(m.mmrWad);
        inputs[k++] = bytes32(m.penaltyBps);
        inputs[k++] = bytes32(m.scale);
        inputs[k++] = bytes32(index);
        inputs[k++] = _field(p.deltaCommitment);
        inputs[k++] = _field(p.claimCommitment);
        for (uint256 i; i < CLAIM_KEYS; i++) {
            for (uint256 j; j < CT_CLAIM; j++) inputs[k++] = _field(p.claimCt[i][j]);
        }
        inputs[k++] = bytes32(c.riskAX);
        inputs[k++] = bytes32(c.riskAY);
        inputs[k++] = bytes32(c.riskBX);
        inputs[k] = bytes32(c.riskBY);
    }

    function lock(PairTypes.LockPublic calldata p, PairTypes.Keys memory c) external pure returns (bytes32[] memory inputs) {
        inputs = new bytes32[](5 + CT_NOTE + 2 * CT_LOCK + 3 + 2 * CT_LOCK + 4);
        uint256 k;
        inputs[k++] = p.root;
        inputs[k++] = _field(p.nullifiers[0]);
        inputs[k++] = _field(p.nullifiers[1]);
        inputs[k++] = _field(p.changeCommitment);
        inputs[k++] = _field(p.lockCommitment);
        for (uint256 i; i < CT_NOTE; i++) inputs[k++] = _field(p.changeCt[i]);
        for (uint256 i; i < CT_LOCK; i++) inputs[k++] = _field(p.ownerCt[i]);
        for (uint256 i; i < CT_LOCK; i++) inputs[k++] = _field(p.coordinatorCt[i]);
        inputs[k++] = bytes32(c.deploymentId);
        inputs[k++] = bytes32(c.coordinatorX);
        inputs[k++] = bytes32(c.coordinatorY);
        for (uint256 i; i < 2; i++) {
            for (uint256 j; j < CT_LOCK; j++) inputs[k++] = _field(p.riskCt[i][j]);
        }
        inputs[k++] = bytes32(c.riskAX);
        inputs[k++] = bytes32(c.riskAY);
        inputs[k++] = bytes32(c.riskBX);
        inputs[k] = bytes32(c.riskBY);
    }

    function release(PairTypes.ReleasePublic calldata p, PairTypes.Keys memory c) external pure returns (bytes32[] memory inputs) {
        inputs = new bytes32[](3 + CT_NOTE + 2);
        uint256 k;
        inputs[k++] = p.root;
        inputs[k++] = _field(p.nullifier);
        inputs[k++] = _field(p.commitment);
        for (uint256 i; i < CT_NOTE; i++) inputs[k++] = _field(p.ciphertext[i]);
        inputs[k++] = bytes32(c.deploymentId);
        inputs[k] = bytes32(p.asOf);
    }

    function redeem(PairTypes.RedeemPublic calldata p, PairTypes.Keys memory c, uint256 ratio)
        external
        pure
        returns (bytes32[] memory inputs)
    {
        inputs = new bytes32[](3 + CT_NOTE + 3);
        uint256 k;
        inputs[k++] = p.root;
        inputs[k++] = _field(p.nullifier);
        inputs[k++] = _field(p.commitment);
        for (uint256 i; i < CT_NOTE; i++) inputs[k++] = _field(p.ciphertext[i]);
        inputs[k++] = bytes32(c.deploymentId);
        inputs[k++] = _field(p.deltaCommitment);
        inputs[k] = bytes32(ratio);
    }

    function sweep(PairTypes.SweepPublic calldata p, PairTypes.Market memory m, PairTypes.Keys memory c, bytes32 head)
        external
        pure
        returns (bytes32[] memory inputs)
    {
        inputs = new bytes32[](6 + CT_NOTE + 3 + 6 + MARKET_KEYS * CT_MARKET);
        uint256 k;
        inputs[k++] = bytes32(c.deploymentId);
        inputs[k++] = bytes32(p.market);
        inputs[k++] = bytes32(uint256(uint160(m.asset)));
        inputs[k++] = head;
        inputs[k++] = _field(p.newHead);
        inputs[k++] = _field(p.commitment);
        for (uint256 i; i < CT_NOTE; i++) inputs[k++] = _field(p.ciphertext[i]);
        inputs[k++] = bytes32(c.feeAuth);
        inputs[k++] = bytes32(c.feeX);
        inputs[k++] = bytes32(c.feeY);
        inputs[k++] = bytes32(c.coordinatorX);
        inputs[k++] = bytes32(c.coordinatorY);
        inputs[k++] = bytes32(c.riskAX);
        inputs[k++] = bytes32(c.riskAY);
        inputs[k++] = bytes32(c.riskBX);
        inputs[k++] = bytes32(c.riskBY);
        for (uint256 i; i < MARKET_KEYS; i++) {
            for (uint256 j; j < CT_MARKET; j++) inputs[k++] = _field(p.marketCt[i][j]);
        }
    }
}
