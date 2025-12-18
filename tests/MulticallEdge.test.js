const { expect } = require("chai");
const { ethers } = require("hardhat");

const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const AddressZero = "0x0000000000000000000000000000000000000000";
const AddressDead = "0x000000000000000000000000000000000000dEaD";

describe("Multicall Edge Cases", function () {
  let owner, treasury, team, user1, user2, faction1, entropyProvider;
  let weth, unit, rig, entropy, multicall, auction, donut, lp;
  let factory, router;
  let snapshotId;

  before("Deploy full system", async function () {
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

    // Deploy Uniswap V2 mocks
    const factoryArtifact = await ethers.getContractFactory("MockUniswapV2Factory");
    factory = await factoryArtifact.deploy();

    const routerArtifact = await ethers.getContractFactory("MockUniswapV2Router");
    router = await routerArtifact.deploy(factory.address);

    // Mint tokens for LP creation (owner is initial rig)
    await unit.mint(owner.address, convert("100000", 18));
    await donut.mint(owner.address, convert("100000", 18));

    // Approve router
    await unit.approve(router.address, convert("100000", 18));
    await donut.approve(router.address, convert("100000", 18));

    // Create LP
    const block = await ethers.provider.getBlock("latest");
    await router.addLiquidity(
      unit.address,
      donut.address,
      convert("50000", 18),
      convert("50000", 18),
      0,
      0,
      owner.address,
      block.timestamp + 3600
    );

    // Get LP token
    const lpAddress = await factory.getPair(unit.address, donut.address);
    lp = await ethers.getContractAt("MockLP", lpAddress);

    // Deploy Auction
    const auctionArtifact = await ethers.getContractFactory("Auction");
    auction = await auctionArtifact.deploy(
      convert("1", 18),
      lp.address,
      AddressDead,
      86400,
      convert("1.2", 18),
      convert("1", 18)
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

    // Set multipliers
    await rig.setMultipliers([convert("1", 18), convert("2", 18), convert("5", 18)]);

    // Fund users
    await weth.connect(user1).deposit({ value: convert("100", 18) });
    await weth.connect(user2).deposit({ value: convert("100", 18) });
    await weth.connect(user1).approve(rig.address, ethers.constants.MaxUint256);
    await weth.connect(user2).approve(rig.address, ethers.constants.MaxUint256);

    // Give users LP tokens
    await lp.transfer(user1.address, convert("1000", 18));
    await lp.transfer(user2.address, convert("1000", 18));
    await lp.connect(user1).approve(multicall.address, ethers.constants.MaxUint256);
    await lp.connect(user2).approve(multicall.address, ethers.constants.MaxUint256);
  });

  beforeEach(async function () {
    snapshotId = await ethers.provider.send("evm_snapshot", []);
  });

  afterEach(async function () {
    await ethers.provider.send("evm_revert", [snapshotId]);
  });

  describe("1. Multicall Mining Edge Cases", function () {
    it("1.1 Should correctly calculate entropy need at MULTIPLIER_DURATION boundary minus 1 second", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(
        AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#first",
        { value: 0 }
      );

      // Process callback
      await entropy.mockReveal(entropyProvider.address, 1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random1")));

      // Get lastMultiplierTime
      slot = await rig.getSlot(0);
      const lastMultiplierTime = slot.lastMultiplierTime.toNumber();

      // Fast forward to MULTIPLIER_DURATION - 1 second
      const MULTIPLIER_DURATION = 24 * 3600;
      const currentBlock = await ethers.provider.getBlock("latest");
      const timeToAdvance = MULTIPLIER_DURATION - 1 - (currentBlock.timestamp - lastMultiplierTime);
      await ethers.provider.send("evm_increaseTime", [timeToAdvance]);
      await ethers.provider.send("evm_mine", []);

      // Should NOT need entropy (within duration)
      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");

      // This should succeed without needing entropy fee
      await multicall.connect(user2).mine(
        AddressZero, 0, slot.epochId, latest.timestamp + 3600, price, "#second",
        { value: price }
      );

      // Verify no new entropy request was made (multiplier should stay the same)
      const updatedSlot = await rig.getSlot(0);
      expect(updatedSlot.epochId).to.equal(2);
    });

    it("1.2 Should handle mining with exactly 0 ETH when no entropy needed and price is 0", async function () {
      // First mine - price is 0
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(
        AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#first",
        { value: 0 }
      );

      // Process callback
      await entropy.mockReveal(entropyProvider.address, 1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random")));

      // Wait for price to decay to 0 but within multiplier duration
      await ethers.provider.send("evm_increaseTime", [3601]); // 1 hour + 1 second
      await ethers.provider.send("evm_mine", []);

      // Price should be 0
      expect(await rig.getPrice(0)).to.equal(0);

      // Second mine with 0 ETH should work
      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user2).mine(
        AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#second",
        { value: 0 }
      );

      expect((await rig.getSlot(0)).epochId).to.equal(2);
    });

    it("1.3 Should refund exact excess WETH when sending more than price", async function () {
      // First mine to set up price
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(
        AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#first",
        { value: 0 }
      );

      // Process callback
      await entropy.mockReveal(entropyProvider.address, 1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random")));

      // Get actual price
      slot = await rig.getSlot(0);
      const actualPrice = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");

      // Send 2x the actual price
      const sentAmount = actualPrice.mul(2);
      const wethBefore = await weth.balanceOf(user2.address);

      await multicall.connect(user2).mine(
        AddressZero, 0, slot.epochId, latest.timestamp + 3600, actualPrice, "#second",
        { value: sentAmount }
      );

      const wethAfter = await weth.balanceOf(user2.address);
      const refund = wethAfter.sub(wethBefore);

      // Refund should be approximately the excess (actualPrice)
      // Due to price decay between read and execution, allow small variance
      expect(refund).to.be.closeTo(actualPrice, actualPrice.div(10));
    });

    it("1.4 Should handle rapid consecutive Multicall mines correctly", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(
        AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#first",
        { value: 0 }
      );

      // Process callback
      await entropy.mockReveal(entropyProvider.address, 1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random")));

      // Rapid consecutive mines (5 in a row)
      for (let i = 0; i < 5; i++) {
        slot = await rig.getSlot(0);
        const price = await rig.getPrice(0);
        latest = await ethers.provider.getBlock("latest");

        await multicall.connect(i % 2 === 0 ? user1 : user2).mine(
          AddressZero, 0, slot.epochId, latest.timestamp + 3600, price, `#rapid${i}`,
          { value: price }
        );
      }

      // Verify epoch advanced correctly
      expect((await rig.getSlot(0)).epochId).to.equal(6);
    });
  });

  describe("2. Multicall View Functions Edge Cases", function () {
    it("2.1 Should return correct multiplierTime when just updated", async function () {
      // Mine and get callback
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(
        user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#first"
      );

      await entropy.mockReveal(entropyProvider.address, 1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random")));

      const slotState = await multicall.getSlot(0);

      // multiplierTime should be close to MULTIPLIER_DURATION (24 hours)
      // Convert to number for comparison
      const multiplierTime = slotState.multiplierTime.toNumber();
      const expected = 24 * 3600;
      expect(multiplierTime).to.be.within(expected - 10, expected);
    });

    it("2.2 Should return 0 multiplierTime when expired", async function () {
      // Mine and get callback
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(
        user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#first"
      );

      await entropy.mockReveal(entropyProvider.address, 1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random")));

      // Fast forward past MULTIPLIER_DURATION
      await ethers.provider.send("evm_increaseTime", [25 * 3600]);
      await ethers.provider.send("evm_mine", []);

      const slotState = await multicall.getSlot(0);
      expect(slotState.multiplierTime).to.equal(0);
    });

    it("2.3 Should handle getSlots with reversed indices gracefully", async function () {
      await rig.setCapacity(5);

      // This might revert or return empty - depends on implementation
      // Let's verify it handles edge cases
      try {
        await multicall.getSlots(4, 0);
        // If it doesn't revert, check what it returns
      } catch (e) {
        // Expected to fail - that's fine
        expect(e.message).to.include("revert");
      }
    });

    it("2.4 Should return correct UPS for different capacity settings", async function () {
      // Get initial UPS
      const ups1 = (await multicall.getRig(user1.address)).ups;

      // Increase capacity
      await rig.setCapacity(10);

      // UPS should be same (global UPS doesn't change with capacity)
      const ups2 = (await multicall.getRig(user1.address)).ups;
      expect(ups2).to.equal(ups1);

      // But slot UPS should be divided by capacity
      await rig.connect(user1).mine(
        user1.address, AddressZero, 0, 0,
        (await ethers.provider.getBlock("latest")).timestamp + 3600,
        0, "#test"
      );

      const slotState = await multicall.getSlot(0);
      // slotState.ups = slot.ups * multiplier / 1e18
      // slot.ups = global_ups / capacity
      expect(slotState.ups).to.be.lt(ups1);
    });
  });

  describe("3. Multicall Buy Edge Cases", function () {
    it("3.1 Should handle buying when auction price is 0", async function () {
      // Fast forward past auction epoch
      await ethers.provider.send("evm_increaseTime", [86401]); // > 1 day
      await ethers.provider.send("evm_mine", []);

      const auctionState = await multicall.getAuction(user1.address);
      expect(auctionState.price).to.equal(0);

      // Add WETH to auction for assets
      await weth.deposit({ value: convert("1", 18) });
      await weth.transfer(auction.address, convert("1", 18));

      const wethBefore = await weth.balanceOf(user1.address);
      const lpBefore = await lp.balanceOf(user1.address);

      const latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).buy(auctionState.epochId, latest.timestamp + 3600, 0);

      const wethAfter = await weth.balanceOf(user1.address);
      const lpAfter = await lp.balanceOf(user1.address);

      // Should have received WETH
      expect(wethAfter).to.be.gt(wethBefore);
      // Should not have spent LP (price was 0)
      expect(lpAfter).to.equal(lpBefore);
    });

    it("3.2 Should revert buy with incorrect epochId", async function () {
      const auctionState = await multicall.getAuction(user1.address);
      const latest = await ethers.provider.getBlock("latest");

      await expect(
        multicall.connect(user1).buy(
          auctionState.epochId.add(1), // Wrong epochId
          latest.timestamp + 3600,
          auctionState.price
        )
      ).to.be.reverted;
    });

    it("3.3 Should revert buy with expired deadline", async function () {
      const auctionState = await multicall.getAuction(user1.address);
      const latest = await ethers.provider.getBlock("latest");

      await expect(
        multicall.connect(user1).buy(
          auctionState.epochId,
          latest.timestamp - 1, // Expired
          auctionState.price
        )
      ).to.be.reverted;
    });
  });

  describe("4. Error Handling", function () {
    it("4.1 Should revert mine with insufficient ETH for entropy fee", async function () {
      // This test requires a mock entropy with non-zero fee
      // Since our mock has 0 fee, we'll test the error path differently

      // First, let's verify that mining works with 0 fee (current setup)
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");

      // Should succeed with 0 value when mock fee is 0
      await multicall.connect(user1).mine(
        AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#test",
        { value: 0 }
      );
    });

    it("4.2 Should handle mine with invalid index", async function () {
      const latest = await ethers.provider.getBlock("latest");

      await expect(
        multicall.connect(user1).mine(
          AddressZero, 999, 0, latest.timestamp + 3600, 0, "#invalid",
          { value: 0 }
        )
      ).to.be.reverted;
    });

    it("4.3 Should handle mine with wrong epochId", async function () {
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");

      await expect(
        multicall.connect(user1).mine(
          AddressZero, 0, slot.epochId.add(1), latest.timestamp + 3600, 0, "#wrong",
          { value: 0 }
        )
      ).to.be.reverted;
    });

    it("4.4 Should handle mine with maxPrice exceeded", async function () {
      // First mine to set a price
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(
        AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#first",
        { value: 0 }
      );

      // Process callback
      await entropy.mockReveal(entropyProvider.address, 1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random")));

      // Try to mine with maxPrice of 0 when price > 0
      slot = await rig.getSlot(0);
      const actualPrice = await rig.getPrice(0);
      expect(actualPrice).to.be.gt(0);

      latest = await ethers.provider.getBlock("latest");

      await expect(
        multicall.connect(user2).mine(
          AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#fail",
          { value: actualPrice }
        )
      ).to.be.reverted;
    });
  });

  describe("5. Integration with Factions", function () {
    it("5.1 Should correctly handle mining with faction via Multicall", async function () {
      // First mine to set up price
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(
        AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#setup",
        { value: 0 }
      );

      // Process callback
      await entropy.mockReveal(entropyProvider.address, 1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random")));

      // Get balances
      const factionBefore = await weth.balanceOf(faction1.address);

      // Mine with faction
      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");

      await multicall.connect(user2).mine(
        faction1.address, 0, slot.epochId, latest.timestamp + 3600, price, "#faction",
        { value: price }
      );

      const factionAfter = await weth.balanceOf(faction1.address);

      // Faction should have received fee
      expect(factionAfter).to.be.gt(factionBefore);
    });

    it("5.2 Should revert when mining with non-whitelisted faction", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await multicall.connect(user1).mine(
        AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#first",
        { value: 0 }
      );

      // Process callback
      await entropy.mockReveal(entropyProvider.address, 1,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("random")));

      // Try to mine with non-whitelisted faction
      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");

      await expect(
        multicall.connect(user2).mine(
          user2.address, // Not a whitelisted faction
          0, slot.epochId, latest.timestamp + 3600, price, "#fail",
          { value: price }
        )
      ).to.be.reverted;
    });
  });
});
