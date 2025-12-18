const { expect } = require("chai");
const { ethers } = require("hardhat");

const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const AddressZero = "0x0000000000000000000000000000000000000000";
const AddressDead = "0x000000000000000000000000000000000000dEaD";

describe("Stress Tests", function () {
  let owner, treasury, team, entropyProvider;
  let miners = [];
  let weth, unit, rig, entropy, auction, multicall, donut, lp;
  let snapshotId;

  const NUM_MINERS = 10;
  const EPOCH_PERIOD = 3600; // 1 hour

  before("Deploy contracts and setup miners", async function () {
    const signers = await ethers.getSigners();
    [owner, treasury, team, entropyProvider] = signers;

    // Use remaining signers as miners
    miners = signers.slice(4, 4 + NUM_MINERS);

    // Deploy MockWETH
    const wethArtifact = await ethers.getContractFactory("MockWETH");
    weth = await wethArtifact.deploy();

    // Deploy MockEntropy
    const entropyArtifact = await ethers.getContractFactory("TestMockEntropy");
    entropy = await entropyArtifact.deploy(entropyProvider.address);

    // Deploy Unit
    const unitArtifact = await ethers.getContractFactory("Unit");
    unit = await unitArtifact.deploy("TestUnit", "TUNIT");

    // Deploy mock Donut token
    const donutArtifact = await ethers.getContractFactory("MockDonut");
    donut = await donutArtifact.deploy();

    // Deploy mock LP token
    const lpArtifact = await ethers.getContractFactory("MockLP");
    lp = await lpArtifact.deploy(weth.address, donut.address);

    // Deploy Auction
    const auctionArtifact = await ethers.getContractFactory("Auction");
    auction = await auctionArtifact.deploy(
      convert("1", 18),
      lp.address,
      AddressDead,
      EPOCH_PERIOD,
      ethers.utils.parseUnits("1.2", 18),
      convert("0.001", 18)
    );

    // Deploy Rig
    const rigArtifact = await ethers.getContractFactory("Rig");
    rig = await rigArtifact.deploy(unit.address, weth.address, entropy.address, treasury.address);
    await rig.setTeam(team.address);

    // Transfer minting rights to Rig
    await unit.setRig(rig.address);

    // Deploy Multicall
    const multicallArtifact = await ethers.getContractFactory("Multicall");
    multicall = await multicallArtifact.deploy(rig.address, auction.address, donut.address);

    // Set multipliers
    await rig.setMultipliers([
      convert("1", 18),
      convert("2", 18),
      convert("3", 18),
      convert("5", 18),
      convert("10", 18),
    ]);

    // Fund all miners with WETH (large amount for stress tests)
    for (const miner of miners) {
      await weth.connect(miner).deposit({ value: convert("1000", 18) });
      await weth.connect(miner).approve(rig.address, ethers.constants.MaxUint256);
    }
  });

  beforeEach(async function () {
    snapshotId = await ethers.provider.send("evm_snapshot", []);
  });

  afterEach(async function () {
    await ethers.provider.send("evm_revert", [snapshotId]);
  });

  describe("1. High Volume Mining", function () {
    it("1.1 Should handle 50 consecutive mines on single slot", async function () {
      const NUM_MINES = 50;

      for (let i = 0; i < NUM_MINES; i++) {
        const miner = miners[i % miners.length];
        const slot = await rig.getSlot(0);
        const price = await rig.getPrice(0);
        const latest = await ethers.provider.getBlock("latest");

        // Wait for price to decay to keep costs manageable
        if (i > 0 && i % 5 === 0) {
          await ethers.provider.send("evm_increaseTime", [3600]); // 1 hour
          await ethers.provider.send("evm_mine", []);
        }

        const currentPrice = await rig.getPrice(0);

        await rig.connect(miner).mine(
          miner.address,
          AddressZero,
          0,
          slot.epochId,
          latest.timestamp + 7200,
          currentPrice,
          `#${i.toString().padStart(6, '0')}`
        );

        // Simulate entropy callback for every mine
        if (i > 0) {
          await entropy.mockReveal(
            entropyProvider.address,
            i,
            ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`random${i}`))
          );
        }
      }

      const finalSlot = await rig.getSlot(0);
      expect(finalSlot.epochId).to.equal(NUM_MINES);
    });

    it("1.2 Should handle mining across 100 slots", async function () {
      await rig.setCapacity(100);

      for (let i = 0; i < 100; i++) {
        const miner = miners[i % miners.length];
        const latest = await ethers.provider.getBlock("latest");

        await rig.connect(miner).mine(
          miner.address,
          AddressZero,
          i,
          0,
          latest.timestamp + 3600,
          0,
          `#slot${i}`
        );
      }

      // Verify all slots are mined
      for (let i = 0; i < 100; i++) {
        const slot = await rig.getSlot(i);
        expect(slot.epochId).to.equal(1);
        expect(slot.miner).to.not.equal(AddressZero);
      }
    });

    it("1.3 Should correctly track rewards for rapid takeovers", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(miners[0]).mine(
        miners[0].address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#000000"
      );

      // Rapid takeovers every block
      const balancesBefore = [];
      for (const miner of miners) {
        balancesBefore.push(await unit.balanceOf(miner.address));
      }

      for (let i = 1; i < 20; i++) {
        await ethers.provider.send("evm_increaseTime", [60]); // 1 minute between each
        await ethers.provider.send("evm_mine", []);

        const miner = miners[i % miners.length];
        slot = await rig.getSlot(0);
        const price = await rig.getPrice(0);
        latest = await ethers.provider.getBlock("latest");

        await rig.connect(miner).mine(
          miner.address,
          AddressZero,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          price,
          `#${i.toString().padStart(6, '0')}`
        );
      }

      // Verify rewards were distributed
      let totalRewards = ethers.BigNumber.from(0);
      for (let i = 0; i < miners.length; i++) {
        const balanceAfter = await unit.balanceOf(miners[i].address);
        const reward = balanceAfter.sub(balancesBefore[i]);
        totalRewards = totalRewards.add(reward);
      }

      expect(totalRewards).to.be.gt(0);
    });
  });

  describe("2. Extreme Values", function () {
    it("2.1 Should handle very long URI strings (10KB)", async function () {
      const longUri = "#" + "A".repeat(10000);
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");

      await rig.connect(miners[0]).mine(
        miners[0].address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        longUri
      );

      const updatedSlot = await rig.getSlot(0);
      expect(updatedSlot.uri).to.equal(longUri);
    });

    it("2.2 Should handle maximum capacity correctly", async function () {
      const maxCapacity = await rig.MAX_CAPACITY();
      await rig.setCapacity(maxCapacity);
      expect(await rig.capacity()).to.equal(maxCapacity);

      // Mine the last slot
      const lastIndex = maxCapacity.sub(1);
      const latest = await ethers.provider.getBlock("latest");

      await rig.connect(miners[0]).mine(
        miners[0].address,
        AddressZero,
        lastIndex,
        0,
        latest.timestamp + 3600,
        0,
        "#lastslot"
      );

      const slot = await rig.getSlot(lastIndex);
      expect(slot.miner).to.equal(miners[0].address);
    });

    it("2.3 Should handle price at ABS_MAX_INIT_PRICE boundary", async function () {
      // This tests that the price cap works
      // First, mine many times to pump up the price
      for (let i = 0; i < 20; i++) {
        const slot = await rig.getSlot(0);
        const price = await rig.getPrice(0);
        const latest = await ethers.provider.getBlock("latest");

        await rig.connect(miners[i % miners.length]).mine(
          miners[i % miners.length].address,
          AddressZero,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          price,
          `#${i}`
        );
      }

      // Price should be capped
      const slot = await rig.getSlot(0);
      const absMaxInitPrice = await rig.ABS_MAX_INIT_PRICE();
      expect(slot.initPrice).to.be.lte(absMaxInitPrice);
    });

    it("2.4 Should handle mining with tight deadline", async function () {
      const slot = await rig.getSlot(0);
      // Mine a block first to get accurate timestamp
      await ethers.provider.send("evm_mine", []);
      const latest = await ethers.provider.getBlock("latest");
      // Use current timestamp + 1 second - the next block will have this timestamp
      const deadline = latest.timestamp + 1;

      // Set the next block timestamp explicitly to match our deadline
      await ethers.provider.send("evm_setNextBlockTimestamp", [deadline]);

      // Mine with tight deadline
      await rig.connect(miners[0]).mine(
        miners[0].address,
        AddressZero,
        0,
        slot.epochId,
        deadline,
        0,
        "#tight"
      );

      const updatedSlot = await rig.getSlot(0);
      expect(updatedSlot.miner).to.equal(miners[0].address);
    });

    it("2.5 Should handle very far future deadline", async function () {
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      const farFuture = latest.timestamp + 365 * 24 * 3600; // 1 year

      await rig.connect(miners[0]).mine(
        miners[0].address,
        AddressZero,
        0,
        slot.epochId,
        farFuture,
        0,
        "#future"
      );

      const updatedSlot = await rig.getSlot(0);
      expect(updatedSlot.miner).to.equal(miners[0].address);
    });
  });

  describe("3. Long-Term Simulation", function () {
    it("3.1 Should correctly halve UPS over 6 months (6 halvings)", async function () {
      const initialUps = await rig.getUps();

      // Fast forward 6 months (180 days = 6 halving periods)
      await ethers.provider.send("evm_increaseTime", [180 * 24 * 3600]);
      await ethers.provider.send("evm_mine", []);

      const upsAfter = await rig.getUps();

      // Should be initial / 64 (2^6) = initial / 64
      // But may be at TAIL_UPS if initial / 64 < TAIL_UPS
      const tailUps = await rig.TAIL_UPS();
      const expectedUps = initialUps.div(64);

      if (expectedUps.lt(tailUps)) {
        expect(upsAfter).to.equal(tailUps);
      } else {
        expect(upsAfter).to.equal(expectedUps);
      }
    });

    it("3.2 Should accumulate significant rewards over long mining period", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(miners[0]).mine(
        miners[0].address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#start"
      );

      // Fast forward 7 days
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600]);
      await ethers.provider.send("evm_mine", []);

      const balanceBefore = await unit.balanceOf(miners[0].address);

      // Second mine to trigger reward payout
      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(miners[1]).mine(
        miners[1].address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#end"
      );

      const balanceAfter = await unit.balanceOf(miners[0].address);
      const reward = balanceAfter.sub(balanceBefore);

      // Should have accumulated substantial rewards
      // 7 days * 4 UPS * 1x multiplier = 7 * 24 * 3600 * 4 = 2,419,200 tokens
      expect(reward).to.be.gt(convert("1000000", 18)); // At least 1M tokens
    });

    it("3.3 Should handle multiplier expiration and renewal cycle", async function () {
      // First mine - triggers entropy request
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(miners[0]).mine(
        miners[0].address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#first"
      );

      // Process callback to set multiplier
      await entropy.mockReveal(
        entropyProvider.address,
        1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random1"))
      );

      slot = await rig.getSlot(0);
      const firstMultiplier = slot.multiplier;
      expect(firstMultiplier).to.be.gte(convert("1", 18));

      // Fast forward 25 hours (past MULTIPLIER_DURATION)
      await ethers.provider.send("evm_increaseTime", [25 * 3600]);
      await ethers.provider.send("evm_mine", []);

      // Second mine - should trigger new entropy request
      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(miners[1]).mine(
        miners[1].address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        price,
        "#second"
      );

      // Multiplier should be reset to default
      slot = await rig.getSlot(0);
      expect(slot.multiplier).to.equal(convert("1", 18)); // DEFAULT_MULTIPLIER

      // Process new callback
      await entropy.mockReveal(
        entropyProvider.address,
        2,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random2"))
      );

      slot = await rig.getSlot(0);
      expect(slot.lastMultiplierTime).to.be.gt(0);
    });
  });

  describe("4. Concurrent Operations", function () {
    beforeEach(async function () {
      await rig.setCapacity(10);
    });

    it("4.1 Should handle simultaneous mining on different slots", async function () {
      // All miners mine different slots in same block (simulated)
      const promises = [];
      for (let i = 0; i < Math.min(miners.length, 10); i++) {
        const latest = await ethers.provider.getBlock("latest");
        promises.push(
          rig.connect(miners[i]).mine(
            miners[i].address,
            AddressZero,
            i,
            0,
            latest.timestamp + 3600,
            0,
            `#miner${i}`
          )
        );
      }

      await Promise.all(promises);

      // Verify all slots were mined
      for (let i = 0; i < Math.min(miners.length, 10); i++) {
        const slot = await rig.getSlot(i);
        expect(slot.miner).to.equal(miners[i].address);
      }
    });

    it("4.2 Should correctly handle fee distribution with max participants", async function () {
      // Add faction
      await rig.setFaction(miners[9].address, true);

      // First mine to set up price
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(miners[0]).mine(
        miners[0].address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#setup"
      );

      // Get balances before
      const treasuryBefore = await weth.balanceOf(treasury.address);
      const teamBefore = await weth.balanceOf(team.address);
      const factionBefore = await weth.balanceOf(miners[9].address);
      const minerBefore = await weth.balanceOf(miners[0].address);

      // Second mine with all fee recipients
      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(miners[1]).mine(
        miners[1].address,
        miners[9].address, // faction
        0,
        slot.epochId,
        latest.timestamp + 3600,
        price,
        "#fees"
      );

      // Verify all parties received fees
      const treasuryAfter = await weth.balanceOf(treasury.address);
      const teamAfter = await weth.balanceOf(team.address);
      const factionAfter = await weth.balanceOf(miners[9].address);
      const minerAfter = await weth.balanceOf(miners[0].address);

      expect(treasuryAfter).to.be.gt(treasuryBefore);
      expect(teamAfter).to.be.gt(teamBefore);
      expect(factionAfter).to.be.gt(factionBefore);
      expect(minerAfter).to.be.gt(minerBefore);

      // Verify total is 100%
      const totalFees = treasuryAfter.sub(treasuryBefore)
        .add(teamAfter.sub(teamBefore))
        .add(factionAfter.sub(factionBefore))
        .add(minerAfter.sub(minerBefore));

      // Total fees should equal price paid (allowing for tiny variance)
      expect(totalFees).to.be.closeTo(price, price.div(1000));
    });
  });

  describe("5. State Consistency", function () {
    it("5.1 Should maintain correct total supply across many operations", async function () {
      let expectedSupply = ethers.BigNumber.from(0);

      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(miners[0]).mine(
        miners[0].address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#first"
      );

      // Many mines, tracking expected rewards
      for (let i = 1; i < 20; i++) {
        await ethers.provider.send("evm_increaseTime", [300]); // 5 minutes
        await ethers.provider.send("evm_mine", []);

        slot = await rig.getSlot(0);
        const price = await rig.getPrice(0);
        const supplyBefore = await unit.totalSupply();

        latest = await ethers.provider.getBlock("latest");
        await rig.connect(miners[i % miners.length]).mine(
          miners[i % miners.length].address,
          AddressZero,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          price,
          `#${i}`
        );

        const supplyAfter = await unit.totalSupply();
        expect(supplyAfter).to.be.gte(supplyBefore);
        expectedSupply = supplyAfter;
      }

      // Verify total supply matches sum of all balances
      let totalBalances = ethers.BigNumber.from(0);
      for (const miner of miners) {
        totalBalances = totalBalances.add(await unit.balanceOf(miner.address));
      }

      expect(await unit.totalSupply()).to.equal(totalBalances);
    });

    it("5.2 Should never have stuck ETH in Rig after Multicall mines", async function () {
      const rigBalanceStart = await ethers.provider.getBalance(rig.address);

      // Many mines through Multicall
      for (let i = 0; i < 10; i++) {
        const slot = await rig.getSlot(0);
        const price = await rig.getPrice(0);
        const latest = await ethers.provider.getBlock("latest");

        await multicall.connect(miners[i % miners.length]).mine(
          AddressZero,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          price,
          `#${i}`,
          { value: price }
        );

        // Process entropy callback
        if (i > 0) {
          await entropy.mockReveal(
            entropyProvider.address,
            i,
            ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`random${i}`))
          );
        }
      }

      const rigBalanceEnd = await ethers.provider.getBalance(rig.address);

      // No ETH should accumulate (mock entropy fee is 0)
      expect(rigBalanceEnd).to.equal(rigBalanceStart);
    });

    it("5.3 Should maintain epoch ID monotonicity across all slots", async function () {
      await rig.setCapacity(5);

      // Track epoch IDs for each slot
      const epochIds = [0, 0, 0, 0, 0];

      // Random mining across slots
      for (let i = 0; i < 30; i++) {
        const slotIndex = i % 5;
        const miner = miners[i % miners.length];

        const slot = await rig.getSlot(slotIndex);
        const price = await rig.getPrice(slotIndex);
        const latest = await ethers.provider.getBlock("latest");

        // Verify epochId only increases
        expect(slot.epochId.toNumber()).to.equal(epochIds[slotIndex]);

        await rig.connect(miner).mine(
          miner.address,
          AddressZero,
          slotIndex,
          slot.epochId,
          latest.timestamp + 3600,
          price,
          `#${i}`
        );

        epochIds[slotIndex]++;
      }

      // Final verification
      for (let i = 0; i < 5; i++) {
        const slot = await rig.getSlot(i);
        expect(slot.epochId.toNumber()).to.equal(epochIds[i]);
      }
    });
  });

  describe("6. Recovery Scenarios", function () {
    it("6.1 Should continue working after slot sits unmined for long period", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(miners[0]).mine(
        miners[0].address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#start"
      );

      // Fast forward 30 days (slot sits idle)
      await ethers.provider.send("evm_increaseTime", [30 * 24 * 3600]);
      await ethers.provider.send("evm_mine", []);

      // Price should be 0
      expect(await rig.getPrice(0)).to.equal(0);

      // Should still be able to mine
      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(miners[1]).mine(
        miners[1].address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#resume"
      );

      const updatedSlot = await rig.getSlot(0);
      expect(updatedSlot.miner).to.equal(miners[1].address);
      expect(updatedSlot.epochId).to.equal(2);
    });

    it("6.2 Should handle entropy callback for stale epoch gracefully", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(miners[0]).mine(
        miners[0].address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#epoch0"
      );

      // Second mine before callback arrives
      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await rig.connect(miners[1]).mine(
        miners[1].address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        price,
        "#epoch1"
      );

      // First callback arrives (stale - for epoch 1, but we're now on epoch 2)
      await entropy.mockReveal(
        entropyProvider.address,
        1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("stale"))
      );

      // Slot should have default multiplier (stale callback ignored)
      slot = await rig.getSlot(0);
      expect(slot.multiplier).to.equal(convert("1", 18));

      // Second callback arrives (for current epoch)
      await entropy.mockReveal(
        entropyProvider.address,
        2,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("current"))
      );

      // Now multiplier should be set
      slot = await rig.getSlot(0);
      expect(slot.lastMultiplierTime).to.be.gt(0);
    });
  });
});
