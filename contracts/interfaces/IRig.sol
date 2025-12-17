// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IRig {
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

    function unit() external view returns (address);
    function quote() external view returns (address);
    function treasury() external view returns (address);
    function team() external view returns (address);
    function startTime() external view returns (uint256);
    function capacity() external view returns (uint256);
    function index_Slot(uint256 index) external view returns (Slot memory);
    function getMultipliers() external view returns (uint256[] memory);
    function getPrice(uint256 index) external view returns (uint256);
    function getUps() external view returns (uint256);
    function getSlot(uint256 index) external view returns (Slot memory);
    function getEntropyFee() external view returns (uint256);
    function getMultipliersLength() external view returns (uint256);
    function MULTIPLIER_DURATION() external view returns (uint256);

    function mine(
        address miner,
        address faction,
        uint256 index,
        uint256 epochId,
        uint256 deadline,
        uint256 maxPrice,
        string memory uri
    ) external payable returns (uint256 price);

    function setTreasury(address _treasury) external;
    function setTeam(address _team) external;
    function setFaction(address _faction, bool _isFaction) external;
    function setCapacity(uint256 _capacity) external;
    function setMultipliers(uint256[] calldata _multipliers) external;
    function transferOwnership(address newOwner) external;
}
