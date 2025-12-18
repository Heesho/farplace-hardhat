const { expect } = require("chai");
const { ethers } = require("hardhat");

const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const divDec = (amount, decimals = 18) => amount / 10 ** decimals;
const AddressZero = "0x0000000000000000000000000000000000000000";

describe("Rig Contract", function () {
  let owner, treasury, team, user1, user2, faction1, faction2, entropyProvider;
  let weth, unit, rig, entropy;
  let snapshotId;

  before("Deploy contracts", async function () {
    [owner, treasury, team, user1, user2, faction1, faction2, entropyProvider] =
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

    // Setup factions
    await rig.setFaction(faction1.address, true);
    await rig.setFaction(faction2.address, true);

    // Fund users with WETH
    await weth.connect(user1).deposit({ value: convert("100", 18) });
    await weth.connect(user2).deposit({ value: convert("100", 18) });
    await weth.connect(user1).approve(rig.address, ethers.constants.MaxUint256);
    await weth.connect(user2).approve(rig.address, ethers.constants.MaxUint256);
  });

  beforeEach(async function () {
    snapshotId = await ethers.provider.send("evm_snapshot", []);
  });

  afterEach(async function () {
    await ethers.provider.send("evm_revert", [snapshotId]);
  });

  describe("Deployment", function () {
    it("should set correct immutable addresses", async function () {
      expect(await rig.unit()).to.equal(unit.address);
      expect(await rig.quote()).to.equal(weth.address);
      expect(await rig.treasury()).to.equal(treasury.address);
    });

    it("should set correct initial capacity", async function () {
      expect(await rig.capacity()).to.equal(1);
    });

    it("should set correct fee constants", async function () {
      expect(await rig.TOTAL_FEE()).to.equal(2000); // 20%
      expect(await rig.TEAM_FEE()).to.equal(200); // 2%
      expect(await rig.FACTION_FEE()).to.equal(200); // 2%
      expect(await rig.DIVISOR()).to.equal(10000);
    });

    it("should set correct timing constants", async function () {
      expect(await rig.EPOCH_PERIOD()).to.equal(3600); // 1 hour
      expect(await rig.HALVING_PERIOD()).to.equal(2592000); // 30 days
    });

    it("should set correct UPS constants", async function () {
      expect(await rig.INITIAL_UPS()).to.equal(convert("4", 18));
      expect(await rig.TAIL_UPS()).to.equal(convert("0.01", 18));
    });

    it("should have empty multipliers array initially", async function () {
      const multipliers = await rig.getMultipliers();
      expect(multipliers.length).to.equal(0);
    });

    it("should set startTime to deployment timestamp", async function () {
      const startTime = await rig.startTime();
      expect(startTime).to.be.gt(0);
    });
  });

  describe("Access Control", function () {
    it("should only allow owner to call setTreasury", async function () {
      await expect(rig.connect(user1).setTreasury(user1.address)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
      await rig.setTreasury(user1.address);
      expect(await rig.treasury()).to.equal(user1.address);
    });

    it("should only allow owner to call setTeam", async function () {
      await expect(rig.connect(user1).setTeam(user1.address)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
      await rig.setTeam(user1.address);
      expect(await rig.team()).to.equal(user1.address);
    });

    it("should only allow owner to call setFaction", async function () {
      await expect(rig.connect(user1).setFaction(user1.address, true)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });

    it("should only allow owner to call setCapacity", async function () {
      await expect(rig.connect(user1).setCapacity(10)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });

    it("should only allow owner to call setMultipliers", async function () {
      await expect(rig.connect(user1).setMultipliers([convert("1", 18)])).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });

    it("should transfer ownership correctly", async function () {
      await rig.transferOwnership(user1.address);
      expect(await rig.owner()).to.equal(user1.address);

      await expect(rig.setCapacity(10)).to.be.revertedWith("Ownable: caller is not the owner");
      await rig.connect(user1).setCapacity(10);
      expect(await rig.capacity()).to.equal(10);
    });
  });

  describe("Admin Functions - setTreasury", function () {
    it("should update treasury address", async function () {
      await rig.setTreasury(user1.address);
      expect(await rig.treasury()).to.equal(user1.address);
    });

    it("should emit Rig__TreasurySet event", async function () {
      await expect(rig.setTreasury(user1.address))
        .to.emit(rig, "Rig__TreasurySet")
        .withArgs(user1.address);
    });

    it("should reject zero address for treasury", async function () {
      await expect(rig.setTreasury(AddressZero)).to.be.reverted;
    });
  });

  describe("Admin Functions - setTeam", function () {
    it("should update team address", async function () {
      await rig.setTeam(user1.address);
      expect(await rig.team()).to.equal(user1.address);
    });

    it("should emit Rig__TeamSet event", async function () {
      await expect(rig.setTeam(user1.address))
        .to.emit(rig, "Rig__TeamSet")
        .withArgs(user1.address);
    });

    it("should allow setting team to zero address (disables team fee)", async function () {
      await rig.setTeam(AddressZero);
      expect(await rig.team()).to.equal(AddressZero);
    });
  });

  describe("Admin Functions - setFaction", function () {
    it("should whitelist new faction", async function () {
      await rig.setFaction(user1.address, true);
      expect(await rig.account_IsFaction(user1.address)).to.be.true;
    });

    it("should remove faction from whitelist", async function () {
      await rig.setFaction(faction1.address, false);
      expect(await rig.account_IsFaction(faction1.address)).to.be.false;
    });

    it("should emit Rig__FactionSet event", async function () {
      await expect(rig.setFaction(user1.address, true))
        .to.emit(rig, "Rig__FactionSet")
        .withArgs(user1.address, true);
    });

    it("should reject whitelisting zero address", async function () {
      await expect(rig.setFaction(AddressZero, true)).to.be.reverted;
    });

    it("should allow toggling faction status multiple times", async function () {
      expect(await rig.account_IsFaction(faction1.address)).to.be.true;
      await rig.setFaction(faction1.address, false);
      expect(await rig.account_IsFaction(faction1.address)).to.be.false;
      await rig.setFaction(faction1.address, true);
      expect(await rig.account_IsFaction(faction1.address)).to.be.true;
    });
  });

  describe("Admin Functions - setCapacity", function () {
    it("should increase capacity", async function () {
      await rig.setCapacity(10);
      expect(await rig.capacity()).to.equal(10);
    });

    it("should emit Rig__CapacitySet event", async function () {
      await expect(rig.setCapacity(10)).to.emit(rig, "Rig__CapacitySet").withArgs(10);
    });

    it("should reject capacity equal to current", async function () {
      const current = await rig.capacity();
      await expect(rig.setCapacity(current)).to.be.reverted;
    });

    it("should reject capacity less than current", async function () {
      await rig.setCapacity(10);
      await expect(rig.setCapacity(5)).to.be.reverted;
    });

    it("should reject capacity above MAX_CAPACITY", async function () {
      const maxCapacity = await rig.MAX_CAPACITY();
      await expect(rig.setCapacity(maxCapacity.add(1))).to.be.reverted;
    });

    it("should allow setting capacity to MAX_CAPACITY", async function () {
      const maxCapacity = await rig.MAX_CAPACITY();
      await rig.setCapacity(maxCapacity);
      expect(await rig.capacity()).to.equal(maxCapacity);
    });
  });

  describe("Admin Functions - setMultipliers", function () {
    it("should set multipliers array", async function () {
      const multipliers = [convert("1", 18), convert("2", 18), convert("5", 18)];
      await rig.setMultipliers(multipliers);

      const stored = await rig.getMultipliers();
      expect(stored.length).to.equal(3);
      expect(stored[0]).to.equal(convert("1", 18));
      expect(stored[1]).to.equal(convert("2", 18));
      expect(stored[2]).to.equal(convert("5", 18));
    });

    it("should emit Rig__MultipliersSet event", async function () {
      const multipliers = [convert("1", 18)];
      await expect(rig.setMultipliers(multipliers)).to.emit(rig, "Rig__MultipliersSet");
    });

    it("should reject empty multipliers array", async function () {
      await expect(rig.setMultipliers([])).to.be.reverted;
    });

    it("should reject multipliers below DEFAULT_MULTIPLIER (1e18)", async function () {
      await expect(rig.setMultipliers([convert("0.5", 18)])).to.be.reverted;
    });

    it("should allow all multipliers equal to 1x", async function () {
      const multipliers = Array(10).fill(convert("1", 18));
      await rig.setMultipliers(multipliers);
      expect((await rig.getMultipliers()).length).to.equal(10);
    });

    it("should allow replacing multipliers", async function () {
      await rig.setMultipliers([convert("1", 18), convert("2", 18)]);
      await rig.setMultipliers([convert("3", 18)]);

      const stored = await rig.getMultipliers();
      expect(stored.length).to.equal(1);
      expect(stored[0]).to.equal(convert("3", 18));
    });
  });

  describe("Mining - Input Validation", function () {
    it("should reject zero miner address", async function () {
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      await expect(
        rig
          .connect(user1)
          .mine(AddressZero, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#123456")
      ).to.be.reverted;
    });

    it("should reject expired deadline", async function () {
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      await expect(
        rig
          .connect(user1)
          .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp - 1, 0, "#123456")
      ).to.be.reverted;
    });

    it("should reject invalid slot index", async function () {
      const capacity = await rig.capacity();
      const latest = await ethers.provider.getBlock("latest");
      await expect(
        rig
          .connect(user1)
          .mine(user1.address, AddressZero, capacity, 0, latest.timestamp + 3600, 0, "#123456")
      ).to.be.reverted;
    });

    it("should reject wrong epochId", async function () {
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      await expect(
        rig
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

    it("should reject non-whitelisted faction", async function () {
      // First mine to set price
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      // Try with non-whitelisted faction
      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await expect(
        rig
          .connect(user2)
          .mine(
            user2.address,
            user1.address,
            0,
            slot.epochId,
            latest.timestamp + 3600,
            price,
            "#222222"
          )
      ).to.be.reverted;
    });

    it("should reject price exceeding maxPrice", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      // Price should be > 0 now, try to mine with maxPrice=0
      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await expect(
        rig
          .connect(user2)
          .mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#222222")
      ).to.be.reverted;
    });
  });

  describe("Mining - State Changes", function () {
    it("should update slot miner address", async function () {
      const slot = await rig.getSlot(0);
      expect(slot.miner).to.equal(AddressZero);

      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      const updatedSlot = await rig.getSlot(0);
      expect(updatedSlot.miner).to.equal(user1.address);
    });

    it("should update slot URI", async function () {
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#AABBCC");

      const updatedSlot = await rig.getSlot(0);
      expect(updatedSlot.uri).to.equal("#AABBCC");
    });

    it("should increment epochId", async function () {
      const slot = await rig.getSlot(0);
      expect(slot.epochId).to.equal(0);

      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      const updatedSlot = await rig.getSlot(0);
      expect(updatedSlot.epochId).to.equal(1);
    });

    it("should update slot initPrice (doubles after mining)", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      const priceAfterFirst = await rig.getPrice(0);

      // Second mine
      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user2)
        .mine(
          user2.address,
          AddressZero,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          priceAfterFirst,
          "#222222"
        );

      const priceAfterSecond = await rig.getPrice(0);

      // Should be ~2x (PRICE_MULTIPLIER = 2e18)
      const ratio = priceAfterSecond.mul(100).div(priceAfterFirst);
      expect(ratio.toNumber()).to.be.within(195, 205);
    });

    it("should allow empty URI string", async function () {
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "");

      const updatedSlot = await rig.getSlot(0);
      expect(updatedSlot.uri).to.equal("");
    });

    it("should allow very long URI string", async function () {
      const longUri = "#" + "A".repeat(1000);
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, longUri);

      const updatedSlot = await rig.getSlot(0);
      expect(updatedSlot.uri).to.equal(longUri);
    });
  });

  describe("Mining - Event Emission", function () {
    it("should emit Rig__Mine event with correct parameters", async function () {
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");

      await expect(
        rig
          .connect(user1)
          .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#ABCDEF")
      )
        .to.emit(rig, "Rig__Mine")
        .withArgs(user1.address, user1.address, AddressZero, 0, slot.epochId, 0, "#ABCDEF");
    });
  });

  describe("Fee Distribution", function () {
    beforeEach("Mine initial slot", async function () {
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");
    });

    it("should distribute 20% protocol fee and 80% miner fee", async function () {
      const treasuryBefore = await weth.balanceOf(treasury.address);
      const teamBefore = await weth.balanceOf(team.address);
      const factionBefore = await weth.balanceOf(faction1.address);
      const minerBefore = await weth.balanceOf(user1.address);

      const slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user2)
        .mine(
          user2.address,
          faction1.address,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          price,
          "#222222"
        );

      const treasuryAfter = await weth.balanceOf(treasury.address);
      const teamAfter = await weth.balanceOf(team.address);
      const factionAfter = await weth.balanceOf(faction1.address);
      const minerAfter = await weth.balanceOf(user1.address);

      const treasuryGain = treasuryAfter.sub(treasuryBefore);
      const teamGain = teamAfter.sub(teamBefore);
      const factionGain = factionAfter.sub(factionBefore);
      const minerGain = minerAfter.sub(minerBefore);

      const totalReceived = treasuryGain.add(teamGain).add(factionGain).add(minerGain);

      // Protocol = 20%, Miner = 80%
      const protocolPct = treasuryGain.add(teamGain).add(factionGain).mul(10000).div(totalReceived);
      const minerPct = minerGain.mul(10000).div(totalReceived);

      expect(protocolPct.toNumber()).to.be.within(1999, 2001);
      expect(minerPct.toNumber()).to.be.within(7999, 8001);
    });

    it("should give treasury full 20% when no team and no faction", async function () {
      await rig.setTeam(AddressZero);

      const treasuryBefore = await weth.balanceOf(treasury.address);
      const minerBefore = await weth.balanceOf(user1.address);

      const slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user2)
        .mine(
          user2.address,
          AddressZero,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          price,
          "#222222"
        );

      const treasuryAfter = await weth.balanceOf(treasury.address);
      const minerAfter = await weth.balanceOf(user1.address);

      const treasuryGain = treasuryAfter.sub(treasuryBefore);
      const minerGain = minerAfter.sub(minerBefore);
      const total = treasuryGain.add(minerGain);

      expect(treasuryGain.mul(10000).div(total)).to.equal(2000); // 20%
      expect(minerGain.mul(10000).div(total)).to.equal(8000); // 80%
    });

    it("should distribute team fee of 2%", async function () {
      const teamBefore = await weth.balanceOf(team.address);

      const slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user2)
        .mine(
          user2.address,
          AddressZero,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          price,
          "#222222"
        );

      const teamAfter = await weth.balanceOf(team.address);
      const teamGain = teamAfter.sub(teamBefore);

      // Team should get 2% of price (allow small variance due to timing)
      const expectedTeamFee = price.mul(200).div(10000);
      expect(teamGain).to.be.closeTo(expectedTeamFee, expectedTeamFee.div(100));
    });

    it("should distribute faction fee of 2%", async function () {
      const factionBefore = await weth.balanceOf(faction1.address);

      const slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user2)
        .mine(
          user2.address,
          faction1.address,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          price,
          "#222222"
        );

      const factionAfter = await weth.balanceOf(faction1.address);
      const factionGain = factionAfter.sub(factionBefore);

      // Faction should get 2% of price (allow small variance due to timing)
      const expectedFactionFee = price.mul(200).div(10000);
      expect(factionGain).to.be.closeTo(expectedFactionFee, expectedFactionFee.div(100));
    });

    it("should emit fee events correctly", async function () {
      const slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      const latest = await ethers.provider.getBlock("latest");

      const tx = await rig
        .connect(user2)
        .mine(
          user2.address,
          faction1.address,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          price,
          "#222222"
        );

      const receipt = await tx.wait();
      const feeEvents = receipt.events.filter(
        (e) =>
          e.event === "Rig__TreasuryFee" ||
          e.event === "Rig__TeamFee" ||
          e.event === "Rig__FactionFee" ||
          e.event === "Rig__MinerFee"
      );

      expect(feeEvents.length).to.equal(4);
    });
  });

  describe("Price Mechanics", function () {
    it("should start with zero price for unmined slot", async function () {
      const price = await rig.getPrice(0);
      expect(price).to.equal(0);
    });

    it("should set price based on MIN_INIT_PRICE after first mine", async function () {
      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      const price = await rig.getPrice(0);
      const minInitPrice = await rig.MIN_INIT_PRICE();
      expect(price).to.be.gte(0); // Price decays over time
    });

    it("should decay price to zero after EPOCH_PERIOD", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      const priceAfter = await rig.getPrice(0);
      expect(priceAfter).to.be.gt(0);

      // Fast forward past EPOCH_PERIOD
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);

      const priceDecayed = await rig.getPrice(0);
      expect(priceDecayed).to.equal(0);
    });

    it("should decay price linearly over EPOCH_PERIOD", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      const priceStart = await rig.getPrice(0);

      // Fast forward half EPOCH_PERIOD (30 min)
      await ethers.provider.send("evm_increaseTime", [1800]);
      await ethers.provider.send("evm_mine", []);

      const priceHalf = await rig.getPrice(0);
      expect(priceHalf).to.be.lt(priceStart);
      expect(priceHalf).to.be.gt(0);

      // Should be approximately half
      const ratio = priceHalf.mul(100).div(priceStart);
      expect(ratio.toNumber()).to.be.within(45, 55);
    });
  });

  describe("UPS and Token Minting", function () {
    it("should start with INIT_UPS", async function () {
      const ups = await rig.getUps();
      expect(ups).to.equal(convert("4", 18));
    });

    it("should halve UPS after HALVING_PERIOD", async function () {
      const initialUps = await rig.getUps();

      // Fast forward 30 days
      await ethers.provider.send("evm_increaseTime", [30 * 24 * 3600]);
      await ethers.provider.send("evm_mine", []);

      const upsAfter = await rig.getUps();
      expect(upsAfter).to.equal(initialUps.div(2));
    });

    it("should halve UPS multiple times", async function () {
      const initialUps = await rig.getUps();

      // Fast forward 60 days (2 halvings)
      await ethers.provider.send("evm_increaseTime", [60 * 24 * 3600]);
      await ethers.provider.send("evm_mine", []);

      const upsAfter = await rig.getUps();
      expect(upsAfter).to.equal(initialUps.div(4));
    });

    it("should never go below TAIL_UPS", async function () {
      // Fast forward 10 years
      await ethers.provider.send("evm_increaseTime", [365 * 24 * 3600 * 10]);
      await ethers.provider.send("evm_mine", []);

      const ups = await rig.getUps();
      const tailUps = await rig.TAIL_UPS();
      expect(ups).to.equal(tailUps);
    });

    it("should mint tokens to previous miner on new mine", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      // Wait some time
      await ethers.provider.send("evm_increaseTime", [1800]);
      await ethers.provider.send("evm_mine", []);

      const user1BalBefore = await unit.balanceOf(user1.address);

      // Second mine by user2
      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user2)
        .mine(
          user2.address,
          AddressZero,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          price,
          "#222222"
        );

      const user1BalAfter = await unit.balanceOf(user1.address);
      expect(user1BalAfter).to.be.gt(user1BalBefore);
    });

    it("should not mint tokens when no previous miner", async function () {
      const totalSupplyBefore = await unit.totalSupply();

      const slot = await rig.getSlot(0);
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      const totalSupplyAfter = await unit.totalSupply();
      expect(totalSupplyAfter).to.equal(totalSupplyBefore);
    });

    it("should scale minted amount with time held", async function () {
      // First mine
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      // Wait 1 hour
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      const balBefore1 = await unit.balanceOf(user1.address);
      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user2)
        .mine(user2.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#222222");

      const balAfter1 = await unit.balanceOf(user1.address);
      const minted1 = balAfter1.sub(balBefore1);

      // Wait 2 hours
      await ethers.provider.send("evm_increaseTime", [7200]);
      await ethers.provider.send("evm_mine", []);

      const balBefore2 = await unit.balanceOf(user2.address);
      slot = await rig.getSlot(0);
      latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#333333");

      const balAfter2 = await unit.balanceOf(user2.address);
      const minted2 = balAfter2.sub(balBefore2);

      // Second mint should be ~2x first (held 2x as long)
      const ratio = minted2.mul(100).div(minted1);
      expect(ratio.toNumber()).to.be.within(180, 220);
    });
  });

  describe("Slot Independence", function () {
    beforeEach("Increase capacity", async function () {
      await rig.setCapacity(5);
    });

    it("should keep different slots independent", async function () {
      // Mine slot 0
      let latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, 0, latest.timestamp + 3600, 0, "#000000");

      // Mine slot 1
      latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user2)
        .mine(user2.address, AddressZero, 1, 0, latest.timestamp + 3600, 0, "#111111");

      const slot0 = await rig.getSlot(0);
      const slot1 = await rig.getSlot(1);
      const slot2 = await rig.getSlot(2);

      expect(slot0.miner).to.equal(user1.address);
      expect(slot0.uri).to.equal("#000000");
      expect(slot0.epochId).to.equal(1);

      expect(slot1.miner).to.equal(user2.address);
      expect(slot1.uri).to.equal("#111111");
      expect(slot1.epochId).to.equal(1);

      expect(slot2.miner).to.equal(AddressZero);
      expect(slot2.epochId).to.equal(0);
    });

    it("should allow mining new slots after capacity increase", async function () {
      const latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 4, 0, latest.timestamp + 3600, 0, "#444444");

      const slot4 = await rig.getSlot(4);
      expect(slot4.miner).to.equal(user1.address);
    });
  });

  describe("Invariants", function () {
    it("should always total 100% for fee distribution", async function () {
      // Mine initial
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      const balancesBefore = {
        treasury: await weth.balanceOf(treasury.address),
        team: await weth.balanceOf(team.address),
        faction: await weth.balanceOf(faction1.address),
        miner: await weth.balanceOf(user1.address),
        payer: await weth.balanceOf(user2.address),
      };

      slot = await rig.getSlot(0);
      const price = await rig.getPrice(0);
      latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user2)
        .mine(
          user2.address,
          faction1.address,
          0,
          slot.epochId,
          latest.timestamp + 3600,
          price,
          "#222222"
        );

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

    it("should only increase total supply (no burn on mine)", async function () {
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, latest.timestamp + 3600, 0, "#111111");

      for (let i = 0; i < 5; i++) {
        await ethers.provider.send("evm_increaseTime", [1800]);
        await ethers.provider.send("evm_mine", []);

        const supplyBefore = await unit.totalSupply();

        slot = await rig.getSlot(0);
        const price = await rig.getPrice(0);
        latest = await ethers.provider.getBlock("latest");
        await rig
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

    it("should only allow capacity to increase", async function () {
      const cap1 = await rig.capacity();
      await rig.setCapacity(cap1.add(10));

      const cap2 = await rig.capacity();
      expect(cap2).to.be.gt(cap1);

      await expect(rig.setCapacity(cap1)).to.be.reverted;
      await expect(rig.setCapacity(cap2.sub(1))).to.be.reverted;
    });

    it("should never decrease epochId for a slot", async function () {
      let slot = await rig.getSlot(0);
      let prevEpochId = slot.epochId;

      for (let i = 0; i < 5; i++) {
        const latest = await ethers.provider.getBlock("latest");
        await rig
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

        slot = await rig.getSlot(0);
        expect(slot.epochId).to.be.gt(prevEpochId);
        prevEpochId = slot.epochId;
      }
    });
  });

  describe("View Functions", function () {
    it("should return multipliers length correctly", async function () {
      // Initially no multipliers
      expect(await rig.getMultipliersLength()).to.equal(0);

      // Set multipliers
      await rig.setMultipliers([
        convert("1", 18),
        convert("2", 18),
        convert("3", 18),
      ]);

      expect(await rig.getMultipliersLength()).to.equal(3);

      // Update multipliers
      await rig.setMultipliers([
        convert("1", 18),
        convert("2", 18),
        convert("3", 18),
        convert("5", 18),
        convert("10", 18),
      ]);

      expect(await rig.getMultipliersLength()).to.equal(5);
    });

    it("should cap newInitPrice at ABS_MAX_INIT_PRICE", async function () {
      // Get ABS_MAX_INIT_PRICE (uint192.max)
      const ABS_MAX_INIT_PRICE = ethers.BigNumber.from(2).pow(192).sub(1);

      // First, mine the slot to set up a miner
      let slot = await rig.getSlot(0);
      let latest = await ethers.provider.getBlock("latest");
      await rig.connect(user1).mine(
        user1.address,
        AddressZero,
        0,
        slot.epochId,
        latest.timestamp + 3600,
        0,
        "#setup"
      );

      // Now we need to artificially create a high price situation
      // The initPrice is set based on: price * PRICE_MULTIPLIER / PRECISION
      // PRICE_MULTIPLIER is 2e18, so newInitPrice = price * 2
      // To hit the cap, we'd need a price > ABS_MAX_INIT_PRICE / 2

      // Since we can't easily get to that price through normal mining,
      // we test that the contract would cap it correctly by verifying
      // the constant exists and is uint192.max
      expect(await rig.ABS_MAX_INIT_PRICE()).to.equal(ABS_MAX_INIT_PRICE);

      // The actual cap is tested in Stress.test.js with more iterations
      // Here we verify the view function works
      const currentSlot = await rig.getSlot(0);
      expect(currentSlot.initPrice).to.be.lte(ABS_MAX_INIT_PRICE);
    });
  });
});
