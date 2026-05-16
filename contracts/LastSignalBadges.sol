// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title LastSignalBadges
 * @notice Minimal soulbound badge contract for LastSignal milestones.
 * @dev Implements ERC721-style ownership reads and Transfer mint events, while
 *      intentionally reverting all approval and transfer paths.
 */
contract LastSignalBadges {
    string public constant name = "LastSignal Badges";
    string public constant symbol = "LSB";

    uint8 public constant FIRST_SIGNAL = 1;
    uint8 public constant THREE_DAY_SIGNAL = 2;
    uint8 public constant SEVEN_DAY_SIGNAL = 3;
    uint8 public constant FOURTEEN_DAY_SIGNAL = 4;
    uint8 public constant THIRTY_DAY_LEGEND = 5;
    uint8 public constant COMEBACK_SIGNAL = 6;
    uint8 public constant VAULT_SEALER = 7;
    uint8 public constant GUARDIAN = 8;
    uint8 public constant GHOST_CALLER = 9;
    uint8 public constant BACK_FROM_THE_DEAD = 10;

    address public owner;
    uint256 public totalSupply;

    mapping(address => bool) public minters;
    mapping(uint256 => address) private tokenOwners;
    mapping(address => uint256) private balances;
    mapping(uint256 => uint8) public badgeTypeOf;
    mapping(uint256 => uint256) public awardedAt;
    mapping(address => mapping(uint8 => uint256)) private userBadgeToken;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event MinterUpdated(address indexed minter, bool allowed);

    error NotOwner();
    error NotMinter();
    error InvalidRecipient();
    error InvalidBadgeType();
    error TokenNotFound();
    error NonTransferable();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyMinter() {
        if (!minters[msg.sender]) revert NotMinter();
        _;
    }

    constructor() {
        owner = msg.sender;
        minters[msg.sender] = true;
        emit MinterUpdated(msg.sender, true);
    }

    function setMinter(address minter, bool allowed) external onlyOwner {
        minters[minter] = allowed;
        emit MinterUpdated(minter, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidRecipient();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function mintBadge(address user, uint8 badgeType) external onlyMinter returns (uint256 tokenId) {
        if (user == address(0)) revert InvalidRecipient();
        if (badgeType < FIRST_SIGNAL || badgeType > BACK_FROM_THE_DEAD) revert InvalidBadgeType();

        tokenId = userBadgeToken[user][badgeType];
        if (tokenId != 0) return tokenId;

        tokenId = ++totalSupply;
        tokenOwners[tokenId] = user;
        balances[user] += 1;
        badgeTypeOf[tokenId] = badgeType;
        awardedAt[tokenId] = block.timestamp;
        userBadgeToken[user][badgeType] = tokenId;

        emit Transfer(address(0), user, tokenId);
    }

    function hasBadge(address user, uint8 badgeType) external view returns (bool) {
        return userBadgeToken[user][badgeType] != 0;
    }

    function tokenOf(address user, uint8 badgeType) external view returns (uint256) {
        return userBadgeToken[user][badgeType];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address tokenOwner = tokenOwners[tokenId];
        if (tokenOwner == address(0)) revert TokenNotFound();
        return tokenOwner;
    }

    function balanceOf(address user) external view returns (uint256) {
        if (user == address(0)) revert InvalidRecipient();
        return balances[user];
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (tokenOwners[tokenId] == address(0)) revert TokenNotFound();
        return string.concat(
            "lastsignal://badge/",
            _toString(badgeTypeOf[tokenId]),
            "/",
            _toString(tokenId)
        );
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        if (tokenOwners[tokenId] == address(0)) revert TokenNotFound();
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function approve(address, uint256) external pure {
        revert NonTransferable();
    }

    function setApprovalForAll(address, bool) external pure {
        revert NonTransferable();
    }

    function transferFrom(address, address, uint256) external pure {
        revert NonTransferable();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert NonTransferable();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert NonTransferable();
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";

        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }

        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }

        return string(buffer);
    }
}
