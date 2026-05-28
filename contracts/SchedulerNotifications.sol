// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SchedulerNotifications
 * @notice Per-message inactivity checkpoints for LastSignal.
 * @dev Uses Ritual Scheduler to emit warning/unlockable events for each sealed
 *      message. The scheduler never unlocks content; MessageVault remains the
 *      final authority for claim/read permissions.
 */
interface IScheduler {
    function schedule(
        bytes calldata data,
        uint32 gasLimit,
        uint32 startBlock,
        uint32 numCalls,
        uint32 frequency,
        uint32 ttl,
        uint256 maxFeePerGas,
        uint256 maxPriorityFeePerGas,
        uint256 value,
        address payer
    ) external returns (uint256 callId);

    function cancel(uint256 callId) external;
}

interface IScheduledCheckIn {
    function lastSeen(address user) external view returns (uint256);
}

contract SchedulerNotifications {
    struct MessageSchedule {
        address owner;
        address recipient;
        uint256 baseLastSeen;
        uint256 inactivityUnlock;
        uint256 generation;
        uint256 warningCallId;
        uint256 unlockCallId;
        bool active;
        bool completed;
    }

    address public owner;
    address public vault;
    IScheduledCheckIn public checkIn;
    IScheduler public scheduler;

    uint256 public constant BLOCK_TIME_MS = 350;
    uint256 public constant WARNING_BPS = 8_000;
    uint256 public constant BPS = 10_000;
    uint32 public constant CALLBACK_GAS_LIMIT = 300_000;
    uint32 public constant CALLBACK_TTL = 100;

    mapping(bytes32 => MessageSchedule) public messageSchedules;

    event VaultUpdated(address indexed oldVault, address indexed newVault);
    event CheckInUpdated(address indexed oldCheckIn, address indexed newCheckIn);
    event MessageScheduleArmed(
        bytes32 indexed messageId,
        address indexed owner,
        address indexed recipient,
        uint256 generation,
        uint256 baseLastSeen,
        uint256 inactivityUnlock,
        uint256 warningCallId,
        uint256 unlockCallId
    );
    event MessageScheduleFinalized(bytes32 indexed messageId, string reason);
    event MessageLockWarning(
        bytes32 indexed messageId,
        address indexed owner,
        address indexed recipient,
        uint256 unlockAt
    );
    event MessageUnlockable(
        bytes32 indexed messageId,
        address indexed owner,
        address indexed recipient,
        uint256 inactiveDuration
    );
    event ScheduleSkipped(bytes32 indexed messageId, string reason);

    error NotOwner();
    error NotVault();
    error NotScheduler();
    error InvalidAddress();
    error ScheduleNotFound();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    modifier onlyScheduler() {
        if (msg.sender != address(scheduler)) revert NotScheduler();
        _;
    }

    constructor(address _checkIn, address _scheduler) {
        if (_checkIn == address(0) || _scheduler == address(0)) revert InvalidAddress();
        owner = msg.sender;
        checkIn = IScheduledCheckIn(_checkIn);
        scheduler = IScheduler(_scheduler);
    }

    function setVault(address newVault) external onlyOwner {
        if (newVault == address(0)) revert InvalidAddress();
        emit VaultUpdated(vault, newVault);
        vault = newVault;
    }

    function setCheckIn(address newCheckIn) external onlyOwner {
        if (newCheckIn == address(0)) revert InvalidAddress();
        emit CheckInUpdated(address(checkIn), newCheckIn);
        checkIn = IScheduledCheckIn(newCheckIn);
    }

    function armMessage(
        bytes32 messageId,
        address messageOwner,
        address recipient,
        uint256 inactivityUnlock
    ) external onlyVault returns (uint256 warningCallId, uint256 unlockCallId) {
        uint256 baseLastSeen = _lastSeen(messageOwner);
        MessageSchedule storage item = messageSchedules[messageId];

        item.owner = messageOwner;
        item.recipient = recipient;
        item.inactivityUnlock = inactivityUnlock;
        item.completed = false;

        return _arm(messageId, item, baseLastSeen);
    }

    function refreshMessage(
        bytes32 messageId,
        uint256 inactivityUnlock
    ) external onlyVault returns (uint256 warningCallId, uint256 unlockCallId) {
        MessageSchedule storage item = messageSchedules[messageId];
        if (item.owner == address(0)) revert ScheduleNotFound();

        item.inactivityUnlock = inactivityUnlock;
        item.completed = false;

        return _arm(messageId, item, _lastSeen(item.owner));
    }

    function finalizeMessage(bytes32 messageId, string calldata reason) external onlyVault {
        MessageSchedule storage item = messageSchedules[messageId];
        if (item.owner == address(0)) return;

        item.active = false;
        item.completed = true;
        _tryCancel(item.warningCallId);
        _tryCancel(item.unlockCallId);

        emit MessageScheduleFinalized(messageId, reason);
    }

    function executeWarningCheck(
        uint256,
        bytes32 messageId,
        uint256 generation
    ) external onlyScheduler {
        MessageSchedule storage item = messageSchedules[messageId];
        if (!_isCurrent(item, generation)) {
            emit ScheduleSkipped(messageId, "stale or inactive");
            return;
        }

        uint256 currentLastSeen = _lastSeen(item.owner);
        if (currentLastSeen > item.baseLastSeen) {
            _arm(messageId, item, currentLastSeen);
            return;
        }

        emit MessageLockWarning(
            messageId,
            item.owner,
            item.recipient,
            item.baseLastSeen + item.inactivityUnlock
        );
    }

    function executeUnlockCheck(
        uint256,
        bytes32 messageId,
        uint256 generation
    ) external onlyScheduler {
        MessageSchedule storage item = messageSchedules[messageId];
        if (!_isCurrent(item, generation)) {
            emit ScheduleSkipped(messageId, "stale or inactive");
            return;
        }

        uint256 currentLastSeen = _lastSeen(item.owner);
        if (currentLastSeen > item.baseLastSeen) {
            _arm(messageId, item, currentLastSeen);
            return;
        }

        uint256 silence = _now() - currentLastSeen;
        if (silence < item.inactivityUnlock) {
            _arm(messageId, item, currentLastSeen);
            return;
        }

        item.active = false;
        item.completed = true;

        emit MessageUnlockable(messageId, item.owner, item.recipient, silence);
    }

    function _arm(
        bytes32 messageId,
        MessageSchedule storage item,
        uint256 baseLastSeen
    ) private returns (uint256 warningCallId, uint256 unlockCallId) {
        item.baseLastSeen = baseLastSeen;
        item.generation += 1;
        item.active = true;

        uint256 generation = item.generation;
        uint256 warningDelay = (item.inactivityUnlock * WARNING_BPS) / BPS;

        uint32 warningBlock = _delayToBlock(warningDelay);
        uint32 unlockBlock = _delayToBlock(item.inactivityUnlock);

        warningCallId = _schedule(
            abi.encodeWithSelector(
                this.executeWarningCheck.selector,
                uint256(0),
                messageId,
                generation
            ),
            warningBlock,
            item.owner
        );

        unlockCallId = _schedule(
            abi.encodeWithSelector(
                this.executeUnlockCheck.selector,
                uint256(0),
                messageId,
                generation
            ),
            unlockBlock,
            item.owner
        );

        item.warningCallId = warningCallId;
        item.unlockCallId = unlockCallId;

        emit MessageScheduleArmed(
            messageId,
            item.owner,
            item.recipient,
            generation,
            baseLastSeen,
            item.inactivityUnlock,
            warningCallId,
            unlockCallId
        );
    }

    function _schedule(
        bytes memory data,
        uint32 startBlock,
        address payer
    ) private returns (uint256 callId) {
        return scheduler.schedule(
            data,
            CALLBACK_GAS_LIMIT,
            startBlock,
            1,
            1,
            CALLBACK_TTL,
            tx.gasprice,
            0,
            0,
            payer
        );
    }

    function _delayToBlock(uint256 delaySeconds) private view returns (uint32) {
        uint256 blocksAhead = (delaySeconds * 1000) / BLOCK_TIME_MS;
        if (blocksAhead == 0) blocksAhead = 1;
        uint256 targetBlock = block.number + blocksAhead;
        require(targetBlock <= type(uint32).max, "Schedule too far");
        return uint32(targetBlock);
    }

    function _isCurrent(
        MessageSchedule storage item,
        uint256 generation
    ) private view returns (bool) {
        return item.active && !item.completed && item.generation == generation;
    }

    function _lastSeen(address user) private view returns (uint256) {
        return checkIn.lastSeen(user);
    }

    function _now() private view returns (uint256) {
        return block.timestamp > 1e12 ? block.timestamp / 1000 : block.timestamp;
    }

    function _tryCancel(uint256 callId) private {
        if (callId == 0) return;
        try scheduler.cancel(callId) {} catch {}
    }
}
