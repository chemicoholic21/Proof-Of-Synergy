// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";

/// @title SkillPassport
/// @notice The tangible artifact of ProofOfSynergy: a SOULBOUND (non-transferable) ERC-721
///         that represents a wallet's verified Skill Passport. The token metadata points at the
///         IPFS evidence bundle; the underlying value lives in SkillAttestationRegistry.
/// @dev    Soulbound: transfers are disabled by overriding _update to reject non-mint/non-burn moves.
contract SkillPassport is ERC721 {
    uint256 public nextId = 1;
    mapping(uint256 => string) private _uris;
    /// @notice One passport per wallet (latest mint wins as the canonical token).
    mapping(address => uint256) public passportOf;

    event PassportMinted(address indexed to, uint256 indexed tokenId, string tokenURI);

    constructor() ERC721("ProofOfSynergy Skill Passport", "PSYN") {}

    /// @notice Mint a soulbound passport for `to`. Permissionless for the hackathon demo.
    function mint(address to, string calldata uri) external returns (uint256 tokenId) {
        require(to != address(0), "to=0");
        tokenId = nextId++;
        _safeMint(to, tokenId);
        _uris[tokenId] = uri;
        passportOf[to] = tokenId;
        emit PassportMinted(to, tokenId, uri);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _uris[tokenId];
    }

    /// @dev Soulbound enforcement: allow mint (from==0) and burn (to==0); reject transfers.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        require(from == address(0) || to == address(0), "soulbound: non-transferable");
        return super._update(to, tokenId, auth);
    }
}
