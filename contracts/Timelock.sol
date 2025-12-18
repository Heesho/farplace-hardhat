// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/**
 * @title Timelock
 * @notice Imports OpenZeppelin's TimelockController for governance.
 * @dev Used with a Safe wallet to add a 48-hour delay to Unit ownership actions.
 *      Safe (proposer) → TimelockController (48h delay) → Unit.setRig()
 */
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
