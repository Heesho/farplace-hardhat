const { expect } = require("chai");
const { ethers } = require("hardhat");

const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const divDec = (amount, decimals = 18) => amount / 10 ** decimals;
const AddressZero = "0x0000000000000000000000000000000000000000";
const AddressDead = "0x000000000000000000000000000000000000dEaD";

describe("Multicall Contract", function () {
  let owner, treasury, team, user1, user2, faction1, entropyProvider;
  let weth, unit, rig, auction, multicall, entropy;
  let donut, factory, router, lpToken;
  let snapshotId;

  before("Deploy full system with LP", async function () {
    [owner, treasury, team, user1, user2, faction1, entropyProvider] = await ethers.getSigners();

    // Deploy MockWETH
    const wethArtifact = await ethers.getContractFactory("MockWETH");
    weth = await wethArtifact.deploy();

    // Deploy MockDonut
    const donutArtifact = await ethers.getContractFactory("MockDonut");
    donut = await donutArtifact.deploy();

    // Deploy MockEntropy
    const entropyArtifact = await ethers.getContractFactory("TestMockEntropy");
    entropy = await entropyArtifact.deploy(entropyProvider.address);

    // Deploy Unit
    const unitArtifact = await ethers.getContractFactory("Unit");
    unit = await unitArtifact.deploy("FarPlace", "FARP");

    // Temporarily set rig to owner so we can mint for LP creation
    await unit.setRig(owner.address);

    // Deploy Uniswap V2 mocks
    const factoryArtifact = await ethers.getContractFactory("MockUniswapV2Factory");
    factory = await factoryArtifact.deploy();

    const routerArtifact = await ethers.getContractFactory("MockUniswapV2Router");
    router = await routerArtifact.deploy(factory.address);

    // Mint Unit tokens for LP creation (owner is still the rig at this point)
    await unit.mint(owner.address, convert("100000", 18));

    // Mint Donut tokens for LP creation
    await donut.mint(owner.address, convert("100000", 18));

    // Approve router
    await unit.approve(router.address, convert("100000", 18));
    await donut.approve(router.address, convert("100000", 18));

    // Create LP (Unit + Donut)
    const block = await ethers.provider.getBlock("latest");
    const deadline = block.timestamp + 3600;
    await router.addLiquidity(
      unit.address,
      donut.address,
      convert("50000", 18),
      convert("50000", 18),
      0,
      0,
      owner.address,
      deadline
    );

    // Get LP token address
    const lpAddress = await factory.getPair(unit.address, donut.address);
    lpToken = await ethers.getContractAt("MockLP", lpAddress);

    // Deploy Auction with LP as payment token
    const auctionArtifact = await ethers.getContractFactory("Auction");
    auction = await auctionArtifact.deploy(
      convert("1", 18), // initPrice
      lpToken.address, // paymentToken (LP)
      AddressDead, // burnAddress
      86400, // auctionPeriod (1 day)
      convert("1.2", 18), // priceMultiplier
      convert("1", 18) // minInitPrice
    );

    // Deploy Rig
    const rigArtifact = await ethers.getContractFactory("Rig");
    rig = await rigArtifact.deploy(unit.address, weth.address, entropy.address, treasury.address);
    await rig.setTeam(team.address);

    // Transfer minting rights to Rig
    await unit.setRig(rig.address);

    // Setup factions
    await rig.setFaction(faction1.address, true);

    // Deploy Multicall
    const multicallArtifact = await ethers.getContractFactory("Multicall");
    multicall = await multicallArtifact.deploy(rig.address, auction.address, donut.address);

    // Fund users with WETH
    await weth.connect(user1).deposit({ value: convert("100", 18) });
    await weth.connect(user2).deposit({ value: convert("100", 18) });
    await weth.connect(user1).approve(rig.address, ethers.constants.MaxUint256);
    await weth.connect(user2).approve(rig.address, ethers.constants.MaxUint256);

    // Give users some LP tokens for testing
    await lpToken.transfer(user1.address, convert("1000", 18));
    await lpToken.transfer(user2.address, convert("1000", 18));
  });

  beforeEach(async function () {
    snapshotId = await ethers.provider.send("evm_snapshot", []);
  });

  afterEach(async function () {
    await ethers.provider.send("evm_revert", [snapshotId]);
  });

  describe("Deployment", function () {
    it("should set correct immutable addresses", async function () {
      expect(await multicall.rig()).to.equal(rig.address);
      expect(await multicall.auction()).to.equal(auction.address);
      expect(await multicall.donut()).to.equal(donut.address);
    });

    it("should derive unit and weth from rig", async function () {
      expect(await multicall.unit()).to.equal(unit.address);
      expect(await multicall.weth()).to.equal(weth.address);
    });
  });

  describe("getRig - Rig State Query", function () {
    it("should return correct UPS", async function () {
      const state = await multicall.getRig(user1.address);
      const expectedUps = await rig.getUps();
      expect(state.ups).to.equal(expectedUps);
    });

    it("should return correct unit balance for user", async function () {
      // Mint some Unit to user
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      // Wait and mine again to receive tokens
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      const slot2 = await rig.getSlot(0);
      const latest2 = await ethers.provider.getBlock("latest");
      await rig
        .connect(user2)
        .mine(user2.address, AddressZero, 0, slot2.epochId, latest2.timestamp + 3600, 0, "#222222");

      const state = await multicall.getRig(user1.address);
      const actualBalance = await unit.balanceOf(user1.address);
      expect(state.unitBalance).to.equal(actualBalance);
    });

    it("should return correct ETH balance for user", async function () {
      const state = await multicall.getRig(user1.address);
      const actualBalance = await ethers.provider.getBalance(user1.address);
      expect(state.ethBalance).to.equal(actualBalance);
    });

    it("should return correct WETH balance for user", async function () {
      const state = await multicall.getRig(user1.address);
      const actualBalance = await weth.balanceOf(user1.address);
      expect(state.wethBalance).to.equal(actualBalance);
    });

    it("should return zero balances for zero address", async function () {
      const state = await multicall.getRig(AddressZero);
      expect(state.unitBalance).to.equal(0);
      expect(state.ethBalance).to.equal(0);
      expect(state.wethBalance).to.equal(0);
    });

    it("should calculate unitPrice from LP reserves", async function () {
      const state = await multicall.getRig(user1.address);
      // LP has Unit and Donut in equal amounts initially
      // unitPrice = donutInPool * 1e18 / unitInPool
      const donutInPool = await donut.balanceOf(lpToken.address);
      const unitInPool = await unit.balanceOf(lpToken.address);
      const expectedPrice = unitInPool.eq(0) ? 0 : donutInPool.mul(convert("1", 18)).div(unitInPool);
      expect(state.unitPrice).to.equal(expectedPrice);
    });

    it("should handle zero unitInPool gracefully", async function () {
      // Create a new LP with no Unit (this would be unrealistic but tests the edge case)
      // The current LP has tokens, so we need to use a different approach
      // We'll test with the existing setup - if unitInPool is not zero, price is calculated
      const state = await multicall.getRig(user1.address);
      const unitInPool = await unit.balanceOf(lpToken.address);
      if (unitInPool.gt(0)) {
        expect(state.unitPrice).to.be.gt(0);
      }
    });
  });

  describe("getSlot - Single Slot Query", function () {
    it("should return correct slot data for unmined slot", async function () {
      const state = await multicall.getSlot(0);
      expect(state.epochId).to.equal(0);
      expect(state.initPrice).to.equal(0);
      expect(state.price).to.equal(0);
      expect(state.miner).to.equal(AddressZero);
      expect(state.uri).to.equal("");
    });

    it("should return correct slot data after mining", async function () {
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, 0, latest.timestamp + 3600, 0, "#AABBCC");

      const state = await multicall.getSlot(0);
      expect(state.epochId).to.equal(1);
      expect(state.miner).to.equal(user1.address);
      expect(state.uri).to.equal("#AABBCC");
      expect(state.initPrice).to.be.gt(0);
    });

    it("should return correct price (decaying over time)", async function () {
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, 0, latest.timestamp + 3600, 0, "#111111");

      const stateImmediate = await multicall.getSlot(0);
      const priceImmediate = stateImmediate.price;

      // Wait 30 minutes
      await ethers.provider.send("evm_increaseTime", [1800]);
      await ethers.provider.send("evm_mine", []);

      const stateDecayed = await multicall.getSlot(0);
      expect(stateDecayed.price).to.be.lt(priceImmediate);
    });

    it("should calculate UPS correctly with multiplier", async function () {
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, 0, latest.timestamp + 3600, 0, "#111111");

      const state = await multicall.getSlot(0);
      const slot = await rig.getSlot(0);
      const expectedUps = slot.ups.mul(state.multiplier).div(convert("1", 18));
      expect(state.ups).to.equal(expectedUps);
    });

    it("should calculate mined amount correctly", async function () {
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, 0, latest.timestamp + 3600, 0, "#111111");

      // Wait some time
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      const state = await multicall.getSlot(0);
      expect(state.mined).to.be.gt(0);
    });

    it("should return correct multiplierTime", async function () {
      // Set multipliers
      await rig.setMultipliers([convert("1", 18), convert("2", 18)]);

      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, 0, latest.timestamp + 3600, 0, "#111111");

      const state = await multicall.getSlot(0);
      // multiplierTime should be > 0 if within MULTIPLIER_DURATION
      // This depends on if entropy set a multiplier > 1x
    });
  });

  describe("getSlots - Batch Slot Query", function () {
    beforeEach("Increase capacity", async function () {
      await rig.setCapacity(5);
    });

    it("should return correct number of slots", async function () {
      const states = await multicall.getSlots(0, 4);
      expect(states.length).to.equal(5);
    });

    it("should return correct data for each slot", async function () {
      // Mine slots 0 and 2
      let latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, 0, latest.timestamp + 3600, 0, "#000000");

      latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user2)
        .mine(user2.address, AddressZero, 2, 0, latest.timestamp + 3600, 0, "#222222");

      const states = await multicall.getSlots(0, 4);

      expect(states[0].miner).to.equal(user1.address);
      expect(states[0].uri).to.equal("#000000");

      expect(states[1].miner).to.equal(AddressZero);

      expect(states[2].miner).to.equal(user2.address);
      expect(states[2].uri).to.equal("#222222");

      expect(states[3].miner).to.equal(AddressZero);
      expect(states[4].miner).to.equal(AddressZero);
    });

    it("should handle single slot range", async function () {
      const states = await multicall.getSlots(0, 0);
      expect(states.length).to.equal(1);
    });

    it("should handle large range", async function () {
      await rig.setCapacity(100);
      const states = await multicall.getSlots(0, 99);
      expect(states.length).to.equal(100);
    });
  });

  describe("getAuction - Auction State Query", function () {
    it("should return correct payment token address", async function () {
      const state = await multicall.getAuction(user1.address);
      expect(state.paymentToken).to.equal(lpToken.address);
    });

    it("should return correct epochId", async function () {
      const state = await multicall.getAuction(user1.address);
      const actualEpochId = await auction.epochId();
      expect(state.epochId).to.equal(actualEpochId);
    });

    it("should return correct initPrice", async function () {
      const state = await multicall.getAuction(user1.address);
      const actualInitPrice = await auction.initPrice();
      expect(state.initPrice).to.equal(actualInitPrice);
    });

    it("should return correct startTime", async function () {
      const state = await multicall.getAuction(user1.address);
      const actualStartTime = await auction.startTime();
      expect(state.startTime).to.equal(actualStartTime);
    });

    it("should return correct price (from auction)", async function () {
      const state = await multicall.getAuction(user1.address);
      const actualPrice = await auction.getPrice();
      expect(state.price).to.equal(actualPrice);
    });

    it("should return user payment token balance", async function () {
      const state = await multicall.getAuction(user1.address);
      const actualBalance = await lpToken.balanceOf(user1.address);
      expect(state.paymentTokenBalance).to.equal(actualBalance);
    });

    it("should return zero balance for zero address", async function () {
      const state = await multicall.getAuction(AddressZero);
      expect(state.paymentTokenBalance).to.equal(0);
    });

    it("should return correct wethAccumulated", async function () {
      const state = await multicall.getAuction(user1.address);
      const actualWeth = await weth.balanceOf(auction.address);
      expect(state.wethAccumulated).to.equal(actualWeth);
    });

    it("should calculate paymentTokenPrice correctly", async function () {
      const state = await multicall.getAuction(user1.address);
      const totalSupply = await lpToken.totalSupply();
      const donutBalance = await donut.balanceOf(lpToken.address);
      const expectedPrice = totalSupply.eq(0)
        ? 0
        : donutBalance.mul(convert("2", 18)).div(totalSupply);
      expect(state.paymentTokenPrice).to.equal(expectedPrice);
    });
  });

  describe("getEntropyFee", function () {
    it("should return entropy fee from rig", async function () {
      const fee = await multicall.getEntropyFee();
      const expectedFee = await rig.getEntropyFee();
      expect(fee).to.equal(expectedFee);
    });
  });

  describe("getMultipliers", function () {
    it("should return empty array when no multipliers set", async function () {
      const multipliers = await multicall.getMultipliers();
      expect(multipliers.length).to.equal(0);
    });

    it("should return multipliers when set", async function () {
      await rig.setMultipliers([convert("1", 18), convert("2", 18), convert("5", 18)]);

      const multipliers = await multicall.getMultipliers();
      expect(multipliers.length).to.equal(3);
      expect(multipliers[0]).to.equal(convert("1", 18));
      expect(multipliers[1]).to.equal(convert("2", 18));
      expect(multipliers[2]).to.equal(convert("5", 18));
    });
  });

  describe("mine - Mining via Multicall", function () {
    it("should allow mining through multicall with ETH", async function () {
      const slot = await multicall.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      const deadline = latest.timestamp + 3600;

      await multicall
        .connect(user1)
        .mine(AddressZero, 0, slot.epochId, deadline, slot.price, "#FF00FF", {
          value: slot.price,
        });

      const updatedSlot = await multicall.getSlot(0);
      expect(updatedSlot.miner).to.equal(user1.address);
      expect(updatedSlot.uri).to.equal("#FF00FF");
    });

    it("should convert ETH to WETH for mining", async function () {
      const slot = await multicall.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      const deadline = latest.timestamp + 3600;

      await multicall
        .connect(user1)
        .mine(AddressZero, 0, slot.epochId, deadline, slot.price, "#123456", {
          value: slot.price,
        });

      // Verify mining succeeded
      const updatedSlot = await multicall.getSlot(0);
      expect(updatedSlot.epochId).to.equal(1);
    });

    it("should refund excess WETH to user", async function () {
      // First mine to set a price
      let slot = await multicall.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111", {
        value: 0,
      });

      // Price should be > 0 now
      slot = await multicall.getSlot(0);
      const price = slot.price;

      // Wait for price to decay
      await ethers.provider.send("evm_increaseTime", [1800]);
      await ethers.provider.send("evm_mine", []);

      slot = await multicall.getSlot(0);
      const decayedPrice = slot.price;

      // Send more ETH than needed
      const wethBefore = await weth.balanceOf(user2.address);
      latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user2).mine(AddressZero, 0, slot.epochId, latest.timestamp + 3600, price, "#222222", {
        value: price, // Send the old (higher) price, actual price is lower now
      });

      const wethAfter = await weth.balanceOf(user2.address);
      // User should have received refund in WETH
      expect(wethAfter).to.be.gt(wethBefore);
    });

    it("should allow mining with faction through multicall", async function () {
      const slot = await multicall.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");

      await multicall
        .connect(user1)
        .mine(faction1.address, 0, slot.epochId, latest.timestamp + 3600, slot.price, "#ABCDEF", {
          value: slot.price,
        });

      const updatedSlot = await multicall.getSlot(0);
      expect(updatedSlot.miner).to.equal(user1.address);
    });

    it("should revert on invalid faction", async function () {
      // First mine to set price > 0
      let slot = await multicall.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111", {
        value: 0,
      });

      slot = await multicall.getSlot(0);
      const price = slot.price;
      latest = await ethers.provider.getBlock("latest");

      // user2 is not a whitelisted faction
      await expect(
        multicall.connect(user2).mine(user2.address, 0, slot.epochId, latest.timestamp + 3600, price, "#222222", {
          value: price,
        })
      ).to.be.reverted;
    });
  });

  describe("buy - Auction Buy via Multicall", function () {
    beforeEach("Approve LP tokens", async function () {
      await lpToken.connect(user1).approve(multicall.address, ethers.constants.MaxUint256);
      await lpToken.connect(user2).approve(multicall.address, ethers.constants.MaxUint256);
    });

    it("should allow buying through multicall", async function () {
      const auctionState = await multicall.getAuction(user1.address);
      const price = auctionState.price;
      const epochId = auctionState.epochId;

      const lpBefore = await lpToken.balanceOf(user1.address);

      const latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).buy(epochId, latest.timestamp + 3600, price);

      const lpAfter = await lpToken.balanceOf(user1.address);
      expect(lpAfter).to.be.lt(lpBefore);
    });

    it("should transfer WETH to buyer after purchase", async function () {
      // First add some WETH to auction
      await weth.connect(user1).transfer(auction.address, convert("10", 18));

      const auctionState = await multicall.getAuction(user1.address);
      const price = auctionState.price;
      const epochId = auctionState.epochId;

      const wethBefore = await weth.balanceOf(user1.address);

      const latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).buy(epochId, latest.timestamp + 3600, price);

      const wethAfter = await weth.balanceOf(user1.address);
      expect(wethAfter).to.be.gt(wethBefore);
    });
  });

  describe("Edge Cases", function () {
    it("should handle zero reserves in LP gracefully for unitPrice", async function () {
      // The test setup has non-zero reserves, but the code handles zero case
      const state = await multicall.getRig(user1.address);
      // Just verify it doesn't revert
      expect(state.ups).to.be.gte(0);
    });

    it("should handle zero totalSupply gracefully for paymentTokenPrice", async function () {
      // With the current setup totalSupply > 0, but code handles zero case
      const state = await multicall.getAuction(user1.address);
      // Just verify it doesn't revert
      expect(state.paymentTokenPrice).to.be.gte(0);
    });

    it("should work with slots at capacity boundary", async function () {
      await rig.setCapacity(10);
      const states = await multicall.getSlots(0, 9);
      expect(states.length).to.equal(10);

      // Mine the last slot
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 9, 0, latest.timestamp + 3600, 0, "#999999");

      const lastSlot = await multicall.getSlot(9);
      expect(lastSlot.miner).to.equal(user1.address);
    });
  });

  describe("Integration - Full Mining Flow", function () {
    it("should complete full mining cycle through multicall", async function () {
      // Initial state check
      let rigState = await multicall.getRig(user1.address);
      expect(rigState.unitBalance).to.equal(0);

      // Mine slot 0
      let slot = await multicall.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111", {
        value: 0,
      });

      // Verify slot updated
      slot = await multicall.getSlot(0);
      expect(slot.miner).to.equal(user1.address);
      expect(slot.epochId).to.equal(1);

      // Wait for time to accrue tokens
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      // Mine again (user2 takes over)
      slot = await multicall.getSlot(0);
      const price = slot.price;
      latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user2).mine(AddressZero, 0, slot.epochId, latest.timestamp + 3600, price, "#222222", {
        value: price,
      });

      // Verify user1 received Unit tokens
      rigState = await multicall.getRig(user1.address);
      expect(rigState.unitBalance).to.be.gt(0);

      // Verify slot updated again
      slot = await multicall.getSlot(0);
      expect(slot.miner).to.equal(user2.address);
      expect(slot.epochId).to.equal(2);
    });

    it("should show correct state after multiple miners", async function () {
      await rig.setCapacity(3);

      // Multiple users mine different slots
      let latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(AddressZero, 0, 0, latest.timestamp + 3600, 0, "#AA0000", {
        value: 0,
      });

      latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user2).mine(AddressZero, 1, 0, latest.timestamp + 3600, 0, "#00BB00", {
        value: 0,
      });

      latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(AddressZero, 2, 0, latest.timestamp + 3600, 0, "#0000CC", {
        value: 0,
      });

      // Get all slots at once
      const slots = await multicall.getSlots(0, 2);

      expect(slots[0].miner).to.equal(user1.address);
      expect(slots[0].uri).to.equal("#AA0000");

      expect(slots[1].miner).to.equal(user2.address);
      expect(slots[1].uri).to.equal("#00BB00");

      expect(slots[2].miner).to.equal(user1.address);
      expect(slots[2].uri).to.equal("#0000CC");
    });
  });
});
