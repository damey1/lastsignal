// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CheckIn
 * @author Maxiq (@cryptomaxiq)
 * @notice LastSignal — your EchoLife onchain
 * @dev The heartbeat contract. Records proof of life for each user.
 *      Every check-in is an onchain timestamp. No heartbeat = signal lost.
 */
contract CheckIn {

    // ── STRUCTS ──

    struct UserSignal {
        uint256 lastCheckIn;      // timestamp of last check-in
        uint256 totalCheckIns;    // lifetime check-in count
        uint256 currentStreak;    // current consecutive day streak
        uint256 longestStreak;    // all-time best streak
        uint256 joinedAt;         // when the user first checked in
        bool exists;              // whether user has ever checked in
    }

    // ── STATE ──

    mapping(address => UserSignal) private signals;
    address[] private allUsers;

    uint256 public constant STREAK_WINDOW = 48 hours; // grace window for streak
    uint256 public constant GHOST_THRESHOLD = 30 days; // default ghost mode trigger

    // ── EVENTS ──

    event HeartBeat(
        address indexed user,
        uint256 timestamp,
        uint256 streak,
        uint256 totalCheckIns
    );

    event SignalLost(
        address indexed user,
        uint256 lastSeen,
        uint256 silenceDuration
    );

    event StreakBroken(
        address indexed user,
        uint256 brokenAt,
        uint256 previousStreak
    );

    // ── ERRORS ──

    error AlreadyCheckedInToday();
    error UserNotFound();

    // ── MAIN FUNCTIONS ──

    /**
     * @notice Check in to prove you are alive. Call this once per day.
     * @dev Records timestamp, updates streak, emits HeartBeat event.
     */
    function checkIn() external {
        UserSignal storage signal = signals[msg.sender];

        // First time checking in
        if (!signal.exists) {
            signal.exists = true;
            signal.joinedAt = block.timestamp;
            allUsers.push(msg.sender);
        } else {
            // Must wait at least 12 hours between check-ins (prevent spam)
            require(
                block.timestamp >= signal.lastCheckIn + 12 hours,
                "Already checked in recently. Come back later."
            );

            // Check if streak is still alive (within 48hr window)
            if (block.timestamp <= signal.lastCheckIn + STREAK_WINDOW) {
                // Streak continues
                signal.currentStreak += 1;
                if (signal.currentStreak > signal.longestStreak) {
                    signal.longestStreak = signal.currentStreak;
                }
            } else {
                // Streak broken
                emit StreakBroken(msg.sender, block.timestamp, signal.currentStreak);
                signal.currentStreak = 1;
            }
        }

        signal.lastCheckIn = block.timestamp;
        signal.totalCheckIns += 1;

        emit HeartBeat(
            msg.sender,
            block.timestamp,
            signal.currentStreak,
            signal.totalCheckIns
        );
    }

    // ── VIEW FUNCTIONS ──

    /**
     * @notice Get full signal data for a user
     */
    function getSignal(address user) external view returns (UserSignal memory) {
        if (!signals[user].exists) revert UserNotFound();
        return signals[user];
    }

    /**
     * @notice Get your own signal
     */
    function mySignal() external view returns (UserSignal memory) {
        if (!signals[msg.sender].exists) revert UserNotFound();
        return signals[msg.sender];
    }

    /**
     * @notice Check how long a user has been silent (in seconds)
     */
    function silenceDuration(address user) external view returns (uint256) {
        if (!signals[user].exists) revert UserNotFound();
        return block.timestamp - signals[user].lastCheckIn;
    }

    /**
     * @notice Check if a user is in ghost mode (silent past threshold)
     * @param user Address to check
     * @param threshold Custom threshold in seconds (0 = use default 30 days)
     */
    function isGhost(address user, uint256 threshold) external view returns (bool) {
        if (!signals[user].exists) return false;
        uint256 t = threshold == 0 ? GHOST_THRESHOLD : threshold;
        return block.timestamp > signals[user].lastCheckIn + t;
    }

    /**
     * @notice Check if user is eligible to check in (12hr cooldown passed)
     */
    function canCheckIn(address user) external view returns (bool) {
        if (!signals[user].exists) return true;
        return block.timestamp >= signals[user].lastCheckIn + 12 hours;
    }

    /**
     * @notice Get total number of users on LastSignal
     */
    function totalUsers() external view returns (uint256) {
        return allUsers.length;
    }

    /**
     * @notice Get last check-in timestamp for a user
     */
    function lastSeen(address user) external view returns (uint256) {
        if (!signals[user].exists) revert UserNotFound();
        return signals[user].lastCheckIn;
    }
}
