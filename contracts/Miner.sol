// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IEntropyV2} from "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";
import {IEntropyConsumer} from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";

contract Unit is ERC20, ERC20Permit, ERC20Votes {
    address public immutable miner;

    error Unit__NotMiner();

    event Unit__Minted(address account, uint256 amount);
    event Unit__Burned(address account, uint256 amount);

    constructor() ERC20("CoreTest", "CORETEST") ERC20Permit("CoreTest") {
        miner = msg.sender;
    }

    function mint(address account, uint256 amount) external {
        if (msg.sender != miner) revert Unit__NotMiner();
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

contract Miner is IEntropyConsumer, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant TOTAL_FEE = 2_000;
    uint256 public constant TEAM_FEE = 200;
    uint256 public constant FACTION_FEE = 200;
    uint256 public constant DIVISOR = 10_000;
    uint256 public constant PRECISION = 1e18;

    uint256 public constant EPOCH_PERIOD = 1 hours;
    uint256 public constant PRICE_MULTIPLIER = 2e18;
    uint256 public constant MIN_INIT_PRICE = 0.0001 ether;
    uint256 public constant ABS_MAX_INIT_PRICE = type(uint192).max;

    uint256 public constant INITIAL_UPS = 2 ether;
    uint256 public constant HALVING_PERIOD = 30 days;
    uint256 public constant TAIL_UPS = 0.01 ether;

    uint256 public constant MAX_CAPACITY = 1024;
    uint256 public constant DEFAULT_MULTIPLIER = 1e18;
    uint256 public constant MULTIPLIER_DURATION = 24 hours;

    address public immutable unit;
    address public immutable quote;
    uint256 public immutable startTime;

    IEntropyV2 entropy;
    address public treasury;
    address public team;

    uint256 public capacity = 1;
    mapping(address => bool) public account_IsFaction;
    uint256[] public multipliers;

    mapping(uint256 => Slot) public index_Slot;
    mapping(uint64 => uint256) public sequence_Index;
    mapping(uint64 => uint256) public sequence_Epoch;

    struct Slot {
        uint256 epochId;
        uint256 initPrice;
        uint256 startTime;
        uint256 ups;
        uint256 multiplier;
        uint256 lastMultiplierTime;
        address miner;
        string uri;
    }

    error Miner__InvalidMiner();
    error Miner__InvalidIndex();
    error Miner__EpochIdMismatch();
    error Miner__MaxPriceExceeded();
    error Miner__Expired();
    error Miner__InsufficientFee();
    error Miner__InvalidTreasury();
    error Miner__InvalidFaction();
    error Miner__CapacityBelowCurrent();
    error Miner__CapacityExceedsMax();
    error Miner__InvalidMultiplier();
    error Miner__InvalidLength();

    event Miner__Mine(
        address sender,
        address indexed miner,
        address indexed faction,
        uint256 indexed index,
        uint256 epochId,
        uint256 price,
        string uri
    );
    event Miner__MultiplierSet(uint256 indexed index, uint256 indexed epochId, uint256 multiplier);
    event Miner__EntropyRequested(uint256 indexed index, uint256 indexed epochId, uint64 indexed sequenceNumber);
    event Miner__FactionFee(address indexed faction, uint256 indexed index, uint256 indexed epochId, uint256 amount);
    event Miner__TreasuryFee(address indexed treasury, uint256 indexed index, uint256 indexed epochId, uint256 amount);
    event Miner__TeamFee(address indexed team, uint256 indexed index, uint256 indexed epochId, uint256 amount);
    event Miner__MinerFee(address indexed miner, uint256 indexed index, uint256 indexed epochId, uint256 amount);
    event Miner__Mint(address indexed miner, uint256 indexed index, uint256 indexed epochId, uint256 amount);
    event Miner__TreasurySet(address indexed treasury);
    event Miner__TeamSet(address indexed team);
    event Miner__FactionWhitelisted(address indexed faction, bool whitelisted);
    event Miner__CapacitySet(uint256 capacity);
    event Miner__MultipliersSet(uint256[] multipliers);

    constructor(address _quote, address _entropy, address _treasury, address _team) {
        quote = _quote;
        treasury = _treasury;
        team = _team;
        startTime = block.timestamp;
        unit = address(new Unit());
        entropy = IEntropyV2(_entropy);
    }

    function mine(
        address miner,
        address faction,
        uint256 index,
        uint256 epochId,
        uint256 deadline,
        uint256 maxPrice,
        string memory uri
    ) external payable nonReentrant returns (uint256 price) {
        if (miner == address(0)) revert Miner__InvalidMiner();
        if (block.timestamp > deadline) revert Miner__Expired();
        if (index >= capacity) revert Miner__InvalidIndex();
        if (faction != address(0) && !account_IsFaction[faction]) revert Miner__InvalidFaction();

        Slot memory slotCache = index_Slot[index];

        if (epochId != slotCache.epochId) revert Miner__EpochIdMismatch();

        price = _getPriceFromCache(slotCache);
        if (price > maxPrice) revert Miner__MaxPriceExceeded();

        if (price > 0) {
            uint256 teamFee = team != address(0) ? price * TEAM_FEE / DIVISOR : 0;
            uint256 factionFee = faction != address(0) ? price * FACTION_FEE / DIVISOR : 0;
            uint256 treasuryFee = price * TOTAL_FEE / DIVISOR - teamFee - factionFee;
            uint256 minerFee = price - treasuryFee - teamFee - factionFee;

            IERC20(quote).safeTransferFrom(msg.sender, treasury, treasuryFee);
            emit Miner__TreasuryFee(treasury, index, epochId, treasuryFee);

            if (teamFee > 0) {
                IERC20(quote).safeTransferFrom(msg.sender, team, teamFee);
                emit Miner__TeamFee(team, index, epochId, teamFee);
            }

            if (factionFee > 0) {
                IERC20(quote).safeTransferFrom(msg.sender, faction, factionFee);
                emit Miner__FactionFee(faction, index, epochId, factionFee);
            }

            IERC20(quote).safeTransferFrom(msg.sender, slotCache.miner, minerFee);
            emit Miner__MinerFee(slotCache.miner, index, epochId, minerFee);
        }

        uint256 newInitPrice = price * PRICE_MULTIPLIER / PRECISION;

        if (newInitPrice > ABS_MAX_INIT_PRICE) {
            newInitPrice = ABS_MAX_INIT_PRICE;
        } else if (newInitPrice < MIN_INIT_PRICE) {
            newInitPrice = MIN_INIT_PRICE;
        }

        uint256 mineTime = block.timestamp - slotCache.startTime;
        uint256 minedAmount = mineTime * slotCache.ups * slotCache.multiplier / PRECISION;

        if (slotCache.miner != address(0)) {
            Unit(unit).mint(slotCache.miner, minedAmount);
            emit Miner__Mint(slotCache.miner, index, epochId, minedAmount);
        }

        unchecked {
            slotCache.epochId++;
        }
        slotCache.initPrice = newInitPrice;
        slotCache.startTime = block.timestamp;
        slotCache.miner = miner;
        slotCache.ups = _getUpsFromTime(block.timestamp) / capacity;
        slotCache.uri = uri;

        bool shouldUpdateMultiplier = block.timestamp - slotCache.lastMultiplierTime > MULTIPLIER_DURATION;
        if (shouldUpdateMultiplier) {
            slotCache.multiplier = DEFAULT_MULTIPLIER;
        }

        index_Slot[index] = slotCache;

        emit Miner__Mine(msg.sender, miner, faction, index, epochId, price, uri);

        if (shouldUpdateMultiplier) {
            uint128 fee = entropy.getFeeV2();
            if (msg.value < fee) revert Miner__InsufficientFee();
            uint64 seq = entropy.requestV2{value: fee}();
            sequence_Index[seq] = index;
            sequence_Epoch[seq] = slotCache.epochId;
            emit Miner__EntropyRequested(index, slotCache.epochId, seq);
        }

        return price;
    }

    function entropyCallback(uint64 sequenceNumber, address, /*provider*/ bytes32 randomNumber) internal override {
        uint256 index = sequence_Index[sequenceNumber];
        uint256 epoch = sequence_Epoch[sequenceNumber];

        delete sequence_Index[sequenceNumber];
        delete sequence_Epoch[sequenceNumber];

        Slot memory slotCache = index_Slot[index];
        if (slotCache.epochId != epoch || slotCache.miner == address(0)) return;

        uint256 multiplier = _drawMultiplier(randomNumber);
        slotCache.multiplier = multiplier;
        slotCache.lastMultiplierTime = block.timestamp;

        index_Slot[index] = slotCache;
        emit Miner__MultiplierSet(index, epoch, multiplier);
    }

    function _drawMultiplier(bytes32 randomNumber) internal view returns (uint256) {
        uint256 length = multipliers.length;
        if (length == 0) return DEFAULT_MULTIPLIER;
        uint256 index = uint256(randomNumber) % length;
        return multipliers[index];
    }

    function _getPriceFromCache(Slot memory slotCache) internal view returns (uint256) {
        uint256 timePassed = block.timestamp - slotCache.startTime;

        if (timePassed > EPOCH_PERIOD) {
            return 0;
        }

        return slotCache.initPrice - slotCache.initPrice * timePassed / EPOCH_PERIOD;
    }

    function _getUpsFromTime(uint256 time) internal view returns (uint256 ups) {
        uint256 halvings = time <= startTime ? 0 : (time - startTime) / HALVING_PERIOD;
        ups = INITIAL_UPS >> halvings;
        if (ups < TAIL_UPS) ups = TAIL_UPS;
        return ups;
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert Miner__InvalidTreasury();
        treasury = _treasury;
        emit Miner__TreasurySet(_treasury);
    }

    function setTeam(address _team) external onlyOwner {
        team = _team;
        emit Miner__TeamSet(_team);
    }

    function setFaction(address _faction, bool _isFaction) external onlyOwner {
        if (_faction == address(0)) revert Miner__InvalidFaction();
        account_IsFaction[_faction] = _isFaction;
        emit Miner__FactionWhitelisted(_faction, _isFaction);
    }

    function setCapacity(uint256 _capacity) external onlyOwner {
        if (_capacity <= capacity) revert Miner__CapacityBelowCurrent();
        if (_capacity > MAX_CAPACITY) revert Miner__CapacityExceedsMax();
        capacity = _capacity;
        emit Miner__CapacitySet(_capacity);
    }

    function setMultipliers(uint256[] calldata _multipliers) external onlyOwner {
        uint256 length = _multipliers.length;
        if (length == 0) revert Miner__InvalidLength();

        uint256 minMultiplier = DEFAULT_MULTIPLIER;
        for (uint256 i = 0; i < length; i++) {
            if (_multipliers[i] < minMultiplier) revert Miner__InvalidMultiplier();
        }

        multipliers = _multipliers;

        emit Miner__MultipliersSet(_multipliers);
    }

    function getEntropy() internal view override returns (address) {
        return address(entropy);
    }

    function getEntropyFee() external view returns (uint256) {
        return entropy.getFeeV2();
    }

    function getPrice(uint256 index) external view returns (uint256) {
        return _getPriceFromCache(index_Slot[index]);
    }

    function getUps() external view returns (uint256) {
        return _getUpsFromTime(block.timestamp);
    }

    function getSlot(uint256 index) external view returns (Slot memory) {
        return index_Slot[index];
    }

    function getMultipliers() external view returns (uint256[] memory) {
        return multipliers;
    }

    function getMultipliersLength() external view returns (uint256) {
        return multipliers.length;
    }
}
