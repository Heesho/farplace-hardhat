const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const divDec = (amount, decimals = 18) => amount / 10 ** decimals;
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const AddressZero = "0x0000000000000000000000000000000000000000";

let owner, multisig, treasury, team, user0, user1, faction0, faction1, entropyProvider;
let weth, unit, rig, entropy;

describe("local: test1 - Fee Distribution Tests", function () {
  before("Initial set up", async function () {
    console.log("Begin Initialization");

    [owner, multisig, treasury, team, user0, user1, faction0, faction1, entropyProvider] =
      await ethers.getSigners();

    const wethArtifact = await ethers.getContractFactory("Base");
    weth = await wethArtifact.deploy();
    console.log("- WETH Initialized");

    const entropyArtifact = await ethers.getContractFactory("TestMockEntropy");
    entropy = await entropyArtifact.deploy(entropyProvider.address);
    console.log("- Entropy Initialized");

    const rigArtifact = await ethers.getContractFactory("Rig");
    rig = await rigArtifact.deploy(
      weth.address,
      entropy.address,
      treasury.address
    );
    await rig.setTeam(team.address);
    console.log("- Rig Initialized");

    unit = await ethers.getContractAt("contracts/Rig.sol:Unit", await rig.unit());
    console.log("- Unit Initialized");

    await rig.transferOwnership(multisig.address);
    console.log("- Ownership transferred to multisig");

    await rig.connect(multisig).setFaction(faction0.address, true);
    await rig.connect(multisig).setFaction(faction1.address, true);
    console.log("- Factions whitelisted");

    // Give users some WETH
    await weth.connect(user0).deposit({ value: convert("100", 18) });
    await weth.connect(user1).deposit({ value: convert("100", 18) });
    await weth.connect(user0).approve(rig.address, convert("100", 18));
    await weth.connect(user1).approve(rig.address, convert("100", 18));
    console.log("- Users funded with WETH");

    console.log("Initialization Complete\n");
  });

  it("Should verify fee constants", async function () {
    console.log("******************************************************");
    const totalFee = await rig.TOTAL_FEE();
    const teamFee = await rig.TEAM_FEE();
    const factionFee = await rig.FACTION_FEE();
    const divisor = await rig.DIVISOR();

    expect(totalFee).to.equal(2000); // 20%
    expect(teamFee).to.equal(200); // 2%
    expect(factionFee).to.equal(200); // 2%
    expect(divisor).to.equal(10000);

    console.log("- TOTAL_FEE:", totalFee.toString(), "(20%)");
    console.log("- TEAM_FEE:", teamFee.toString(), "(2%)");
    console.log("- FACTION_FEE:", factionFee.toString(), "(2%)");
  });

  it("User0 mines slot 0 to set initial price", async function () {
    console.log("******************************************************");
    const slot = await rig.getSlot(0);
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest.timestamp + 3600;

    await rig
      .connect(user0)
      .mine(user0.address, AddressZero, 0, slot.epochId, deadline, 0, "#AABBCC");

    console.log("- User0 mined slot 0 (free, no previous miner)");
  });

  it("Should distribute fees correctly with team AND faction", async function () {
    console.log("******************************************************");

    // Wait some time so price decays
    await ethers.provider.send("evm_increaseTime", [1800]); // 30 min
    await ethers.provider.send("evm_mine", []);

    const treasuryBalBefore = await weth.balanceOf(treasury.address);
    const teamBalBefore = await weth.balanceOf(team.address);
    const factionBalBefore = await weth.balanceOf(faction0.address);
    const minerBalBefore = await weth.balanceOf(user0.address);

    const slot = await rig.getSlot(0);
    const price = await rig.getPrice(0);
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest.timestamp + 3600;

    console.log("- Price:", divDec(price), "WETH");

    // User1 mines with faction0
    await rig
      .connect(user1)
      .mine(user1.address, faction0.address, 0, slot.epochId, deadline, price, "#112233");

    const treasuryBalAfter = await weth.balanceOf(treasury.address);
    const teamBalAfter = await weth.balanceOf(team.address);
    const factionBalAfter = await weth.balanceOf(faction0.address);
    const minerBalAfter = await weth.balanceOf(user0.address);

    const treasuryReceived = treasuryBalAfter.sub(treasuryBalBefore);
    const teamReceived = teamBalAfter.sub(teamBalBefore);
    const factionReceived = factionBalAfter.sub(factionBalBefore);
    const minerReceived = minerBalAfter.sub(minerBalBefore);

    const totalReceived = treasuryReceived.add(teamReceived).add(factionReceived).add(minerReceived);

    console.log("- Treasury received:", divDec(treasuryReceived), "(expected 16%)");
    console.log("- Team received:", divDec(teamReceived), "(expected 2%)");
    console.log("- Faction received:", divDec(factionReceived), "(expected 2%)");
    console.log("- Miner received:", divDec(minerReceived), "(expected 80%)");

    // Verify relative percentages (treasury + team + faction = 20%, miner = 80%)
    // Allow for rounding (1999-2001 for 20%, 7999-8001 for 80%)
    const protocolFees = treasuryReceived.add(teamReceived).add(factionReceived);
    const protocolPct = protocolFees.mul(10000).div(totalReceived).toNumber();
    const minerPct = minerReceived.mul(10000).div(totalReceived).toNumber();
    expect(protocolPct).to.be.within(1999, 2001); // ~20%
    expect(minerPct).to.be.within(7999, 8001); // ~80%

    // Verify team and faction are equal (both 2%)
    expect(teamReceived).to.equal(factionReceived);

    console.log("- All fee distributions verified!");
  });

  it("Should distribute fees correctly with team but NO faction", async function () {
    console.log("******************************************************");

    await ethers.provider.send("evm_increaseTime", [1800]);
    await ethers.provider.send("evm_mine", []);

    const treasuryBalBefore = await weth.balanceOf(treasury.address);
    const teamBalBefore = await weth.balanceOf(team.address);
    const minerBalBefore = await weth.balanceOf(user1.address);

    const slot = await rig.getSlot(0);
    const price = await rig.getPrice(0);
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest.timestamp + 3600;

    console.log("- Price:", divDec(price), "WETH");

    // Mine without faction (AddressZero)
    await rig
      .connect(user0)
      .mine(user0.address, AddressZero, 0, slot.epochId, deadline, price, "#AABBCC");

    const treasuryBalAfter = await weth.balanceOf(treasury.address);
    const teamBalAfter = await weth.balanceOf(team.address);
    const minerBalAfter = await weth.balanceOf(user1.address);

    const treasuryReceived = treasuryBalAfter.sub(treasuryBalBefore);
    const teamReceived = teamBalAfter.sub(teamBalBefore);
    const minerReceived = minerBalAfter.sub(minerBalBefore);

    const totalReceived = treasuryReceived.add(teamReceived).add(minerReceived);

    console.log("- Treasury received:", divDec(treasuryReceived), "(expected 18%)");
    console.log("- Team received:", divDec(teamReceived), "(expected 2%)");
    console.log("- Miner received:", divDec(minerReceived), "(expected 80%)");

    // Treasury should get 18% (20% total - 2% team)
    // Allow for rounding
    const protocolFees = treasuryReceived.add(teamReceived);
    const protocolPct = protocolFees.mul(10000).div(totalReceived).toNumber();
    const teamPct = teamReceived.mul(10000).div(totalReceived).toNumber();
    expect(protocolPct).to.be.within(1999, 2001); // ~20%
    expect(teamPct).to.be.within(199, 201); // ~2%

    console.log("- Fee distribution verified (no faction)!");
  });

  it("Should allow setting team to zero address", async function () {
    console.log("******************************************************");

    await rig.connect(multisig).setTeam(AddressZero);
    const teamAddr = await rig.team();
    expect(teamAddr).to.equal(AddressZero);

    console.log("- Team set to zero address");
  });

  it("Should distribute fees correctly with NO team and NO faction (20% to treasury)", async function () {
    console.log("******************************************************");

    await ethers.provider.send("evm_increaseTime", [1800]);
    await ethers.provider.send("evm_mine", []);

    const treasuryBalBefore = await weth.balanceOf(treasury.address);
    const minerBalBefore = await weth.balanceOf(user0.address);

    const slot = await rig.getSlot(0);
    const price = await rig.getPrice(0);
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest.timestamp + 3600;

    console.log("- Price:", divDec(price), "WETH");

    // Mine without faction, team is zero
    await rig
      .connect(user1)
      .mine(user1.address, AddressZero, 0, slot.epochId, deadline, price, "#DDEEFF");

    const treasuryBalAfter = await weth.balanceOf(treasury.address);
    const minerBalAfter = await weth.balanceOf(user0.address);

    const treasuryReceived = treasuryBalAfter.sub(treasuryBalBefore);
    const minerReceived = minerBalAfter.sub(minerBalBefore);

    const totalReceived = treasuryReceived.add(minerReceived);

    console.log("- Treasury received:", divDec(treasuryReceived), "(expected 20%)");
    console.log("- Miner received:", divDec(minerReceived), "(expected 80%)");

    // Treasury should get full 20%
    expect(treasuryReceived.mul(10000).div(totalReceived)).to.equal(2000); // 20%
    expect(minerReceived.mul(10000).div(totalReceived)).to.equal(8000); // 80%

    console.log("- Fee distribution verified (20% treasury, 80% miner)!");
  });

  it("Should distribute fees correctly with faction but NO team", async function () {
    console.log("******************************************************");

    await ethers.provider.send("evm_increaseTime", [1800]);
    await ethers.provider.send("evm_mine", []);

    const treasuryBalBefore = await weth.balanceOf(treasury.address);
    const factionBalBefore = await weth.balanceOf(faction1.address);
    const minerBalBefore = await weth.balanceOf(user1.address);

    const slot = await rig.getSlot(0);
    const price = await rig.getPrice(0);
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest.timestamp + 3600;

    console.log("- Price:", divDec(price), "WETH");

    // Mine with faction1, team is still zero
    await rig
      .connect(user0)
      .mine(user0.address, faction1.address, 0, slot.epochId, deadline, price, "#123456");

    const treasuryBalAfter = await weth.balanceOf(treasury.address);
    const factionBalAfter = await weth.balanceOf(faction1.address);
    const minerBalAfter = await weth.balanceOf(user1.address);

    const treasuryReceived = treasuryBalAfter.sub(treasuryBalBefore);
    const factionReceived = factionBalAfter.sub(factionBalBefore);
    const minerReceived = minerBalAfter.sub(minerBalBefore);

    const totalReceived = treasuryReceived.add(factionReceived).add(minerReceived);

    console.log("- Treasury received:", divDec(treasuryReceived), "(expected 18%)");
    console.log("- Faction received:", divDec(factionReceived), "(expected 2%)");
    console.log("- Miner received:", divDec(minerReceived), "(expected 80%)");

    // Treasury should get 18% (20% - 2% faction)
    // Allow for rounding
    const protocolFees = treasuryReceived.add(factionReceived);
    const protocolPct = protocolFees.mul(10000).div(totalReceived).toNumber();
    const factionPct = factionReceived.mul(10000).div(totalReceived).toNumber();
    expect(protocolPct).to.be.within(1999, 2001); // ~20%
    expect(factionPct).to.be.within(199, 201); // ~2%

    console.log("- Fee distribution verified (no team, with faction)!");
  });

  it("Should restore team address", async function () {
    console.log("******************************************************");

    await rig.connect(multisig).setTeam(team.address);
    const teamAddr = await rig.team();
    expect(teamAddr).to.equal(team.address);

    console.log("- Team restored to:", team.address);
  });

  it("Should reject non-whitelisted faction", async function () {
    console.log("******************************************************");

    await ethers.provider.send("evm_increaseTime", [1800]);
    await ethers.provider.send("evm_mine", []);

    const slot = await rig.getSlot(0);
    const price = await rig.getPrice(0);
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest.timestamp + 3600;

    // Try to use a non-whitelisted address as faction
    await expect(
      rig
        .connect(user1)
        .mine(user1.address, user0.address, 0, slot.epochId, deadline, price, "#ABCDEF")
    ).to.be.reverted;

    console.log("- Non-whitelisted faction correctly rejected!");
  });

  it("Should allow removing faction from whitelist", async function () {
    console.log("******************************************************");

    await rig.connect(multisig).setFaction(faction0.address, false);
    const isFaction = await rig.account_IsFaction(faction0.address);
    expect(isFaction).to.equal(false);

    console.log("- Faction0 removed from whitelist");

    // Now using faction0 should fail
    const slot = await rig.getSlot(0);
    const price = await rig.getPrice(0);
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest.timestamp + 3600;

    await expect(
      rig
        .connect(user0)
        .mine(user0.address, faction0.address, 0, slot.epochId, deadline, price, "#111111")
    ).to.be.reverted;

    console.log("- Removed faction correctly rejected!");

    // Re-add for future tests
    await rig.connect(multisig).setFaction(faction0.address, true);
    console.log("- Faction0 re-added to whitelist");
  });

  it("Should reject expired deadline", async function () {
    console.log("******************************************************");

    const slot = await rig.getSlot(0);
    const price = await rig.getPrice(0);
    const latest = await ethers.provider.getBlock("latest");
    const expiredDeadline = latest.timestamp - 1; // Already expired

    await expect(
      rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, expiredDeadline, price, "#222222")
    ).to.be.reverted;

    console.log("- Expired deadline correctly rejected!");
  });

  it("Should reject wrong epoch ID", async function () {
    console.log("******************************************************");

    const slot = await rig.getSlot(0);
    const price = await rig.getPrice(0);
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest.timestamp + 3600;
    const wrongEpochId = slot.epochId.add(1);

    await expect(
      rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, wrongEpochId, deadline, price, "#333333")
    ).to.be.reverted;

    console.log("- Wrong epoch ID correctly rejected!");
  });

  it("Should reject price exceeding maxPrice", async function () {
    console.log("******************************************************");

    // First mine to set a known price
    await ethers.provider.send("evm_increaseTime", [1800]);
    await ethers.provider.send("evm_mine", []);

    let slot = await rig.getSlot(0);
    let price = await rig.getPrice(0);
    let latest = await ethers.provider.getBlock("latest");
    let deadline = latest.timestamp + 3600;

    await rig
      .connect(user0)
      .mine(user0.address, AddressZero, 0, slot.epochId, deadline, price, "#444444");

    // Now immediately try with a maxPrice of 0 (price should be high right after mining)
    slot = await rig.getSlot(0);
    price = await rig.getPrice(0);
    latest = await ethers.provider.getBlock("latest");
    deadline = latest.timestamp + 3600;

    // Set maxPrice to 0, actual price should be > 0 right after mining
    await expect(
      rig
        .connect(user1)
        .mine(user1.address, AddressZero, 0, slot.epochId, deadline, 0, "#555555")
    ).to.be.reverted;

    console.log("- MaxPrice exceeded correctly rejected!");
  });

  it("Should reject invalid miner address", async function () {
    console.log("******************************************************");

    const slot = await rig.getSlot(0);
    const price = await rig.getPrice(0);
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest.timestamp + 3600;

    await expect(
      rig
        .connect(user1)
        .mine(AddressZero, AddressZero, 0, slot.epochId, deadline, price, "#555555")
    ).to.be.reverted;

    console.log("- Invalid miner address correctly rejected!");
  });

  it("Should reject invalid index", async function () {
    console.log("******************************************************");

    const capacity = await rig.capacity();
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest.timestamp + 3600;

    await expect(
      rig.connect(user1).mine(user1.address, AddressZero, capacity, 0, deadline, 0, "#666666")
    ).to.be.reverted;

    console.log("- Invalid index correctly rejected!");
  });

  it("Should verify capacity management", async function () {
    console.log("******************************************************");

    const currentCapacity = await rig.capacity();
    console.log("- Current capacity:", currentCapacity.toString());

    // Should reject capacity <= current
    await expect(rig.connect(multisig).setCapacity(currentCapacity)).to.be.reverted;
    console.log("- Capacity <= current correctly rejected");

    // Should reject capacity > MAX_CAPACITY
    const maxCapacity = await rig.MAX_CAPACITY();
    await expect(rig.connect(multisig).setCapacity(maxCapacity.add(1))).to.be.reverted;
    console.log("- Capacity > MAX_CAPACITY correctly rejected");

    // Should allow increasing capacity
    await rig.connect(multisig).setCapacity(currentCapacity.add(5));
    const newCapacity = await rig.capacity();
    expect(newCapacity).to.equal(currentCapacity.add(5));

    console.log("- Capacity increased to:", newCapacity.toString());
  });

  it("Should verify multiplier constraints", async function () {
    console.log("******************************************************");

    // Should reject empty multipliers array
    await expect(rig.connect(multisig).setMultipliers([])).to.be.reverted;
    console.log("- Empty multipliers array correctly rejected");

    // Should reject multipliers below DEFAULT_MULTIPLIER (1e18)
    const invalidMultipliers = [convert("0.5", 18)];
    await expect(rig.connect(multisig).setMultipliers(invalidMultipliers)).to.be.reverted;
    console.log("- Multipliers below 1x correctly rejected");

    // Should allow valid multipliers
    const validMultipliers = [convert("1.0", 18), convert("2.0", 18), convert("5.0", 18)];
    await rig.connect(multisig).setMultipliers(validMultipliers);
    const multipliers = await rig.getMultipliers();
    expect(multipliers.length).to.equal(3);

    console.log("- Valid multipliers set:", multipliers.length, "values");
  });

  it("Should verify treasury cannot be set to zero", async function () {
    console.log("******************************************************");

    await expect(rig.connect(multisig).setTreasury(AddressZero)).to.be.reverted;

    console.log("- Treasury zero address correctly rejected");
  });

  it("Should verify faction zero address cannot be whitelisted", async function () {
    console.log("******************************************************");

    await expect(rig.connect(multisig).setFaction(AddressZero, true)).to.be.reverted;

    console.log("- Faction zero address correctly rejected");
  });

  it("Should verify only owner can call admin functions", async function () {
    console.log("******************************************************");

    await expect(rig.connect(user0).setTreasury(user0.address)).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
    console.log("- setTreasury: non-owner rejected");

    await expect(rig.connect(user0).setTeam(user0.address)).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
    console.log("- setTeam: non-owner rejected");

    await expect(rig.connect(user0).setFaction(user0.address, true)).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
    console.log("- setFaction: non-owner rejected");

    await expect(rig.connect(user0).setCapacity(100)).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
    console.log("- setCapacity: non-owner rejected");

    await expect(rig.connect(user0).setMultipliers([convert("1.0", 18)])).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
    console.log("- setMultipliers: non-owner rejected");
  });

  it("Should mine multiple slots after capacity increase", async function () {
    console.log("******************************************************");

    const capacity = await rig.capacity();
    console.log("- Current capacity:", capacity.toString());

    // Mine a few different slots
    for (let i = 0; i < Math.min(3, capacity.toNumber()); i++) {
      await ethers.provider.send("evm_increaseTime", [600]); // 10 min
      await ethers.provider.send("evm_mine", []);

      const slot = await rig.getSlot(i);
      const price = await rig.getPrice(i);
      const latest = await ethers.provider.getBlock("latest");
      const deadline = latest.timestamp + 3600;

      const uri = "#" + (i * 111111).toString(16).padStart(6, "0");
      await rig.connect(user0).mine(user0.address, AddressZero, i, slot.epochId, deadline, price, uri);

      console.log(`- Mined slot ${i} at price ${divDec(price)} WETH`);
    }
  });

  it("Should verify UPS emission and token minting", async function () {
    console.log("******************************************************");

    const unitBalanceBefore = await unit.balanceOf(user0.address);
    console.log("- User0 UNIT balance before:", divDec(unitBalanceBefore));

    // Wait for some time to accrue UPS
    await ethers.provider.send("evm_increaseTime", [3600]); // 1 hour
    await ethers.provider.send("evm_mine", []);

    // Mine to trigger minting
    const slot = await rig.getSlot(0);
    const price = await rig.getPrice(0);
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest.timestamp + 3600;

    await rig
      .connect(user1)
      .mine(user1.address, AddressZero, 0, slot.epochId, deadline, price, "#FFFFFF");

    const unitBalanceAfter = await unit.balanceOf(user0.address);
    console.log("- User0 UNIT balance after:", divDec(unitBalanceAfter));

    // User0 should have received UNIT tokens (they were the previous miner)
    expect(unitBalanceAfter).to.be.gt(unitBalanceBefore);
    console.log("- UNIT tokens minted to previous miner!");
  });

  it("Should verify epoch period and price decay", async function () {
    console.log("******************************************************");

    // Get current price
    const priceBefore = await rig.getPrice(0);
    console.log("- Price before:", divDec(priceBefore), "WETH");

    // Wait for half an epoch
    const epochPeriod = await rig.EPOCH_PERIOD();
    await ethers.provider.send("evm_increaseTime", [epochPeriod.div(2).toNumber()]);
    await ethers.provider.send("evm_mine", []);

    // Price should have decayed
    const priceAfter = await rig.getPrice(0);
    console.log("- Price after 30 min:", divDec(priceAfter), "WETH");

    expect(priceAfter).to.be.lt(priceBefore);
    console.log("- Price correctly decayed over time!");
  });

  it("Should verify price doubles after mining", async function () {
    console.log("******************************************************");

    // First mine to get a fresh price that we know
    let slot = await rig.getSlot(0);
    let price = await rig.getPrice(0);
    let latest = await ethers.provider.getBlock("latest");
    let deadline = latest.timestamp + 3600;

    await rig
      .connect(user1)
      .mine(user1.address, AddressZero, 0, slot.epochId, deadline, price, "#123ABC");

    // Now read the price immediately after mining (should be at init price)
    const priceBefore = await rig.getPrice(0);
    console.log("- Price right after mining:", divDec(priceBefore), "WETH");

    // Mine again immediately
    slot = await rig.getSlot(0);
    latest = await ethers.provider.getBlock("latest");
    deadline = latest.timestamp + 3600;

    await rig
      .connect(user0)
      .mine(user0.address, AddressZero, 0, slot.epochId, deadline, priceBefore, "#ABCDEF");

    // Get new price immediately after mining
    const priceAfter = await rig.getPrice(0);
    console.log("- Price after second mining:", divDec(priceAfter), "WETH");

    // New init price should be ~2x the old price (PRICE_MULTIPLIER = 2e18)
    const priceMultiplier = await rig.PRICE_MULTIPLIER();
    const expectedPrice = priceBefore.mul(priceMultiplier).div(convert("1", 18));

    // Allow for small time decay since we just mined
    expect(priceAfter).to.be.closeTo(expectedPrice, expectedPrice.div(10)); // Within 10%
    console.log("- Price correctly doubled after mining!");
  });
});
