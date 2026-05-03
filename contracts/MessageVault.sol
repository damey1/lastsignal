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
interface ICheckIn {
    function lastSeen(address user) external view returns (uint256);
}

contract MessageVault {

    // ── STRUCTS ──

    struct Message {
        address owner;            // who wrote this message
        address recipient;        // who it's for
        string encryptedContent;  // encrypted message content (encrypt before storing)
        uint256 inactivityUnlock; // seconds of silence before message unlocks
        uint256 createdAt;        // when message was written
        bool unlocked;            // whether message has been released
        bool canceled;            // whether owner canceled the message
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
    ICheckIn public checkInContract;

    // owner => next message nonce
    mapping(address => uint256) private ownerNonces;

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

    event MessageCanceled(
        bytes32 indexed messageId,
        address indexed owner,
        uint256 canceledAt
    );

    event MessageContentUpdated(
        bytes32 indexed messageId,
        address indexed owner,
        uint256 updatedAt
    );

    event MessageUnlockDelayUpdated(
        bytes32 indexed messageId,
        address indexed owner,
        uint256 inactivityUnlock,
        uint256 updatedAt
    );

    // ── ERRORS ──

    error MessageNotFound();
    error NotRecipient();
    error NotOwner();
    error StillLocked();
    error AlreadyUnlocked();
    error MessageIsCanceled();
    error HeartbeatNotFound();

    // ── CONSTRUCTOR ──

    constructor(address _checkInContract) {
        require(_checkInContract != address(0), "Invalid CheckIn contract");
        checkInContract = ICheckIn(_checkInContract);
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
        require(inactivityUnlock >= 2 days, "Minimum unlock threshold is 2 days");

        _requireHeartbeat(msg.sender);

        uint256 nonce = ownerNonces[msg.sender]++;
        messageId = keccak256(
            abi.encodePacked(msg.sender, recipient, block.timestamp, block.number, nonce)
        );

        messages[messageId] = Message({
            owner: msg.sender,
            recipient: recipient,
            encryptedContent: encryptedContent,
            inactivityUnlock: inactivityUnlock,
            createdAt: block.timestamp,
            unlocked: false,
            canceled: false,
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
     * @notice Claim a message — only works if the inactivity threshold has passed
     * @param messageId The ID of the message to claim
     */
    function claimMessage(bytes32 messageId) external {
        Message storage m = messages[messageId];

        if (!m.exists) revert MessageNotFound();
        if (m.recipient != msg.sender) revert NotRecipient();
        if (m.unlocked) revert AlreadyUnlocked();
        if (m.canceled) revert MessageIsCanceled();

        uint256 lastOwnerHeartbeat = _lastSeen(m.owner);
        uint256 silence = block.timestamp - lastOwnerHeartbeat;
        if (silence < m.inactivityUnlock) revert StillLocked();

        m.unlocked = true;

        emit MessageUnlocked(messageId, msg.sender, block.timestamp);
    }

    /**
     * @notice Cancel a locked message. Only the owner can cancel.
     * @param messageId The ID of the message to cancel
     */
    function cancelMessage(bytes32 messageId) external {
        Message storage m = messages[messageId];

        _requireOwnedLockedMessage(m);

        m.canceled = true;

        emit MessageCanceled(messageId, msg.sender, block.timestamp);
    }

    /**
     * @notice Rotate the encrypted content of a locked message.
     * @param messageId The ID of the message to update
     * @param encryptedContent New encrypted message content
     */
    function updateMessageContent(
        bytes32 messageId,
        string calldata encryptedContent
    ) external {
        require(bytes(encryptedContent).length > 0, "Message cannot be empty");

        Message storage m = messages[messageId];
        _requireOwnedLockedMessage(m);

        m.encryptedContent = encryptedContent;

        emit MessageContentUpdated(messageId, msg.sender, block.timestamp);
    }

    /**
     * @notice Update the inactivity threshold for a locked message.
     * @param messageId The ID of the message to update
     * @param inactivityUnlock New seconds of silence before unlock
     */
    function updateInactivityUnlock(
        bytes32 messageId,
        uint256 inactivityUnlock
    ) external {
        require(inactivityUnlock >= 2 days, "Minimum unlock threshold is 2 days");

        Message storage m = messages[messageId];
        _requireOwnedLockedMessage(m);

        m.inactivityUnlock = inactivityUnlock;

        emit MessageUnlockDelayUpdated(
            messageId,
            msg.sender,
            inactivityUnlock,
            block.timestamp
        );
    }

    // ── VIEW FUNCTIONS ──

    /**
     * @notice Read a message — only available after unlock
     */
    function readMessage(bytes32 messageId) external view returns (string memory) {
        Message storage m = messages[messageId];
        if (!m.exists) revert MessageNotFound();
        if (m.recipient != msg.sender) revert NotRecipient();
        if (m.canceled) revert MessageIsCanceled();
        if (!m.unlocked) revert StillLocked();
        return m.encryptedContent;
    }

    /**
     * @notice Read your own encrypted message content at any time.
     */
    function readOwnMessage(bytes32 messageId) external view returns (string memory) {
        Message storage m = messages[messageId];
        if (!m.exists) revert MessageNotFound();
        if (m.owner != msg.sender) revert NotOwner();
        if (m.canceled) revert MessageIsCanceled();
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
        uint256 lastOwnerHeartbeat,
        bool unlocked,
        bool canceled,
        uint256 silenceRemaining
    ) {
        Message storage m = messages[messageId];
        if (!m.exists) revert MessageNotFound();
        require(
            msg.sender == m.owner || msg.sender == m.recipient,
            "Not authorized"
        );

        uint256 heartbeat = _lastSeen(m.owner);
        uint256 silence = block.timestamp - heartbeat;
        uint256 remaining = silence >= m.inactivityUnlock
            ? 0
            : m.inactivityUnlock - silence;

        return (
            m.owner,
            m.recipient,
            m.inactivityUnlock,
            m.createdAt,
            heartbeat,
            m.unlocked,
            m.canceled,
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
        if (!m.exists || m.unlocked || m.canceled) return false;
        uint256 lastOwnerHeartbeat = _lastSeen(m.owner);
        return block.timestamp >= lastOwnerHeartbeat + m.inactivityUnlock;
    }

    /**
     * @notice How many seconds until a message unlocks (0 = already unlockable)
     */
    function timeUntilUnlock(bytes32 messageId) external view returns (uint256) {
        Message storage m = messages[messageId];
        if (!m.exists) revert MessageNotFound();
        if (m.unlocked || m.canceled) return 0;
        uint256 unlockTime = _lastSeen(m.owner) + m.inactivityUnlock;
        if (block.timestamp >= unlockTime) return 0;
        return unlockTime - block.timestamp;
    }

    function _requireHeartbeat(address user) private view {
        if (_lastSeen(user) == 0) revert HeartbeatNotFound();
    }

    function _lastSeen(address user) private view returns (uint256) {
        try checkInContract.lastSeen(user) returns (uint256 timestamp) {
            return timestamp;
        } catch {
            revert HeartbeatNotFound();
        }
    }

    function _requireOwnedLockedMessage(Message storage m) private view {
        if (!m.exists) revert MessageNotFound();
        if (m.owner != msg.sender) revert NotOwner();
        if (m.unlocked) revert AlreadyUnlocked();
        if (m.canceled) revert MessageIsCanceled();
    }
}
