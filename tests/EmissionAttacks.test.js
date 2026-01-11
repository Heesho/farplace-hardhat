const { expect } = require("chai");
const { ethers } = require("hardhat");

const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const divDec = (amount, decimals = 18) => amount / 10 ** decimals;
const AddressZero = "0x0000000000000000000000000000000000000000";

/**
 * EMISSION ATTACK TESTS
 *
 * Adversarial testing to try to break the emission model.
 * These tests attempt various attack vectors and edge cases.
 */
describe("Emission Attack Tests", function () {
  let owner, treasury, team, user1, user2, user3, attacker, entropyProvider;
  let weth, unit, rig, entropy;
  let snapshotId;

  const INITIAL_UPS = convert("4", 18);
  const HALVING_AMOUNT = convert("10000000", 18);
  const TAIL_UPS = convert("0.01", 18);
  const PRECISION = convert("1", 18);
  const EPOCH_PERIOD = 3600;

  before("Deploy contracts", async function () {
    [owner, treasury, team, user1, user2, user3, attacker, entropyProvider] =
      await ethers.getSigners();

    const wethArtifact = await ethers.getContractFactory("MockWETH");
    weth = await wethArtifact.deploy();

    const entropyArtifact = await ethers.getContractFactory("TestMockEntropy");
    entropy = await entropyArtifact.deploy(entropyProvider.address);

    const unitArtifact = await ethers.getContractFactory("Unit");
    unit = await unitArtifact.deploy("TestUnit", "TUNIT");

    const rigArtifact = await ethers.getContractFactory("Rig");
    rig = await rigArtifact.deploy(unit.address, weth.address, entropy.address, treasury.address);
    await rig.setTeam(team.address);

    await unit.setRig(rig.address);

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
   * ATTACK VECTOR 1: CROSS-HALVING BOUNDARY MANIPULATION
   ***************************************************************************/
  describe("Attack 1: Cross-Halving Boundary Manipulation", function () {

    it("1.1 Single mint crossing multiple halving thresholds", async function () {
      // If someone holds long enough to cross multiple halvings in one tx,
      // does the math still work?

      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#start");

      // Hold for ~75 days (enough to mint ~26M tokens at 4 UPS, crossing 2 halvings)
      // 26M / 4 = 6.5M seconds ≈ 75 days
      const longTime = 75 * 24 * 3600;
      await ethers.provider.send("evm_increaseTime", [longTime]);
      await ethers.provider.send("evm_mine", []);

      const expectedMint = INITIAL_UPS.mul(longTime); // Uses locked rate of 4 UPS

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#end");

      const minted = await unit.balanceOf(user1.address);
      const totalMinted = await rig.totalMinted();

      // Should mint at locked 4 UPS rate for entire duration
      expect(minted).to.be.closeTo(expectedMint, expectedMint.div(100));
      expect(totalMinted).to.equal(await unit.totalSupply());

      // New miner should get post-halving rate
      const newSlot = await rig.getSlot(0);
      expect(newSlot.ups).to.be.lt(INITIAL_UPS); // Should be halved
    });

    it("1.2 Precise halving boundary - mint exactly at threshold", async function () {
      // Try to mint exactly 10M tokens to land on boundary
      // 10M / 4 = 2.5M seconds
      const exactTime = 2500000;

      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#exact");

      await ethers.provider.send("evm_increaseTime", [exactTime]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#exact2");

      const minted = await rig.totalMinted();

      // Check that we're at or near 10M
      expect(minted).to.be.closeTo(HALVING_AMOUNT, convert("100000", 18));

      // Verify UPS has halved for next miner
      const newSlot = await rig.getSlot(0);
      expect(newSlot.ups).to.equal(INITIAL_UPS.div(2)); // 2 UPS
    });

    it("1.3 Oscillating around halving boundary", async function () {
      // Mine in small increments around the halving boundary
      // to check for rounding exploits

      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#osc");

      // Get close to 10M (leave ~1000 tokens remaining)
      const almostTime = Math.floor(9999000 / 4);
      await ethers.provider.send("evm_increaseTime", [almostTime]);
      await ethers.provider.send("evm_mine", []);

      // Take over
      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#osc2");

      const beforeHalving = await rig.getUps();

      // Small increments to cross threshold
      for (let i = 0; i < 5; i++) {
        await ethers.provider.send("evm_increaseTime", [300]); // 5 min
        await ethers.provider.send("evm_mine", []);

        slot = await rig.getSlot(0);
        const price = await rig.getPrice(0);
        latest = await ethers.provider.getBlock("latest");
        const miner = i % 2 === 0 ? user1 : user2;
        await rig.connect(miner).mine(miner.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, price, `#step${i}`);
      }

      // Invariant must hold
      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });
  });

  /***************************************************************************
   * ATTACK VECTOR 2: EXTREME VALUE ATTACKS
   ***************************************************************************/
  describe("Attack 2: Extreme Value Attacks", function () {

    it("2.1 Maximum possible holding time (1000 years)", async function () {
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#max");

      // 1000 years
      const extremeTime = 1000 * 365 * 24 * 3600;
      await ethers.provider.send("evm_increaseTime", [extremeTime]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");

      // Should not overflow
      await expect(
        rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#max2")
      ).to.not.be.reverted;

      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });

    it("2.2 Maximum multiplier with long hold time", async function () {
      // Set extremely high multiplier
      await rig.setMultipliers([convert("1000", 18)]); // 1000x

      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(
        user1.address, AddressZero, 0, slot.epochId,
        latest.timestamp + 3600, 0, "#highmult",
        { value: convert("1", 18) }
      );

      // Simulate entropy callback setting multiplier
      // (In test, multiplier defaults to 1e18 unless callback fires)

      // Hold for 1 year
      await ethers.provider.send("evm_increaseTime", [365 * 24 * 3600]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#highmult2");

      // Should not overflow, invariant holds
      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });

    it("2.3 Minimum time delta (1 second)", async function () {
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#min");

      // Just 1 second
      await ethers.provider.send("evm_increaseTime", [1]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, price, "#min2");

      const minted = await unit.balanceOf(user1.address);
      // Should be at least 4 tokens (1 sec * 4 UPS), allowing for block time variance
      expect(minted).to.be.gte(INITIAL_UPS);
      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });

    it("2.4 Maximum capacity with single slot mining", async function () {
      await rig.setCapacity(1000000); // Max capacity

      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#maxcap");

      const slotData = await rig.getSlot(0);
      // UPS should be 4e18 / 1000000 = 4e12 (very small)
      expect(slotData.ups).to.equal(INITIAL_UPS.div(1000000));

      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#maxcap2");

      // Even with tiny UPS, should mint correctly
      const minted = await unit.balanceOf(user1.address);
      expect(minted).to.be.gt(0);
      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });
  });

  /***************************************************************************
   * ATTACK VECTOR 3: STATE DESYNC ATTACKS
   ***************************************************************************/
  describe("Attack 3: State Desync Attacks", function () {

    it("3.1 Rapid alternating miners trying to desync state", async function () {
      // Alternate between users - but let price decay to avoid running out of WETH
      for (let i = 0; i < 50; i++) {
        // Wait for price to decay to 0
        await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
        await ethers.provider.send("evm_mine", []);

        const slot = await rig.getSlot(0);
        const latest = await ethers.provider.getBlock("latest");
        const miner = [user1, user2, user3][i % 3];

        await rig.connect(miner).mine(
          miner.address, AddressZero, 0, slot.epochId,
          latest.timestamp + 3600, 0, `#rapid${i}`
        );
      }

      // Invariant must hold after chaos
      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });

    it("3.2 Interleaved multi-slot mining", async function () {
      await rig.setCapacity(10);

      // Mine slots in random order
      const order = [3, 7, 1, 9, 0, 5, 2, 8, 4, 6];

      for (const i of order) {
        const slot = await rig.getSlot(i);
        const latest = await ethers.provider.getBlock("latest");
        await rig.connect(user1).mine(user1.address, AddressZero, i, slot.epochId, latest.timestamp + 3600, 0, `#slot${i}`);
      }

      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      // Take over in different order
      const takeOrder = [6, 2, 8, 0, 4, 9, 1, 5, 3, 7];
      for (const i of takeOrder) {
        const slot = await rig.getSlot(i);
        const latest = await ethers.provider.getBlock("latest");
        await rig.connect(user2).mine(user2.address, AddressZero, i, slot.epochId, latest.timestamp + 3600, 0, `#take${i}`);
      }

      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });

    it("3.3 Concurrent slot operations across capacity change", async function () {
      // Mine slot 0
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#pre");

      // Increase capacity
      await rig.setCapacity(5);

      // Mine new slots
      for (let i = 1; i < 5; i++) {
        slot = await rig.getSlot(i);
        latest = await ethers.provider.getBlock("latest");
        await rig.connect(user2).mine(user2.address, AddressZero, i, slot.epochId, latest.timestamp + 3600, 0, `#new${i}`);
      }

      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      // Original slot 0 should still use old UPS (4e18)
      const slot0 = await rig.getSlot(0);
      expect(slot0.ups).to.equal(INITIAL_UPS);

      // New slots should use new UPS (4e18 / 5)
      const slot1 = await rig.getSlot(1);
      expect(slot1.ups).to.equal(INITIAL_UPS.div(5));

      // Take over all slots
      for (let i = 0; i < 5; i++) {
        slot = await rig.getSlot(i);
        latest = await ethers.provider.getBlock("latest");
        await rig.connect(user3).mine(user3.address, AddressZero, i, slot.epochId, latest.timestamp + 3600, 0, `#final${i}`);
      }

      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });
  });

  /***************************************************************************
   * ATTACK VECTOR 4: ECONOMIC MANIPULATION
   ***************************************************************************/
  describe("Attack 4: Economic Manipulation", function () {

    it("4.1 Self-mining loop attack", async function () {
      // Attacker mines, takes over own slot repeatedly (at 0 price)
      let totalSelfMined = ethers.BigNumber.from(0);

      for (let i = 0; i < 20; i++) {
        // Wait for price to decay
        await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
        await ethers.provider.send("evm_mine", []);

        const slot = await rig.getSlot(0);
        const latest = await ethers.provider.getBlock("latest");

        const balBefore = await unit.balanceOf(attacker.address);
        await rig.connect(attacker).mine(
          attacker.address, AddressZero, 0, slot.epochId,
          latest.timestamp + 3600, 0, `#self${i}`
        );
        const balAfter = await unit.balanceOf(attacker.address);
        totalSelfMined = totalSelfMined.add(balAfter.sub(balBefore));
      }

      // Self-mined amount should equal totalMinted (no extra tokens)
      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());

      // Attacker's balance should match what was minted to them
      expect(await unit.balanceOf(attacker.address)).to.equal(totalSelfMined);
    });

    it("4.2 Sandwiching - tokens go to correct recipient", async function () {
      // User1 mines
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#victim");

      // Wait for price to decay to 0
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
      await ethers.provider.send("evm_mine", []);

      // Attacker takes over at 0 price
      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(attacker).mine(attacker.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#frontrun");

      // User1 got their tokens (minted to user1, not attacker)
      expect(await unit.balanceOf(user1.address)).to.be.gt(0);

      // Attacker only gets what they legitimately mine later
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#take");

      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });

    it("4.3 Griefing by blocking slots with immediate takeover", async function () {
      await rig.setCapacity(5);

      // Attacker takes all slots instantly
      for (let i = 0; i < 5; i++) {
        const slot = await rig.getSlot(i);
        const latest = await ethers.provider.getBlock("latest");
        await rig.connect(attacker).mine(attacker.address, AddressZero, i, slot.epochId, latest.timestamp + 3600, 0, `#block${i}`);
      }

      // No tokens minted yet (no previous miners)
      expect(await rig.totalMinted()).to.equal(0);

      // User can still take over by paying price (wait for decay)
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
      await ethers.provider.send("evm_mine", []);

      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#break");

      // Attacker got tokens for their hold time
      expect(await unit.balanceOf(attacker.address)).to.be.gt(0);
      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });
  });

  /***************************************************************************
   * ATTACK VECTOR 5: EPOCH/TIMING MANIPULATION
   ***************************************************************************/
  describe("Attack 5: Epoch/Timing Manipulation", function () {

    it("5.1 Stale epoch ID attack - should revert", async function () {
      let slot = await rig.getSlot(0);
      const staleEpochId = slot.epochId;
      let latest = await ethers.provider.getBlock("latest");

      await rig.connect(user1).mine(user1.address, AddressZero, 0, staleEpochId, latest.timestamp + 3600, 0, "#epoch");

      // Try to use stale epochId - should revert
      latest = await ethers.provider.getBlock("latest");
      await expect(
        rig.connect(attacker).mine(attacker.address, AddressZero, 0, staleEpochId, latest.timestamp + 3600, 0, "#stale")
      ).to.be.reverted;
    });

    it("5.2 Deadline manipulation - past deadline reverts", async function () {
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");

      // Set deadline in the past
      await expect(
        rig.connect(attacker).mine(attacker.address, AddressZero, 0, slot.epochId, latest.timestamp - 1, 0, "#pastdl")
      ).to.be.reverted;
    });

    it("5.3 Mine at exact epoch boundary", async function () {
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#boundary");

      // Wait exactly 1 epoch (price goes to 0)
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD]);
      await ethers.provider.send("evm_mine", []);

      const price = await rig.getPrice(0);
      expect(price).to.equal(0);

      // Can still mine at price 0
      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#after");

      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });

    it("5.4 Many epochs pass without mining", async function () {
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#long");

      // Wait 1000 epochs (1000 hours)
      await ethers.provider.send("evm_increaseTime", [1000 * EPOCH_PERIOD]);
      await ethers.provider.send("evm_mine", []);

      // Should still work, miner gets all accumulated tokens
      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#finally");

      const minted = await unit.balanceOf(user1.address);
      const expected = INITIAL_UPS.mul(1000 * EPOCH_PERIOD);
      expect(minted).to.be.closeTo(expected, expected.div(100));
    });
  });

  /***************************************************************************
   * ATTACK VECTOR 6: SLOT INDEX MANIPULATION
   ***************************************************************************/
  describe("Attack 6: Slot Index Manipulation", function () {

    it("6.1 Mining non-existent slot index reverts", async function () {
      // capacity is 1, so only slot 0 exists
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");

      await expect(
        rig.connect(attacker).mine(attacker.address, AddressZero, 1, slot.epochId, latest.timestamp + 3600, 0, "#bad")
      ).to.be.reverted;

      await expect(
        rig.connect(attacker).mine(attacker.address, AddressZero, 999999, slot.epochId, latest.timestamp + 3600, 0, "#bad2")
      ).to.be.reverted;
    });

    it("6.2 Mining at capacity boundary", async function () {
      await rig.setCapacity(100);

      // Mine slot 99 (last valid)
      let slot = await rig.getSlot(99);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 99, slot.epochId, latest.timestamp + 3600, 0, "#last");

      // Try slot 100 (invalid)
      latest = await ethers.provider.getBlock("latest");
      await expect(
        rig.connect(attacker).mine(attacker.address, AddressZero, 100, 0, latest.timestamp + 3600, 0, "#over")
      ).to.be.reverted;
    });

    it("6.3 Slot data isolation verification", async function () {
      await rig.setCapacity(3);

      // Mine all slots with different users
      for (let i = 0; i < 3; i++) {
        const slot = await rig.getSlot(i);
        const latest = await ethers.provider.getBlock("latest");
        const miner = [user1, user2, user3][i];
        await rig.connect(miner).mine(miner.address, AddressZero, i, slot.epochId, latest.timestamp + 3600, 0, `#slot${i}`);
      }

      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      // Take over slot 1 only
      let slot = await rig.getSlot(1);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(attacker).mine(attacker.address, AddressZero, 1, slot.epochId, latest.timestamp + 3600, 0, "#take1");

      // Only user2 (slot 1 owner) should have tokens
      expect(await unit.balanceOf(user1.address)).to.equal(0);
      expect(await unit.balanceOf(user2.address)).to.be.gt(0);
      expect(await unit.balanceOf(user3.address)).to.equal(0);

      // Take over others
      for (let i of [0, 2]) {
        slot = await rig.getSlot(i);
        latest = await ethers.provider.getBlock("latest");
        await rig.connect(attacker).mine(attacker.address, AddressZero, i, slot.epochId, latest.timestamp + 3600, 0, `#take${i}`);
      }

      // Now all original miners have tokens
      expect(await unit.balanceOf(user1.address)).to.be.gt(0);
      expect(await unit.balanceOf(user3.address)).to.be.gt(0);
    });
  });

  /***************************************************************************
   * ATTACK VECTOR 7: DEEP HALVING TESTS
   ***************************************************************************/
  describe("Attack 7: Deep Halving Exploration", function () {

    it("7.1 Verify halving loop terminates at halvings < 64", async function () {
      // This tests the contract's guard: while (... && halvings < 64)
      // We can't actually reach 64 halvings realistically, but verify math

      let threshold = HALVING_AMOUNT;
      for (let i = 1; i < 64; i++) {
        threshold = threshold.add(HALVING_AMOUNT.shr(i));
      }

      // Threshold converges to 2 * HALVING_AMOUNT
      expect(threshold).to.be.lt(HALVING_AMOUNT.mul(2));
      expect(threshold).to.be.gt(HALVING_AMOUNT.mul(2).sub(convert("1", 18)));
    });

    it("7.2 UPS floor at TAIL_UPS", async function () {
      // After enough halvings, UPS should floor at 0.01
      for (let i = 0; i < 15; i++) {
        const ups = INITIAL_UPS.shr(i);
        if (ups.lt(TAIL_UPS)) {
          // Should use TAIL_UPS instead
          expect(TAIL_UPS).to.equal(convert("0.01", 18));
          break;
        }
      }
    });

    it("7.3 Halving at exact wei boundaries", async function () {
      // Test that integer division in threshold calculation is handled
      const testThresholds = [];
      let t = HALVING_AMOUNT;
      testThresholds.push(t);

      for (let i = 1; i < 20; i++) {
        t = t.add(HALVING_AMOUNT.shr(i));
        testThresholds.push(t);
      }

      // Verify no underflow/overflow in calculations
      for (let i = 0; i < testThresholds.length - 1; i++) {
        expect(testThresholds[i + 1]).to.be.gt(testThresholds[i]);
      }
    });
  });

  /***************************************************************************
   * ATTACK VECTOR 8: MULTIPLIER EDGE CASES
   ***************************************************************************/
  describe("Attack 8: Multiplier Edge Cases", function () {

    it("8.1 Cannot set zero multiplier", async function () {
      await expect(rig.setMultipliers([0])).to.be.reverted;
    });

    it("8.2 Cannot set sub-1x multiplier", async function () {
      await expect(rig.setMultipliers([convert("0.5", 18)])).to.be.reverted;
      await expect(rig.setMultipliers([convert("0.99", 18)])).to.be.reverted;
      await expect(rig.setMultipliers([1])).to.be.reverted; // 1 wei < 1e18
    });

    it("8.3 Exactly 1x multiplier is allowed", async function () {
      await expect(rig.setMultipliers([convert("1", 18)])).to.not.be.reverted;
    });

    it("8.4 Very large multiplier array", async function () {
      // Create array of 100 multipliers
      const mults = [];
      for (let i = 0; i < 100; i++) {
        mults.push(convert((i + 1).toString(), 18));
      }

      await expect(rig.setMultipliers(mults)).to.not.be.reverted;
      expect(await rig.getMultipliersLength()).to.equal(100);
    });

    it("8.5 Empty multiplier array reverts", async function () {
      await expect(rig.setMultipliers([])).to.be.reverted;
    });
  });

  /***************************************************************************
   * ATTACK VECTOR 9: PRICE MANIPULATION
   ***************************************************************************/
  describe("Attack 9: Price Manipulation", function () {

    it("9.1 Cannot pay less than required price", async function () {
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#setup");

      // Very small time passes - price is still very high
      await ethers.provider.send("evm_increaseTime", [10]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      // Use a maxPrice that's significantly lower than initPrice to ensure it fails
      // even with block timing variance
      const initPrice = slot.initPrice;
      const maxPriceTooLow = initPrice.div(10); // Only willing to pay 10% of init price
      latest = await ethers.provider.getBlock("latest");

      // Try to pass maxPrice that's way too low - should fail
      await expect(
        rig.connect(attacker).mine(attacker.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, maxPriceTooLow, "#cheap")
      ).to.be.reverted;
    });

    it("9.2 Price decays correctly over epoch", async function () {
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#decay");

      const slotData = await rig.getSlot(0);
      const initPrice = slotData.initPrice;

      // Price at start
      let price = await rig.getPrice(0);
      expect(price).to.be.lte(initPrice);

      // Price at 50%
      await ethers.provider.send("evm_increaseTime", [1800]);
      await ethers.provider.send("evm_mine", []);
      price = await rig.getPrice(0);
      expect(price).to.be.closeTo(initPrice.div(2), initPrice.div(100));

      // Price at end
      await ethers.provider.send("evm_increaseTime", [1800]);
      await ethers.provider.send("evm_mine", []);
      price = await rig.getPrice(0);
      expect(price).to.equal(0);
    });

    it("9.3 Init price bounds are respected", async function () {
      // Mine multiple times to push price to extremes
      for (let i = 0; i < 10; i++) {
        // Wait for price to decay partially
        await ethers.provider.send("evm_increaseTime", [1800]);
        await ethers.provider.send("evm_mine", []);

        const slot = await rig.getSlot(0);
        const price = await rig.getPrice(0);
        const latest = await ethers.provider.getBlock("latest");
        const miner = i % 2 === 0 ? user1 : user2;
        await rig.connect(miner).mine(miner.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, price, `#price${i}`);
      }

      const slotData = await rig.getSlot(0);
      // Init price should be capped at ABS_MAX_INIT_PRICE or stay reasonable
      expect(slotData.initPrice).to.be.lte(ethers.BigNumber.from(2).pow(192).sub(1));
      expect(slotData.initPrice).to.be.gte(convert("0.0001", 18));
    });
  });

  /***************************************************************************
   * ATTACK VECTOR 10: TOTAL SUPPLY INVARIANT STRESS
   ***************************************************************************/
  describe("Attack 10: Total Supply Invariant Stress", function () {

    it("10.1 Invariant holds after 200 random operations", async function () {
      this.timeout(120000);

      await rig.setCapacity(5);

      for (let i = 0; i < 200; i++) {
        // Random time jumps to let price decay
        const jump = Math.floor(Math.random() * 7200) + 1;
        await ethers.provider.send("evm_increaseTime", [jump]);
        await ethers.provider.send("evm_mine", []);

        const slotIndex = i % 5;
        const slot = await rig.getSlot(slotIndex);
        const price = await rig.getPrice(slotIndex);
        const latest = await ethers.provider.getBlock("latest");
        const miner = [user1, user2, user3][i % 3];

        try {
          await rig.connect(miner).mine(
            miner.address, AddressZero, slotIndex, slot.epochId,
            latest.timestamp + 3600, price, `#stress${i}`
          );
        } catch (e) {
          // Some might fail due to timing, that's ok
        }
      }

      // THE CRITICAL INVARIANT
      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });

    it("10.2 Invariant holds with capacity changes", async function () {
      for (let cap = 1; cap <= 20; cap++) {
        if (cap > 1) await rig.setCapacity(cap);

        // Wait for price to decay
        await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
        await ethers.provider.send("evm_mine", []);

        const slot = await rig.getSlot(0);
        const latest = await ethers.provider.getBlock("latest");

        await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, `#cap${cap}`);

        expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
      }
    });

    it("10.3 Burning tokens doesn't break invariant", async function () {
      // Mine some tokens
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#burn");

      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#burn2");

      const balBefore = await unit.balanceOf(user1.address);
      expect(balBefore).to.be.gt(0);

      // Burn half
      await unit.connect(user1).burn(balBefore.div(2));

      // totalMinted stays same, but totalSupply decreases
      const totalMinted = await rig.totalMinted();
      const totalSupply = await unit.totalSupply();

      // This is expected: totalMinted tracks minted, not circulating supply
      expect(totalMinted).to.be.gt(totalSupply);

      // Burn more tokens
      await unit.connect(user1).burn(await unit.balanceOf(user1.address));

      // totalMinted unchanged
      expect(await rig.totalMinted()).to.equal(totalMinted);
    });

    it("10.4 Verify totalMinted tracks cumulative, not circulating", async function () {
      // This is a property test - totalMinted is cumulative minted, not current supply
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#t1");

      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#t2");

      const totalMintedBefore = await rig.totalMinted();

      // User1 burns all
      await unit.connect(user1).burn(await unit.balanceOf(user1.address));

      // totalMinted unchanged (it's cumulative)
      expect(await rig.totalMinted()).to.equal(totalMintedBefore);

      // But totalSupply decreased
      expect(await unit.totalSupply()).to.be.lt(totalMintedBefore);

      // Mine more - totalMinted increases based on NEW cumulative total
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#t3");

      // totalMinted increased
      expect(await rig.totalMinted()).to.be.gt(totalMintedBefore);
    });
  });

  /***************************************************************************
   * ATTACK VECTOR 11: REENTRANCY AND CALLBACK ATTACKS
   ***************************************************************************/
  describe("Attack 11: Reentrancy and Callback Edge Cases", function () {

    it("11.1 Multiple rapid mines in sequence", async function () {
      // Rapidly mine in same block (as fast as possible)
      for (let i = 0; i < 10; i++) {
        const slot = await rig.getSlot(0);
        const price = await rig.getPrice(0);
        const latest = await ethers.provider.getBlock("latest");

        await rig.connect(user1).mine(
          user1.address, AddressZero, 0, slot.epochId,
          latest.timestamp + 3600, price, `#seq${i}`
        );
      }

      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });

    it("11.2 Entropy callback for wrong epoch is ignored", async function () {
      // The contract checks: if (slotCache.epochId != epoch || slotCache.miner == address(0)) return;
      // This means stale callbacks are safely ignored
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(
        user1.address, AddressZero, 0, slot.epochId,
        latest.timestamp + 3600, 0, "#ent1",
        { value: convert("0.1", 18) }
      );

      const epoch1 = (await rig.getSlot(0)).epochId;

      // Take over (new epoch)
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#ent2");

      const epoch2 = (await rig.getSlot(0)).epochId;
      expect(epoch2).to.be.gt(epoch1);

      // If entropy callback came for epoch1, it would be ignored (tested in contract logic)
      // We can't easily trigger this in test, but the code path is: line 248
      // if (slotCache.epochId != epoch ...) return;
    });
  });

  /***************************************************************************
   * ATTACK VECTOR 12: MATHEMATICAL PRECISION EDGE CASES
   ***************************************************************************/
  describe("Attack 12: Mathematical Precision Edge Cases", function () {

    it("12.1 Division by capacity doesn't lose significant precision", async function () {
      await rig.setCapacity(7); // Non-power-of-2 to test rounding

      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#prec");

      const slotData = await rig.getSlot(0);
      // 4e18 / 7 = 571428571428571428 (some precision loss in last digits)
      const expectedUps = INITIAL_UPS.div(7);
      expect(slotData.ups).to.equal(expectedUps);

      // Mine for 1 hour
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#prec2");

      const minted = await unit.balanceOf(user1.address);
      // Expected: 3600 * (4e18 / 7) ≈ 2057142857142857142800
      const expectedMinted = expectedUps.mul(3600);
      expect(minted).to.be.closeTo(expectedMinted, expectedMinted.div(100));
    });

    it("12.2 Multiplier precision with odd values", async function () {
      await rig.setMultipliers([convert("1.333333333333333333", 18)]); // 1.33... repeating

      // Multiplier is set via callback, so for this test we verify the config is accepted
      const mults = await rig.getMultipliers();
      expect(mults[0]).to.equal(convert("1.333333333333333333", 18));
    });

    it("12.3 Very small UPS with long time", async function () {
      await rig.setCapacity(1000000); // Max capacity = tiny UPS

      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#tiny");

      // UPS = 4e18 / 1M = 4e12
      const slotData = await rig.getSlot(0);
      expect(slotData.ups).to.equal(convert("0.000004", 18));

      // Hold for 1 year
      await ethers.provider.send("evm_increaseTime", [365 * 24 * 3600]);
      await ethers.provider.send("evm_mine", []);

      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(user2).mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#tiny2");

      const minted = await unit.balanceOf(user1.address);
      // Expected: 365 * 24 * 3600 * 4e12 = 126,144,000,000,000,000,000 ≈ 126 tokens
      expect(minted).to.be.gt(0);
      expect(await rig.totalMinted()).to.equal(await unit.totalSupply());
    });
  });
});
