const { expect } = require("chai");
const { ethers } = require("hardhat");

const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const divDec = (amount, decimals = 18) => amount / 10 ** decimals;
const AddressZero = "0x0000000000000000000000000000000000000000";

describe("Unit Token Contract", function () {
  let owner, rig, newRig, user1, user2;
  let unit;

  beforeEach("Deploy fresh Unit contract", async function () {
    [owner, rig, newRig, user1, user2] = await ethers.getSigners();

    const unitArtifact = await ethers.getContractFactory("Unit");
    unit = await unitArtifact.deploy("FarPlace", "FARP");
  });

  describe("Deployment", function () {
    it("should set correct name and symbol", async function () {
      expect(await unit.name()).to.equal("FarPlace");
      expect(await unit.symbol()).to.equal("FARP");
    });

    it("should set deployer as initial rig", async function () {
      expect(await unit.rig()).to.equal(owner.address);
    });

    it("should have zero initial supply", async function () {
      expect(await unit.totalSupply()).to.equal(0);
    });

    it("should support ERC20Votes interface", async function () {
      // Check that voting functions exist
      expect(await unit.delegates(owner.address)).to.equal(AddressZero);
      expect(await unit.getVotes(owner.address)).to.equal(0);
    });
  });

  describe("setRig - Minting Rights Transfer", function () {
    it("should allow current rig to transfer minting rights", async function () {
      await unit.setRig(newRig.address);
      expect(await unit.rig()).to.equal(newRig.address);
    });

    it("should emit Unit__RigSet event on transfer", async function () {
      await expect(unit.setRig(newRig.address))
        .to.emit(unit, "Unit__RigSet")
        .withArgs(newRig.address);
    });

    it("should reject setRig from non-rig address", async function () {
      await expect(unit.connect(user1).setRig(newRig.address)).to.be.reverted;
    });

    it("should reject setting rig to zero address", async function () {
      await expect(unit.setRig(AddressZero)).to.be.reverted;
    });

    it("should allow new rig to transfer rights again", async function () {
      await unit.setRig(newRig.address);
      await unit.connect(newRig).setRig(user1.address);
      expect(await unit.rig()).to.equal(user1.address);
    });

    it("should prevent old rig from transferring after transfer", async function () {
      await unit.setRig(newRig.address);
      await expect(unit.setRig(user1.address)).to.be.reverted;
    });
  });

  describe("Minting", function () {
    it("should allow rig to mint tokens", async function () {
      await unit.mint(user1.address, convert("1000", 18));
      expect(await unit.balanceOf(user1.address)).to.equal(convert("1000", 18));
    });

    it("should increase total supply on mint", async function () {
      await unit.mint(user1.address, convert("1000", 18));
      expect(await unit.totalSupply()).to.equal(convert("1000", 18));
    });

    it("should reject mint from non-rig address", async function () {
      await expect(
        unit.connect(user1).mint(user1.address, convert("1000", 18))
      ).to.be.reverted;
    });

    it("should allow minting to multiple addresses", async function () {
      await unit.mint(user1.address, convert("500", 18));
      await unit.mint(user2.address, convert("300", 18));
      expect(await unit.balanceOf(user1.address)).to.equal(convert("500", 18));
      expect(await unit.balanceOf(user2.address)).to.equal(convert("300", 18));
      expect(await unit.totalSupply()).to.equal(convert("800", 18));
    });

    it("should allow minting zero tokens", async function () {
      await unit.mint(user1.address, 0);
      expect(await unit.balanceOf(user1.address)).to.equal(0);
    });

    it("should allow new rig to mint after transfer", async function () {
      await unit.setRig(newRig.address);
      await unit.connect(newRig).mint(user1.address, convert("1000", 18));
      expect(await unit.balanceOf(user1.address)).to.equal(convert("1000", 18));
    });

    it("should prevent old rig from minting after transfer", async function () {
      await unit.setRig(newRig.address);
      await expect(unit.mint(user1.address, convert("1000", 18))).to.be.reverted;
    });
  });

  describe("Burning", function () {
    beforeEach("Mint tokens to user", async function () {
      await unit.mint(user1.address, convert("1000", 18));
    });

    it("should allow token holder to burn their tokens", async function () {
      await unit.connect(user1).burn(convert("500", 18));
      expect(await unit.balanceOf(user1.address)).to.equal(convert("500", 18));
    });

    it("should decrease total supply on burn", async function () {
      await unit.connect(user1).burn(convert("500", 18));
      expect(await unit.totalSupply()).to.equal(convert("500", 18));
    });

    it("should allow burning entire balance", async function () {
      await unit.connect(user1).burn(convert("1000", 18));
      expect(await unit.balanceOf(user1.address)).to.equal(0);
      expect(await unit.totalSupply()).to.equal(0);
    });

    it("should revert when burning more than balance", async function () {
      await expect(unit.connect(user1).burn(convert("1001", 18))).to.be.reverted;
    });

    it("should allow anyone to burn their own tokens", async function () {
      await unit.mint(user2.address, convert("500", 18));
      await unit.connect(user2).burn(convert("200", 18));
      expect(await unit.balanceOf(user2.address)).to.equal(convert("300", 18));
    });
  });

  describe("ERC20 Standard Functions", function () {
    beforeEach("Mint tokens", async function () {
      await unit.mint(user1.address, convert("1000", 18));
    });

    it("should allow transfers between accounts", async function () {
      await unit.connect(user1).transfer(user2.address, convert("100", 18));
      expect(await unit.balanceOf(user1.address)).to.equal(convert("900", 18));
      expect(await unit.balanceOf(user2.address)).to.equal(convert("100", 18));
    });

    it("should allow approval and transferFrom", async function () {
      await unit.connect(user1).approve(user2.address, convert("500", 18));
      expect(await unit.allowance(user1.address, user2.address)).to.equal(convert("500", 18));

      await unit.connect(user2).transferFrom(user1.address, user2.address, convert("300", 18));
      expect(await unit.balanceOf(user1.address)).to.equal(convert("700", 18));
      expect(await unit.balanceOf(user2.address)).to.equal(convert("300", 18));
    });

    it("should emit Transfer event on transfer", async function () {
      await expect(unit.connect(user1).transfer(user2.address, convert("100", 18)))
        .to.emit(unit, "Transfer")
        .withArgs(user1.address, user2.address, convert("100", 18));
    });

    it("should emit Approval event on approve", async function () {
      await expect(unit.connect(user1).approve(user2.address, convert("500", 18)))
        .to.emit(unit, "Approval")
        .withArgs(user1.address, user2.address, convert("500", 18));
    });
  });

  describe("ERC20Votes Functions", function () {
    beforeEach("Mint tokens", async function () {
      await unit.mint(user1.address, convert("1000", 18));
    });

    it("should allow self-delegation", async function () {
      await unit.connect(user1).delegate(user1.address);
      expect(await unit.delegates(user1.address)).to.equal(user1.address);
      expect(await unit.getVotes(user1.address)).to.equal(convert("1000", 18));
    });

    it("should allow delegation to another address", async function () {
      await unit.connect(user1).delegate(user2.address);
      expect(await unit.delegates(user1.address)).to.equal(user2.address);
      expect(await unit.getVotes(user2.address)).to.equal(convert("1000", 18));
      expect(await unit.getVotes(user1.address)).to.equal(0);
    });

    it("should update votes after transfer when delegated", async function () {
      await unit.connect(user1).delegate(user1.address);
      await unit.mint(user2.address, convert("500", 18));
      await unit.connect(user2).delegate(user2.address);

      expect(await unit.getVotes(user1.address)).to.equal(convert("1000", 18));
      expect(await unit.getVotes(user2.address)).to.equal(convert("500", 18));

      await unit.connect(user1).transfer(user2.address, convert("400", 18));

      expect(await unit.getVotes(user1.address)).to.equal(convert("600", 18));
      expect(await unit.getVotes(user2.address)).to.equal(convert("900", 18));
    });

    it("should emit DelegateChanged event", async function () {
      await expect(unit.connect(user1).delegate(user2.address))
        .to.emit(unit, "DelegateChanged")
        .withArgs(user1.address, AddressZero, user2.address);
    });
  });

  describe("ERC20Permit Functions", function () {
    it("should have correct DOMAIN_SEPARATOR", async function () {
      const domainSeparator = await unit.DOMAIN_SEPARATOR();
      expect(domainSeparator).to.not.equal(ethers.constants.HashZero);
    });

    it("should start with nonce 0 for all accounts", async function () {
      expect(await unit.nonces(user1.address)).to.equal(0);
      expect(await unit.nonces(user2.address)).to.equal(0);
    });
  });
});
