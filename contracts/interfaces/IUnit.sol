// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IUnit is IERC20 {
    function rig() external view returns (address);
    function setRig(address _rig) external;
    function mint(address account, uint256 amount) external;
    function burn(uint256 amount) external;
}
