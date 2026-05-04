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

    // ── UPGRADE STATE ──

    address public owner;
    address public pendingCheckInContract;
    uint256 public pendingUpdateTimestamp;

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

    event OwnershipTransferred(
        address indexed oldOwner,
        address indexed newOwner
    );

    event CheckInContractProposed(
        address indexed oldContract,
        address indexed proposedContract,
        uint256 effectiveAt
    );

    event CheckInContractUpdated(
        address indexed oldContract,
        address indexed newContract
    );

    event CheckInContractUpdateCanceled(
        address indexed canceledContract
    );

    // ── ERRORS ──

    error MessageNotFound();
    error NotRecipient();
    error NotOwner();
    error StillLocked();
    error AlreadyUnlocked();
    error MessageIsCanceled();
    error HeartbeatNotFound();
    error NotContractOwner();
    error NoPendingUpdate();
    error UpdateStillLocked();
    error InvalidContractAddress();

    // ── MODIFIERS ──

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotContractOwner();
        _;
    }

    // ── CONSTRUCTOR ──

    constructor(address _checkInContract) {
        require(_checkInContract != address(0), "Invalid CheckIn contract");
        checkInContract = ICheckIn(_checkInContract);
        owner = msg.sender;
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
        require(bytes(encryptedContent).length <= 100000, "Message too large (max 100KB)");
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
        require(bytes(encryptedContent).length <= 100000, "Message too large (max 100KB)");

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
        address messageOwner,
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

    // ── ADMIN FUNCTIONS ──

    /**
     * @notice Transfer ownership to a new address
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /**
     * @notice Propose a new CheckIn contract address (two-step update)
     */
    function proposeCheckInContract(address newCheckInContract) external onlyOwner {
        require(newCheckInContract != address(0), "Invalid contract address");
        require(newCheckInContract != address(this), "Cannot set to self");
        _assertIsValidCheckIn(newCheckInContract);

        pendingCheckInContract = newCheckInContract;
        pendingUpdateTimestamp = block.timestamp + 5 days;

        emit CheckInContractProposed(
            address(checkInContract),
            newCheckInContract,
            pendingUpdateTimestamp
        );
    }

    /**
     * @notice Confirm the pending CheckIn contract update after delay
     */
    function confirmCheckInContractUpdate() external onlyOwner {
        address pending = pendingCheckInContract;
        if (pending == address(0)) revert NoPendingUpdate();
        if (block.timestamp < pendingUpdateTimestamp) revert UpdateStillLocked();

        // Re-validate it's still a conforming contract
        _assertIsValidCheckIn(pending);

        address oldContract = address(checkInContract);
        checkInContract = ICheckIn(pending);

        // Clear pending state
        pendingCheckInContract = address(0);
        pendingUpdateTimestamp = 0;

        emit CheckInContractUpdated(oldContract, address(checkInContract));
    }

    /**
     * @notice Cancel the pending CheckIn contract update
     */
    function cancelPendingCheckInContractUpdate() external onlyOwner {
        address pending = pendingCheckInContract;
        if (pending == address(0)) revert NoPendingUpdate();

        pendingCheckInContract = address(0);
        pendingUpdateTimestamp = 0;

        emit CheckInContractUpdateCanceled(pending);
    }

    function _requireHeartbeat(address user) private view {
        _lastSeen(user);
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

    /**
     * @dev Verify an address is a contract implementing the ICheckIn interface.
     *      Checks contract existence + makes a test call to lastSeen() to confirm
     *      the interface is actually implemented.
     */
    function _assertIsValidCheckIn(address candidate) private view {
        if (candidate.code.length == 0) revert InvalidContractAddress();
        // Dry-run lastSeen(this) to confirm the interface works
        try ICheckIn(candidate).lastSeen(address(this)) {
            // Interface conforms — call succeeded (even if it returns 0)
        } catch {
            revert InvalidContractAddress();
        }
    }
}
