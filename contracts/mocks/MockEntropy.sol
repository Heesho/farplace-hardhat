// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {MockEntropy} from "@pythnetwork/entropy-sdk-solidity/MockEntropy.sol";

/**
 * @title MockEntropy
 * @notice Mock Entropy contract for testing purposes.
 */
contract TestMockEntropy is MockEntropy {
    constructor(address _defaultProvider) MockEntropy(_defaultProvider) {}
}
