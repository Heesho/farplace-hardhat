// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IRig} from "./interfaces/IRig.sol";
import {IAuction} from "./interfaces/IAuction.sol";
import {IWETH} from "./interfaces/IWETH.sol";

contract Multicall {
    using SafeERC20 for IERC20;

    address public immutable rig;
    address public immutable unit;
    address public immutable weth;
    address public immutable donut;
    address public immutable auction;

    struct RigState {
        uint256 ups;
        uint256 unitPrice;
        uint256 unitBalance;
        uint256 ethBalance;
        uint256 wethBalance;
    }

    struct SlotState {
        uint256 epochId;
        uint256 initPrice;
        uint256 startTime;
        uint256 price;
        uint256 ups;
        uint256 multiplier;
        uint256 multiplierTime;
        uint256 mined;
        address miner;
        string uri;
    }

    struct AuctionState {
        address paymentToken;
        uint256 epochId;
        uint256 initPrice;
        uint256 startTime;
        uint256 price;
        uint256 paymentTokenPrice;
        uint256 wethAccumulated;
        uint256 paymentTokenBalance;
    }

    constructor(address _rig, address _auction, address _donut) {
        rig = _rig;
        auction = _auction;
        donut = _donut;
        unit = IRig(rig).unit();
        weth = IRig(rig).quote();
    }

    function mine(
        address faction,
        uint256 index,
        uint256 epochId,
        uint256 deadline,
        uint256 maxPrice,
        string memory uri
    ) external payable {
        uint256 entropyFee = IRig(rig).getEntropyFee();
        uint256 payment = msg.value - entropyFee;
        IWETH(weth).deposit{value: payment}();
        IERC20(weth).safeApprove(rig, 0);
        IERC20(weth).safeApprove(rig, payment);
        IRig(rig).mine{value: entropyFee}(msg.sender, faction, index, epochId, deadline, maxPrice, uri);
        uint256 wethBalance = IERC20(weth).balanceOf(address(this));
        IERC20(weth).safeTransfer(msg.sender, wethBalance);
    }

    function buy(uint256 epochId, uint256 deadline, uint256 maxPaymentTokenAmount) external {
        address paymentToken = IAuction(auction).paymentToken();
        uint256 price = IAuction(auction).getPrice();
        address[] memory assets = new address[](1);
        assets[0] = weth;

        IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), price);
        IERC20(paymentToken).safeApprove(auction, 0);
        IERC20(paymentToken).safeApprove(auction, price);
        IAuction(auction).buy(assets, msg.sender, epochId, deadline, maxPaymentTokenAmount);
    }

    function getRig(address account) external view returns (RigState memory state) {
        address pool = IAuction(auction).paymentToken();
        state.ups = IRig(rig).getUps();
        uint256 donutInPool = IERC20(donut).balanceOf(pool);
        uint256 unitInPool = IERC20(unit).balanceOf(pool);
        state.unitPrice = unitInPool == 0 ? 0 : donutInPool * 1e18 / unitInPool;
        state.unitBalance = account == address(0) ? 0 : IERC20(unit).balanceOf(account);
        state.ethBalance = account == address(0) ? 0 : account.balance;
        state.wethBalance = account == address(0) ? 0 : IERC20(weth).balanceOf(account);
        return state;
    }

    function getSlot(uint256 index) public view returns (SlotState memory state) {
        IRig.Slot memory slot = IRig(rig).getSlot(index);
        state.epochId = slot.epochId;
        state.initPrice = slot.initPrice;
        state.startTime = slot.startTime;
        state.price = IRig(rig).getPrice(index);
        state.multiplier = slot.multiplier;
        uint256 duration = IRig(rig).MULTIPLIER_DURATION();
        if (block.timestamp < slot.lastMultiplierTime + duration) {
            state.multiplierTime = slot.lastMultiplierTime + duration - block.timestamp;
        } else {
            state.multiplierTime = 0;
        }
        state.ups = slot.ups * state.multiplier / 1e18;
        state.mined = state.ups * (block.timestamp - state.startTime);
        state.miner = slot.miner;
        state.uri = slot.uri;
        return state;
    }

    function getAuction(address account) external view returns (AuctionState memory state) {
        state.epochId = IAuction(auction).epochId();
        state.initPrice = IAuction(auction).initPrice();
        state.startTime = IAuction(auction).startTime();
        state.paymentToken = IAuction(auction).paymentToken();
        state.price = IAuction(auction).getPrice();
        uint256 totalSupply = IERC20(state.paymentToken).totalSupply();
        state.paymentTokenPrice = totalSupply == 0 ? 0 : IERC20(donut).balanceOf(state.paymentToken) * 2e18 / totalSupply;
        state.wethAccumulated = IERC20(weth).balanceOf(auction);
        state.paymentTokenBalance = account == address(0) ? 0 : IERC20(state.paymentToken).balanceOf(account);
        return state;
    }

    function getSlots(uint256 startIndex, uint256 endIndex) external view returns (SlotState[] memory states) {
        states = new SlotState[](endIndex - startIndex + 1);
        for (uint256 i = startIndex; i <= endIndex; i++) {
            states[i - startIndex] = getSlot(i);
        }
        return states;
    }

    function getEntropyFee() external view returns (uint256) {
        return IRig(rig).getEntropyFee();
    }

    function getMultipliers() external view returns (uint256[] memory) {
        return IRig(rig).getMultipliers();
    }
}
