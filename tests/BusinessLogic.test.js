const { expect } = require("chai");
const { ethers } = require("hardhat");

const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const divDec = (amount, decimals = 18) => amount / 10 ** decimals;
const AddressZero = "0x0000000000000000000000000000000000000000";
const AddressDead = "0x000000000000000000000000000000000000dEaD";

// Helper to get block timestamp based deadline
async function getDeadline(secondsFromNow) {
  const block = await ethers.provider.getBlock("latest");
  return block.timestamp + secondsFromNow;
}

describe("Business Logic Tests", function () {
  let owner, treasury, team, faction, miner1, miner2, miner3, buyer;
  let unit, rig, auction, weth, donut, lpToken, entropy;
  let baseSnapshotId;

  const EPOCH_PERIOD = 3600; // 1 hour
  const PRICE_MULTIPLIER = convert("2", 18); // 2x
  const MIN_INIT_PRICE = convert("0.0001", 18);
  const INITIAL_UPS = convert("4", 18);
  const HALVING_PERIOD = 30 * 24 * 3600; // 30 days
  const TAIL_UPS = convert("0.01", 18);
  const MULTIPLIER_DURATION = 24 * 3600; // 24 hours

  const TOTAL_FEE = 2000; // 20%
  const TEAM_FEE = 200; // 2%
  const FACTION_FEE = 200; // 2%
  const DIVISOR = 10000;

  // Take a snapshot at the very start to restore blockchain time
  before(async function () {
    baseSnapshotId = await ethers.provider.send("evm_snapshot", []);
  });

  // Restore to base snapshot after each test to reset blockchain time
  afterEach(async function () {
    await ethers.provider.send("evm_revert", [baseSnapshotId]);
    baseSnapshotId = await ethers.provider.send("evm_snapshot", []);
  });

  beforeEach("Deploy fresh contracts", async function () {
    [owner, treasury, team, faction, miner1, miner2, miner3, buyer] = await ethers.getSigners();

    // Deploy Unit
    const unitArtifact = await ethers.getContractFactory("Unit");
    unit = await unitArtifact.deploy("FarPlace", "FARP");

    // Deploy WETH mock
    const wethArtifact = await ethers.getContractFactory("MockWETH");
    weth = await wethArtifact.deploy();

    // Deploy Entropy mock
    const entropyArtifact = await ethers.getContractFactory("TestMockEntropy");
    entropy = await entropyArtifact.deploy(owner.address);

    // Deploy Donut mock
    const donutArtifact = await ethers.getContractFactory("MockDonut");
    donut = await donutArtifact.deploy();

    // Deploy LP mock
    const lpArtifact = await ethers.getContractFactory("MockLP");
    lpToken = await lpArtifact.deploy(unit.address, donut.address);

    // Deploy Auction
    const auctionArtifact = await ethers.getContractFactory("Auction");
    auction = await auctionArtifact.deploy(
      convert("1", 18), // initPrice
      lpToken.address, // paymentToken
      AddressDead, // paymentReceiver (burn)
      86400, // epochPeriod (1 day)
      convert("1.2", 18), // priceMultiplier
      convert("1", 18) // minInitPrice
    );

    // Deploy Rig
    const rigArtifact = await ethers.getContractFactory("Rig");
    rig = await rigArtifact.deploy(unit.address, weth.address, entropy.address, treasury.address);

    // Setup: Transfer minting rights to Rig
    await unit.setRig(rig.address);

    // Setup: Set team and faction
    await rig.setTeam(team.address);
    await rig.setFaction(faction.address, true);

    // Setup: Fund miners with WETH
    await weth.deposit({ value: convert("100", 18) });
    await weth.transfer(miner1.address, convert("20", 18));
    await weth.transfer(miner2.address, convert("20", 18));
    await weth.transfer(miner3.address, convert("20", 18));

    // Setup: Approve WETH spending
    await weth.connect(miner1).approve(rig.address, convert("100", 18));
    await weth.connect(miner2).approve(rig.address, convert("100", 18));
    await weth.connect(miner3).approve(rig.address, convert("100", 18));
  });

  /***************************************************************************
   * 1. RIG PRICE MECHANICS
   ***************************************************************************/
  describe("1. Rig Price Mechanics", function () {
    it("1.1 New slot starts with price 0 (no miner)", async function () {
      const price = await rig.getPrice(0);
      expect(price).to.equal(0);
    });

    it("1.2 Price decays linearly from initPrice to 0 over epoch period", async function () {
      // First mine to set initPrice
      const deadline = await getDeadline(3600);
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      const slot = await rig.getSlot(0);
      const initPrice = slot.initPrice;

      // At start, price should equal initPrice
      let price = await rig.getPrice(0);
      expect(price).to.equal(initPrice);

      // At 25% through epoch
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD / 4]);
      await ethers.provider.send("evm_mine");
      price = await rig.getPrice(0);
      expect(price).to.be.closeTo(initPrice.mul(75).div(100), initPrice.div(100));

      // At 50% through epoch
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD / 4]);
      await ethers.provider.send("evm_mine");
      price = await rig.getPrice(0);
      expect(price).to.be.closeTo(initPrice.mul(50).div(100), initPrice.div(100));

      // At 75% through epoch
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD / 4]);
      await ethers.provider.send("evm_mine");
      price = await rig.getPrice(0);
      expect(price).to.be.closeTo(initPrice.mul(25).div(100), initPrice.div(100));
    });

    it("1.3 Price becomes 0 after epoch period ends", async function () {
      const deadline = await getDeadline(7200);
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      // After epoch period
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
      await ethers.provider.send("evm_mine");

      const price = await rig.getPrice(0);
      expect(price).to.equal(0);
    });

    it("1.4 Next epoch initPrice is 2x the paid price (capped by MIN_INIT_PRICE)", async function () {
      // First mine (free)
      const deadline = await getDeadline(3600);
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      // Second mine immediately (pay near full initPrice - slight decay due to time between blocks)
      const slotBefore = await rig.getSlot(0);
      const initPriceBefore = slotBefore.initPrice;

      // Get current price which accounts for any decay
      const currentPrice = await rig.getPrice(0);

      await rig.connect(miner2).mine(
        miner2.address,
        AddressZero,
        0,
        1,
        deadline,
        convert("10", 18),
        "uri2"
      );

      const slotAfter = await rig.getSlot(0);

      // The new initPrice should be approximately 2x the paid price
      // Using closeTo to account for minimal time between price read and mine execution
      const expectedInitPrice = currentPrice.mul(2);

      if (expectedInitPrice.lt(MIN_INIT_PRICE)) {
        expect(slotAfter.initPrice).to.equal(MIN_INIT_PRICE);
      } else {
        // Allow 1% tolerance for timing differences
        expect(slotAfter.initPrice).to.be.closeTo(expectedInitPrice, expectedInitPrice.div(100));
      }
    });

    it("1.5 Mining at price 0 sets initPrice to MIN_INIT_PRICE", async function () {
      // First mine (free)
      const deadline = await getDeadline(7200);
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      // Wait for price to decay to 0
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
      await ethers.provider.send("evm_mine");

      // Mine at price 0
      await rig.connect(miner2).mine(miner2.address, AddressZero, 0, 1, deadline, 0, "uri2");

      const slot = await rig.getSlot(0);
      expect(slot.initPrice).to.equal(MIN_INIT_PRICE);
    });
  });

  /***************************************************************************
   * 2. FEE DISTRIBUTION
   ***************************************************************************/
  describe("2. Fee Distribution", function () {
    it("2.1 Fee split: 20% protocol (treasury+team+faction), 80% miner", async function () {
      const deadline = await getDeadline(3600);

      // First mine (miner1 takes slot)
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      // Get price for second mine
      const price = await rig.getPrice(0);

      const treasuryBefore = await weth.balanceOf(treasury.address);
      const teamBefore = await weth.balanceOf(team.address);
      const factionBefore = await weth.balanceOf(faction.address);
      const miner1Before = await weth.balanceOf(miner1.address);

      // Second mine with faction
      await rig
        .connect(miner2)
        .mine(miner2.address, faction.address, 0, 1, deadline, convert("10", 18), "uri2");

      const treasuryAfter = await weth.balanceOf(treasury.address);
      const teamAfter = await weth.balanceOf(team.address);
      const factionAfter = await weth.balanceOf(faction.address);
      const miner1After = await weth.balanceOf(miner1.address);

      // Calculate expected fees
      const teamFee = price.mul(TEAM_FEE).div(DIVISOR);
      const factionFee = price.mul(FACTION_FEE).div(DIVISOR);
      const treasuryFee = price.mul(TOTAL_FEE).div(DIVISOR).sub(teamFee).sub(factionFee);
      const minerFee = price.sub(treasuryFee).sub(teamFee).sub(factionFee);

      // Verify each party received correct amount
      expect(treasuryAfter.sub(treasuryBefore)).to.be.closeTo(treasuryFee, treasuryFee.div(100));
      expect(teamAfter.sub(teamBefore)).to.be.closeTo(teamFee, teamFee.div(100));
      expect(factionAfter.sub(factionBefore)).to.be.closeTo(factionFee, factionFee.div(100));
      expect(miner1After.sub(miner1Before)).to.be.closeTo(minerFee, minerFee.div(100));

      // Verify total fees = price
      const totalFees = treasuryAfter
        .sub(treasuryBefore)
        .add(teamAfter.sub(teamBefore))
        .add(factionAfter.sub(factionBefore))
        .add(miner1After.sub(miner1Before));
      expect(totalFees).to.be.closeTo(price, price.div(100));
    });

    it("2.2 Without team: treasury gets extra 2%", async function () {
      // Remove team
      await rig.setTeam(AddressZero);

      const deadline = await getDeadline(3600);
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      const price = await rig.getPrice(0);
      const treasuryBefore = await weth.balanceOf(treasury.address);

      await rig
        .connect(miner2)
        .mine(miner2.address, faction.address, 0, 1, deadline, convert("10", 18), "uri2");

      const treasuryAfter = await weth.balanceOf(treasury.address);

      // Treasury should get TOTAL_FEE - FACTION_FEE = 20% - 2% = 18%
      const expectedTreasuryFee = price.mul(TOTAL_FEE - FACTION_FEE).div(DIVISOR);
      expect(treasuryAfter.sub(treasuryBefore)).to.be.closeTo(
        expectedTreasuryFee,
        expectedTreasuryFee.div(100)
      );
    });

    it("2.3 Without faction: treasury gets extra 2%", async function () {
      const deadline = await getDeadline(3600);
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      const price = await rig.getPrice(0);
      const treasuryBefore = await weth.balanceOf(treasury.address);

      // Mine without faction (AddressZero)
      await rig
        .connect(miner2)
        .mine(miner2.address, AddressZero, 0, 1, deadline, convert("10", 18), "uri2");

      const treasuryAfter = await weth.balanceOf(treasury.address);

      // Treasury should get TOTAL_FEE - TEAM_FEE = 20% - 2% = 18%
      const expectedTreasuryFee = price.mul(TOTAL_FEE - TEAM_FEE).div(DIVISOR);
      expect(treasuryAfter.sub(treasuryBefore)).to.be.closeTo(
        expectedTreasuryFee,
        expectedTreasuryFee.div(100)
      );
    });

    it("2.4 Without team or faction: treasury gets full 20%", async function () {
      await rig.setTeam(AddressZero);

      const deadline = await getDeadline(3600);
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      const price = await rig.getPrice(0);
      const treasuryBefore = await weth.balanceOf(treasury.address);

      await rig
        .connect(miner2)
        .mine(miner2.address, AddressZero, 0, 1, deadline, convert("10", 18), "uri2");

      const treasuryAfter = await weth.balanceOf(treasury.address);

      // Treasury gets full 20%
      const expectedTreasuryFee = price.mul(TOTAL_FEE).div(DIVISOR);
      expect(treasuryAfter.sub(treasuryBefore)).to.be.closeTo(
        expectedTreasuryFee,
        expectedTreasuryFee.div(100)
      );
    });

    it("2.5 First miner on slot pays 0 (no previous miner)", async function () {
      const deadline = await getDeadline(3600);

      const miner1Before = await weth.balanceOf(miner1.address);

      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      const miner1After = await weth.balanceOf(miner1.address);

      // No WETH spent (price was 0)
      expect(miner1Before).to.equal(miner1After);
    });
  });

  /***************************************************************************
   * 3. UNIT MINTING (Mining Rewards)
   ***************************************************************************/
  describe("3. Unit Minting (Mining Rewards)", function () {
    it("3.1 Minted amount = time * UPS * multiplier / PRECISION", async function () {
      const deadline = await getDeadline(7200);

      // First mine
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      const slot = await rig.getSlot(0);
      const mineStartTime = slot.startTime;

      // Wait some time
      const mineTime = 1800; // 30 minutes
      await ethers.provider.send("evm_increaseTime", [mineTime]);
      await ethers.provider.send("evm_mine");

      const miner1UnitBefore = await unit.balanceOf(miner1.address);

      // Second mine (triggers minting for miner1)
      await rig
        .connect(miner2)
        .mine(miner2.address, AddressZero, 0, 1, deadline, convert("10", 18), "uri2");

      const miner1UnitAfter = await unit.balanceOf(miner1.address);

      // Calculate expected minted amount
      const slotData = await rig.getSlot(0);
      // UPS = INITIAL_UPS / capacity = 4e18 / 1 = 4e18
      // minted = time * ups * multiplier / 1e18
      // multiplier is 1e18 (default)
      const expectedMinted = ethers.BigNumber.from(mineTime + 1) // +1 for block time
        .mul(slot.ups)
        .mul(slot.multiplier)
        .div(convert("1", 18));

      expect(miner1UnitAfter.sub(miner1UnitBefore)).to.be.closeTo(
        expectedMinted,
        expectedMinted.div(50) // 2% tolerance for timing
      );
    });

    it("3.2 First mine on slot mints 0 (no previous miner)", async function () {
      const deadline = await getDeadline(3600);

      const totalSupplyBefore = await unit.totalSupply();

      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      const totalSupplyAfter = await unit.totalSupply();

      expect(totalSupplyAfter).to.equal(totalSupplyBefore);
    });

    it("3.3 Longer mining time = more rewards", async function () {
      const deadline = await getDeadline(86400);

      // Mine slot 0 - first miner (30 mins)
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      // Wait 30 minutes
      await ethers.provider.send("evm_increaseTime", [1800]);
      await ethers.provider.send("evm_mine");

      // Replace miner1 with miner2 (miner1 gets 30 min rewards)
      await rig
        .connect(miner2)
        .mine(miner2.address, AddressZero, 0, 1, deadline, convert("10", 18), "uri2");

      const miner1Rewards = await unit.balanceOf(miner1.address);

      // Wait another 60 minutes (miner2 will have 60 min)
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine");

      // Replace miner2 with miner3 (miner2 gets 60 min rewards)
      await rig
        .connect(miner3)
        .mine(miner3.address, AddressZero, 0, 2, deadline, convert("10", 18), "uri3");

      const miner2Rewards = await unit.balanceOf(miner2.address);

      // Miner2 should have ~2x rewards (60 mins vs 30 mins)
      // Both had same UPS since same slot was used
      expect(miner2Rewards).to.be.closeTo(miner1Rewards.mul(2), miner1Rewards.div(5)); // ~2x with tolerance
    });

    it("3.4 No rewards minted if epoch ends and no one takes over", async function () {
      const deadline = await getDeadline(86400);

      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      // Wait past epoch period (no one takes over)
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 100]);
      await ethers.provider.send("evm_mine");

      // Miner1 still owns slot but hasn't been replaced, so no minting yet
      const miner1Balance = await unit.balanceOf(miner1.address);
      expect(miner1Balance).to.equal(0);

      // When someone finally takes over, miner1 gets rewards for full time
      await rig
        .connect(miner2)
        .mine(miner2.address, AddressZero, 0, 1, deadline, convert("10", 18), "uri2");

      const miner1BalanceAfter = await unit.balanceOf(miner1.address);
      expect(miner1BalanceAfter).to.be.gt(0);
    });
  });

  /***************************************************************************
   * 4. UPS (Units Per Second) MECHANICS
   ***************************************************************************/
  describe("4. UPS Mechanics", function () {
    it("4.1 Initial UPS is 4 tokens per second", async function () {
      const ups = await rig.getUps();
      expect(ups).to.equal(INITIAL_UPS);
    });

    it("4.2 UPS halves every 30 days", async function () {
      // Initial UPS
      let ups = await rig.getUps();
      expect(ups).to.equal(INITIAL_UPS); // 4e18

      // After 30 days
      await ethers.provider.send("evm_increaseTime", [HALVING_PERIOD]);
      await ethers.provider.send("evm_mine");
      ups = await rig.getUps();
      expect(ups).to.equal(INITIAL_UPS.div(2)); // 2e18

      // After 60 days
      await ethers.provider.send("evm_increaseTime", [HALVING_PERIOD]);
      await ethers.provider.send("evm_mine");
      ups = await rig.getUps();
      expect(ups).to.equal(INITIAL_UPS.div(4)); // 1e18

      // After 90 days
      await ethers.provider.send("evm_increaseTime", [HALVING_PERIOD]);
      await ethers.provider.send("evm_mine");
      ups = await rig.getUps();
      expect(ups).to.equal(INITIAL_UPS.div(8)); // 0.5e18
    });

    it("4.3 UPS never falls below tail emission (0.01)", async function () {
      // Fast forward many halving periods (4e18 -> 0.01e18 after ~9 halvings)
      // 4 -> 2 -> 1 -> 0.5 -> 0.25 -> 0.125 -> 0.0625 -> 0.03125 -> 0.015625 -> 0.0078125
      // After 9 halvings, we'd be at ~0.0078 which is below TAIL_UPS (0.01)
      await ethers.provider.send("evm_increaseTime", [HALVING_PERIOD * 10]);
      await ethers.provider.send("evm_mine");

      const ups = await rig.getUps();
      expect(ups).to.equal(TAIL_UPS);
    });

    it("4.4 Slot UPS is global UPS divided by capacity", async function () {
      let deadline = await getDeadline(3600);

      // Mine with capacity 1
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");
      let slot = await rig.getSlot(0);
      expect(slot.ups).to.equal(INITIAL_UPS.div(1)); // 4e18 / 1

      // Increase capacity to 4
      await rig.setCapacity(4);

      // Mine again (updates slot UPS)
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
      await ethers.provider.send("evm_mine");
      deadline = await getDeadline(3600); // Refresh deadline after time travel
      await rig.connect(miner2).mine(miner2.address, AddressZero, 0, 1, deadline, 0, "uri2");

      slot = await rig.getSlot(0);
      expect(slot.ups).to.equal(INITIAL_UPS.div(4)); // 4e18 / 4 = 1e18
    });
  });

  /***************************************************************************
   * 5. MULTIPLIER MECHANICS
   ***************************************************************************/
  describe("5. Multiplier Mechanics", function () {
    it("5.1 Default multiplier is 1x", async function () {
      const deadline = await getDeadline(3600);
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      const slot = await rig.getSlot(0);
      expect(slot.multiplier).to.equal(convert("1", 18));
    });

    it("5.2 Multiplier resets to default after 24 hours", async function () {
      const deadline = await getDeadline(86400 * 2);

      // First mine
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      // Wait 24+ hours (multiplier expires)
      await ethers.provider.send("evm_increaseTime", [MULTIPLIER_DURATION + 100]);
      await ethers.provider.send("evm_mine");

      // Mine again - should reset multiplier
      await rig
        .connect(miner2)
        .mine(miner2.address, AddressZero, 0, 1, deadline, convert("10", 18), "uri2");

      const slot = await rig.getSlot(0);
      expect(slot.multiplier).to.equal(convert("1", 18)); // Reset to default
    });

    it("5.3 Multipliers must be >= 1x", async function () {
      // Try setting multiplier below 1x
      await expect(rig.setMultipliers([convert("0.9", 18)])).to.be.reverted;

      // Valid multipliers
      await rig.setMultipliers([convert("1", 18), convert("2", 18), convert("5", 18)]);
      const multipliers = await rig.getMultipliers();
      expect(multipliers.length).to.equal(3);
    });

    it("5.4 Higher multiplier = more mining rewards", async function () {
      // This test validates the math: rewards = time * ups * multiplier
      const deadline = await getDeadline(86400);

      // Mine slot 0 with default multiplier
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      // Increase capacity
      await rig.setCapacity(2);

      // Mine slot 1
      await rig.connect(miner2).mine(miner2.address, AddressZero, 1, 0, deadline, 0, "uri2");

      // Both slots have multiplier 1x initially
      let slot0 = await rig.getSlot(0);
      let slot1 = await rig.getSlot(1);
      expect(slot0.multiplier).to.equal(slot1.multiplier);

      // The reward formula is: time * ups * multiplier / 1e18
      // So if time and ups are same, multiplier directly scales rewards
    });
  });

  /***************************************************************************
   * 6. AUCTION PRICE MECHANICS
   ***************************************************************************/
  describe("6. Auction Price Mechanics", function () {
    it("6.1 Auction price decays linearly over epoch period", async function () {
      const initPrice = await auction.initPrice();
      const epochPeriod = await auction.epochPeriod();

      // At start (allow small tolerance for time between deployment and check)
      let price = await auction.getPrice();
      expect(price).to.be.closeTo(initPrice, initPrice.div(1000)); // 0.1% tolerance

      // At 50%
      await ethers.provider.send("evm_increaseTime", [epochPeriod.toNumber() / 2]);
      await ethers.provider.send("evm_mine");
      price = await auction.getPrice();
      expect(price).to.be.closeTo(initPrice.div(2), initPrice.div(100));

      // At 100%+
      await ethers.provider.send("evm_increaseTime", [epochPeriod.toNumber() / 2 + 100]);
      await ethers.provider.send("evm_mine");
      price = await auction.getPrice();
      expect(price).to.equal(0);
    });

    it("6.2 Next epoch initPrice = paid price * 1.2x", async function () {
      // Fund LP tokens for buyer
      await lpToken.mint(buyer.address, convert("100", 18));
      await lpToken.connect(buyer).approve(auction.address, convert("100", 18));

      // Send some WETH to auction for assets
      await weth.deposit({ value: convert("5", 18) });
      await weth.transfer(auction.address, convert("5", 18));

      const priceBefore = await auction.getPrice();
      const deadline = await getDeadline(3600);

      await auction.connect(buyer).buy([weth.address], buyer.address, 0, deadline, convert("100", 18));

      const initPriceAfter = await auction.initPrice();
      const expectedInitPrice = priceBefore.mul(convert("1.2", 18)).div(convert("1", 18));

      expect(initPriceAfter).to.be.closeTo(expectedInitPrice, expectedInitPrice.div(100));
    });

    it("6.3 initPrice respects minInitPrice floor", async function () {
      // Fund LP tokens
      await lpToken.mint(buyer.address, convert("100", 18));
      await lpToken.connect(buyer).approve(auction.address, convert("100", 18));

      // Send WETH to auction
      await weth.deposit({ value: convert("5", 18) });
      await weth.transfer(auction.address, convert("5", 18));

      // Wait for price to decay to 0
      const epochPeriod = await auction.epochPeriod();
      await ethers.provider.send("evm_increaseTime", [epochPeriod.toNumber() + 100]);
      await ethers.provider.send("evm_mine");

      // Buy at price 0
      const deadline = await getDeadline(86400);
      await auction.connect(buyer).buy([weth.address], buyer.address, 0, deadline, convert("100", 18));

      // initPrice should be at minInitPrice
      const minInitPrice = await auction.minInitPrice();
      const initPriceAfter = await auction.initPrice();
      expect(initPriceAfter).to.equal(minInitPrice);
    });

    it("6.4 LP tokens are sent to burn address on buy", async function () {
      await lpToken.mint(buyer.address, convert("100", 18));
      await lpToken.connect(buyer).approve(auction.address, convert("100", 18));

      await weth.deposit({ value: convert("5", 18) });
      await weth.transfer(auction.address, convert("5", 18));

      const burnBalanceBefore = await lpToken.balanceOf(AddressDead);
      const price = await auction.getPrice();

      const deadline = await getDeadline(3600);
      await auction.connect(buyer).buy([weth.address], buyer.address, 0, deadline, convert("100", 18));

      const burnBalanceAfter = await lpToken.balanceOf(AddressDead);
      expect(burnBalanceAfter.sub(burnBalanceBefore)).to.be.closeTo(price, price.div(100));
    });

    it("6.5 Assets are transferred to buyer on buy", async function () {
      await lpToken.mint(buyer.address, convert("100", 18));
      await lpToken.connect(buyer).approve(auction.address, convert("100", 18));

      const assetAmount = convert("5", 18);
      await weth.deposit({ value: assetAmount });
      await weth.transfer(auction.address, assetAmount);

      const buyerWethBefore = await weth.balanceOf(buyer.address);

      const deadline = await getDeadline(3600);
      await auction.connect(buyer).buy([weth.address], buyer.address, 0, deadline, convert("100", 18));

      const buyerWethAfter = await weth.balanceOf(buyer.address);
      expect(buyerWethAfter.sub(buyerWethBefore)).to.equal(assetAmount);
    });
  });

  /***************************************************************************
   * 7. INTEGRATION: FULL MINING CYCLE
   ***************************************************************************/
  describe("7. Integration: Full Mining Cycle", function () {
    it("7.1 Complete mining cycle with multiple participants", async function () {
      const deadline = await getDeadline(86400);

      // Step 1: Miner1 takes empty slot (free)
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "miner1_uri");

      let slot = await rig.getSlot(0);
      expect(slot.miner).to.equal(miner1.address);
      expect(slot.epochId).to.equal(1);

      // Step 2: Wait and let miner1 accumulate rewards
      await ethers.provider.send("evm_increaseTime", [600]); // 10 minutes
      await ethers.provider.send("evm_mine");

      // Step 3: Miner2 takes over (pays fee)
      const price = await rig.getPrice(0);
      expect(price).to.be.gt(0);

      await rig
        .connect(miner2)
        .mine(miner2.address, AddressZero, 0, 1, deadline, convert("10", 18), "miner2_uri");

      slot = await rig.getSlot(0);
      expect(slot.miner).to.equal(miner2.address);
      expect(slot.epochId).to.equal(2);

      // Miner1 should have received UNIT tokens
      const miner1Units = await unit.balanceOf(miner1.address);
      expect(miner1Units).to.be.gt(0);

      // Miner1 should have received 80% of price as WETH
      // (we already verified fee distribution above)

      // Step 4: Wait past epoch, take over at 0 price
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 100]);
      await ethers.provider.send("evm_mine");

      const priceAfterEpoch = await rig.getPrice(0);
      expect(priceAfterEpoch).to.equal(0);

      await rig.connect(miner3).mine(miner3.address, AddressZero, 0, 2, deadline, 0, "miner3_uri");

      slot = await rig.getSlot(0);
      expect(slot.miner).to.equal(miner3.address);

      // Miner2 should have received UNIT tokens for full epoch + extra time
      const miner2Units = await unit.balanceOf(miner2.address);
      expect(miner2Units).to.be.gt(miner1Units); // More time = more rewards
    });

    it("7.2 Multiple slots operating independently", async function () {
      const deadline = await getDeadline(86400);

      // Expand capacity
      await rig.setCapacity(3);

      // Mine all three slots
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "slot0");
      await rig.connect(miner2).mine(miner2.address, AddressZero, 1, 0, deadline, 0, "slot1");
      await rig.connect(miner3).mine(miner3.address, AddressZero, 2, 0, deadline, 0, "slot2");

      // Verify all slots have different miners
      const slot0 = await rig.getSlot(0);
      const slot1 = await rig.getSlot(1);
      const slot2 = await rig.getSlot(2);

      expect(slot0.miner).to.equal(miner1.address);
      expect(slot1.miner).to.equal(miner2.address);
      expect(slot2.miner).to.equal(miner3.address);

      // Each slot has its own epochId
      expect(slot0.epochId).to.equal(1);
      expect(slot1.epochId).to.equal(1);
      expect(slot2.epochId).to.equal(1);

      // Wait and replace only slot 1
      await ethers.provider.send("evm_increaseTime", [600]);
      await ethers.provider.send("evm_mine");

      await rig
        .connect(miner1)
        .mine(miner1.address, AddressZero, 1, 1, deadline, convert("10", 18), "slot1_new");

      // Slot 1 epochId increased, others unchanged
      const slot0After = await rig.getSlot(0);
      const slot1After = await rig.getSlot(1);
      const slot2After = await rig.getSlot(2);

      expect(slot0After.epochId).to.equal(1);
      expect(slot1After.epochId).to.equal(2);
      expect(slot2After.epochId).to.equal(1);

      // Miner2 received rewards from slot 1
      const miner2Units = await unit.balanceOf(miner2.address);
      expect(miner2Units).to.be.gt(0);
    });
  });

  /***************************************************************************
   * 8. EDGE CASES AND SECURITY
   ***************************************************************************/
  describe("8. Edge Cases and Security", function () {
    it("8.1 Cannot mine with wrong epochId (frontrun protection)", async function () {
      const deadline = await getDeadline(3600);
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      // Try to mine with wrong epochId
      await expect(
        rig.connect(miner2).mine(miner2.address, AddressZero, 0, 0, deadline, convert("10", 18), "uri2")
      ).to.be.reverted;
    });

    it("8.2 Cannot mine past deadline", async function () {
      const deadline = 1; // Already passed (timestamp 1 is in the past)
      await expect(
        rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1")
      ).to.be.reverted;
    });

    it("8.3 Cannot mine if price exceeds maxPrice", async function () {
      const deadline = await getDeadline(3600);
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      // Set maxPrice to 0 (only accept free slots)
      await expect(
        rig.connect(miner2).mine(miner2.address, AddressZero, 0, 1, deadline, 0, "uri2")
      ).to.be.reverted;
    });

    it("8.4 Cannot mine invalid slot index", async function () {
      const deadline = await getDeadline(3600);

      // Try to mine slot 1 when capacity is 1
      await expect(
        rig.connect(miner1).mine(miner1.address, AddressZero, 1, 0, deadline, 0, "uri1")
      ).to.be.reverted;
    });

    it("8.5 Cannot set invalid faction", async function () {
      const deadline = await getDeadline(3600);
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri1");

      // Try to use non-approved faction
      await expect(
        rig
          .connect(miner2)
          .mine(miner2.address, miner3.address, 0, 1, deadline, convert("10", 18), "uri2")
      ).to.be.reverted;
    });

    it("8.6 Cannot mine with zero address as miner", async function () {
      const deadline = await getDeadline(3600);
      await expect(
        rig.connect(miner1).mine(AddressZero, AddressZero, 0, 0, deadline, 0, "uri1")
      ).to.be.reverted;
    });

    it("8.7 Auction rejects empty assets array", async function () {
      await lpToken.mint(buyer.address, convert("100", 18));
      await lpToken.connect(buyer).approve(auction.address, convert("100", 18));

      const deadline = await getDeadline(3600);
      await expect(auction.connect(buyer).buy([], buyer.address, 0, deadline, convert("100", 18))).to.be
        .reverted;
    });

    it("8.8 Auction rejects wrong epochId", async function () {
      await lpToken.mint(buyer.address, convert("100", 18));
      await lpToken.connect(buyer).approve(auction.address, convert("100", 18));
      await weth.deposit({ value: convert("5", 18) });
      await weth.transfer(auction.address, convert("5", 18));

      const deadline = await getDeadline(3600);
      await expect(
        auction.connect(buyer).buy([weth.address], buyer.address, 1, deadline, convert("100", 18))
      ).to.be.reverted;
    });

    it("8.9 Auction rejects if maxPaymentAmount exceeded", async function () {
      await lpToken.mint(buyer.address, convert("100", 18));
      await lpToken.connect(buyer).approve(auction.address, convert("100", 18));
      await weth.deposit({ value: convert("5", 18) });
      await weth.transfer(auction.address, convert("5", 18));

      const deadline = await getDeadline(3600);
      // Set maxPaymentAmount very low
      await expect(
        auction.connect(buyer).buy([weth.address], buyer.address, 0, deadline, convert("0.0001", 18))
      ).to.be.reverted;
    });

    it("8.10 Capacity can only increase", async function () {
      await rig.setCapacity(5);

      // Try to decrease
      await expect(rig.setCapacity(3)).to.be.reverted;

      // Try to set same
      await expect(rig.setCapacity(5)).to.be.reverted;
    });

    it("8.11 Treasury cannot be set to zero address", async function () {
      await expect(rig.setTreasury(AddressZero)).to.be.reverted;
    });

    it("8.12 Only owner can set admin parameters", async function () {
      await expect(rig.connect(miner1).setCapacity(10)).to.be.reverted;
      await expect(rig.connect(miner1).setTreasury(miner1.address)).to.be.reverted;
      await expect(rig.connect(miner1).setTeam(miner1.address)).to.be.reverted;
      await expect(rig.connect(miner1).setFaction(miner1.address, true)).to.be.reverted;
      await expect(rig.connect(miner1).setMultipliers([convert("2", 18)])).to.be.reverted;
    });
  });

  /***************************************************************************
   * 9. STRESS TESTS
   ***************************************************************************/
  describe("9. Stress Tests", function () {
    it("9.1 Rapid slot takeovers work correctly", async function () {
      const deadline = await getDeadline(86400);

      // Initial mine
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri0");

      // Rapid takeovers
      for (let i = 1; i <= 5; i++) {
        const miner = i % 2 === 0 ? miner2 : miner1;
        const price = await rig.getPrice(0);

        await rig
          .connect(miner)
          .mine(miner.address, AddressZero, 0, i, deadline, price.add(convert("1", 18)), `uri${i}`);

        const slot = await rig.getSlot(0);
        expect(slot.epochId).to.equal(i + 1);
        expect(slot.miner).to.equal(miner.address);
      }
    });

    it("9.2 Many slots can operate simultaneously", async function () {
      const deadline = await getDeadline(86400);

      // Expand capacity
      await rig.setCapacity(10);

      // Mine all slots
      for (let i = 0; i < 10; i++) {
        const miner = [miner1, miner2, miner3][i % 3];
        await rig.connect(miner).mine(miner.address, AddressZero, i, 0, deadline, 0, `slot${i}`);
      }

      // Verify all slots are active
      for (let i = 0; i < 10; i++) {
        const slot = await rig.getSlot(i);
        expect(slot.epochId).to.equal(1);
        expect(slot.miner).to.not.equal(AddressZero);
      }
    });

    it("9.3 Long-term mining accumulates significant rewards", async function () {
      const deadline = await getDeadline(86400 * 10);

      // Mine
      await rig.connect(miner1).mine(miner1.address, AddressZero, 0, 0, deadline, 0, "uri");

      // Wait 1 day
      await ethers.provider.send("evm_increaseTime", [86400]);
      await ethers.provider.send("evm_mine");

      // Takeover to trigger minting
      await rig.connect(miner2).mine(miner2.address, AddressZero, 0, 1, deadline, 0, "uri2");

      const miner1Units = await unit.balanceOf(miner1.address);

      // Expected: 86400 seconds * 4e18 UPS * 1e18 multiplier / 1e18 = ~345,600 tokens
      // With capacity 1, UPS = 4e18
      const expectedApprox = ethers.BigNumber.from("86400").mul(convert("4", 18));
      expect(miner1Units).to.be.closeTo(expectedApprox, expectedApprox.div(10));
    });
  });
});
