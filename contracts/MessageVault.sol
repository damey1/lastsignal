// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MessageVault
 * @author Maxiq (@cryptomaxiq)
 * @notice LastSignal — your EchoLife onchain
 * @dev The message capsule contract. Locked messages that unlock
 *      only when the owner's signal goes dark past a set threshold.
 *      Messages are encrypted off-chain before storing — only the
 *      encrypted content lives here.
 */
contract MessageVault {

    // ── STRUCTS ──

    struct Message {
        address owner;            // who wrote this message
        address recipient;        // who it's for
        string encryptedContent;  // encrypted message content (encrypt before storing)
        uint256 inactivityUnlock; // seconds of silence before message unlocks
        uint256 createdAt;        // when message was written
        uint256 lastOwnerActivity;// owner's last activity timestamp
        bool unlocked;            // whether message has been released
        bool exists;
    }

    // ── STATE ──

    // messageId => Message
    mapping(bytes32 => Message) private messages;

    // owner => list of their message IDs
    mapping(address => bytes32[]) private ownerMessages;

    // recipient => list of messages for them
    mapping(address => bytes32[]) private recipientMessages;

    // CheckIn contract address (for reading heartbeat data)
    address public checkInContract;

    // ── EVENTS ──

    event MessageSealed(
        bytes32 indexed messageId,
        address indexed owner,
        address indexed recipient,
        uint256 unlockAfter,
        uint256 timestamp
    );

    event MessageUnlocked(
        bytes32 indexed messageId,
        address indexed recipient,
        uint256 unlockedAt
    );

    event VaultRefreshed(
        address indexed owner,
        uint256 timestamp
    );

    // ── ERRORS ──

    error MessageNotFound();
    error NotRecipient();
    error NotOwner();
    error StillLocked();
    error AlreadyUnlocked();

    // ── CONSTRUCTOR ──

    constructor(address _checkInContract) {
        checkInContract = _checkInContract;
    }

    // ── MAIN FUNCTIONS ──

    /**
     * @notice Seal a message in the vault for a recipient
     * @param recipient The address this message is for
     * @param encryptedContent Encrypted message string (encrypt BEFORE calling this)
     * @param inactivityUnlock Seconds of silence before message unlocks (e.g. 2592000 = 30 days)
     * @return messageId The unique ID of the sealed message
     */
    function sealMessage(
        address recipient,
        string calldata encryptedContent,
        uint256 inactivityUnlock
    ) external returns (bytes32 messageId) {
        require(recipient != address(0), "Invalid recipient");
        require(bytes(encryptedContent).length > 0, "Message cannot be empty");
        require(inactivityUnlock >= 7 days, "Minimum unlock threshold is 7 days");

        messageId = keccak256(
            abi.encodePacked(msg.sender, recipient, block.timestamp, block.number)
        );

        messages[messageId] = Message({
            owner: msg.sender,
            recipient: recipient,
            encryptedContent: encryptedContent,
            inactivityUnlock: inactivityUnlock,
            createdAt: block.timestamp,
            lastOwnerActivity: block.timestamp,
            unlocked: false,
            exists: true
        });

        ownerMessages[msg.sender].push(messageId);
        recipientMessages[recipient].push(messageId);

        emit MessageSealed(
            messageId,
            msg.sender,
            recipient,
            inactivityUnlock,
            block.timestamp
        );

        return messageId;
    }

    /**
     * @notice Refresh your vault — resets the inactivity timer on all your messages.
     *         Call this when you check in to prove you are still here.
     */
    function refreshVault() external {
        bytes32[] memory ids = ownerMessages[msg.sender];
        for (uint256 i = 0; i < ids.length; i++) {
            if (messages[ids[i]].exists && !messages[ids[i]].unlocked) {
                messages[ids[i]].lastOwnerActivity = block.timestamp;
            }
        }
        emit VaultRefreshed(msg.sender, block.timestamp);
    }

    /**
     * @notice Claim a message — only works if the inactivity threshold has passed
     * @param messageId The ID of the message to claim
     */
    function claimMessage(bytes32 messageId) external {
        Message storage m = messages[messageId];

        if (!m.exists) revert MessageNotFound();
        if (m.recipient != msg.sender) revert NotRecipient();
        if (m.unlocked) revert AlreadyUnlocked();

        // Check if inactivity threshold has passed
        uint256 silence = block.timestamp - m.lastOwnerActivity;
        if (silence < m.inactivityUnlock) revert StillLocked();

        m.unlocked = true;

        emit MessageUnlocked(messageId, msg.sender, block.timestamp);
    }

    // ── VIEW FUNCTIONS ──

    /**
     * @notice Read a message — only available after unlock
     */
    function readMessage(bytes32 messageId) external view returns (string memory) {
        Message storage m = messages[messageId];
        if (!m.exists) revert MessageNotFound();
        if (m.recipient != msg.sender) revert NotRecipient();
        if (!m.unlocked) revert StillLocked();
        return m.encryptedContent;
    }

    /**
     * @notice Get message metadata (no content) — available to owner or recipient
     */
    function getMessageInfo(bytes32 messageId) external view returns (
        address owner,
        address recipient,
        uint256 inactivityUnlock,
        uint256 createdAt,
        uint256 lastOwnerActivity,
        bool unlocked,
        uint256 silenceRemaining
    ) {
        Message storage m = messages[messageId];
        if (!m.exists) revert MessageNotFound();
        require(
            msg.sender == m.owner || msg.sender == m.recipient,
            "Not authorized"
        );

        uint256 silence = block.timestamp - m.lastOwnerActivity;
        uint256 remaining = silence >= m.inactivityUnlock
            ? 0
            : m.inactivityUnlock - silence;

        return (
            m.owner,
            m.recipient,
            m.inactivityUnlock,
            m.createdAt,
            m.lastOwnerActivity,
            m.unlocked,
            remaining
        );
    }

    /**
     * @notice Get all message IDs owned by an address
     */
    function getMyMessages() external view returns (bytes32[] memory) {
        return ownerMessages[msg.sender];
    }

    /**
     * @notice Get all message IDs addressed to you
     */
    function getMessagesForMe() external view returns (bytes32[] memory) {
        return recipientMessages[msg.sender];
    }

    /**
     * @notice Check if a message is unlockable right now
     */
    function isUnlockable(bytes32 messageId) external view returns (bool) {
        Message storage m = messages[messageId];
        if (!m.exists || m.unlocked) return false;
        return block.timestamp >= m.lastOwnerActivity + m.inactivityUnlock;
    }

    /**
     * @notice How many seconds until a message unlocks (0 = already unlockable)
     */
    function timeUntilUnlock(bytes32 messageId) external view returns (uint256) {
        Message storage m = messages[messageId];
        if (!m.exists) revert MessageNotFound();
        if (m.unlocked) return 0;
        uint256 unlockTime = m.lastOwnerActivity + m.inactivityUnlock;
        if (block.timestamp >= unlockTime) return 0;
        return unlockTime - block.timestamp;
    }
}
