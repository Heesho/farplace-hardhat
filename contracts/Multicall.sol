// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IWETH {
    function deposit() external payable;
}

interface IRig {
    struct Slot {
        uint256 epochId;
        uint256 initPrice;
        uint256 startTime;
        uint256 ups;
        uint256 multiplier;
        uint256 lastMultiplierTime;
        address rig;
        string uri;
    }

    function unit() external view returns (address);
    function quote() external view returns (address);
    function startTime() external view returns (uint256);
    function capacity() external view returns (uint256);
    function index_Slot(uint256 index) external view returns (Slot memory);
    function getMultipliers() external view returns (uint256[] memory);
    function getPrice(uint256 index) external view returns (uint256);
    function getUps() external view returns (uint256);
    function getSlot(uint256 index) external view returns (Slot memory);
    function getEntropy() external view returns (address);
    function getEntropyFee() external view returns (uint256);
    function getMultipliersLength() external view returns (uint256);
    function MULTIPLIER_DURATION() external view returns (uint256);

    function mine(
        address rig,
        address provider,
        uint256 index,
        uint256 epochId,
        uint256 deadline,
        uint256 maxPrice,
        string memory uri
    ) external payable returns (uint256 price);
}

interface IAuction {
    struct Slot0 {
        uint8 locked;
        uint16 epochId;
        uint192 initPrice;
        uint40 startTime;
    }

    function paymentToken() external view returns (address);
    function getPrice() external view returns (uint256);
    function getSlot0() external view returns (Slot0 memory);
    function buy(
        address[] calldata assets,
        address assetsReceiver,
        uint256 epochId,
        uint256 deadline,
        uint256 maxPaymentTokenAmount
    ) external;
}

contract Multicall is Ownable {
    using SafeERC20 for IERC20;

    address public immutable rig;
    address public immutable unit;
    address public immutable quote;

    address public auction;
    address public donut;
    address public refPool;

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
        address rig;
        string uri;
    }

    struct AuctionState {
        uint16 epochId;
        uint192 initPrice;
        uint40 startTime;
        address paymentToken;
        uint256 price;
        uint256 paymentTokenPrice;
        uint256 wethAccumulated;
        uint256 wethBalance;
        uint256 paymentTokenBalance;
    }

    constructor(address _rig) {
        rig = _rig;
        unit = IRig(rig).unit();
        quote = IRig(rig).quote();
    }

    function mine(
        address provider,
        uint256 index,
        uint256 epochId,
        uint256 deadline,
        uint256 maxPrice,
        string memory uri
    ) external payable {
        uint256 entropyFee = IRig(rig).getEntropyFee();
        uint256 payment = msg.value - entropyFee;
        IWETH(quote).deposit{value: payment}();
        IERC20(quote).safeApprove(rig, 0);
        IERC20(quote).safeApprove(rig, payment);
        IRig(rig).mine{value: entropyFee}(msg.sender, provider, index, epochId, deadline, maxPrice, uri);
        uint256 wethBalance = IERC20(quote).balanceOf(address(this));
        IERC20(quote).safeTransfer(msg.sender, wethBalance);
    }

    function buy(uint256 epochId, uint256 deadline, uint256 maxPaymentTokenAmount) external {
        address paymentToken = IAuction(auction).paymentToken();
        uint256 price = IAuction(auction).getPrice();
        address[] memory assets = new address[](1);
        assets[0] = quote;

        IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), price);
        IERC20(paymentToken).safeApprove(auction, 0);
        IERC20(paymentToken).safeApprove(auction, price);
        IAuction(auction).buy(assets, msg.sender, epochId, deadline, maxPaymentTokenAmount);
    }

    function setAuction(address _auction) external onlyOwner {
        auction = _auction;
    }

    function setDonut(address _donut, address _refPool) external onlyOwner {
        donut = _donut;
        refPool = _refPool;
    }

    function getRig(address account) external view returns (RigState memory state) {
        state.ups = IRig(rig).getUps();
        if (auction != address(0)) {
            address pool = IAuction(auction).paymentToken();
            if (refPool != address(0) && donut != address(0)) {
                uint256 donutInPool = IERC20(donut).balanceOf(pool);
                uint256 unitInPool = IERC20(unit).balanceOf(pool);
                uint256 donutInRefPool = IERC20(donut).balanceOf(refPool);
                uint256 quoteInRefPool = IERC20(quote).balanceOf(refPool);
                state.unitPrice =
                    unitInPool == 0 ? 0 : (donutInPool * 1e18 / unitInPool) * quoteInRefPool / donutInRefPool;
            } else {
                uint256 quoteInPool = IERC20(quote).balanceOf(pool);
                uint256 unitInPool = IERC20(unit).balanceOf(pool);
                state.unitPrice = unitInPool == 0 ? 0 : quoteInPool * 1e18 / unitInPool;
            }
        }
        state.unitBalance = account == address(0) ? 0 : IERC20(unit).balanceOf(account);
        state.ethBalance = account == address(0) ? 0 : account.balance;
        state.wethBalance = account == address(0) ? 0 : IERC20(quote).balanceOf(account);
        return state;
    }

    function getAuction(address account) external view returns (AuctionState memory state) {
        IAuction.Slot0 memory slot0 = IAuction(auction).getSlot0();
        state.epochId = slot0.epochId;
        state.initPrice = slot0.initPrice;
        state.startTime = slot0.startTime;
        state.paymentToken = IAuction(auction).paymentToken();
        state.price = IAuction(auction).getPrice();
        if (refPool != address(0) && donut != address(0)) {
            uint256 donutPrice = IERC20(donut).balanceOf(refPool) == 0
                ? 0
                : IERC20(quote).balanceOf(refPool) * 1e18 / IERC20(donut).balanceOf(refPool);
            state.paymentTokenPrice =
                IERC20(donut).balanceOf(state.paymentToken) * donutPrice * 2 / IERC20(state.paymentToken).totalSupply();
        } else {
            state.paymentTokenPrice =
                IERC20(quote).balanceOf(state.paymentToken) * 2e18 / IERC20(state.paymentToken).totalSupply();
        }
        state.wethAccumulated = IERC20(quote).balanceOf(auction);
        state.wethBalance = account == address(0) ? 0 : IERC20(quote).balanceOf(account);
        state.paymentTokenBalance = account == address(0) ? 0 : IERC20(state.paymentToken).balanceOf(account);
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
        state.rig = slot.rig;
        state.uri = slot.uri;
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
