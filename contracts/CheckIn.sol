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

    enum SignalLevel {
        None,
        New,
        Stable,
        Strong,
        Legendary
    }

    enum GhostRisk {
        Unknown,
        Active,
        Watch,
        Ghost
    }

    // ── STATE ──

    mapping(address => UserSignal) private signals;
    mapping(address => bool) private ghostDeclared;
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

    event GhostModeEntered(
        address indexed user,
        uint256 lastSeen,
        uint256 declaredAt
    );

    // ── ERRORS ──

    error AlreadyCheckedIn();
    error UserNotFound();
    error NotGhostYet();

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
            signal.currentStreak = 1;
            signal.longestStreak = 1;
            allUsers.push(msg.sender);
        } else {
            if (block.timestamp < signal.lastCheckIn + 1 days) {
                revert AlreadyCheckedIn();
            }

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
        ghostDeclared[msg.sender] = false;

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
     * @notice Check if user is eligible to check in (24-hour rolling window)
     */
    function canCheckIn(address user) external view returns (bool) {
        if (!signals[user].exists) return true;
        return block.timestamp >= signals[user].lastCheckIn + 1 days;
    }

    /**
     * @notice Get total number of users on LastSignal
     */
    function totalUsers() external view returns (uint256) {
        return allUsers.length;
    }

    /**
     * @notice Get the next eligible check-in timestamp for a user
     */
    function nextCheckInTime(address user) external view returns (uint256) {
        if (!signals[user].exists) return 0;
        return signals[user].lastCheckIn + 1 days;
    }

    /**
     * @notice Emit a ghost mode event for a user once they've gone dark
     */
    function declareGhost(address user) external returns (bool) {
        UserSignal storage signal = signals[user];
        if (!signal.exists) revert UserNotFound();
        if (block.timestamp <= signal.lastCheckIn + GHOST_THRESHOLD) revert NotGhostYet();
        if (ghostDeclared[user]) return false;

        ghostDeclared[user] = true;
        emit GhostModeEntered(user, signal.lastCheckIn, block.timestamp);
        return true;
    }

    /**
     * @notice Get last check-in timestamp for a user
     */
    function lastSeen(address user) external view returns (uint256) {
        if (!signals[user].exists) revert UserNotFound();
        return signals[user].lastCheckIn;
    }

    /**
     * @notice Get a user's streak tier.
     */
    function signalLevel(address user) external view returns (SignalLevel) {
        UserSignal storage signal = signals[user];
        if (!signal.exists) return SignalLevel.None;

        if (signal.currentStreak >= 30) return SignalLevel.Legendary;
        if (signal.currentStreak >= 14) return SignalLevel.Strong;
        if (signal.currentStreak >= 7) return SignalLevel.Stable;
        return SignalLevel.New;
    }

    /**
     * @notice Get a user's inactivity risk level.
     */
    function ghostRisk(address user) external view returns (GhostRisk) {
        UserSignal storage signal = signals[user];
        if (!signal.exists) return GhostRisk.Unknown;

        uint256 silence = block.timestamp - signal.lastCheckIn;
        if (silence > GHOST_THRESHOLD) return GhostRisk.Ghost;
        if (silence > STREAK_WINDOW) return GhostRisk.Watch;
        return GhostRisk.Active;
    }

    /**
     * @notice Get a simple 0-100 signal strength score.
     */
    function signalScore(address user) external view returns (uint256) {
        UserSignal storage signal = signals[user];
        if (!signal.exists) return 0;

        uint256 silence = block.timestamp - signal.lastCheckIn;
        if (silence > GHOST_THRESHOLD) return 0;

        uint256 score = 20;
        score += _min(signal.currentStreak * 2, 40);
        score += _min(signal.longestStreak, 25);
        score += _min(signal.totalCheckIns, 15);

        if (silence > STREAK_WINDOW && score > 60) return 60;
        return _min(score, 100);
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
