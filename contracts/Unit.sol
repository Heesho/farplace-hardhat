// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";

/**
 * @title Unit
 * @author heesho
 * @notice ERC20 token with voting capabilities, minted by a Rig contract.
 * @dev Deployer can mint initially, then transfers minting rights to Rig via setRig().
 */
contract Unit is ERC20, ERC20Permit, ERC20Votes {
    address public rig;

    error Unit__NotRig();
    error Unit__RigAlreadySet();
    error Unit__InvalidRig();

    event Unit__Minted(address account, uint256 amount);
    event Unit__Burned(address account, uint256 amount);
    event Unit__RigSet(address rig);

    constructor(string memory _name, string memory _symbol) ERC20(_name, _symbol) ERC20Permit(_name) {
        rig = msg.sender;
    }

    /**
     * @notice Transfer minting rights to the Rig contract (one-time).
     * @param _rig Address of the Rig contract
     */
    function setRig(address _rig) external {
        if (msg.sender != rig) revert Unit__NotRig();
        if (_rig == address(0)) revert Unit__InvalidRig();
        rig = _rig;
        emit Unit__RigSet(_rig);
    }

    function mint(address account, uint256 amount) external {
        if (msg.sender != rig) revert Unit__NotRig();
        _mint(account, amount);
        emit Unit__Minted(account, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
        emit Unit__Burned(msg.sender, amount);
    }

    function _afterTokenTransfer(address from, address to, uint256 amount) internal override(ERC20, ERC20Votes) {
        super._afterTokenTransfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal override(ERC20, ERC20Votes) {
        super._mint(to, amount);
    }

    function _burn(address account, uint256 amount) internal override(ERC20, ERC20Votes) {
        super._burn(account, amount);
    }
}
