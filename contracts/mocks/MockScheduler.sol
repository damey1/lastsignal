// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockScheduler {
    struct ScheduledCall {
        address caller;
        bytes data;
        uint32 gasLimit;
        uint32 startBlock;
        uint32 numCalls;
        uint32 frequency;
        uint32 ttl;
        uint256 maxFeePerGas;
        uint256 maxPriorityFeePerGas;
        uint256 value;
        address payer;
        bool canceled;
    }

    mapping(uint256 => ScheduledCall) private scheduledCalls;
    uint256 public nextCallId;
    bytes public scheduleRevertData;

    event Canceled(uint256 indexed callId);

    function setScheduleRevertData(bytes calldata data) external {
        scheduleRevertData = data;
    }

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
    ) external payable returns (uint256 callId) {
        if (scheduleRevertData.length > 0) {
            bytes memory reason = scheduleRevertData;
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }

        callId = ++nextCallId;
        scheduledCalls[callId] = ScheduledCall({
            caller: msg.sender,
            data: data,
            gasLimit: gasLimit,
            startBlock: startBlock,
            numCalls: numCalls,
            frequency: frequency,
            ttl: ttl,
            maxFeePerGas: maxFeePerGas,
            maxPriorityFeePerGas: maxPriorityFeePerGas,
            value: value,
            payer: payer,
            canceled: false
        });

    }

    function cancel(uint256 callId) external {
        scheduledCalls[callId].canceled = true;
        emit Canceled(callId);
    }

    function execute(uint256 callId) external returns (bytes memory result) {
        ScheduledCall storage item = scheduledCalls[callId];
        require(!item.canceled, "Call canceled");
        (bool ok, bytes memory response) = item.caller.call(item.data);
        require(ok, "Scheduled call failed");
        return response;
    }

    function scheduled(uint256 callId) external view returns (
        address caller,
        bytes memory data,
        uint32 gasLimit,
        uint32 startBlock,
        uint32 numCalls,
        uint32 frequency,
        uint32 ttl,
        uint256 maxFeePerGas,
        uint256 maxPriorityFeePerGas,
        uint256 value,
        address payer,
        bool canceled
    ) {
        ScheduledCall storage item = scheduledCalls[callId];
        return (
            item.caller,
            item.data,
            item.gasLimit,
            item.startBlock,
            item.numCalls,
            item.frequency,
            item.ttl,
            item.maxFeePerGas,
            item.maxPriorityFeePerGas,
            item.value,
            item.payer,
            item.canceled
        );
    }
}
