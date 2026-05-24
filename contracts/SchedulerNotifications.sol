// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SchedulerNotifications
 * @notice LastSignal — onchain scheduled notifications via Ritual Scheduler
 * @dev Uses Ritual Chain's Scheduler system contract to execute time-based
 *      ghost checks and streak nudges without any off-chain infrastructure.
 *
 * Ritual Scheduler (0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B):
 *   scheduleTransaction(target, data, executeAt) → bytes32 jobId
 *
 * The Scheduler calls executeGhostCheck / executeStreakNudge at the
 * pre-determined block. Those functions check CheckIn state and emit
 * notification events.
 */

/// @dev Minimal CheckIn interface
interface ICheckIn {
    function lastSeen(address user) external view returns (uint256);
}

/// @dev Ritual Scheduler system contract interface
interface IScheduler {
    function scheduleTransaction(address target, bytes calldata data, uint256 executeAt) external returns (bytes32);
}

contract SchedulerNotifications {

    // ── Constants ──

    /// @notice Ritual Chain's genesis-deployed Scheduler
    IScheduler public constant SCHEDULER = IScheduler(0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B);

    uint256 public constant GHOST_THRESHOLD = 30 days;
    uint256 public constant NUDGE_BEFORE_GHOST = 1 days; // nudge 1 day before ghost triggers

    // ── State ──

    address public owner;
    ICheckIn public checkIn;

    // ── Events ──

    /// @dev Emitted when a scheduled ghost check fires and the user is still silent
    event GhostCheckTriggered(address indexed user, uint256 silenceDuration);
    /// @dev Emitted when a scheduled streak nudge fires (user approaching ghost)
    event StreakNudge(address indexed user, uint256 hoursSilent);
    /// @dev Emitted when a scheduled callback finds the user active (nothing to do)
    event ScheduledCheckSkipped(address indexed user, string reason);

    // ── Errors ──

    error NotOwner();
    error NotUser();
    error NotScheduler();

    // ── Modifiers ──

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyScheduler() {
        if (msg.sender != address(SCHEDULER)) revert NotScheduler();
        _;
    }

    // ── Constructor ──

    constructor(address _checkIn) {
        checkIn = ICheckIn(_checkIn);
        owner = msg.sender;
    }

    // ── Owner Functions ──

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    // ── CheckIn integration: called after successful check-in ──

    /**
     * @notice Schedule a ghost check and a streak nudge for a user.
     * @dev Call from frontend after checkIn() succeeds. Anyone can schedule
     *      for themselves (msg.sender == user). Cost is paid from this
     *      contract's RitualWallet balance.
     * @param user User to schedule checks for
     * @param forGhostCheckAt Block number for ghost check (now + 30d in blocks)
     * @param forNudgeAt Block number for streak nudge (now + 29d in blocks)
     */
    function scheduleCheckIns(
        address user,
        uint256 forGhostCheckAt,
        uint256 forNudgeAt
    ) external returns (bytes32 ghostId, bytes32 nudgeId) {
        if (msg.sender != user) revert NotUser();
        ghostId = SCHEDULER.scheduleTransaction(
            address(this),
            abi.encodeWithSelector(this.executeGhostCheck.selector, user),
            forGhostCheckAt
        );
        nudgeId = SCHEDULER.scheduleTransaction(
            address(this),
            abi.encodeWithSelector(this.executeStreakNudge.selector, user),
            forNudgeAt
        );
    }

    // ── Scheduler Callbacks ──

    /**
     * @notice Called by the Scheduler at the scheduled block.
     * @dev Checks if the user is still silent beyond GHOST_THRESHOLD.
     */
    function executeGhostCheck(address user) external onlyScheduler {
        uint256 last = _safeLastSeen(user);
        if (last == 0) {
            emit ScheduledCheckSkipped(user, "user not found");
            return;
        }
        uint256 silence = _now() - last;
        if (silence >= GHOST_THRESHOLD) {
            emit GhostCheckTriggered(user, silence);
        } else {
            emit ScheduledCheckSkipped(user, "user checked in before ghost threshold");
        }
    }

    /**
     * @notice Called by the Scheduler as a streak nudge.
     * @dev Emits StreakNudge about 1 day before ghost threshold.
     */
    function executeStreakNudge(address user) external onlyScheduler {
        uint256 last = _safeLastSeen(user);
        if (last == 0) {
            emit ScheduledCheckSkipped(user, "user not found");
            return;
        }
        uint256 silence = _now() - last;
        if (silence >= GHOST_THRESHOLD - NUDGE_BEFORE_GHOST && silence < GHOST_THRESHOLD) {
            emit StreakNudge(user, silence / 1 hours);
        } else {
            emit ScheduledCheckSkipped(user, "nudge window passed or user checked in");
        }
    }

    // ── Internal ──

    function _safeLastSeen(address user) private view returns (uint256) {
        (bool ok, bytes memory data) = address(checkIn).staticcall(
            abi.encodeWithSignature("lastSeen(address)", user)
        );
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    function _now() private view returns (uint256) {
        return block.timestamp > 1e12 ? block.timestamp / 1000 : block.timestamp;
    }
}
