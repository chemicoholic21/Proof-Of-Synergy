// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SkillAttestationRegistry
/// @notice ProofOfSynergy's core Monad-native primitive: a permissionless, ERC-8004-aligned
///         reputation registry of AI-generated skill attestations. Any contract or agent can
///         read a wallet's attested skill confidence WITHOUT permission from the subject or the
///         attester. That trustless, composable read is what a database cannot provide — it is
///         the answer to "why not Postgres?".
/// @dev    Skills are keyed by bytes32 (keccak256 of a lowercased skill name) so reads are O(1)
///         and gas-cheap. Confidence is 0-100. The latest attestation per (subject, skill, attester)
///         wins, but full history is retained for auditability.
contract SkillAttestationRegistry {
    struct Attestation {
        bytes32 skill;        // keccak256(lowercased skill name)
        uint8 confidence;     // 0-100, observed during the AI interview
        address attester;     // who vouched (ProofOfSynergy AI evaluator wallet)
        uint64 timestamp;     // block time of attestation
        string evidenceURI;   // ipfs:// pointer to interview evidence / metadata
    }

    /// @notice Full append-only history of attestations for a subject.
    mapping(address => Attestation[]) private _history;

    /// @notice Latest confidence for (subject => skill => attester).
    mapping(address => mapping(bytes32 => mapping(address => uint8))) private _latest;
    /// @notice Whether (subject => skill => attester) has any attestation.
    mapping(address => mapping(bytes32 => mapping(address => bool))) private _exists;

    event Attested(
        address indexed subject,
        bytes32 indexed skill,
        address indexed attester,
        uint8 confidence,
        string evidenceURI,
        uint64 timestamp
    );

    /// @notice Write a skill attestation for `subject`. Open/permissionless for the hackathon;
    ///         the attester address is recorded so reputation remains attributable (ERC-8004 semantics).
    function attest(
        address subject,
        bytes32 skill,
        uint8 confidence,
        string calldata evidenceURI
    ) external {
        require(subject != address(0), "subject=0");
        require(confidence <= 100, "confidence>100");

        uint64 ts = uint64(block.timestamp);
        _history[subject].push(
            Attestation({
                skill: skill,
                confidence: confidence,
                attester: msg.sender,
                timestamp: ts,
                evidenceURI: evidenceURI
            })
        );
        _latest[subject][skill][msg.sender] = confidence;
        _exists[subject][skill][msg.sender] = true;

        emit Attested(subject, skill, msg.sender, confidence, evidenceURI, ts);
    }

    /// @notice Batch helper so one interview mints all skill attestations in a single tx.
    function attestBatch(
        address subject,
        bytes32[] calldata skills,
        uint8[] calldata confidences,
        string calldata evidenceURI
    ) external {
        require(skills.length == confidences.length, "len mismatch");
        require(subject != address(0), "subject=0");
        uint64 ts = uint64(block.timestamp);
        for (uint256 i = 0; i < skills.length; i++) {
            require(confidences[i] <= 100, "confidence>100");
            _history[subject].push(
                Attestation({
                    skill: skills[i],
                    confidence: confidences[i],
                    attester: msg.sender,
                    timestamp: ts,
                    evidenceURI: evidenceURI
                })
            );
            _latest[subject][skills[i]][msg.sender] = confidences[i];
            _exists[subject][skills[i]][msg.sender] = true;
            emit Attested(subject, skills[i], msg.sender, confidences[i], evidenceURI, ts);
        }
    }

    // ---------------------------------------------------------------------
    // Consumer-facing reads — the composability surface other apps build on
    // ---------------------------------------------------------------------

    /// @notice Latest confidence for a (subject, skill) from a specific attester.
    function getConfidence(address subject, bytes32 skill, address attester)
        external
        view
        returns (uint8 confidence, bool exists)
    {
        return (_latest[subject][skill][attester], _exists[subject][skill][attester]);
    }

    /// @notice Full attestation history for a subject (for passports / portfolios).
    function getAttestations(address subject) external view returns (Attestation[] memory) {
        return _history[subject];
    }

    function attestationCount(address subject) external view returns (uint256) {
        return _history[subject].length;
    }

    /// @notice Convenience: hash a human-readable skill name into its registry key.
    function skillKey(string calldata name) external pure returns (bytes32) {
        return keccak256(bytes(name));
    }
}
