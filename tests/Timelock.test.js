const { expect } = require("chai");
const { ethers } = require("hardhat");

const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const AddressZero = "0x0000000000000000000000000000000000000000";

describe("TimelockController + Unit Integration", function () {
  let owner, safeWallet, newRig, user1, executor;
  let unit, timelock;
  let snapshotId;

  const MIN_DELAY = 48 * 3600; // 48 hours in seconds

  before("Deploy contracts", async function () {
    [owner, safeWallet, newRig, user1, executor] = await ethers.getSigners();

    // Deploy Unit (owner is deployer, rig is deployer initially)
    const unitArtifact = await ethers.getContractFactory("Unit");
    unit = await unitArtifact.deploy("FarPlace", "FARP");

    // Deploy TimelockController
    // - minDelay: 48 hours
    // - proposers: [safeWallet] - only Safe can propose
    // - executors: [AddressZero] - anyone can execute after delay
    // - admin: AddressZero - no admin (trustless)
    const timelockArtifact = await ethers.getContractFactory("TimelockController");
    timelock = await timelockArtifact.deploy(
      MIN_DELAY,
      [safeWallet.address], // proposers
      [AddressZero], // executors (anyone)
      AddressZero // admin (none)
    );

    // Transfer Unit ownership to Timelock
    await unit.transferOwnership(timelock.address);
  });

  beforeEach(async function () {
    snapshotId = await ethers.provider.send("evm_snapshot", []);
  });

  afterEach(async function () {
    await ethers.provider.send("evm_revert", [snapshotId]);
  });

  describe("Setup Verification", function () {
    it("should have Timelock as Unit owner", async function () {
      expect(await unit.owner()).to.equal(timelock.address);
    });

    it("should have correct minDelay (48 hours)", async function () {
      expect(await timelock.getMinDelay()).to.equal(MIN_DELAY);
    });

    it("should have safeWallet as proposer", async function () {
      const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
      expect(await timelock.hasRole(PROPOSER_ROLE, safeWallet.address)).to.be.true;
    });

    it("should allow anyone to execute (executor role is open)", async function () {
      const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
      // AddressZero having executor role means anyone can execute
      expect(await timelock.hasRole(EXECUTOR_ROLE, AddressZero)).to.be.true;
    });

    it("should have no admin", async function () {
      const TIMELOCK_ADMIN_ROLE = await timelock.TIMELOCK_ADMIN_ROLE();
      // Timelock itself is admin initially for setup, but we passed AddressZero
      expect(await timelock.hasRole(TIMELOCK_ADMIN_ROLE, owner.address)).to.be.false;
    });
  });

  describe("Direct Access Blocked", function () {
    it("should NOT allow old owner to call setRig directly", async function () {
      await expect(unit.setRig(newRig.address)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });

    it("should NOT allow safeWallet to call setRig directly", async function () {
      await expect(unit.connect(safeWallet).setRig(newRig.address)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });

    it("should NOT allow random user to call setRig directly", async function () {
      await expect(unit.connect(user1).setRig(newRig.address)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });
  });

  describe("Timelock Flow: Schedule → Wait → Execute", function () {
    let setRigCalldata;
    let predecessor;
    let salt;

    beforeEach(async function () {
      // Prepare the setRig call
      setRigCalldata = unit.interface.encodeFunctionData("setRig", [newRig.address]);
      predecessor = ethers.constants.HashZero; // No predecessor
      salt = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("setRig-1"));
    });

    it("should allow proposer (Safe) to schedule setRig", async function () {
      await expect(
        timelock.connect(safeWallet).schedule(
          unit.address,
          0, // value
          setRigCalldata,
          predecessor,
          salt,
          MIN_DELAY
        )
      ).to.emit(timelock, "CallScheduled");
    });

    it("should NOT allow non-proposer to schedule", async function () {
      await expect(
        timelock.connect(user1).schedule(
          unit.address,
          0,
          setRigCalldata,
          predecessor,
          salt,
          MIN_DELAY
        )
      ).to.be.reverted;
    });

    it("should NOT allow execution before delay", async function () {
      // Schedule
      await timelock.connect(safeWallet).schedule(
        unit.address,
        0,
        setRigCalldata,
        predecessor,
        salt,
        MIN_DELAY
      );

      // Try to execute immediately
      await expect(
        timelock.execute(unit.address, 0, setRigCalldata, predecessor, salt)
      ).to.be.revertedWith("TimelockController: operation is not ready");
    });

    it("should allow execution after delay passes", async function () {
      // Schedule
      await timelock.connect(safeWallet).schedule(
        unit.address,
        0,
        setRigCalldata,
        predecessor,
        salt,
        MIN_DELAY
      );

      // Fast forward 48 hours
      await ethers.provider.send("evm_increaseTime", [MIN_DELAY]);
      await ethers.provider.send("evm_mine", []);

      // Execute
      await expect(
        timelock.execute(unit.address, 0, setRigCalldata, predecessor, salt)
      ).to.emit(timelock, "CallExecuted");

      // Verify rig was updated
      expect(await unit.rig()).to.equal(newRig.address);
    });

    it("should allow anyone to execute after delay (not just proposer)", async function () {
      // Schedule by Safe
      await timelock.connect(safeWallet).schedule(
        unit.address,
        0,
        setRigCalldata,
        predecessor,
        salt,
        MIN_DELAY
      );

      // Fast forward
      await ethers.provider.send("evm_increaseTime", [MIN_DELAY]);
      await ethers.provider.send("evm_mine", []);

      // Random user executes
      await timelock.connect(user1).execute(
        unit.address,
        0,
        setRigCalldata,
        predecessor,
        salt
      );

      expect(await unit.rig()).to.equal(newRig.address);
    });

    it("should NOT allow re-execution of same operation", async function () {
      // Schedule
      await timelock.connect(safeWallet).schedule(
        unit.address,
        0,
        setRigCalldata,
        predecessor,
        salt,
        MIN_DELAY
      );

      // Fast forward and execute
      await ethers.provider.send("evm_increaseTime", [MIN_DELAY]);
      await ethers.provider.send("evm_mine", []);
      await timelock.execute(unit.address, 0, setRigCalldata, predecessor, salt);

      // Try to execute again
      await expect(
        timelock.execute(unit.address, 0, setRigCalldata, predecessor, salt)
      ).to.be.revertedWith("TimelockController: operation is not ready");
    });
  });

  describe("Cancellation", function () {
    let setRigCalldata;
    let predecessor;
    let salt;
    let operationId;

    beforeEach(async function () {
      setRigCalldata = unit.interface.encodeFunctionData("setRig", [newRig.address]);
      predecessor = ethers.constants.HashZero;
      salt = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("setRig-cancel"));

      // Calculate operation ID
      operationId = await timelock.hashOperation(
        unit.address,
        0,
        setRigCalldata,
        predecessor,
        salt
      );

      // Schedule the operation
      await timelock.connect(safeWallet).schedule(
        unit.address,
        0,
        setRigCalldata,
        predecessor,
        salt,
        MIN_DELAY
      );
    });

    it("should allow proposer to cancel before execution", async function () {
      await expect(timelock.connect(safeWallet).cancel(operationId))
        .to.emit(timelock, "Cancelled")
        .withArgs(operationId);
    });

    it("should NOT allow non-proposer to cancel", async function () {
      await expect(timelock.connect(user1).cancel(operationId)).to.be.reverted;
    });

    it("should NOT allow execution after cancellation", async function () {
      // Cancel
      await timelock.connect(safeWallet).cancel(operationId);

      // Fast forward
      await ethers.provider.send("evm_increaseTime", [MIN_DELAY]);
      await ethers.provider.send("evm_mine", []);

      // Try to execute
      await expect(
        timelock.execute(unit.address, 0, setRigCalldata, predecessor, salt)
      ).to.be.revertedWith("TimelockController: operation is not ready");
    });
  });

  describe("Batch Operations", function () {
    it("should allow scheduling and executing multiple operations in batch", async function () {
      // Prepare two operations: setRig and transferOwnership
      const setRigCalldata = unit.interface.encodeFunctionData("setRig", [newRig.address]);

      const targets = [unit.address];
      const values = [0];
      const payloads = [setRigCalldata];
      const predecessor = ethers.constants.HashZero;
      const salt = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("batch-1"));

      // Schedule batch
      await timelock.connect(safeWallet).scheduleBatch(
        targets,
        values,
        payloads,
        predecessor,
        salt,
        MIN_DELAY
      );

      // Fast forward
      await ethers.provider.send("evm_increaseTime", [MIN_DELAY]);
      await ethers.provider.send("evm_mine", []);

      // Execute batch
      await timelock.executeBatch(targets, values, payloads, predecessor, salt);

      expect(await unit.rig()).to.equal(newRig.address);
    });
  });

  describe("Edge Cases", function () {
    it("should reject setRig to zero address via timelock", async function () {
      const setRigCalldata = unit.interface.encodeFunctionData("setRig", [AddressZero]);
      const predecessor = ethers.constants.HashZero;
      const salt = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zero-rig"));

      // Schedule
      await timelock.connect(safeWallet).schedule(
        unit.address,
        0,
        setRigCalldata,
        predecessor,
        salt,
        MIN_DELAY
      );

      // Fast forward
      await ethers.provider.send("evm_increaseTime", [MIN_DELAY]);
      await ethers.provider.send("evm_mine", []);

      // Execute - should revert with Unit's error
      await expect(
        timelock.execute(unit.address, 0, setRigCalldata, predecessor, salt)
      ).to.be.reverted;
    });

    it("should handle multiple pending operations", async function () {
      const predecessor = ethers.constants.HashZero;

      // Schedule first operation
      const salt1 = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("op-1"));
      const calldata1 = unit.interface.encodeFunctionData("setRig", [newRig.address]);
      await timelock.connect(safeWallet).schedule(
        unit.address, 0, calldata1, predecessor, salt1, MIN_DELAY
      );

      // Schedule second operation with different salt
      const salt2 = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("op-2"));
      const calldata2 = unit.interface.encodeFunctionData("setRig", [user1.address]);
      await timelock.connect(safeWallet).schedule(
        unit.address, 0, calldata2, predecessor, salt2, MIN_DELAY
      );

      // Fast forward
      await ethers.provider.send("evm_increaseTime", [MIN_DELAY]);
      await ethers.provider.send("evm_mine", []);

      // Execute second operation first
      await timelock.execute(unit.address, 0, calldata2, predecessor, salt2);
      expect(await unit.rig()).to.equal(user1.address);

      // Execute first operation
      await timelock.execute(unit.address, 0, calldata1, predecessor, salt1);
      expect(await unit.rig()).to.equal(newRig.address);
    });

    it("should verify delay is exactly 48 hours", async function () {
      const setRigCalldata = unit.interface.encodeFunctionData("setRig", [newRig.address]);
      const predecessor = ethers.constants.HashZero;
      const salt = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("timing-test"));

      // Schedule
      await timelock.connect(safeWallet).schedule(
        unit.address, 0, setRigCalldata, predecessor, salt, MIN_DELAY
      );

      // Fast forward 47 hours 59 minutes (not quite 48 hours)
      await ethers.provider.send("evm_increaseTime", [MIN_DELAY - 60]);
      await ethers.provider.send("evm_mine", []);

      // Should still fail
      await expect(
        timelock.execute(unit.address, 0, setRigCalldata, predecessor, salt)
      ).to.be.revertedWith("TimelockController: operation is not ready");

      // Fast forward the remaining time
      await ethers.provider.send("evm_increaseTime", [60]);
      await ethers.provider.send("evm_mine", []);

      // Now should work
      await timelock.execute(unit.address, 0, setRigCalldata, predecessor, salt);
      expect(await unit.rig()).to.equal(newRig.address);
    });
  });

  describe("Ownership Transfer via Timelock", function () {
    it("should allow transferring Unit ownership via timelock", async function () {
      // Prepare transferOwnership call
      const transferCalldata = unit.interface.encodeFunctionData("transferOwnership", [safeWallet.address]);
      const predecessor = ethers.constants.HashZero;
      const salt = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("transfer-ownership"));

      // Schedule
      await timelock.connect(safeWallet).schedule(
        unit.address, 0, transferCalldata, predecessor, salt, MIN_DELAY
      );

      // Fast forward
      await ethers.provider.send("evm_increaseTime", [MIN_DELAY]);
      await ethers.provider.send("evm_mine", []);

      // Execute
      await timelock.execute(unit.address, 0, transferCalldata, predecessor, salt);

      // Now safeWallet owns Unit directly (no more timelock)
      expect(await unit.owner()).to.equal(safeWallet.address);

      // Safe can now set rig directly
      await unit.connect(safeWallet).setRig(newRig.address);
      expect(await unit.rig()).to.equal(newRig.address);
    });
  });
});
