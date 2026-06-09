// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {SkillAttestationRegistry} from "../src/SkillAttestationRegistry.sol";
import {SkillPassport} from "../src/SkillPassport.sol";
import {SkillGate} from "../src/SkillGate.sol";

/// @notice Deploys the three ProofOfSynergy contracts to Monad testnet and pre-seeds demo data
///         (real attestations + minted passports) so judges can verify on-chain reputation that
///         exists independently of any live demo.
///
/// Usage:
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url $MONAD_RPC_URL --broadcast --private-key $DEPLOYER_PRIVATE_KEY
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        SkillAttestationRegistry registry = new SkillAttestationRegistry();
        SkillPassport passport = new SkillPassport();
        // The deployer acts as the trusted ProofOfSynergy attester for the demo.
        SkillGate gate = new SkillGate(registry, deployer);

        // --- Pre-seed demo wallet #1: a strong engineer ---
        address demoEngineer = 0x000000000000000000000000000000000000e001;
        _seed(
            registry,
            passport,
            demoEngineer,
            ["python", "aws", "react"],
            [uint8(91), 84, 88],
            "ipfs://demo-engineer-passport"
        );

        // --- Pre-seed demo wallet #2: a resume with an exaggerated claim ---
        address demoExaggerator = 0x000000000000000000000000000000000000e002;
        _seed(
            registry,
            passport,
            demoExaggerator,
            ["kubernetes", "python", "docker"],
            [uint8(34), 76, 80],
            "ipfs://demo-exaggerator-passport"
        );

        vm.stopBroadcast();

        console2.log("SkillAttestationRegistry:", address(registry));
        console2.log("SkillPassport:          ", address(passport));
        console2.log("SkillGate:              ", address(gate));
        console2.log("TrustedAttester:        ", deployer);
    }

    function _seed(
        SkillAttestationRegistry registry,
        SkillPassport passport,
        address subject,
        string[3] memory names,
        uint8[3] memory confs,
        string memory uri
    ) internal {
        bytes32[] memory skills = new bytes32[](3);
        uint8[] memory cs = new uint8[](3);
        for (uint256 i = 0; i < 3; i++) {
            skills[i] = keccak256(bytes(names[i]));
            cs[i] = confs[i];
        }
        registry.attestBatch(subject, skills, cs, uri);
        passport.mint(subject, uri);
    }
}
