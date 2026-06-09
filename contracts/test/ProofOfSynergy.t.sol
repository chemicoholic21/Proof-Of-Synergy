// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SkillAttestationRegistry} from "../src/SkillAttestationRegistry.sol";
import {SkillPassport} from "../src/SkillPassport.sol";
import {SkillGate} from "../src/SkillGate.sol";

contract ProofOfSynergyTest is Test {
    SkillAttestationRegistry registry;
    SkillPassport passport;
    SkillGate gate;

    address attester = address(0xA11CE);
    address candidate = address(0xCA11D);
    address stranger = address(0xBEEF);

    bytes32 PY = keccak256("python");
    bytes32 K8S = keccak256("kubernetes");

    function setUp() public {
        registry = new SkillAttestationRegistry();
        passport = new SkillPassport();
        gate = new SkillGate(registry, attester);
    }

    function test_AttestAndRead() public {
        vm.prank(attester);
        registry.attest(candidate, PY, 91, "ipfs://evidence");

        (uint8 c, bool ok) = registry.getConfidence(candidate, PY, attester);
        assertTrue(ok);
        assertEq(c, 91);
        assertEq(registry.attestationCount(candidate), 1);
    }

    function test_AttestBatch() public {
        bytes32[] memory skills = new bytes32[](2);
        uint8[] memory confs = new uint8[](2);
        skills[0] = PY; skills[1] = K8S;
        confs[0] = 91; confs[1] = 34;

        vm.prank(attester);
        registry.attestBatch(candidate, skills, confs, "ipfs://bundle");

        (uint8 cpy,) = registry.getConfidence(candidate, PY, attester);
        (uint8 ck8s,) = registry.getConfidence(candidate, K8S, attester);
        assertEq(cpy, 91);
        assertEq(ck8s, 34);
        assertEq(registry.getAttestations(candidate).length, 2);
    }

    function test_RevertWhen_ConfidenceTooHigh() public {
        vm.prank(attester);
        vm.expectRevert("confidence>100");
        registry.attest(candidate, PY, 101, "ipfs://x");
    }

    function test_PassportMintsSoulbound() public {
        uint256 id = passport.mint(candidate, "ipfs://passport.json");
        assertEq(passport.ownerOf(id), candidate);
        assertEq(passport.passportOf(candidate), id);
        assertEq(passport.tokenURI(id), "ipfs://passport.json");

        // Transfers must revert (soulbound).
        vm.prank(candidate);
        vm.expectRevert("soulbound: non-transferable");
        passport.transferFrom(candidate, stranger, id);
    }

    /// The headline "why not Postgres" test: a third party grants a role purely by reading
    /// on-chain reputation, with no permission from candidate or attester.
    function test_SkillGateConsumesReputation() public {
        vm.prank(attester);
        registry.attestBatch(candidate, _one(PY), _one8(91), "ipfs://e");

        // High-confidence skill passes the gate.
        assertTrue(gate.meetsRequirement(candidate, PY, 80));
        vm.prank(candidate);
        gate.claimRole(PY, 80);
        assertTrue(gate.hasRole(candidate));

        // Exaggerated skill (low confidence) is rejected.
        vm.prank(attester);
        registry.attest(stranger, K8S, 34, "ipfs://e");
        assertFalse(gate.meetsRequirement(stranger, K8S, 80));
        vm.prank(stranger);
        vm.expectRevert("insufficient skill confidence");
        gate.claimRole(K8S, 80);
    }

    // helpers
    function _one(bytes32 a) internal pure returns (bytes32[] memory arr) {
        arr = new bytes32[](1); arr[0] = a;
    }
    function _one8(uint8 a) internal pure returns (uint8[] memory arr) {
        arr = new uint8[](1); arr[0] = a;
    }
}
