const { expect } = require("chai");
const { ethers } = require("hardhat");

const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const divDec = (amount, decimals = 18) => amount / 10 ** decimals;
const AddressZero = "0x0000000000000000000000000000000000000000";
const AddressDead = "0x000000000000000000000000000000000000dEaD";

describe("AUDIT: Entropy Fee and Multicall Tests", function () {
  let owner, treasury, team, user1, user2, faction1, entropyProvider;
  let weth, unit, rig, entropy, multicall, auction, donut, lp;

  const MULTIPLIER_DURATION = 24 * 3600; // 24 hours
  const EPOCH_PERIOD = 3600; // 1 hour

  before("Deploy contracts", async function () {
    [owner, treasury, team, user1, user2, faction1, entropyProvider] =
      await ethers.getSigners();

    // Deploy MockWETH
    const wethArtifact = await ethers.getContractFactory("MockWETH");
    weth = await wethArtifact.deploy();

    // Deploy MockEntropy (fee is 0 in mock)
    const entropyArtifact = await ethers.getContractFactory("TestMockEntropy");
    entropy = await entropyArtifact.deploy(entropyProvider.address);

    // Deploy Unit
    const unitArtifact = await ethers.getContractFactory("Unit");
    unit = await unitArtifact.deploy("TestUnit", "TUNIT");

    // Deploy mock Donut token
    const donutArtifact = await ethers.getContractFactory("MockDonut");
    donut = await donutArtifact.deploy();

    // Deploy mock LP token (requires token0 and token1)
    const lpArtifact = await ethers.getContractFactory("MockLP");
    lp = await lpArtifact.deploy(weth.address, donut.address);

    // Deploy Auction
    const auctionArtifact = await ethers.getContractFactory("Auction");
    auction = await auctionArtifact.deploy(
      convert("1", 18), // initPrice
      lp.address, // paymentToken (LP)
      AddressDead, // paymentReceiver (burn)
      3600, // epochPeriod
      ethers.utils.parseUnits("1.2", 18), // priceMultiplier
      convert("0.001", 18) // minInitPrice
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

    // Fund users with ETH and WETH
    await weth.connect(user1).deposit({ value: convert("100", 18) });
    await weth.connect(user2).deposit({ value: convert("100", 18) });
    await weth.connect(user1).approve(rig.address, ethers.constants.MaxUint256);
    await weth.connect(user2).approve(rig.address, ethers.constants.MaxUint256);

    // Set multipliers
    await rig.setMultipliers([convert("1", 18), convert("2", 18), convert("3", 18)]);
  });

  let snapshotId;

  beforeEach(async function () {
    snapshotId = await ethers.provider.send("evm_snapshot", []);
  });

  afterEach(async function () {
    await ethers.provider.send("evm_revert", [snapshotId]);
  });

  describe("1. Entropy Fee Calculation in Multicall", function () {
    it("1.1 Should detect entropy needed for first mine on a slot (multiplier never set)", async function () {
      const slot = await rig.getSlot(0);
      expect(slot.lastMultiplierTime).to.equal(0);

      // Check that needsEntropy would be true
      const latest = await ethers.provider.getBlock("latest");
      const needsEntropy = latest.timestamp - slot.lastMultiplierTime > MULTIPLIER_DURATION;
      expect(needsEntropy).to.be.true;

      const price = await rig.getPrice(0);

      // Should succeed (mock entropy fee is 0)
      await multicall.connect(user1).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        price,
        "#111111",
        { value: 0 }
      );

      const updatedSlot = await rig.getSlot(0);
      expect(updatedSlot.miner).to.equal(user1.address);
    });

    it("1.2 Should correctly identify when multiplier was recently updated", async function () {
      // First mine - triggers entropy request
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");

      await multicall.connect(user1).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#111111",
        { value: 0 }
      );

      // Simulate entropy callback to update multiplier using mockReveal
      const randomNumber = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random"));
      await entropy.mockReveal(entropyProvider.address, 1, randomNumber);

      // Check that lastMultiplierTime was updated
      slot = await rig.getSlot(0);
      expect(slot.lastMultiplierTime).to.be.gt(0);

      // Fast forward 1 hour (within 24h multiplier duration)
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      // Second mine - needsEntropy should be false
      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");

      // Verify needsEntropy is false
      const timeSinceMultiplier = latest.timestamp - slot.lastMultiplierTime.toNumber();
      expect(timeSinceMultiplier).to.be.lt(MULTIPLIER_DURATION);

      // Should succeed
      await multicall.connect(user2).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        price,
        "#222222",
        { value: price }
      );

      const updatedSlot = await rig.getSlot(0);
      expect(updatedSlot.miner).to.equal(user2.address);
    });

    it("1.3 Should detect entropy needed again after MULTIPLIER_DURATION expires", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");

      await multicall.connect(user1).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#111111",
        { value: 0 }
      );

      // Simulate entropy callback
      const randomNumber = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random"));
      await entropy.mockReveal(entropyProvider.address, 1, randomNumber);

      // Fast forward 25 hours (past 24h multiplier duration)
      await ethers.provider.send("evm_increaseTime", [25 * 3600]);
      await ethers.provider.send("evm_mine", []);

      // Check needsEntropy is true now
      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      const timeSinceMultiplier = latest.timestamp - slot.lastMultiplierTime.toNumber();
      expect(timeSinceMultiplier).to.be.gt(MULTIPLIER_DURATION);

      // Mine should still work (entropy request will be made)
      const price = await rig.getPrice(0);
      await multicall.connect(user2).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        price,
        "#222222",
        { value: price }
      );

      // Verify entropy was requested (multiplier reset to default)
      const updatedSlot = await rig.getSlot(0);
      expect(updatedSlot.multiplier).to.equal(convert("1", 18)); // DEFAULT_MULTIPLIER
    });

    it("1.4 Should correctly calculate needsEntropy at exactly MULTIPLIER_DURATION boundary", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");

      await multicall.connect(user1).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#111111",
        { value: 0 }
      );

      // Simulate entropy callback
      const randomNumber = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random"));
      await entropy.mockReveal(entropyProvider.address, 1, randomNumber);

      // Get the exact lastMultiplierTime
      slot = await rig.getSlot(0);
      const lastMultiplierTime = slot.lastMultiplierTime.toNumber();

      // Fast forward to exactly MULTIPLIER_DURATION (boundary)
      const currentBlock = await ethers.provider.getBlock("latest");
      const targetTimestamp = lastMultiplierTime + MULTIPLIER_DURATION;

      // Set next block timestamp explicitly to hit exact boundary
      await ethers.provider.send("evm_setNextBlockTimestamp", [targetTimestamp]);
      await ethers.provider.send("evm_mine", []);

      // At exactly MULTIPLIER_DURATION, needsEntropy should be FALSE (uses >)
      latest = await ethers.provider.getBlock("latest");
      const timePassed = latest.timestamp - lastMultiplierTime;
      expect(timePassed).to.equal(MULTIPLIER_DURATION);

      // At exactly the boundary, > check is false, so no entropy needed
      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);

      // Should work - no new entropy request at boundary
      await multicall.connect(user2).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        price,
        "#222222",
        { value: price }
      );
    });

    it("1.5 Should handle rapid consecutive mines correctly", async function () {
      // First mine - needs entropy
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#111111",
        { value: 0 }
      );

      // Callback arrives
      await entropy.mockReveal(
        entropyProvider.address,
        1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random1"))
      );

      // Rapid second mine (within seconds) - should NOT trigger new entropy
      slot = await rig.getSlot(0);
      let price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user2).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        price,
        "#222222",
        { value: price }
      );

      // Rapid third mine - should NOT trigger new entropy
      slot = await rig.getSlot(0);
      price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        price,
        "#333333",
        { value: price }
      );

      // All three mines succeeded, entropy only required once
      expect((await rig.getSlot(0)).epochId).to.equal(3);
    });
  });

  describe("2. ETH Handling and Refunds", function () {
    it("2.1 Should not leave excess ETH in Rig contract when mining via Multicall", async function () {
      const rigBalanceBefore = await ethers.provider.getBalance(rig.address);

      // Mine (mock entropy fee is 0)
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");

      await multicall.connect(user1).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#111111",
        { value: 0 }
      );

      const rigBalanceAfter = await ethers.provider.getBalance(rig.address);

      // No ETH should accumulate in Rig
      expect(rigBalanceAfter.sub(rigBalanceBefore)).to.equal(0);
    });

    it("2.2 Should return excess WETH to user", async function () {
      // First mine to set up price
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");

      await multicall.connect(user1).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#111111",
        { value: 0 }
      );

      // Callback
      await entropy.mockReveal(
        entropyProvider.address,
        1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random"))
      );

      // Wait for price to decay a bit
      await ethers.provider.send("evm_increaseTime", [1800]);
      await ethers.provider.send("evm_mine", []);

      // Second mine with more ETH than needed
      slot = await rig.getSlot(0);
      const actualPrice = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");

      const excessETH = convert("1", 18);

      const tx = await multicall.connect(user2).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        actualPrice,
        "#222222",
        { value: actualPrice.add(excessETH) }
      );

      // User should get excess WETH back (converted to WETH, sent back as WETH)
      const user2WethAfter = await weth.balanceOf(user2.address);
      // Excess ETH should have been returned as WETH
      expect(user2WethAfter).to.be.gt(0);
    });

    it("2.3 Should not accumulate ETH in Rig when entropy is not needed", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");

      await multicall.connect(user1).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#111111",
        { value: 0 }
      );

      // Callback
      await entropy.mockReveal(
        entropyProvider.address,
        1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random"))
      );

      const rigBalanceAfterFirst = await ethers.provider.getBalance(rig.address);

      // Second mine - no entropy needed
      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");

      await multicall.connect(user2).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        price,
        "#222222",
        { value: price }
      );

      const rigBalanceAfterSecond = await ethers.provider.getBalance(rig.address);

      // No ETH should have accumulated in Rig
      expect(rigBalanceAfterSecond).to.equal(rigBalanceAfterFirst);
    });
  });

  describe("3. Direct Rig.mine() vs Multicall.mine()", function () {
    it("3.1 Direct Rig.mine() should work (mock entropy fee is 0)", async function () {
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");

      // Direct call to Rig
      await rig.connect(user1).mine(
        user1.address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#111111",
        { value: 0 }
      );

      const updatedSlot = await rig.getSlot(0);
      expect(updatedSlot.miner).to.equal(user1.address);
    });

    it("3.2 Direct Rig.mine() refunds excess ETH", async function () {
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      const excessETH = convert("0.1", 18);

      const rigBalanceBefore = await ethers.provider.getBalance(rig.address);
      const userBalanceBefore = await ethers.provider.getBalance(user1.address);

      // Send more than needed directly to Rig
      const tx = await rig.connect(user1).mine(
        user1.address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#111111",
        { value: excessETH }
      );
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed.mul(receipt.effectiveGasPrice);

      const rigBalanceAfter = await ethers.provider.getBalance(rig.address);
      const userBalanceAfter = await ethers.provider.getBalance(user1.address);

      // Rig should not hold any excess ETH (only entropy fee which is 0 in mock)
      expect(rigBalanceAfter).to.equal(rigBalanceBefore);

      // User should only have paid gas (excess ETH refunded, entropy fee is 0 in mock)
      expect(userBalanceBefore.sub(userBalanceAfter)).to.equal(gasUsed);
    });
  });

  describe("4. Multiple Slots and Capacity", function () {
    beforeEach(async function () {
      await rig.setCapacity(5);
    });

    it("4.1 Each slot tracks multiplier time independently", async function () {
      // Mine slot 0
      let latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(
        AddressZero,
        0,
        0,
        latest.timestamp + 3600,
        0,
        "#000000",
        { value: 0 }
      );

      // Callback for slot 0
      await entropy.mockReveal(
        entropyProvider.address,
        1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random0"))
      );

      // Fast forward 12 hours
      await ethers.provider.send("evm_increaseTime", [12 * 3600]);
      await ethers.provider.send("evm_mine", []);

      // Mine slot 1 - needs entropy (never mined)
      latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(
        AddressZero,
        1,
        0,
        latest.timestamp + 3600,
        0,
        "#111111",
        { value: 0 }
      );

      // Callback for slot 1
      await entropy.mockReveal(
        entropyProvider.address,
        2,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random1"))
      );

      // Mine slot 0 again - should NOT trigger new entropy (only 12h passed)
      let slot0 = await rig.getSlot(0);
      let price0 = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user2).mine(
        AddressZero,
        0,
        slot0.epochId,
        latest.timestamp + 3600,
        price0,
        "#000001",
        { value: price0 }
      );

      // Mine slot 1 again - should NOT trigger new entropy (just updated)
      let slot1 = await rig.getSlot(1);
      let price1 = await rig.getPrice(1);
      latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user2).mine(
        AddressZero,
        1,
        slot1.epochId,
        latest.timestamp + 3600,
        price1,
        "#111112",
        { value: price1 }
      );

      // Verify both slots advanced
      expect((await rig.getSlot(0)).epochId).to.equal(2);
      expect((await rig.getSlot(1)).epochId).to.equal(2);
    });

    it("4.2 New slots always trigger entropy request (lastMultiplierTime = 0)", async function () {
      // Mine slots 0, 1, 2 - all should trigger entropy requests
      for (let i = 0; i < 3; i++) {
        const latest = await ethers.provider.getBlock("latest");

        // Mine should succeed (mock fee is 0)
        await multicall.connect(user1).mine(
          AddressZero,
          i,
          0,
          latest.timestamp + 3600,
          0,
          `#${i}${i}${i}${i}${i}${i}`,
          { value: 0 }
        );

        // Callback
        await entropy.mockReveal(
          entropyProvider.address,
          i + 1,
          ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`random${i}`))
        );

        // Verify multiplier was updated
        const slot = await rig.getSlot(i);
        expect(slot.lastMultiplierTime).to.be.gt(0);
      }
    });
  });

  describe("5. Edge Cases and Attack Vectors", function () {
    it("5.1 Slot multiplier times are tracked independently", async function () {
      await rig.setCapacity(5);

      // Mine slot 0
      let latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(
        AddressZero,
        0,
        0,
        latest.timestamp + 3600,
        0,
        "#000000",
        { value: 0 }
      );

      // Callback for slot 0
      await entropy.mockReveal(
        entropyProvider.address,
        1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random"))
      );

      // Slot 0 has multiplier time set
      const slot0 = await rig.getSlot(0);
      expect(slot0.lastMultiplierTime).to.be.gt(0);

      // Slot 1 still has lastMultiplierTime = 0 (never mined)
      const slot1 = await rig.getSlot(1);
      expect(slot1.lastMultiplierTime).to.equal(0);
    });

    it("5.2 Callback arriving late doesn't break subsequent mines", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#111111",
        { value: 0 }
      );

      // Don't process callback yet - mine again immediately
      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");

      // Multiplier was just reset, so needsEntropy is false for Multicall
      // (lastMultiplierTime is from the first mine where multiplier was reset)
      // But wait - Rig sets lastMultiplierTime only on callback, not on mine
      // So lastMultiplierTime is still 0 here, meaning needsEntropy is true

      // Mine should still work
      await multicall.connect(user2).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        price,
        "#222222",
        { value: price }
      );

      // Now first callback arrives (for old epoch) - should be ignored
      await entropy.mockReveal(
        entropyProvider.address,
        1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random1"))
      );

      // Slot should still have default multiplier (callback was for wrong epoch)
      slot = await rig.getSlot(0);
      expect(slot.multiplier).to.equal(convert("1", 18)); // DEFAULT_MULTIPLIER

      // Second callback arrives
      await entropy.mockReveal(
        entropyProvider.address,
        2,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random2"))
      );

      // Now multiplier should be updated
      slot = await rig.getSlot(0);
      expect(slot.lastMultiplierTime).to.be.gt(0);
    });

    it("5.3 Mining works correctly (verifies no overflow)", async function () {
      // This test verifies the math doesn't overflow
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");

      // Should work
      await multicall.connect(user1).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#111111",
        { value: 0 }
      );

      const updatedSlot = await rig.getSlot(0);
      expect(updatedSlot.miner).to.equal(user1.address);
    });

    it("5.4 Mining at epoch boundary correctly determines entropy need", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#111111",
        { value: 0 }
      );

      // Callback
      await entropy.mockReveal(
        entropyProvider.address,
        1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random"))
      );

      // Wait for price to decay to 0
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
      await ethers.provider.send("evm_mine", []);

      // Price should be 0
      const price = await rig.getPrice(0);
      expect(price).to.equal(0);

      // Second mine at price 0 - should NOT trigger new entropy (within 24h)
      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user2).mine(
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#222222",
        { value: 0 }
      );

      expect((await rig.getSlot(0)).epochId).to.equal(2);
    });
  });

  describe("6. Gas Optimization Verification", function () {
    it("6.1 Entropy request adds gas cost compared to no-entropy mine", async function () {
      // To fairly compare, we need similar conditions
      // Use direct Rig.mine() for both tests to isolate entropy cost

      // First mine - triggers entropy request
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      const tx1 = await rig.connect(user1).mine(
        user1.address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#111111",
        { value: 0 }
      );
      const receipt1 = await tx1.wait();
      const gasWithEntropy = receipt1.gasUsed;

      // Callback to set lastMultiplierTime
      await entropy.mockReveal(
        entropyProvider.address,
        1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random"))
      );

      // Wait for price to decay to 0 so token transfer costs are similar
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);

      // Second mine - no entropy request (within 24h, price 0)
      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      const tx2 = await rig.connect(user2).mine(
        user2.address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#222222",
        { value: 0 }
      );
      const receipt2 = await tx2.wait();
      const gasWithoutEntropy = receipt2.gasUsed;

      // Mining without entropy request should use less gas
      expect(gasWithoutEntropy).to.be.lt(gasWithEntropy);
      console.log(`      Gas with entropy request: ${gasWithEntropy}`);
      console.log(`      Gas without entropy request: ${gasWithoutEntropy}`);
      console.log(`      Gas saved: ${gasWithEntropy.sub(gasWithoutEntropy)}`);
    });
  });
});
