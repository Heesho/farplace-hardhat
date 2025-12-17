// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title Auction
 * @author heesho
 * @notice A Dutch auction contract for selling accumulated assets in exchange for LP tokens.
 *         The price decays linearly from initPrice to 0 over each epoch. When purchased,
 *         all accumulated assets are transferred to the buyer, LP tokens are burned,
 *         and a new auction begins with a price based on the previous sale.
 * @dev Forked and modified from Euler Fee Flow.
 */
contract Auction is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*----------  CONSTANTS  --------------------------------------------*/

    uint256 public constant MIN_EPOCH_PERIOD = 1 hours;
    uint256 public constant MAX_EPOCH_PERIOD = 365 days;
    uint256 public constant MIN_PRICE_MULTIPLIER = 1.1e18; // 1.1x minimum
    uint256 public constant MAX_PRICE_MULTIPLIER = 3e18; // 3x maximum
    uint256 public constant ABS_MIN_INIT_PRICE = 1e6;
    uint256 public constant ABS_MAX_INIT_PRICE = type(uint192).max;
    uint256 public constant PRICE_MULTIPLIER_SCALE = 1e18;

    /*----------  IMMUTABLES  -------------------------------------------*/

    address public immutable paymentToken; // LP token used for payment
    address public immutable paymentReceiver; // receives payment (burn address)
    uint256 public immutable epochPeriod; // duration of each Dutch auction
    uint256 public immutable priceMultiplier; // multiplier for next epoch's starting price
    uint256 public immutable minInitPrice; // minimum starting price per epoch

    /*----------  STATE  ------------------------------------------------*/

    uint256 public epochId; // current epoch counter
    uint256 public initPrice; // starting price for current epoch
    uint256 public startTime; // timestamp when current epoch began

    /*----------  ERRORS  -----------------------------------------------*/

    error Auction__DeadlinePassed();
    error Auction__EpochIdMismatch();
    error Auction__MaxPaymentAmountExceeded();
    error Auction__EmptyAssets();
    error Auction__InitPriceBelowMin();
    error Auction__InitPriceExceedsMax();
    error Auction__EpochPeriodBelowMin();
    error Auction__EpochPeriodExceedsMax();
    error Auction__PriceMultiplierBelowMin();
    error Auction__PriceMultiplierExceedsMax();
    error Auction__MinInitPriceBelowMin();
    error Auction__MinInitPriceExceedsAbsMaxInitPrice();

    /*----------  EVENTS  -----------------------------------------------*/

    event Auction__Buy(address indexed buyer, address indexed assetsReceiver, uint256 paymentAmount);

    /*----------  CONSTRUCTOR  ------------------------------------------*/

    /**
     * @notice Deploy a new Auction contract.
     * @param _initPrice Starting price for the first epoch
     * @param _paymentToken LP token address used for payments
     * @param _paymentReceiver Address to receive payments (typically burn address)
     * @param _epochPeriod Duration of each auction epoch
     * @param _priceMultiplier Price multiplier for calculating next epoch's starting price
     * @param _minInitPrice Minimum allowed starting price
     */
    constructor(
        uint256 _initPrice,
        address _paymentToken,
        address _paymentReceiver,
        uint256 _epochPeriod,
        uint256 _priceMultiplier,
        uint256 _minInitPrice
    ) {
        if (_initPrice < _minInitPrice) revert Auction__InitPriceBelowMin();
        if (_initPrice > ABS_MAX_INIT_PRICE) revert Auction__InitPriceExceedsMax();
        if (_epochPeriod < MIN_EPOCH_PERIOD) revert Auction__EpochPeriodBelowMin();
        if (_epochPeriod > MAX_EPOCH_PERIOD) revert Auction__EpochPeriodExceedsMax();
        if (_priceMultiplier < MIN_PRICE_MULTIPLIER) revert Auction__PriceMultiplierBelowMin();
        if (_priceMultiplier > MAX_PRICE_MULTIPLIER) revert Auction__PriceMultiplierExceedsMax();
        if (_minInitPrice < ABS_MIN_INIT_PRICE) revert Auction__MinInitPriceBelowMin();
        if (_minInitPrice > ABS_MAX_INIT_PRICE) revert Auction__MinInitPriceExceedsAbsMaxInitPrice();

        initPrice = _initPrice;
        startTime = block.timestamp;

        paymentToken = _paymentToken;
        paymentReceiver = _paymentReceiver;
        epochPeriod = _epochPeriod;
        priceMultiplier = _priceMultiplier;
        minInitPrice = _minInitPrice;
    }

    /*----------  EXTERNAL FUNCTIONS  -----------------------------------*/

    /**
     * @notice Buy all accumulated assets by paying the current Dutch auction price.
     * @dev Transfers all balances of specified assets to the receiver.
     * @param assets Array of token addresses to claim from this contract
     * @param assetsReceiver Address to receive the claimed assets
     * @param _epochId Expected epoch ID (reverts if mismatched for frontrun protection)
     * @param deadline Transaction deadline timestamp
     * @param maxPaymentTokenAmount Maximum LP tokens willing to pay (slippage protection)
     * @return paymentAmount Actual amount of LP tokens paid
     */
    function buy(
        address[] calldata assets,
        address assetsReceiver,
        uint256 _epochId,
        uint256 deadline,
        uint256 maxPaymentTokenAmount
    ) external nonReentrant returns (uint256 paymentAmount) {
        if (block.timestamp > deadline) revert Auction__DeadlinePassed();
        if (assets.length == 0) revert Auction__EmptyAssets();
        if (_epochId != epochId) revert Auction__EpochIdMismatch();

        paymentAmount = getPrice();
        if (paymentAmount > maxPaymentTokenAmount) revert Auction__MaxPaymentAmountExceeded();

        // Transfer LP tokens to receiver (burn address)
        if (paymentAmount > 0) {
            IERC20(paymentToken).safeTransferFrom(msg.sender, paymentReceiver, paymentAmount);
        }

        // Transfer all accumulated assets to buyer
        for (uint256 i = 0; i < assets.length; i++) {
            uint256 balance = IERC20(assets[i]).balanceOf(address(this));
            IERC20(assets[i]).safeTransfer(assetsReceiver, balance);
        }

        // Calculate next epoch's starting price
        uint256 newInitPrice = paymentAmount * priceMultiplier / PRICE_MULTIPLIER_SCALE;
        if (newInitPrice > ABS_MAX_INIT_PRICE) {
            newInitPrice = ABS_MAX_INIT_PRICE;
        } else if (newInitPrice < minInitPrice) {
            newInitPrice = minInitPrice;
        }

        // Update state for new epoch
        unchecked {
            epochId++;
        }
        initPrice = newInitPrice;
        startTime = block.timestamp;

        emit Auction__Buy(msg.sender, assetsReceiver, paymentAmount);

        return paymentAmount;
    }

    /*----------  VIEW FUNCTIONS  ---------------------------------------*/

    /**
     * @notice Get the current Dutch auction price.
     * @return Current price (linearly decays from initPrice to 0 over epochPeriod)
     */
    function getPrice() public view returns (uint256) {
        uint256 timePassed = block.timestamp - startTime;
        if (timePassed > epochPeriod) return 0;
        return initPrice - initPrice * timePassed / epochPeriod;
    }
}
