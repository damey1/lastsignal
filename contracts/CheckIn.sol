// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CheckIn
 * @author Maxiq (@cryptomaxiq)
 * @notice LastSignal — your EchoLife onchain
 * @dev The heartbeat contract. Records proof of life for each user.
 *      Every check-in is an onchain timestamp. No heartbeat = signal lost.
 */
interface ILastSignalBadges {
    function mintBadge(address user, uint8 badgeType) external returns (uint256);
}

interface IPreviousCheckIn {
    function getSignal(address user) external view returns (
        uint256 lastCheckIn,
        uint256 totalCheckIns,
        uint256 currentStreak,
        uint256 longestStreak,
        uint256 joinedAt,
        bool exists
    );
}

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
    mapping(address => uint256) public signalPoints;
    mapping(address => uint256) public ghostsCalled;
    address[] private allUsers;
    ILastSignalBadges public badgeContract;
    IPreviousCheckIn public previousCheckIn;

    uint256 public constant STREAK_WINDOW = 48 hours; // grace window for streak
    uint256 public constant GHOST_THRESHOLD = 30 days; // default ghost mode trigger
    uint256 public constant GHOST_CALL_POINTS = 25;

    uint8 private constant FIRST_SIGNAL = 1;
    uint8 private constant THREE_DAY_SIGNAL = 2;
    uint8 private constant SEVEN_DAY_SIGNAL = 3;
    uint8 private constant FOURTEEN_DAY_SIGNAL = 4;
    uint8 private constant THIRTY_DAY_LEGEND = 5;
    uint8 private constant COMEBACK_SIGNAL = 6;
    uint8 private constant GHOST_CALLER = 9;
    uint8 private constant BACK_FROM_THE_DEAD = 10;

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

    event GhostCalled(
        address indexed caller,
        address indexed ghost,
        uint256 pointsAwarded,
        uint256 callerTotalPoints,
        uint256 callerGhostsCalled
    );

    event BackFromTheDead(
        address indexed user,
        uint256 checkedInAt,
        uint256 silenceDuration
    );

    event SignalMigrated(
        address indexed user,
        address indexed previousCheckIn,
        uint256 lastCheckIn,
        uint256 currentStreak,
        uint256 totalCheckIns
    );

    // ── ERRORS ──

    error AlreadyCheckedIn();
    error UserNotFound();
    error NotGhostYet();
    error AlreadyMigrated();
    error MigrationUnavailable();
    error CannotDeclareSelf();

    constructor(address _badgeContract, address _previousCheckIn) {
        require(_badgeContract != address(0), "Invalid badge contract");
        badgeContract = ILastSignalBadges(_badgeContract);
        if (_previousCheckIn != address(0)) {
            previousCheckIn = IPreviousCheckIn(_previousCheckIn);
        }
    }

    // ── MAIN FUNCTIONS ──

    /**
     * @notice Check in to prove you are alive. Call this once per day.
     * @dev Records timestamp, updates streak, emits HeartBeat event.
     */
    function checkIn() external {
        UserSignal storage signal = signals[msg.sender];
        bool comeback = false;
        bool wasDeclaredGhost = false;
        uint256 silenceBeforeCheckIn = 0;

        // First time checking in
        if (!signal.exists) {
            signal.exists = true;
            signal.joinedAt = _now();
            signal.currentStreak = 1;
            signal.longestStreak = 1;
            allUsers.push(msg.sender);
        } else {
            silenceBeforeCheckIn = _now() - signal.lastCheckIn;
            wasDeclaredGhost = ghostDeclared[msg.sender];

            if (_now() < signal.lastCheckIn + 1 days) {
                revert AlreadyCheckedIn();
            }

            // Check if streak is still alive (within 48hr window)
            if (_now() <= signal.lastCheckIn + STREAK_WINDOW) {
                // Streak continues
                signal.currentStreak += 1;
                if (signal.currentStreak > signal.longestStreak) {
                    signal.longestStreak = signal.currentStreak;
                }
            } else {
                // Streak broken
                emit StreakBroken(msg.sender, _now(), signal.currentStreak);
                signal.currentStreak = 1;
                comeback = true;
            }
        }

        signal.lastCheckIn = _now();
        signal.totalCheckIns += 1;
        ghostDeclared[msg.sender] = false;
        _awardHeartbeatBadges(msg.sender, signal.currentStreak, signal.totalCheckIns, comeback);
        if (wasDeclaredGhost) {
            try badgeContract.mintBadge(msg.sender, BACK_FROM_THE_DEAD) {} catch {}
            emit BackFromTheDead(msg.sender, _now(), silenceBeforeCheckIn);
        }

        emit HeartBeat(
            msg.sender,
            _now(),
            signal.currentStreak,
            signal.totalCheckIns
        );
    }

    /**
     * @notice Copy your signal from the previous CheckIn contract once.
     * @dev Preserves streak timing and awards any milestone badges already earned.
     */
    function migrateMySignal() external {
        if (address(previousCheckIn) == address(0)) revert MigrationUnavailable();

        UserSignal storage signal = signals[msg.sender];
        if (signal.exists) revert AlreadyMigrated();

        (
            uint256 lastCheckIn,
            uint256 totalCheckIns,
            uint256 currentStreak,
            uint256 longestStreak,
            uint256 joinedAt,
            bool exists
        ) = previousCheckIn.getSignal(msg.sender);

        if (!exists) revert UserNotFound();

        signals[msg.sender] = UserSignal({
            lastCheckIn: lastCheckIn,
            totalCheckIns: totalCheckIns,
            currentStreak: currentStreak,
            longestStreak: longestStreak,
            joinedAt: joinedAt,
            exists: true
        });
        allUsers.push(msg.sender);
        ghostDeclared[msg.sender] = false;
        _awardMilestoneBadges(msg.sender, currentStreak, totalCheckIns);

        emit SignalMigrated(
            msg.sender,
            address(previousCheckIn),
            lastCheckIn,
            currentStreak,
            totalCheckIns
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
        return _now() - signals[user].lastCheckIn;
    }

    /**
     * @notice Check if a user is in ghost mode (silent past threshold)
     * @param user Address to check
     * @param threshold Custom threshold in seconds (0 = use default 30 days)
     */
    function isGhost(address user, uint256 threshold) external view returns (bool) {
        if (!signals[user].exists) return false;
        uint256 t = threshold == 0 ? GHOST_THRESHOLD : threshold;
        return _now() > signals[user].lastCheckIn + t;
    }

    /**
     * @notice Check if user is eligible to check in (24-hour rolling window)
     */
    function canCheckIn(address user) external view returns (bool) {
        if (!signals[user].exists) return true;
        return _now() >= signals[user].lastCheckIn + 1 days;
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
        if (user == msg.sender) revert CannotDeclareSelf();

        UserSignal storage signal = signals[user];
        if (!signal.exists) revert UserNotFound();
        if (_now() <= signal.lastCheckIn + GHOST_THRESHOLD) revert NotGhostYet();
        if (ghostDeclared[user]) return false;

        ghostDeclared[user] = true;
        signalPoints[msg.sender] += GHOST_CALL_POINTS;
        ghostsCalled[msg.sender] += 1;
        try badgeContract.mintBadge(msg.sender, GHOST_CALLER) {} catch {}

        emit GhostModeEntered(user, signal.lastCheckIn, _now());
        emit GhostCalled(
            msg.sender,
            user,
            GHOST_CALL_POINTS,
            signalPoints[msg.sender],
            ghostsCalled[msg.sender]
        );
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

        uint256 silence = _now() - signal.lastCheckIn;
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

        uint256 silence = _now() - signal.lastCheckIn;
        if (silence > GHOST_THRESHOLD) return 0;

        uint256 score = 20;
        score += _min(signal.currentStreak * 2, 40);
        score += _min(signal.longestStreak, 25);
        score += _min(signal.totalCheckIns, 15);

        if (silence > STREAK_WINDOW && score > 60) return 60;
        return _min(score, 100);
    }

    // Normalise block.timestamp to seconds (Ritual chain may use ms)
    function _now() private view returns (uint256) {
        return block.timestamp > 1e12 ? block.timestamp / 1000 : block.timestamp;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _awardHeartbeatBadges(
        address user,
        uint256 currentStreak,
        uint256 totalCheckIns,
        bool comeback
    ) private {
        _awardMilestoneBadges(user, currentStreak, totalCheckIns);
        if (comeback) {
            try badgeContract.mintBadge(user, COMEBACK_SIGNAL) {} catch {}
        }
    }

    function _awardMilestoneBadges(
        address user,
        uint256 currentStreak,
        uint256 totalCheckIns
    ) private {
        if (totalCheckIns >= 1) try badgeContract.mintBadge(user, FIRST_SIGNAL) {} catch {}
        if (currentStreak >= 3) try badgeContract.mintBadge(user, THREE_DAY_SIGNAL) {} catch {}
        if (currentStreak >= 7) try badgeContract.mintBadge(user, SEVEN_DAY_SIGNAL) {} catch {}
        if (currentStreak >= 14) try badgeContract.mintBadge(user, FOURTEEN_DAY_SIGNAL) {} catch {}
        if (currentStreak >= 30) try badgeContract.mintBadge(user, THIRTY_DAY_LEGEND) {} catch {}
    }
}
