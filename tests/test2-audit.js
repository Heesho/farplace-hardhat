/**
 * @title Miner Contract Security Audit Tests
 * @notice Comprehensive security-focused test suite for the Miner contract
 * @dev Tests cover: reentrancy, access control, arithmetic, state manipulation,
 *      economic attacks, edge cases, and invariant checking
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const divDec = (amount, decimals = 18) => amount / 10 ** decimals;

const AddressZero = "0x0000000000000000000000000000000000000000";

describe("AUDIT: Miner Contract Security Tests", function () {
  let owner, attacker, user1, user2, treasury, team, faction1, faction2, entropyProvider;
  let weth, miner, unit, entropy;
  let snapshotId;

  before("Deploy contracts once", async function () {
    [owner, attacker, user1, user2, treasury, team, faction1, faction2, entropyProvider] =
      await ethers.getSigners();

    // Deploy WETH mock
    const wethArtifact = await ethers.getContractFactory("Base");
    weth = await wethArtifact.deploy();

    // Deploy Entropy mock
    const entropyArtifact = await ethers.getContractFactory("TestMockEntropy");
    entropy = await entropyArtifact.deploy(entropyProvider.address);

    // Deploy Miner
    const minerArtifact = await ethers.getContractFactory("Miner");
    miner = await minerArtifact.deploy(
      weth.address,
      entropy.address,
      treasury.address,
      team.address
    );

    // Get Unit token
    unit = await ethers.getContractAt("contracts/Miner.sol:Unit", await miner.unit());

    // Setup factions
    await miner.setFaction(faction1.address, true);
    await miner.setFaction(faction2.address, true);

    // Fund users with WETH
    await weth.connect(user1).deposit({ value: convert("100", 18) });
    await weth.connect(user2).deposit({ value: convert("100", 18) });
    await weth.connect(attacker).deposit({ value: convert("100", 18) });

    // Approve miner
    await weth.connect(user1).approve(miner.address, ethers.constants.MaxUint256);
    await weth.connect(user2).approve(miner.address, ethers.constants.MaxUint256);
    await weth.connect(attacker).approve(miner.address, ethers.constants.MaxUint256);
  });

  beforeEach(async function () {
    snapshotId = await ethers.provider.send("evm_snapshot", []);
  });

  afterEach(async function () {
    await ethers.provider.send("evm_revert", [snapshotId]);
  });

  // ============================================
  // SECTION 1: ACCESS CONTROL TESTS
  // ============================================

  describe("1. Access Control", function () {
    it("1.1 Only owner can call setTreasury", async function () {
      await expect(miner.connect(attacker).setTreasury(attacker.address)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });

    it("1.2 Only owner can call setTeam", async function () {
      await expect(miner.connect(attacker).setTeam(attacker.address)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });

    it("1.3 Only owner can call setFaction", async function () {
      await expect(miner.connect(attacker).setFaction(attacker.address, true)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });

    it("1.4 Only owner can call setCapacity", async function () {
      await expect(miner.connect(attacker).setCapacity(10)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });

    it("1.5 Only owner can call setMultipliers", async function () {
      await expect(
        miner.connect(attacker).setMultipliers([convert("1", 18)])
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("1.6 Ownership transfer works correctly", async function () {
      await miner.transferOwnership(user1.address);
      expect(await miner.owner()).to.equal(user1.address);

      // Old owner can no longer call admin functions
      await expect(miner.connect(owner).setCapacity(10)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );

      // New owner can call admin functions
      await miner.connect(user1).setCapacity(10);
      expect(await miner.capacity()).to.equal(10);
    });

    it("1.7 Unit token can only be minted by Miner contract", async function () {
      await expect(unit.connect(attacker).mint(attacker.address, convert("1000", 18))).to.be
        .reverted;
    });
  });

  // ============================================
  // SECTION 2: INPUT VALIDATION TESTS
  // ============================================

  describe("2. Input Validation", function () {
    it("2.1 Cannot mine with zero miner address", async function () {
      const slot = await miner.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      await expect(
        miner
          .connect(user1)
          .mine(AddressZero, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#123456")
      ).to.be.reverted;
    });

    it("2.2 Cannot mine with expired deadline", async function () {
      const slot = await miner.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      await expect(
        miner
          .connect(user1)
          .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp - 1, 0, "#123456")
      ).to.be.reverted;
    });

    it("2.3 Cannot mine with invalid index", async function () {
      const capacity = await miner.capacity();
      const latest = await ethers.provider.getBlock("latest");
      await expect(
        miner.connect(user1).mine(user1.address, AddressZero, capacity, 0, latest.timestamp + 3600, 0, "#123456")
      ).to.be.reverted;
    });

    it("2.4 Cannot mine with wrong epochId", async function () {
      const slot = await miner.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      await expect(
        miner
          .connect(user1)
          .mine(
            user1.address,
            AddressZero,
            0,
            slot.epochId.add(1),
            latest.timestamp + 3600,
            0,
            "#123456"
          )
      ).to.be.reverted;
    });

    it("2.5 Cannot mine with non-whitelisted faction", async function () {
      // First mine to set price > 0
      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#123456");

      // Try to mine with non-whitelisted address
      slot = await miner.getSlot(0);
      const price = await miner.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await expect(
        miner
          .connect(user2)
          .mine(user2.address, attacker.address, 0, slot.epochId, latest.timestamp + 3600, price, "#654321")
      ).to.be.reverted;
    });

    it("2.6 Cannot set treasury to zero address", async function () {
      await expect(miner.setTreasury(AddressZero)).to.be.reverted;
    });

    it("2.7 Cannot whitelist zero address as faction", async function () {
      await expect(miner.setFaction(AddressZero, true)).to.be.reverted;
    });

    it("2.8 Cannot set capacity below or equal to current", async function () {
      const currentCapacity = await miner.capacity();
      await expect(miner.setCapacity(currentCapacity)).to.be.reverted;
      await expect(miner.setCapacity(0)).to.be.reverted;
    });

    it("2.9 Cannot set capacity above MAX_CAPACITY", async function () {
      const maxCapacity = await miner.MAX_CAPACITY();
      await expect(miner.setCapacity(maxCapacity.add(1))).to.be.reverted;
    });

    it("2.10 Cannot set empty multipliers array", async function () {
      await expect(miner.setMultipliers([])).to.be.reverted;
    });

    it("2.11 Cannot set multipliers below DEFAULT_MULTIPLIER", async function () {
      await expect(miner.setMultipliers([convert("0.5", 18)])).to.be.reverted;
    });
  });

  // ============================================
  // SECTION 3: ECONOMIC SECURITY TESTS
  // ============================================

  describe("3. Economic Security", function () {
    it("3.1 Fee distribution always totals 100%", async function () {
      // Mine initial slot
      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      // Get balances before
      const treasuryBefore = await weth.balanceOf(treasury.address);
      const teamBefore = await weth.balanceOf(team.address);
      const factionBefore = await weth.balanceOf(faction1.address);
      const minerBefore = await weth.balanceOf(user1.address);
      const user2Before = await weth.balanceOf(user2.address);

      // Mine with faction
      slot = await miner.getSlot(0);
      const price = await miner.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user2)
        .mine(user2.address, faction1.address, 0, slot.epochId, latest.timestamp + 3600, price, "#222222");

      // Get balances after
      const treasuryAfter = await weth.balanceOf(treasury.address);
      const teamAfter = await weth.balanceOf(team.address);
      const factionAfter = await weth.balanceOf(faction1.address);
      const minerAfter = await weth.balanceOf(user1.address);
      const user2After = await weth.balanceOf(user2.address);

      // Calculate flows
      const treasuryGain = treasuryAfter.sub(treasuryBefore);
      const teamGain = teamAfter.sub(teamBefore);
      const factionGain = factionAfter.sub(factionBefore);
      const minerGain = minerAfter.sub(minerBefore);
      const user2Loss = user2Before.sub(user2After);

      // Total received should equal total paid
      const totalReceived = treasuryGain.add(teamGain).add(factionGain).add(minerGain);
      expect(totalReceived).to.equal(user2Loss);
    });

    it("3.2 Cannot extract value through maxPrice manipulation", async function () {
      // Mine initial slot
      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      // Get price
      const price = await miner.getPrice(0);

      // Cannot mine with maxPrice below actual price
      slot = await miner.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await expect(
        miner.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#222222")
      ).to.be.reverted;
    });

    it("3.3 Price doubles correctly after mining (PRICE_MULTIPLIER)", async function () {
      // Mine slot 0
      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      // Get price immediately after
      const priceAfterFirst = await miner.getPrice(0);

      // Mine again immediately
      slot = await miner.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user2)
        .mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, priceAfterFirst, "#222222");

      // Price should be ~2x (allowing for minimal decay)
      const priceAfterSecond = await miner.getPrice(0);
      const ratio = priceAfterSecond.mul(100).div(priceAfterFirst);
      expect(ratio.toNumber()).to.be.within(195, 205); // ~2x with tolerance
    });

    it("3.4 Price decays to zero after EPOCH_PERIOD", async function () {
      // Mine slot 0
      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      // Price should be > 0 immediately
      const priceAfter = await miner.getPrice(0);
      expect(priceAfter).to.be.gt(0);

      // Fast forward past EPOCH_PERIOD (1 hour)
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);

      // Price should be 0
      const priceDecayed = await miner.getPrice(0);
      expect(priceDecayed).to.equal(0);
    });

    it("3.5 UPS halving works correctly", async function () {
      const initialUps = await miner.getUps();

      // Fast forward 30 days
      await ethers.provider.send("evm_increaseTime", [30 * 24 * 3600]);
      await ethers.provider.send("evm_mine", []);

      const upsAfter30Days = await miner.getUps();
      expect(upsAfter30Days).to.equal(initialUps.div(2));

      // Fast forward another 30 days
      await ethers.provider.send("evm_increaseTime", [30 * 24 * 3600]);
      await ethers.provider.send("evm_mine", []);

      const upsAfter60Days = await miner.getUps();
      expect(upsAfter60Days).to.equal(initialUps.div(4));
    });

    it("3.6 UPS never goes below TAIL_UPS", async function () {
      // Fast forward many halving periods (e.g., 10 years)
      await ethers.provider.send("evm_increaseTime", [365 * 24 * 3600 * 10]);
      await ethers.provider.send("evm_mine", []);

      const ups = await miner.getUps();
      const tailUps = await miner.TAIL_UPS();
      expect(ups).to.equal(tailUps);
    });

    it("3.7 Team fee is optional - treasury absorbs when team=0", async function () {
      // Set team to zero
      await miner.setTeam(AddressZero);

      // Mine initial
      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      // Get balances
      const treasuryBefore = await weth.balanceOf(treasury.address);
      const minerBefore = await weth.balanceOf(user1.address);

      // Mine
      slot = await miner.getSlot(0);
      const price = await miner.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user2)
        .mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, price, "#222222");

      const treasuryAfter = await weth.balanceOf(treasury.address);
      const minerAfter = await weth.balanceOf(user1.address);

      const treasuryGain = treasuryAfter.sub(treasuryBefore);
      const minerGain = minerAfter.sub(minerBefore);

      // Treasury should get 20% (full protocol fee)
      const totalFees = treasuryGain.add(minerGain);
      const treasuryPct = treasuryGain.mul(10000).div(totalFees).toNumber();
      expect(treasuryPct).to.be.within(1999, 2001);
    });
  });

  // ============================================
  // SECTION 4: STATE MANIPULATION TESTS
  // ============================================

  describe("4. State Manipulation", function () {
    it("4.1 EpochId increments correctly on each mine", async function () {
      const slot0 = await miner.getSlot(0);
      expect(slot0.epochId).to.equal(0);

      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot0.epochId, latest.timestamp + 3600, 0, "#111111");

      const slot1 = await miner.getSlot(0);
      expect(slot1.epochId).to.equal(1);

      latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user2)
        .mine(user2.address, AddressZero, 0, slot1.epochId, latest.timestamp + 3600, slot1.initPrice, "#222222");

      const slot2 = await miner.getSlot(0);
      expect(slot2.epochId).to.equal(2);
    });

    it("4.2 Cannot replay old epochId", async function () {
      let slot = await miner.getSlot(0);
      const oldEpochId = slot.epochId;

      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, oldEpochId, latest.timestamp + 3600, 0, "#111111");

      // Try to use old epochId
      slot = await miner.getSlot(0);
      const price = await miner.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await expect(
        miner.connect(user2).mine(user2.address, AddressZero, 0, oldEpochId, latest.timestamp + 3600, price, "#222222")
      ).to.be.reverted;
    });

    it("4.3 Slot miner address updates correctly", async function () {
      let slot = await miner.getSlot(0);
      expect(slot.miner).to.equal(AddressZero);

      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      slot = await miner.getSlot(0);
      expect(slot.miner).to.equal(user1.address);

      latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user2)
        .mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, slot.initPrice, "#222222");

      slot = await miner.getSlot(0);
      expect(slot.miner).to.equal(user2.address);
    });

    it("4.4 Slot URI updates correctly", async function () {
      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");

      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#AABBCC");

      slot = await miner.getSlot(0);
      expect(slot.uri).to.equal("#AABBCC");
    });

    it("4.5 Capacity increase allows mining new slots", async function () {
      // Initially capacity is 1
      expect(await miner.capacity()).to.equal(1);

      // Cannot mine slot 1
      const latest1 = await ethers.provider.getBlock("latest");
      await expect(
        miner.connect(user1).mine(user1.address, AddressZero, 1, 0, latest1.timestamp + 3600, 0, "#111111")
      ).to.be.reverted;

      // Increase capacity
      await miner.setCapacity(5);

      // Now can mine slot 1
      const latest2 = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 1, 0, latest2.timestamp + 3600, 0, "#111111");

      const slot1 = await miner.getSlot(1);
      expect(slot1.miner).to.equal(user1.address);
    });

    it("4.6 Different slots are independent", async function () {
      await miner.setCapacity(3);

      // Mine slot 0
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, 0, latest.timestamp + 3600, 0, "#000000");

      // Mine slot 1
      latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user2)
        .mine(user2.address, AddressZero, 1, 0, latest.timestamp + 3600, 0, "#111111");

      // Verify slots are independent
      const slot0 = await miner.getSlot(0);
      const slot1 = await miner.getSlot(1);
      const slot2 = await miner.getSlot(2);

      expect(slot0.miner).to.equal(user1.address);
      expect(slot0.epochId).to.equal(1);
      expect(slot0.uri).to.equal("#000000");

      expect(slot1.miner).to.equal(user2.address);
      expect(slot1.epochId).to.equal(1);
      expect(slot1.uri).to.equal("#111111");

      expect(slot2.miner).to.equal(AddressZero);
      expect(slot2.epochId).to.equal(0);
    });
  });

  // ============================================
  // SECTION 5: TOKEN MINTING SECURITY
  // ============================================

  describe("5. Token Minting Security", function () {
    it("5.1 UNIT tokens only minted to previous miner", async function () {
      // Initial mine (no tokens minted as no previous miner)
      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      // Wait for some time
      await ethers.provider.send("evm_increaseTime", [1800]); // 30 min
      await ethers.provider.send("evm_mine", []);

      const user1BalBefore = await unit.balanceOf(user1.address);
      const user2BalBefore = await unit.balanceOf(user2.address);

      // User2 mines
      slot = await miner.getSlot(0);
      const price = await miner.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user2)
        .mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, price, "#222222");

      const user1BalAfter = await unit.balanceOf(user1.address);
      const user2BalAfter = await unit.balanceOf(user2.address);

      // User1 (previous miner) should have received tokens
      expect(user1BalAfter).to.be.gt(user1BalBefore);
      // User2 (current miner) should NOT have received tokens (they get on next mine)
      expect(user2BalAfter).to.equal(user2BalBefore);
    });

    it("5.2 No tokens minted when slot has no previous miner", async function () {
      const totalSupplyBefore = await unit.totalSupply();

      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      const totalSupplyAfter = await unit.totalSupply();
      expect(totalSupplyAfter).to.equal(totalSupplyBefore);
    });

    it("5.3 Minted amount scales with time held and multiplier", async function () {
      // Mine slot 0
      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      // Wait 1 hour
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      const balBefore1 = await unit.balanceOf(user1.address);

      // Mine again
      slot = await miner.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user2)
        .mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#222222");

      const balAfter1 = await unit.balanceOf(user1.address);
      const minted1 = balAfter1.sub(balBefore1);

      // User2 mines - wait 2 hours
      await ethers.provider.send("evm_increaseTime", [7200]);
      await ethers.provider.send("evm_mine", []);

      const balBefore2 = await unit.balanceOf(user2.address);

      slot = await miner.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#333333");

      const balAfter2 = await unit.balanceOf(user2.address);
      const minted2 = balAfter2.sub(balBefore2);

      // Second mint should be ~2x first (held 2x as long)
      const ratio = minted2.mul(100).div(minted1);
      expect(ratio.toNumber()).to.be.within(180, 220);
    });
  });

  // ============================================
  // SECTION 6: EDGE CASES AND BOUNDARIES
  // ============================================

  describe("6. Edge Cases and Boundaries", function () {
    it("6.1 Can mine immediately after previous mine (no time passed)", async function () {
      // First mine
      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      // Immediate second mine (price should be at initPrice)
      slot = await miner.getSlot(0);
      const price = await miner.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user2)
        .mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, price, "#222222");

      const slot2 = await miner.getSlot(0);
      expect(slot2.miner).to.equal(user2.address);
    });

    it("6.2 Price respects MIN_INIT_PRICE floor", async function () {
      // The initial price is set to MIN_INIT_PRICE when price=0
      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      slot = await miner.getSlot(0);
      const minInitPrice = await miner.MIN_INIT_PRICE();
      expect(slot.initPrice).to.be.gte(minInitPrice);
    });

    it("6.3 Mining at exactly deadline timestamp works", async function () {
      const slot = await miner.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      const deadline = latest.timestamp + 1;

      // This should work since block.timestamp <= deadline
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, deadline, 0, "#111111");
    });

    it("6.4 Large capacity increase works", async function () {
      const maxCapacity = await miner.MAX_CAPACITY();
      await miner.setCapacity(maxCapacity);

      expect(await miner.capacity()).to.equal(maxCapacity);

      // Can mine last slot
      const latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, maxCapacity.sub(1), 0, latest.timestamp + 3600, 0, "#FFFFFF");
    });

    it("6.5 Multiplier array with all same values works", async function () {
      const multipliers = Array(10).fill(convert("2", 18));
      await miner.setMultipliers(multipliers);

      const stored = await miner.getMultipliers();
      expect(stored.length).to.equal(10);
      for (const m of stored) {
        expect(m).to.equal(convert("2", 18));
      }
    });

    it("6.6 Can toggle faction status multiple times", async function () {
      expect(await miner.account_IsFaction(faction1.address)).to.be.true;

      await miner.setFaction(faction1.address, false);
      expect(await miner.account_IsFaction(faction1.address)).to.be.false;

      await miner.setFaction(faction1.address, true);
      expect(await miner.account_IsFaction(faction1.address)).to.be.true;

      await miner.setFaction(faction1.address, false);
      expect(await miner.account_IsFaction(faction1.address)).to.be.false;
    });

    it("6.7 Empty URI string is allowed", async function () {
      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "");

      slot = await miner.getSlot(0);
      expect(slot.uri).to.equal("");
    });

    it("6.8 Very long URI string is allowed", async function () {
      const longUri = "#" + "A".repeat(1000);
      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, longUri);

      slot = await miner.getSlot(0);
      expect(slot.uri).to.equal(longUri);
    });
  });

  // ============================================
  // SECTION 7: INVARIANT TESTS
  // ============================================

  describe("7. Invariants", function () {
    it("7.1 Protocol fee + miner fee always equals price paid", async function () {
      // Mine initial
      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      // Track all balances
      const balancesBefore = {
        treasury: await weth.balanceOf(treasury.address),
        team: await weth.balanceOf(team.address),
        faction: await weth.balanceOf(faction1.address),
        miner: await weth.balanceOf(user1.address),
        payer: await weth.balanceOf(user2.address),
      };

      // Mine with faction
      slot = await miner.getSlot(0);
      const price = await miner.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user2)
        .mine(user2.address, faction1.address, 0, slot.epochId, latest.timestamp + 3600, price, "#222222");

      const balancesAfter = {
        treasury: await weth.balanceOf(treasury.address),
        team: await weth.balanceOf(team.address),
        faction: await weth.balanceOf(faction1.address),
        miner: await weth.balanceOf(user1.address),
        payer: await weth.balanceOf(user2.address),
      };

      const pricePaid = balancesBefore.payer.sub(balancesAfter.payer);
      const totalReceived = balancesAfter.treasury
        .sub(balancesBefore.treasury)
        .add(balancesAfter.team.sub(balancesBefore.team))
        .add(balancesAfter.faction.sub(balancesBefore.faction))
        .add(balancesAfter.miner.sub(balancesBefore.miner));

      expect(pricePaid).to.equal(totalReceived);
    });

    it("7.2 UNIT total supply only increases (no burn in mine)", async function () {
      // Setup
      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      // Multiple mines
      for (let i = 0; i < 5; i++) {
        await ethers.provider.send("evm_increaseTime", [1800]);
        await ethers.provider.send("evm_mine", []);

        const supplyBefore = await unit.totalSupply();

        slot = await miner.getSlot(0);
        const price = await miner.getPrice(0);
        latest = await ethers.provider.getBlock("latest");
        await miner
          .connect(i % 2 === 0 ? user2 : user1)
          .mine(
            i % 2 === 0 ? user2.address : user1.address,
            AddressZero,
            0,
            slot.epochId,
            latest.timestamp + 3600,
            price,
            "#" + i.toString().repeat(6)
          );

        const supplyAfter = await unit.totalSupply();
        expect(supplyAfter).to.be.gte(supplyBefore);
      }
    });

    it("7.3 Capacity can only increase, never decrease", async function () {
      const cap1 = await miner.capacity();
      await miner.setCapacity(cap1.add(10));

      const cap2 = await miner.capacity();
      expect(cap2).to.be.gt(cap1);

      // Cannot decrease
      await expect(miner.setCapacity(cap1)).to.be.reverted;
      await expect(miner.setCapacity(cap2.sub(1))).to.be.reverted;
    });

    it("7.4 Epoch ID never decreases for a given slot", async function () {
      let slot = await miner.getSlot(0);
      let prevEpochId = slot.epochId;

      for (let i = 0; i < 10; i++) {
        const latest = await ethers.provider.getBlock("latest");
        await miner
          .connect(i % 2 === 0 ? user1 : user2)
          .mine(
            i % 2 === 0 ? user1.address : user2.address,
            AddressZero,
            0,
            slot.epochId,
            latest.timestamp + 3600,
            slot.initPrice,
            "#" + i.toString().repeat(6)
          );

        slot = await miner.getSlot(0);
        expect(slot.epochId).to.be.gt(prevEpochId);
        prevEpochId = slot.epochId;
      }
    });
  });

  // ============================================
  // SECTION 8: EVENT EMISSION TESTS
  // ============================================

  describe("8. Event Emissions", function () {
    it("8.1 Miner__Mine event emitted with correct parameters", async function () {
      const slot = await miner.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");

      await expect(
        miner
          .connect(user1)
          .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#ABCDEF")
      )
        .to.emit(miner, "Miner__Mine")
        .withArgs(user1.address, user1.address, AddressZero, 0, slot.epochId, 0, "#ABCDEF");
    });

    it("8.2 Fee events emitted correctly", async function () {
      // Mine initial
      let slot = await miner.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await miner
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      // Second mine with faction
      slot = await miner.getSlot(0);
      const price = await miner.getPrice(0);
      latest = await ethers.provider.getBlock("latest");

      const tx = await miner
        .connect(user2)
        .mine(user2.address, faction1.address, 0, slot.epochId, latest.timestamp + 3600, price, "#222222");

      const receipt = await tx.wait();

      // Should have Treasury, Team, Faction, and Miner fee events
      const feeEvents = receipt.events.filter(
        (e) =>
          e.event === "Miner__TreasuryFee" ||
          e.event === "Miner__TeamFee" ||
          e.event === "Miner__FactionFee" ||
          e.event === "Miner__MinerFee"
      );

      expect(feeEvents.length).to.equal(4);
    });

    it("8.3 Admin events emitted correctly", async function () {
      await expect(miner.setTreasury(user1.address))
        .to.emit(miner, "Miner__TreasurySet")
        .withArgs(user1.address);

      await expect(miner.setTeam(user1.address))
        .to.emit(miner, "Miner__TeamSet")
        .withArgs(user1.address);

      await expect(miner.setCapacity(10))
        .to.emit(miner, "Miner__CapacitySet")
        .withArgs(10);

      await expect(miner.setFaction(user2.address, true))
        .to.emit(miner, "Miner__FactionWhitelisted")
        .withArgs(user2.address, true);
    });
  });
});
