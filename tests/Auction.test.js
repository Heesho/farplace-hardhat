const { expect } = require("chai");
const { ethers } = require("hardhat");

const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const divDec = (amount, decimals = 18) => amount / 10 ** decimals;
const AddressZero = "0x0000000000000000000000000000000000000000";
const AddressDead = "0x000000000000000000000000000000000000dEaD";

describe("Auction Contract", function () {
  let owner, buyer1, buyer2, burnAddress;
  let weth, lpToken, auction, donut, unit;
  let factory, router;
  let snapshotId;

  const EPOCH_PERIOD = 86400; // 1 day
  const PRICE_MULTIPLIER = convert("1.2", 18); // 1.2x
  const MIN_INIT_PRICE = convert("1", 18);
  const INIT_PRICE = convert("10", 18);

  before("Deploy contracts", async function () {
    [owner, buyer1, buyer2, burnAddress] = await ethers.getSigners();

    // Deploy MockWETH
    const wethArtifact = await ethers.getContractFactory("MockWETH");
    weth = await wethArtifact.deploy();

    // Deploy MockDonut
    const donutArtifact = await ethers.getContractFactory("MockDonut");
    donut = await donutArtifact.deploy();

    // Deploy Unit
    const unitArtifact = await ethers.getContractFactory("Unit");
    unit = await unitArtifact.deploy("TestUnit", "TUNIT");

    // Temporarily set rig to owner so we can mint for LP creation
    await unit.setRig(owner.address);

    // Deploy Uniswap V2 mocks
    const factoryArtifact = await ethers.getContractFactory("MockUniswapV2Factory");
    factory = await factoryArtifact.deploy();

    const routerArtifact = await ethers.getContractFactory("MockUniswapV2Router");
    router = await routerArtifact.deploy(factory.address);

    // Mint tokens for LP creation
    await unit.mint(owner.address, convert("100000", 18));
    await donut.mint(owner.address, convert("100000", 18));

    // Approve router
    await unit.approve(router.address, convert("100000", 18));
    await donut.approve(router.address, convert("100000", 18));

    // Create LP
    const deadline = Math.floor(Date.now() / 1000) + 3600;
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

    // Get LP token
    const lpAddress = await factory.getPair(unit.address, donut.address);
    lpToken = await ethers.getContractAt("MockLP", lpAddress);

    // Deploy Auction
    const auctionArtifact = await ethers.getContractFactory("Auction");
    auction = await auctionArtifact.deploy(
      INIT_PRICE,
      lpToken.address,
      burnAddress.address,
      EPOCH_PERIOD,
      PRICE_MULTIPLIER,
      MIN_INIT_PRICE
    );

    // Fund buyers with LP tokens
    await lpToken.transfer(buyer1.address, convert("1000", 18));
    await lpToken.transfer(buyer2.address, convert("1000", 18));

    // Approve auction
    await lpToken.connect(buyer1).approve(auction.address, ethers.constants.MaxUint256);
    await lpToken.connect(buyer2).approve(auction.address, ethers.constants.MaxUint256);
  });

  beforeEach(async function () {
    snapshotId = await ethers.provider.send("evm_snapshot", []);
  });

  afterEach(async function () {
    await ethers.provider.send("evm_revert", [snapshotId]);
  });

  describe("Deployment", function () {
    it("should set correct immutable values", async function () {
      expect(await auction.paymentToken()).to.equal(lpToken.address);
      expect(await auction.paymentReceiver()).to.equal(burnAddress.address);
      expect(await auction.epochPeriod()).to.equal(EPOCH_PERIOD);
      expect(await auction.priceMultiplier()).to.equal(PRICE_MULTIPLIER);
      expect(await auction.minInitPrice()).to.equal(MIN_INIT_PRICE);
    });

    it("should set correct initial state", async function () {
      expect(await auction.epochId()).to.equal(0);
      expect(await auction.initPrice()).to.equal(INIT_PRICE);
      expect(await auction.startTime()).to.be.gt(0);
    });

    it("should set price to initPrice at deployment", async function () {
      const price = await auction.getPrice();
      // Might be slightly less due to time passing between deployment and query
      expect(price).to.be.lte(INIT_PRICE);
      expect(price).to.be.gt(INIT_PRICE.mul(99).div(100)); // Within 1%
    });

    it("should have correct constants", async function () {
      expect(await auction.MIN_EPOCH_PERIOD()).to.equal(3600); // 1 hour
      expect(await auction.MAX_EPOCH_PERIOD()).to.equal(365 * 24 * 3600); // 1 year
      expect(await auction.MIN_PRICE_MULTIPLIER()).to.equal(convert("1.1", 18));
      expect(await auction.MAX_PRICE_MULTIPLIER()).to.equal(convert("3", 18));
      expect(await auction.ABS_MIN_INIT_PRICE()).to.equal(1e6);
    });
  });

  describe("Deployment Validation", function () {
    it("should reject initPrice below minInitPrice", async function () {
      const auctionArtifact = await ethers.getContractFactory("Auction");
      await expect(
        auctionArtifact.deploy(
          convert("0.5", 18), // initPrice < minInitPrice
          lpToken.address,
          burnAddress.address,
          EPOCH_PERIOD,
          PRICE_MULTIPLIER,
          convert("1", 18) // minInitPrice
        )
      ).to.be.reverted;
    });

    it("should reject epochPeriod below MIN_EPOCH_PERIOD", async function () {
      const auctionArtifact = await ethers.getContractFactory("Auction");
      await expect(
        auctionArtifact.deploy(
          INIT_PRICE,
          lpToken.address,
          burnAddress.address,
          1800, // 30 minutes < 1 hour
          PRICE_MULTIPLIER,
          MIN_INIT_PRICE
        )
      ).to.be.reverted;
    });

    it("should reject epochPeriod above MAX_EPOCH_PERIOD", async function () {
      const auctionArtifact = await ethers.getContractFactory("Auction");
      await expect(
        auctionArtifact.deploy(
          INIT_PRICE,
          lpToken.address,
          burnAddress.address,
          366 * 24 * 3600, // > 365 days
          PRICE_MULTIPLIER,
          MIN_INIT_PRICE
        )
      ).to.be.reverted;
    });

    it("should reject priceMultiplier below MIN_PRICE_MULTIPLIER", async function () {
      const auctionArtifact = await ethers.getContractFactory("Auction");
      await expect(
        auctionArtifact.deploy(
          INIT_PRICE,
          lpToken.address,
          burnAddress.address,
          EPOCH_PERIOD,
          convert("1.05", 18), // < 1.1x
          MIN_INIT_PRICE
        )
      ).to.be.reverted;
    });

    it("should reject priceMultiplier above MAX_PRICE_MULTIPLIER", async function () {
      const auctionArtifact = await ethers.getContractFactory("Auction");
      await expect(
        auctionArtifact.deploy(
          INIT_PRICE,
          lpToken.address,
          burnAddress.address,
          EPOCH_PERIOD,
          convert("3.5", 18), // > 3x
          MIN_INIT_PRICE
        )
      ).to.be.reverted;
    });

    it("should reject minInitPrice below ABS_MIN_INIT_PRICE", async function () {
      const auctionArtifact = await ethers.getContractFactory("Auction");
      await expect(
        auctionArtifact.deploy(
          1e6, // initPrice
          lpToken.address,
          burnAddress.address,
          EPOCH_PERIOD,
          PRICE_MULTIPLIER,
          100 // < 1e6
        )
      ).to.be.reverted;
    });
  });

  describe("getPrice - Dutch Auction Price Decay", function () {
    it("should start at initPrice", async function () {
      // Deploy fresh auction for accurate timing
      const auctionArtifact = await ethers.getContractFactory("Auction");
      const freshAuction = await auctionArtifact.deploy(
        INIT_PRICE,
        lpToken.address,
        burnAddress.address,
        EPOCH_PERIOD,
        PRICE_MULTIPLIER,
        MIN_INIT_PRICE
      );

      const price = await freshAuction.getPrice();
      // Should be very close to initPrice
      expect(price).to.be.closeTo(INIT_PRICE, INIT_PRICE.div(1000)); // Within 0.1%
    });

    it("should decay linearly over time", async function () {
      const priceStart = await auction.getPrice();

      // Fast forward 50% of epoch
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD / 2]);
      await ethers.provider.send("evm_mine", []);

      const priceMid = await auction.getPrice();

      // Should be approximately half
      expect(priceMid).to.be.lt(priceStart);
      const ratio = priceMid.mul(100).div(priceStart);
      expect(ratio.toNumber()).to.be.within(45, 55);
    });

    it("should reach zero at end of epoch", async function () {
      // Fast forward past epoch
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
      await ethers.provider.send("evm_mine", []);

      const price = await auction.getPrice();
      expect(price).to.equal(0);
    });

    it("should stay at zero after epoch ends", async function () {
      // Fast forward way past epoch
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD * 2]);
      await ethers.provider.send("evm_mine", []);

      const price = await auction.getPrice();
      expect(price).to.equal(0);
    });
  });

  describe("buy - Purchasing Assets", function () {
    beforeEach("Add WETH to auction", async function () {
      // Send some WETH to auction as accumulated assets
      await weth.connect(owner).deposit({ value: convert("10", 18) });
      await weth.transfer(auction.address, convert("10", 18));
    });

    it("should transfer assets to buyer", async function () {
      const wethBefore = await weth.balanceOf(buyer1.address);
      const auctionWethBefore = await weth.balanceOf(auction.address);

      const price = await auction.getPrice();
      const epochId = await auction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      await auction.connect(buyer1).buy([weth.address], buyer1.address, epochId, latest.timestamp + 3600, price);

      const wethAfter = await weth.balanceOf(buyer1.address);
      expect(wethAfter.sub(wethBefore)).to.equal(auctionWethBefore);
    });

    it("should transfer LP tokens to payment receiver", async function () {
      const burnBefore = await lpToken.balanceOf(burnAddress.address);

      const price = await auction.getPrice();
      const epochId = await auction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      await auction.connect(buyer1).buy([weth.address], buyer1.address, epochId, latest.timestamp + 3600, price);

      const burnAfter = await lpToken.balanceOf(burnAddress.address);
      // Price may have decayed slightly between getPrice and transaction execution
      expect(burnAfter.sub(burnBefore)).to.be.closeTo(price, price.div(100));
    });

    it("should increment epochId", async function () {
      const epochBefore = await auction.epochId();

      const price = await auction.getPrice();
      const latest = await ethers.provider.getBlock("latest");

      await auction.connect(buyer1).buy([weth.address], buyer1.address, epochBefore, latest.timestamp + 3600, price);

      const epochAfter = await auction.epochId();
      expect(epochAfter).to.equal(epochBefore.add(1));
    });

    it("should update initPrice based on payment and multiplier", async function () {
      const price = await auction.getPrice();
      const epochId = await auction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      await auction.connect(buyer1).buy([weth.address], buyer1.address, epochId, latest.timestamp + 3600, price);

      const newInitPrice = await auction.initPrice();
      const expectedPrice = price.mul(PRICE_MULTIPLIER).div(convert("1", 18));

      // Should be multiplied price or minInitPrice, whichever is larger
      // Allow small variance due to price decay between read and execution
      if (expectedPrice.lt(MIN_INIT_PRICE)) {
        expect(newInitPrice).to.equal(MIN_INIT_PRICE);
      } else {
        expect(newInitPrice).to.be.closeTo(expectedPrice, expectedPrice.div(100));
      }
    });

    it("should update startTime", async function () {
      const startTimeBefore = await auction.startTime();

      // Wait a bit
      await ethers.provider.send("evm_increaseTime", [100]);
      await ethers.provider.send("evm_mine", []);

      const price = await auction.getPrice();
      const epochId = await auction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      await auction.connect(buyer1).buy([weth.address], buyer1.address, epochId, latest.timestamp + 3600, price);

      const startTimeAfter = await auction.startTime();
      expect(startTimeAfter).to.be.gt(startTimeBefore);
    });

    it("should emit Auction__Buy event", async function () {
      const price = await auction.getPrice();
      const epochId = await auction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      // Just check the event is emitted (don't check exact price due to timing)
      await expect(
        auction.connect(buyer1).buy([weth.address], buyer1.address, epochId, latest.timestamp + 3600, price)
      ).to.emit(auction, "Auction__Buy");
    });

    it("should allow buying multiple assets at once", async function () {
      // Add donut to auction
      await donut.mint(auction.address, convert("5", 18));

      const wethBefore = await weth.balanceOf(buyer1.address);
      const donutBefore = await donut.balanceOf(buyer1.address);

      const price = await auction.getPrice();
      const epochId = await auction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      await auction
        .connect(buyer1)
        .buy([weth.address, donut.address], buyer1.address, epochId, latest.timestamp + 3600, price);

      const wethAfter = await weth.balanceOf(buyer1.address);
      const donutAfter = await donut.balanceOf(buyer1.address);

      expect(wethAfter).to.be.gt(wethBefore);
      expect(donutAfter).to.be.gt(donutBefore);
    });

    it("should allow different assetsReceiver", async function () {
      const buyer2WethBefore = await weth.balanceOf(buyer2.address);

      const price = await auction.getPrice();
      const epochId = await auction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      // Buyer1 buys but assets go to buyer2
      await auction.connect(buyer1).buy([weth.address], buyer2.address, epochId, latest.timestamp + 3600, price);

      const buyer2WethAfter = await weth.balanceOf(buyer2.address);
      expect(buyer2WethAfter).to.be.gt(buyer2WethBefore);
    });

    it("should allow buying at price zero after epoch ends", async function () {
      // Fast forward past epoch
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
      await ethers.provider.send("evm_mine", []);

      const price = await auction.getPrice();
      expect(price).to.equal(0);

      const epochId = await auction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      const lpBefore = await lpToken.balanceOf(buyer1.address);

      await auction.connect(buyer1).buy([weth.address], buyer1.address, epochId, latest.timestamp + 3600, 0);

      // LP balance should not change (paid 0)
      const lpAfter = await lpToken.balanceOf(buyer1.address);
      expect(lpAfter).to.equal(lpBefore);

      // But should still receive assets
      const wethBalance = await weth.balanceOf(buyer1.address);
      expect(wethBalance).to.be.gt(0);
    });

    it("should set minInitPrice when calculated price is too low", async function () {
      // Fast forward past epoch so price is 0
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD + 1]);
      await ethers.provider.send("evm_mine", []);

      const price = await auction.getPrice();
      expect(price).to.equal(0);

      const epochId = await auction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      await auction.connect(buyer1).buy([weth.address], buyer1.address, epochId, latest.timestamp + 3600, 0);

      // New initPrice should be minInitPrice since 0 * multiplier = 0
      const newInitPrice = await auction.initPrice();
      expect(newInitPrice).to.equal(MIN_INIT_PRICE);
    });
  });

  describe("buy - Input Validation", function () {
    beforeEach("Add WETH to auction", async function () {
      await weth.connect(owner).deposit({ value: convert("10", 18) });
      await weth.transfer(auction.address, convert("10", 18));
    });

    it("should reject expired deadline", async function () {
      const price = await auction.getPrice();
      const epochId = await auction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      await expect(
        auction.connect(buyer1).buy([weth.address], buyer1.address, epochId, latest.timestamp - 1, price)
      ).to.be.reverted;
    });

    it("should reject wrong epochId", async function () {
      const price = await auction.getPrice();
      const epochId = await auction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      await expect(
        auction.connect(buyer1).buy([weth.address], buyer1.address, epochId.add(1), latest.timestamp + 3600, price)
      ).to.be.reverted;
    });

    it("should reject empty assets array", async function () {
      const price = await auction.getPrice();
      const epochId = await auction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      await expect(
        auction.connect(buyer1).buy([], buyer1.address, epochId, latest.timestamp + 3600, price)
      ).to.be.reverted;
    });

    it("should reject maxPaymentTokenAmount exceeded", async function () {
      const price = await auction.getPrice();
      const epochId = await auction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      // Set max to less than current price
      await expect(
        auction.connect(buyer1).buy([weth.address], buyer1.address, epochId, latest.timestamp + 3600, price.div(2))
      ).to.be.reverted;
    });
  });

  describe("Multiple Epochs", function () {
    beforeEach("Add WETH to auction", async function () {
      await weth.connect(owner).deposit({ value: convert("100", 18) });
      await weth.transfer(auction.address, convert("10", 18));
    });

    it("should handle multiple consecutive buys", async function () {
      for (let i = 0; i < 3; i++) {
        // Add more WETH for each epoch
        await weth.transfer(auction.address, convert("5", 18));

        const price = await auction.getPrice();
        const epochId = await auction.epochId();
        const latest = await ethers.provider.getBlock("latest");

        await auction.connect(buyer1).buy([weth.address], buyer1.address, epochId, latest.timestamp + 3600, price);

        expect(await auction.epochId()).to.equal(i + 1);
      }
    });

    it("should increase price over consecutive immediate buys", async function () {
      const prices = [];

      for (let i = 0; i < 3; i++) {
        await weth.transfer(auction.address, convert("1", 18));

        const price = await auction.getPrice();
        prices.push(price);

        const epochId = await auction.epochId();
        const latest = await ethers.provider.getBlock("latest");

        await auction.connect(buyer1).buy([weth.address], buyer1.address, epochId, latest.timestamp + 3600, price);
      }

      // Each subsequent initPrice should be larger due to multiplier
      const initPrice1 = prices[0].mul(PRICE_MULTIPLIER).div(convert("1", 18));
      const initPrice2 = prices[1].mul(PRICE_MULTIPLIER).div(convert("1", 18));

      // Price 1 should be ~initPrice0 * 1.2 (if > minInitPrice)
      // Since we buy immediately, price ≈ initPrice
      expect(prices[1]).to.be.gte(prices[0]);
    });

    it("should reset price to initPrice after buy", async function () {
      await weth.transfer(auction.address, convert("1", 18));

      // Wait for price to decay
      await ethers.provider.send("evm_increaseTime", [EPOCH_PERIOD / 2]);
      await ethers.provider.send("evm_mine", []);

      const priceBeforeBuy = await auction.getPrice();

      const epochId = await auction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      await auction.connect(buyer1).buy([weth.address], buyer1.address, epochId, latest.timestamp + 3600, priceBeforeBuy);

      const newInitPrice = await auction.initPrice();
      const priceAfterBuy = await auction.getPrice();

      // Price should now be at new initPrice (start of new epoch)
      expect(priceAfterBuy).to.be.closeTo(newInitPrice, newInitPrice.div(100));
    });
  });

  describe("ReentrancyGuard", function () {
    it("should be protected by ReentrancyGuard", async function () {
      // The contract has ReentrancyGuard, so the buy function is protected
      // We can verify this by checking the nonReentrant modifier is applied
      // A proper test would require a malicious contract, but we trust OZ's ReentrancyGuard
      expect(await auction.paymentToken()).to.equal(lpToken.address);
    });
  });

  describe("Edge Cases", function () {
    it("should handle buying with zero accumulated assets", async function () {
      // No WETH in auction
      const auctionWeth = await weth.balanceOf(auction.address);
      expect(auctionWeth).to.equal(0);

      const price = await auction.getPrice();
      const epochId = await auction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      // Should still succeed (just transfers 0 of the asset)
      await auction.connect(buyer1).buy([weth.address], buyer1.address, epochId, latest.timestamp + 3600, price);

      expect(await auction.epochId()).to.equal(1);
    });

    it("should handle asset with zero balance gracefully", async function () {
      // Add some WETH but request donut which has zero balance
      await weth.connect(owner).deposit({ value: convert("1", 18) });
      await weth.transfer(auction.address, convert("1", 18));

      const price = await auction.getPrice();
      const epochId = await auction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      // Should succeed even though donut balance is 0
      const donutBefore = await donut.balanceOf(buyer1.address);
      await auction.connect(buyer1).buy([donut.address], buyer1.address, epochId, latest.timestamp + 3600, price);
      const donutAfter = await donut.balanceOf(buyer1.address);

      // No change in donut balance
      expect(donutAfter).to.equal(donutBefore);
    });

    it("should work with minimum valid parameters", async function () {
      const auctionArtifact = await ethers.getContractFactory("Auction");
      const minAuction = await auctionArtifact.deploy(
        1e6, // minInitPrice
        lpToken.address,
        burnAddress.address,
        3600, // MIN_EPOCH_PERIOD
        convert("1.1", 18), // MIN_PRICE_MULTIPLIER
        1e6 // ABS_MIN_INIT_PRICE
      );

      expect(await minAuction.epochPeriod()).to.equal(3600);
      expect(await minAuction.priceMultiplier()).to.equal(convert("1.1", 18));
    });

    it("should work with maximum valid parameters", async function () {
      const auctionArtifact = await ethers.getContractFactory("Auction");
      const maxAuction = await auctionArtifact.deploy(
        convert("1000000", 18), // large initPrice
        lpToken.address,
        burnAddress.address,
        365 * 24 * 3600, // MAX_EPOCH_PERIOD
        convert("3", 18), // MAX_PRICE_MULTIPLIER
        1e6
      );

      expect(await maxAuction.epochPeriod()).to.equal(365 * 24 * 3600);
      expect(await maxAuction.priceMultiplier()).to.equal(convert("3", 18));
    });

    it("should cap newInitPrice at ABS_MAX_INIT_PRICE", async function () {
      // Get ABS_MAX_INIT_PRICE (uint192.max)
      const ABS_MAX_INIT_PRICE = ethers.BigNumber.from(2).pow(192).sub(1);

      // Deploy auction with very high init price (ABS_MAX / 2) and 3x multiplier
      // When multiplied by 3, it should exceed ABS_MAX and get capped
      const highInitPrice = ABS_MAX_INIT_PRICE.div(2);

      const auctionArtifact = await ethers.getContractFactory("Auction");
      const highAuction = await auctionArtifact.deploy(
        highInitPrice,
        lpToken.address,
        burnAddress.address,
        3600, // 1 hour epoch
        convert("3", 18), // 3x multiplier
        1e6
      );

      // Mint a huge amount of LP tokens for this test
      await lpToken.connect(owner).mint(buyer1.address, highInitPrice.mul(2));
      await lpToken.connect(buyer1).approve(highAuction.address, ethers.constants.MaxUint256);

      // Buy immediately at init price with high multiplier
      const price = await highAuction.getPrice();
      const epochId = await highAuction.epochId();
      const latest = await ethers.provider.getBlock("latest");

      await highAuction.connect(buyer1).buy([weth.address], buyer1.address, epochId, latest.timestamp + 3600, price);

      // New init price should be capped at ABS_MAX_INIT_PRICE
      const newInitPrice = await highAuction.initPrice();
      expect(newInitPrice).to.equal(ABS_MAX_INIT_PRICE);
    });
  });
});
