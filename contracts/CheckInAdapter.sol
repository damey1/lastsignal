// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICheckInLastSeen {
    function lastSeen(address user) external view returns (uint256);
}

/**
 * @title CheckInAdapter
 * @notice Compatibility adapter for legacy MessageVault upgrades.
 * @dev The legacy vault validates a new CheckIn by calling lastSeen(vault).
 *      Real users resolve against the new CheckIn first, then the previous one.
 */
contract CheckInAdapter {
    ICheckInLastSeen public immutable primaryCheckIn;
    ICheckInLastSeen public immutable fallbackCheckIn;
    address public immutable legacyVault;
    uint256 public immutable validationTimestamp;

    error UserNotFound();

    constructor(address _primaryCheckIn, address _fallbackCheckIn, address _legacyVault) {
        require(_primaryCheckIn != address(0), "Invalid primary CheckIn");
        require(_fallbackCheckIn != address(0), "Invalid fallback CheckIn");
        require(_legacyVault != address(0), "Invalid legacy vault");

        primaryCheckIn = ICheckInLastSeen(_primaryCheckIn);
        fallbackCheckIn = ICheckInLastSeen(_fallbackCheckIn);
        legacyVault = _legacyVault;
        validationTimestamp = _now();
    }

    function lastSeen(address user) external view returns (uint256) {
        if (user == legacyVault) return validationTimestamp;

        try primaryCheckIn.lastSeen(user) returns (uint256 timestamp) {
            return timestamp;
        } catch {
            try fallbackCheckIn.lastSeen(user) returns (uint256 timestamp) {
                return timestamp;
            } catch {
                revert UserNotFound();
            }
        }
    }

    function _now() private view returns (uint256) {
        return block.timestamp > 1e12 ? block.timestamp / 1000 : block.timestamp;
    }
}
