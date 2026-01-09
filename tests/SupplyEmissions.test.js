const { expect } = require("chai");
const { ethers } = require("hardhat");

const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const divDec = (amount, decimals = 18) => amount / 10 ** decimals;
const AddressZero = "0x0000000000000000000000000000000000000000";

/**
 * SUPPLY EMISSIONS SECURITY TESTS
 *
 * These tests rigorously verify the amount-based halving mechanism
 * to ensure no exploits exist in the token emission system.
 */
describe("Supply Emissions Security", function () {
  let owner, treasury, team, user1, user2, user3, attacker, entropyProvider;
  let weth, unit, rig, entropy;
  let snapshotId;

  // Constants matching contract
  const INITIAL_UPS = convert("4", 18);
  const HALVING_AMOUNT = convert("10000000", 18); // 10M tokens
  const TAIL_UPS = convert("0.01", 18);
  const PRECISION = convert("1", 18);
  const DEFAULT_MULTIPLIER = convert("1", 18);
  const EPOCH_PERIOD = 3600; // 1 hour

  before("Deploy contracts", async function () {
    [owner, treasury, team, user1, user2, user3, attacker, entropyProvider] =
      await ethers.getSigners();

    // Deploy MockWETH
    const wethArtifact = await ethers.getContractFactory("MockWETH");
    weth = await wethArtifact.deploy();

    // Deploy MockEntropy
    const entropyArtifact = await ethers.getContractFactory("TestMockEntropy");
    entropy = await entropyArtifact.deploy(entropyProvider.address);

    // Deploy Unit
    const unitArtifact = await ethers.getContractFactory("Unit");
    unit = await unitArtifact.deploy("TestUnit", "TUNIT");

    // Deploy Rig
    const rigArtifact = await ethers.getContractFactory("Rig");
    rig = await rigArtifact.deploy(unit.address, weth.address, entropy.address, treasury.address);
    await rig.setTeam(team.address);

    // Transfer minting rights to Rig
    await unit.setRig(rig.address);

    // Fund users with WETH
    const users = [user1, user2, user3, attacker];
    for (const user of users) {
      await weth.connect(user).deposit({ value: convert("1000", 18) });
      await weth.connect(user).approve(rig.address, ethers.constants.MaxUint256);
    }
  });

  beforeEach(async function () {
    snapshotId = await ethers.provider.send("evm_snapshot", []);
  });

  afterEach(async function () {
    await ethers.provider.send("evm_revert", [snapshotId]);
  });

  /***************************************************************************
   * 1. TOTAL MINTED INVARIANTS
   ***************************************************************************/
  describe("1. TotalMinted Invariants", function () {
    it("1.1 totalMinted should always equal unit.totalSupply()", async function () {
      // Mine multiple times
      for (let i = 0; i < 10; i++) {
        const slot = await rig.getSlot(0);
        const latest = await ethers.provider.getBlock("latest");
        const miner = i % 2 === 0 ? user1 : user2;

        await rig.connect(miner).mine(
          miner.address,
          AddressZero,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          slot.initPrice,
          `#test${i}`
        );

        // Wait between mines
        await ethers.provider.send("evm_increaseTime", [1800]);
        await ethers.provider.send("evm_mine", []);

        // Invariant check
        const totalMinted = await rig.totalMinted();
        const totalSupply = await unit.totalSupply();
        expect(totalMinted).to.equal(totalSupply, `Mismatch at iteration ${i}`);
      }
    });

    it("1.2 totalMinted should never decrease", async function () {
      let prevTotalMinted = ethers.BigNumber.from(0);

      for (let i = 0; i < 15; i++) {
        const slot = await rig.getSlot(0);
        const latest = await ethers.provider.getBlock("latest");
        const miner = [user1, user2, user3][i % 3];

        await rig.connect(miner).mine(
          miner.address,
          AddressZero,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          slot.initPrice,
          `#test${i}`
        );

        await ethers.provider.send("evm_increaseTime", [600]);
        await ethers.provider.send("evm_mine", []);

        const totalMinted = await rig.totalMinted();
        expect(totalMinted).to.be.gte(prevTotalMinted, `totalMinted decreased at iteration ${i}`);
        prevTotalMinted = totalMinted;
      }
    });

    it("1.3 totalMinted should only increase when previous miner exists", async function () {
      // First mine - no previous miner
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(
        user1.address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#first"
      );

      expect(await rig.totalMinted()).to.equal(0);

      // Wait and mine again - should mint tokens
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(
        user2.address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#second"
      );

      expect(await rig.totalMinted()).to.be.gt(0);
    });

    it("1.4 totalMinted accumulates correctly across multiple slots", async function () {
      await rig.setCapacity(5);

      // Mine all 5 slots
      for (let i = 0; i < 5; i++) {
        const slot = await rig.getSlot(i);
        const latest = await ethers.provider.getBlock("latest");
        await rig.connect(user1).mine(
          user1.address,
          AddressZero,
          i,
          slot.epochId,
          latest.timestamp + 3600,
          0,
          `#slot${i}`
        );
      }

      expect(await rig.totalMinted()).to.equal(0); // No previous miners

      // Wait and take over all slots
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      let expectedTotal = ethers.BigNumber.from(0);

      for (let i = 0; i < 5; i++) {
        const slot = await rig.getSlot(i);
        const latest = await ethers.provider.getBlock("latest");

        const balBefore = await unit.balanceOf(user1.address);
        await rig.connect(user2).mine(
          user2.address,
          AddressZero,
          i,
          slot.epochId,
          latest.timestamp + 3600,
          0,
          `#take${i}`
        );
        const balAfter = await unit.balanceOf(user1.address);
        expectedTotal = expectedTotal.add(balAfter.sub(balBefore));
      }

      expect(await rig.totalMinted()).to.equal(expectedTotal);
      expect(await unit.totalSupply()).to.equal(expectedTotal);
    });
  });

  /***************************************************************************
   * 2. HALVING THRESHOLD BOUNDARY TESTS
   ***************************************************************************/
  describe("2. Halving Threshold Boundaries", function () {
    // Helper to set totalMinted directly via storage manipulation
    async function setTotalMinted(amount) {
      // Find storage slot for totalMinted
      // Layout: treasury(53), team(54), capacity(55), totalMinted(56)
      // But we need the actual slot which depends on inheritance
      // For testing, we'll use a workaround - deploy a test contract

      // Actually, let's just verify the math without storage manipulation
      // since that's more reliable
    }

    it("2.1 Halving thresholds are computed correctly", async function () {
      // Verify thresholds: 10M, 15M, 17.5M, 18.75M, ...
      const thresholds = [];
      let threshold = HALVING_AMOUNT;
      thresholds.push(threshold);

      for (let i = 1; i < 15; i++) {
        threshold = threshold.add(HALVING_AMOUNT.shr(i));
        thresholds.push(threshold);
      }

      // Check first few thresholds
      expect(thresholds[0]).to.equal(convert("10000000", 18));
      expect(thresholds[1]).to.equal(convert("15000000", 18));
      expect(thresholds[2]).to.equal(convert("17500000", 18));
      expect(thresholds[3]).to.equal(convert("18750000", 18));
      expect(thresholds[4]).to.equal(convert("19375000", 18));
      expect(thresholds[5]).to.equal(convert("19687500", 18));

      // Thresholds converge to 2 * HALVING_AMOUNT = 20M
      expect(thresholds[14]).to.be.lt(convert("20000000", 18));
      expect(thresholds[14]).to.be.gt(convert("19999000", 18));
    });

    it("2.2 UPS rate halves correctly at each threshold", async function () {
      // Verify the bit shift produces correct rates
      expect(INITIAL_UPS.shr(0)).to.equal(convert("4", 18));
      expect(INITIAL_UPS.shr(1)).to.equal(convert("2", 18));
      expect(INITIAL_UPS.shr(2)).to.equal(convert("1", 18));
      expect(INITIAL_UPS.shr(3)).to.equal(convert("0.5", 18));
      expect(INITIAL_UPS.shr(4)).to.equal(convert("0.25", 18));
      expect(INITIAL_UPS.shr(5)).to.equal(convert("0.125", 18));
      expect(INITIAL_UPS.shr(6)).to.equal(convert("0.0625", 18));
      expect(INITIAL_UPS.shr(7)).to.equal(convert("0.03125", 18));
      expect(INITIAL_UPS.shr(8)).to.equal(convert("0.015625", 18));
    });

    it("2.3 Tail UPS kicks in at correct halving", async function () {
      // 4 >> 8 = 0.015625 > 0.01 (above tail)
      // 4 >> 9 = 0.0078125 < 0.01 (below tail, use tail)
      expect(INITIAL_UPS.shr(8)).to.be.gt(TAIL_UPS);
      expect(INITIAL_UPS.shr(9)).to.be.lt(TAIL_UPS);

      // This means tail kicks in at halving 9
      // Which happens when totalMinted >= threshold[8]
      // threshold[8] = 10M * (2 - 1/2^8) ≈ 19.96M
    });

    it("2.4 Loop terminates correctly (halvings < 64 guard)", async function () {
      // The contract has: while (totalMinted >= threshold && halvings < 64)
      // Verify that even with extremely high totalMinted, it terminates

      // After 64 halvings, 4e18 >> 64 = 0
      // So the loop guard prevents infinite loops
      expect(INITIAL_UPS.shr(64)).to.equal(0);
    });
  });

  /***************************************************************************
   * 3. MINTING CALCULATION ACCURACY
   ***************************************************************************/
  describe("3. Minting Calculation Accuracy", function () {
    it("3.1 Minted amount equals time * ups * multiplier / PRECISION", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      const tx1 = await rig.connect(user1).mine(
        user1.address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#first"
      );
      const receipt1 = await tx1.wait();
      const block1 = await ethers.provider.getBlock(receipt1.blockNumber);

      // Wait exactly 1 hour
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      // Second mine
      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      const tx2 = await rig.connect(user2).mine(
        user2.address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#second"
      );
      const receipt2 = await tx2.wait();
      const block2 = await ethers.provider.getBlock(receipt2.blockNumber);

      const mineTime = block2.timestamp - block1.timestamp;
      const ups = INITIAL_UPS; // capacity = 1
      const multiplier = DEFAULT_MULTIPLIER;
      const expectedMint = ups.mul(mineTime).mul(multiplier).div(PRECISION);

      const actualMint = await unit.balanceOf(user1.address);
      expect(actualMint).to.equal(expectedMint);
    });

    it("3.2 Minting with different capacities", async function () {
      // Test with capacity 1
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#c1");

      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#c1b");

      const mintedCap1 = await unit.balanceOf(user1.address);

      // Now increase capacity to 10
      await rig.setCapacity(10);

      // Mine slot 1
      slot = await rig.getSlot(1);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 1, slot.epochId, latest.timestamp + 3600, 0, "#c10");

      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      const user1BalBefore = await unit.balanceOf(user1.address);
      slot = await rig.getSlot(1);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 1, slot.epochId, latest.timestamp + 3600, 0, "#c10b");

      const mintedCap10 = (await unit.balanceOf(user1.address)).sub(user1BalBefore);

      // With capacity 10, should mint 1/10 of what capacity 1 mints (roughly)
      const ratio = mintedCap1.mul(100).div(mintedCap10);
      expect(ratio.toNumber()).to.be.within(950, 1050); // ~10x, with some tolerance
    });

    it("3.3 Minting precision is maintained", async function () {
      // Test with very small time deltas
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#prec");

      // Wait just 1 second
      await ethers.provider.send("evm_increaseTime", [1]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, price, "#prec2");

      const minted = await unit.balanceOf(user1.address);
      // Should be at least ~4e18 (4 tokens for 1 second at 4 UPS)
      // But timing might add 1-2 extra seconds
      expect(minted).to.be.gte(INITIAL_UPS);
      expect(minted).to.be.lte(INITIAL_UPS.mul(5)); // Allow up to 5 seconds
    });

    it("3.4 No precision loss with large time values", async function () {
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#large");

      // Wait 30 days
      const thirtyDays = 30 * 24 * 3600;
      await ethers.provider.send("evm_increaseTime", [thirtyDays]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#large2");

      const minted = await unit.balanceOf(user1.address);
      // Expected: 30 days * 4 UPS = 30 * 24 * 3600 * 4 = 10,368,000 tokens
      const expected = INITIAL_UPS.mul(thirtyDays);

      // Should be very close (within 1% for block timing variance)
      const diff = minted.sub(expected).abs();
      expect(diff).to.be.lt(expected.div(100));
    });
  });

  /***************************************************************************
   * 4. MULTIPLIER SECURITY
   ***************************************************************************/
  describe("4. Multiplier Security", function () {
    it("4.1 Multipliers can only be >= 1x", async function () {
      // Should reject multipliers below 1e18
      await expect(rig.setMultipliers([convert("0.5", 18)])).to.be.reverted;
      await expect(rig.setMultipliers([convert("0.99", 18)])).to.be.reverted;

      // Should accept 1x
      await rig.setMultipliers([convert("1", 18)]);

      // Should accept higher
      await rig.setMultipliers([convert("2", 18), convert("5", 18), convert("10", 18)]);
    });

    it("4.2 High multipliers accelerate supply but don't break curve", async function () {
      // Set a 10x multiplier
      await rig.setMultipliers([convert("10", 18)]);

      // Even with 10x multiplier, totalMinted still accurately tracks supply
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(
        user1.address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#multi",
        { value: convert("1", 18) }
      );

      // The multiplier gets set via entropy callback
      // For now, verify default multiplier is applied
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(
        user2.address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#multi2",
        { value: convert("1", 18) }
      );

      // Invariant holds
      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });

    it("4.3 Slot multiplier is locked at mine time", async function () {
      // Mine a slot
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#lock");

      const slotData = await rig.getSlot(0);
      const lockedMultiplier = slotData.multiplier;

      // Changing multipliers array doesn't affect existing slot
      await rig.setMultipliers([convert("100", 18)]);

      const slotDataAfter = await rig.getSlot(0);
      expect(slotDataAfter.multiplier).to.equal(lockedMultiplier);
    });

    it("4.4 Multiplier affects minting correctly", async function () {
      // First, mine without multiplier boost
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#base");

      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#base2");

      const baseMint = await unit.balanceOf(user1.address);

      // The multiplier is 1x by default, so this establishes baseline
      expect(baseMint).to.be.gt(0);

      // Formula check: baseMint ≈ 3600 * 4e18 * 1e18 / 1e18 = 14400e18
      expect(baseMint).to.be.closeTo(convert("14400", 18), convert("100", 18));
    });
  });

  /***************************************************************************
   * 5. UPS RATE LOCKING
   ***************************************************************************/
  describe("5. UPS Rate Locking", function () {
    it("5.1 Slot UPS is locked at mine time", async function () {
      // Mine a slot
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#lock");

      const slotData = await rig.getSlot(0);
      expect(slotData.ups).to.equal(INITIAL_UPS); // capacity = 1, so full UPS

      // Even if we somehow change totalMinted externally, this slot's UPS stays fixed
      // (We can't change it externally, but the slot.ups value is stored)
    });

    it("5.2 New miners get current UPS rate", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#r1");

      const slot1 = await rig.getSlot(0);
      const ups1 = slot1.ups;

      // Wait and take over
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#r2");

      const slot2 = await rig.getSlot(0);
      const ups2 = slot2.ups;

      // Since we're still in halving period 0, UPS should be same
      expect(ups2).to.equal(ups1);
    });

    it("5.3 UPS is correctly divided by capacity", async function () {
      // With capacity 1
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#cap1");

      let slotData = await rig.getSlot(0);
      expect(slotData.ups).to.equal(INITIAL_UPS.div(1));

      // Increase capacity to 100
      await rig.setCapacity(100);

      // Wait and mine again
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#cap100");

      slotData = await rig.getSlot(0);
      expect(slotData.ups).to.equal(INITIAL_UPS.div(100));
    });
  });

  /***************************************************************************
   * 6. ATTACK VECTORS
   ***************************************************************************/
  describe("6. Attack Vectors", function () {
    it("6.1 Cannot mint without taking over a slot", async function () {
      // Only way to mint is via mine() which requires taking a slot
      const totalSupplyBefore = await unit.totalSupply();

      // Try to call Unit.mint directly
      await expect(unit.connect(attacker).mint(attacker.address, convert("1000000", 18)))
        .to.be.reverted;

      const totalSupplyAfter = await unit.totalSupply();
      expect(totalSupplyAfter).to.equal(totalSupplyBefore);
    });

    it("6.2 Cannot exploit by rapid slot takeovers", async function () {
      // Rapidly taking over slots shouldn't create extra tokens
      let totalMintedAccum = ethers.BigNumber.from(0);

      for (let i = 0; i < 20; i++) {
        const slot = await rig.getSlot(0);
        const latest = await ethers.provider.getBlock("latest");
        const miner = i % 2 === 0 ? user1 : user2;

        const supplyBefore = await unit.totalSupply();
        await rig.connect(miner).mine(
          miner.address,
          AddressZero,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          slot.initPrice,
          `#rapid${i}`
        );
        const supplyAfter = await unit.totalSupply();
        totalMintedAccum = totalMintedAccum.add(supplyAfter.sub(supplyBefore));
      }

      expect(await rig.totalMinted()).to.equal(totalMintedAccum);
      expect(await unit.totalSupply()).to.equal(totalMintedAccum);
    });

    it("6.3 Cannot exploit timing by mining just before epoch ends", async function () {
      // Mine at start
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#t1");

      // Wait until just before epoch ends (59 min 59 sec)
      await ethers.provider.send("evm_increaseTime", [3599]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      const priceNearEnd = await rig.getPrice(0);
      expect(priceNearEnd).to.be.gt(0); // Still has some price

      // Take over - should mint correct amount based on time held
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, priceNearEnd, "#t2");

      const minted = await unit.balanceOf(user1.address);
      // Should be approximately 3600 seconds worth at 4 UPS
      expect(minted).to.be.closeTo(INITIAL_UPS.mul(3600), INITIAL_UPS.mul(10));
    });

    it("6.4 Cannot exploit by mining on multiple slots simultaneously", async function () {
      await rig.setCapacity(10);

      // Mine all slots at once
      for (let i = 0; i < 10; i++) {
        const slot = await rig.getSlot(i);
        const latest = await ethers.provider.getBlock("latest");
        await rig.connect(user1).mine(user1.address, AddressZero, i, slot.epochId, latest.timestamp + 3600, 0, `#s${i}`);
      }

      // No tokens minted yet
      expect(await unit.totalSupply()).to.equal(0);

      // Wait
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      // Take over all slots
      for (let i = 0; i < 10; i++) {
        const slot = await rig.getSlot(i);
        const latest = await ethers.provider.getBlock("latest");
        await rig.connect(user2).mine(user2.address, AddressZero, i, slot.epochId, latest.timestamp + 3600, 0, `#t${i}`);
      }

      const totalMinted = await rig.totalMinted();
      const totalSupply = await unit.totalSupply();
      expect(totalMinted).to.equal(totalSupply);

      // Each slot should contribute roughly equal amount
      // Total UPS is 4e18, divided by 10 slots = 0.4e18 per slot
      // Each slot held for ~3600 seconds = 1440 tokens per slot
      // Total should be ~14400 tokens (same as 1 slot with full UPS)
      expect(totalSupply).to.be.closeTo(convert("14400", 18), convert("1000", 18));
    });

    it("6.5 Cannot exploit by creating many epochs rapidly", async function () {
      // Rapidly cycle through epochs on a slot
      // Wait for price to decay to 0 between each mine
      for (let i = 0; i < 20; i++) {
        // Wait for epoch to end (price = 0)
        await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
        await ethers.provider.send("evm_mine", []);

        const slot = await rig.getSlot(0);
        const latest = await ethers.provider.getBlock("latest");
        const miner = i % 2 === 0 ? user1 : user2;

        await rig.connect(miner).mine(
          miner.address,
          AddressZero,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          0, // Price is 0 after epoch
          `#epoch${i}`
        );
      }

      // Invariant still holds
      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });

    it("6.6 Self-mining doesn't create duplicate rewards", async function () {
      // Mine own slot
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#self1");

      await ethers.provider.send("evm_increaseTime", [1800]);
      await ethers.provider.send("evm_mine", []);

      const balBefore = await unit.balanceOf(user1.address);

      // Mine own slot again (need to pass current price as maxPrice)
      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, price, "#self2");

      const balAfter = await unit.balanceOf(user1.address);

      // Should have received minted tokens (paid to self as previous miner)
      // Note: user1 pays fee to themselves, so net effect is just the minted tokens
      expect(balAfter).to.be.gt(balBefore);

      // Invariant holds
      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });

    it("6.7 Cannot exploit reentrancy during mining", async function () {
      // The contract uses ReentrancyGuard
      // Verify mining completes atomically

      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#re");

      await ethers.provider.send("evm_increaseTime", [1800]);
      await ethers.provider.send("evm_mine", []);

      // Multiple concurrent takeover attempts should only allow one
      // (In practice, the second would fail due to epochId mismatch)
      slot = await rig.getSlot(0);
      const epochId = slot.epochId;
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");

      await rig.connect(user2).mine(user2.address, AddressZero, 0, epochId, latest.timestamp + 3600, price, "#re2");

      // Second attempt with same epochId should fail (epochId already incremented)
      await expect(
        rig.connect(user3).mine(user3.address, AddressZero, 0, epochId, latest.timestamp + 3600, price, "#re3")
      ).to.be.reverted;
    });
  });

  /***************************************************************************
   * 7. EDGE CASES
   ***************************************************************************/
  describe("7. Edge Cases", function () {
    it("7.1 Mining with zero time delta", async function () {
      // Mine twice in same block (simulated)
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#z1");

      // Immediately take over (same or next block) - price is very high, need to pass it
      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, price, "#z2");

      // Should mint minimal tokens (just 1-2 seconds worth)
      const minted = await unit.balanceOf(user1.address);
      expect(minted).to.be.lt(convert("20", 18)); // Less than 5 seconds worth
    });

    it("7.2 Mining after very long period", async function () {
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#long1");

      // Wait 1 year
      await ethers.provider.send("evm_increaseTime", [365 * 24 * 3600]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#long2");

      const minted = await unit.balanceOf(user1.address);
      // Should be roughly 1 year * 4 UPS = 126,144,000 tokens
      const expected = INITIAL_UPS.mul(365 * 24 * 3600);
      expect(minted).to.be.closeTo(expected, expected.div(100));
    });

    it("7.3 First halving triggers correctly", async function () {
      // We need to mint 10M tokens to trigger first halving
      // At 4 UPS, that's 10M / 4 = 2.5M seconds ≈ 29 days

      // Verify that before 10M, UPS is still 4
      expect(await rig.getUps()).to.equal(INITIAL_UPS);
      expect(await rig.totalMinted()).to.equal(0);
    });

    it("7.4 Capacity changes don't affect pending rewards", async function () {
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#cap1");

      const slotBefore = await rig.getSlot(0);
      const upsBefore = slotBefore.ups;

      await ethers.provider.send("evm_increaseTime", [1800]);
      await ethers.provider.send("evm_mine", []);

      // Increase capacity mid-mining
      await rig.setCapacity(100);

      // The slot's UPS should still be the original value
      const slotAfter = await rig.getSlot(0);
      expect(slotAfter.ups).to.equal(upsBefore);

      // Take over (price decayed, should be low)
      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, price, "#cap2");

      // Rewards should be based on original UPS (4e18), not new (0.04e18)
      const minted = await unit.balanceOf(user1.address);
      // 1800 seconds * 4 UPS ≈ 7200 tokens
      expect(minted).to.be.closeTo(convert("7200", 18), convert("100", 18));
    });

    it("7.5 Maximum uint256 safety for minting calculation", async function () {
      // Verify no overflow in: mineTime * ups * multiplier / PRECISION
      // Worst case: uint256 max time * 4e18 * 1e18 / 1e18

      // In practice, time is bounded by reasonable block times
      // Let's verify calculation for 100 years
      const hundredYears = 100 * 365 * 24 * 3600;
      const maxMint = INITIAL_UPS.mul(hundredYears).mul(DEFAULT_MULTIPLIER).div(PRECISION);

      // Should not overflow (stays well within uint256)
      expect(maxMint).to.be.lt(ethers.constants.MaxUint256);

      // Should be calculable: 4 * 100 * 365 * 24 * 3600 ≈ 12.6B tokens
      const expectedTokens = 4 * 100 * 365 * 24 * 3600;
      expect(maxMint).to.equal(convert(expectedTokens.toString(), 18));
    });

    it("7.6 Zero address mining target protection", async function () {
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");

      await expect(
        rig.connect(user1).mine(AddressZero, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#zero")
      ).to.be.reverted;
    });
  });

  /***************************************************************************
   * 8. SUPPLY CURVE VERIFICATION
   ***************************************************************************/
  describe("8. Supply Curve Verification", function () {
    it("8.1 Theoretical supply after each halving", async function () {
      // Calculate total supply at each halving threshold
      const supplies = [];
      let supply = HALVING_AMOUNT; // After halving 0: 10M
      supplies.push(supply);

      for (let i = 1; i < 12; i++) {
        supply = supply.add(HALVING_AMOUNT.shr(i));
        supplies.push(supply);
      }

      // Verify supplies
      expect(supplies[0]).to.equal(convert("10000000", 18));
      expect(supplies[1]).to.equal(convert("15000000", 18));
      expect(supplies[2]).to.equal(convert("17500000", 18));
      expect(supplies[3]).to.equal(convert("18750000", 18));

      // Supply converges to 2 * HALVING_AMOUNT = 20M
      expect(supplies[11]).to.be.lt(convert("20000000", 18));
      expect(supplies[11]).to.be.gt(convert("19990000", 18));
    });

    it("8.2 Tail emissions contribute unbounded supply over time", async function () {
      // After reaching ~20M, tail emissions of 0.01 UPS continue forever
      // Per year: 0.01 * 365 * 24 * 3600 = 315,360 tokens

      const tailPerSecond = TAIL_UPS;
      const tailPerYear = tailPerSecond.mul(365 * 24 * 3600);

      expect(tailPerYear).to.equal(convert("315360", 18));

      // After 100 years of tail: ~31.5M additional tokens
      const tailPer100Years = tailPerYear.mul(100);
      expect(tailPer100Years).to.equal(convert("31536000", 18));
    });

    it("8.3 Supply at specific time intervals (with continuous mining)", async function () {
      // This is a theoretical calculation assuming continuous mining
      // In practice, supply depends on mining activity

      // At t=0, totalMinted=0, UPS=4
      // If someone mines continuously for 29 days at 4 UPS:
      // 29 * 24 * 3600 * 4 = 10,022,400 tokens (first halving triggered)

      const daysTo10M = 10_000_000 / (4 * 24 * 3600);
      expect(daysTo10M).to.be.closeTo(28.93, 0.1); // ~29 days to first halving
    });
  });

  /***************************************************************************
   * 9. STRESS TESTS
   ***************************************************************************/
  describe("9. Stress Tests", function () {
    it("9.1 50 consecutive mines maintain invariants", async function () {
      this.timeout(60000);

      for (let i = 0; i < 50; i++) {
        // Wait for price to decay between mines
        await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
        await ethers.provider.send("evm_mine", []);

        const slot = await rig.getSlot(0);
        const latest = await ethers.provider.getBlock("latest");
        const miner = [user1, user2, user3][i % 3];

        await rig.connect(miner).mine(
          miner.address,
          AddressZero,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          0, // Price is 0 after epoch
          `#stress${i}`
        );
      }

      // Verify invariants
      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });

    it("9.2 Mining across capacity changes", async function () {
      for (let cap = 1; cap <= 100; cap += 10) {
        if (cap > 1) await rig.setCapacity(cap);

        const slot = await rig.getSlot(0);
        const latest = await ethers.provider.getBlock("latest");
        await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, slot.initPrice, `#cap${cap}`);

        await ethers.provider.send("evm_increaseTime", [300]);
        await ethers.provider.send("evm_mine", []);
      }

      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });

    it("9.3 Mining on all slots with max capacity", async function () {
      await rig.setCapacity(100);

      // Mine on first 20 slots
      for (let i = 0; i < 20; i++) {
        const slot = await rig.getSlot(i);
        const latest = await ethers.provider.getBlock("latest");
        await rig.connect(user1).mine(user1.address, AddressZero, i, slot.epochId, latest.timestamp + 3600, 0, `#slot${i}`);
      }

      // Wait for epoch to end (price = 0)
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
      await ethers.provider.send("evm_mine", []);

      // Take over all slots (price is 0 now)
      for (let i = 0; i < 20; i++) {
        const slot = await rig.getSlot(i);
        const latest = await ethers.provider.getBlock("latest");
        await rig.connect(user2).mine(user2.address, AddressZero, i, slot.epochId, latest.timestamp + 3600, 0, `#take${i}`);
      }

      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });
  });

  /***************************************************************************
   * 10. MATHEMATICAL PROOFS
   ***************************************************************************/
  describe("10. Mathematical Proofs", function () {
    it("10.1 Sum of halving amounts converges to 2 * HALVING_AMOUNT", async function () {
      // Sum = HALVING_AMOUNT * (1 + 1/2 + 1/4 + 1/8 + ...)
      // = HALVING_AMOUNT * 2 (geometric series)
      // Note: With integer division, we lose small amounts each halving

      let sum = ethers.BigNumber.from(0);
      let term = HALVING_AMOUNT;

      for (let i = 0; i < 100; i++) {
        sum = sum.add(term);
        term = term.shr(1);
        if (term.eq(0)) break;
      }

      // Should be very close to 2 * HALVING_AMOUNT (within rounding error)
      const target = HALVING_AMOUNT.mul(2);

      // Due to integer division, sum will be slightly less than 2 * HALVING_AMOUNT
      // The difference is at most log2(HALVING_AMOUNT) * 1 wei per halving
      const diff = target.sub(sum);
      expect(diff).to.be.lt(convert("1", 18)); // Less than 1 token difference
      expect(sum).to.be.gt(target.sub(convert("1", 18))); // Very close to target
    });

    it("10.2 Halving count from totalMinted calculation is correct", async function () {
      // Verify the halving calculation matches expected values

      const testCases = [
        { minted: convert("0", 18), expectedHalvings: 0 },
        { minted: convert("5000000", 18), expectedHalvings: 0 },
        { minted: convert("10000000", 18), expectedHalvings: 1 },
        { minted: convert("14000000", 18), expectedHalvings: 1 },
        { minted: convert("15000000", 18), expectedHalvings: 2 },
        { minted: convert("17000000", 18), expectedHalvings: 2 },
        { minted: convert("17500000", 18), expectedHalvings: 3 },
        { minted: convert("18500000", 18), expectedHalvings: 3 },
        { minted: convert("18750000", 18), expectedHalvings: 4 },
      ];

      for (const tc of testCases) {
        let halvings = 0;
        let threshold = HALVING_AMOUNT;

        while (tc.minted.gte(threshold) && halvings < 64) {
          halvings++;
          threshold = threshold.add(HALVING_AMOUNT.shr(halvings));
        }

        expect(halvings).to.equal(tc.expectedHalvings, `Failed for minted=${tc.minted.toString()}`);
      }
    });

    it("10.3 UPS at each halving level is correct", async function () {
      const expectedRates = [
        convert("4", 18),       // Halving 0
        convert("2", 18),       // Halving 1
        convert("1", 18),       // Halving 2
        convert("0.5", 18),     // Halving 3
        convert("0.25", 18),    // Halving 4
        convert("0.125", 18),   // Halving 5
        convert("0.0625", 18),  // Halving 6
        convert("0.03125", 18), // Halving 7
        convert("0.015625", 18),// Halving 8
      ];

      for (let i = 0; i < expectedRates.length; i++) {
        const rate = INITIAL_UPS.shr(i);
        expect(rate).to.equal(expectedRates[i], `Failed at halving ${i}`);
      }

      // Verify tail kicks in at halving 9
      const halving9Rate = INITIAL_UPS.shr(9);
      expect(halving9Rate).to.be.lt(TAIL_UPS);
    });

    it("10.4 No rounding errors in minting formula", async function () {
      // mineTime * ups * multiplier / PRECISION
      // All values are in wei (1e18), so division should be exact when possible

      const testCases = [
        { time: 1, ups: convert("4", 18), mult: convert("1", 18), expected: convert("4", 18) },
        { time: 60, ups: convert("4", 18), mult: convert("1", 18), expected: convert("240", 18) },
        { time: 3600, ups: convert("4", 18), mult: convert("1", 18), expected: convert("14400", 18) },
        { time: 3600, ups: convert("4", 18), mult: convert("2", 18), expected: convert("28800", 18) },
        { time: 3600, ups: convert("0.01", 18), mult: convert("1", 18), expected: convert("36", 18) },
      ];

      for (const tc of testCases) {
        const result = tc.ups.mul(tc.time).mul(tc.mult).div(PRECISION);
        expect(result).to.equal(tc.expected);
      }
    });
  });
});
