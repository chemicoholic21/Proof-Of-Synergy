// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SkillAttestationRegistry} from "./SkillAttestationRegistry.sol";

/// @title SkillGate
/// @notice THE "why-not-Postgres" proof. An unrelated third-party contract that grants access
///         to a role purely by reading on-chain skill reputation from SkillAttestationRegistry —
///         without asking the subject or the attester for permission. A database cannot offer
///         this trustless, permissionless composability. This is what makes the chain load-bearing.
/// @dev    Example use: a DAO grants a "verified reviewer" role only to wallets whose attested
///         confidence for a given skill (by a trusted attester) meets a minimum threshold.
contract SkillGate {
    SkillAttestationRegistry public immutable registry;
    address public immutable trustedAttester; // ProofOfSynergy evaluator

    mapping(address => bool) public hasRole;

    event RoleGranted(address indexed user, bytes32 indexed skill, uint8 confidence, uint8 minRequired);

    constructor(SkillAttestationRegistry _registry, address _trustedAttester) {
        registry = _registry;
        trustedAttester = _trustedAttester;
    }

    /// @notice View whether `user` would pass the gate for `skill` at `minConfidence`.
    function meetsRequirement(address user, bytes32 skill, uint8 minConfidence)
        public
        view
        returns (bool)
    {
        (uint8 confidence, bool exists) = registry.getConfidence(user, skill, trustedAttester);
        return exists && confidence >= minConfidence;
    }

    /// @notice Claim a role based solely on on-chain reputation. Reverts if the gate isn't met.
    function claimRole(bytes32 skill, uint8 minConfidence) external {
        (uint8 confidence, bool exists) = registry.getConfidence(msg.sender, skill, trustedAttester);
        require(exists, "no attestation");
        require(confidence >= minConfidence, "insufficient skill confidence");
        hasRole[msg.sender] = true;
        emit RoleGranted(msg.sender, skill, confidence, minConfidence);
    }
}
