const { ethers } = require("hardhat");
const { utils, BigNumber } = require("ethers");
const hre = require("hardhat");
const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));
const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const AddressZero = "0x0000000000000000000000000000000000000000";

/*===================================================================*/
/*===========================  SETTINGS  ============================*/

const MULTISIG_ADDRESS = "0x7a8C895E7826F66e1094532cB435Da725dc3868f"; // Multisig Address
const DAO_ADDRESS = ""; // DAO Address
const ENTROPY_ADDRESS = "0x6E7D74FA7d5c90FEF9F0512987605a6d546181Bb"; // Entropy Address
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006"; // WETH Address
const DONUT_ADDRESS = "0xAE4a37d554C6D6F3E398546d8566B25052e0169C"; // Donut Address
const ADDRESS_DEAD = "0x000000000000000000000000000000000000dEaD";

// Uniswap V2 (Base)
const UNISWAP_V2_FACTORY = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6";
const UNISWAP_V2_ROUTER = "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24";

// Unit settings
const UNIT_NAME = "FarPlace";
const UNIT_SYMBOL = "FARP";
const INITIAL_MINT = convert("1000000", 18); // 1M tokens for LP

// LP settings
const UNIT_FOR_LP = convert("500000", 18); // 500K Unit for LP
const DONUT_FOR_LP = convert("500000", 18); // 500K Donut for LP (adjust based on desired price)

// Auction settings
const AUCTION_PERIOD = 86400; // 1 day
const PRICE_MULTIPLIER = convert("1.2", 18); // 120%
const MIN_INIT_PRICE = convert("1", 18); // 1 LP

// Timelock settings
const TIMELOCK_MIN_DELAY = 48 * 3600; // 48 hours in seconds

/*===========================  END SETTINGS  ========================*/
/*===================================================================*/

// Uniswap V2 ABIs (minimal)
const UNISWAP_V2_FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
  "function createPair(address tokenA, address tokenB) external returns (address pair)",
];

const UNISWAP_V2_ROUTER_ABI = [
  "function factory() external pure returns (address)",
  "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) external returns (uint256 amountA, uint256 amountB, uint256 liquidity)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

// Contract Variables
let unit, rig, auction, multicall, lpToken, timelock;

/*===================================================================*/
/*===========================  CONTRACT DATA  =======================*/

async function getContracts() {
  unit = await ethers.getContractAt(
    "contracts/Unit.sol:Unit",
    "0x..." // Unit address
  );
  rig = await ethers.getContractAt(
    "contracts/Rig.sol:Rig",
    "0x..." // Rig address
  );
  auction = await ethers.getContractAt(
    "contracts/Auction.sol:Auction",
    "0x..." // Auction address
  );
  multicall = await ethers.getContractAt(
    "contracts/Multicall.sol:Multicall",
    "0x..." // Multicall address
  );
  timelock = await ethers.getContractAt(
    "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController",
    "0x..." // Timelock address
  );
  console.log("Contracts Retrieved");
}

/*===========================  END CONTRACT DATA  ===================*/
/*===================================================================*/

async function deployUnit() {
  console.log("Starting Unit Deployment");
  const unitArtifact = await ethers.getContractFactory("Unit");
  const unitContract = await unitArtifact.deploy(UNIT_NAME, UNIT_SYMBOL, {
    gasPrice: ethers.gasPrice,
  });
  unit = await unitContract.deployed();
  await sleep(5000);
  console.log("Unit Deployed at:", unit.address);
}

async function mintUnit() {
  console.log("Minting initial Unit supply for LP");
  await unit.mint(await unit.signer.getAddress(), INITIAL_MINT);
  console.log("Minted", ethers.utils.formatEther(INITIAL_MINT), "Unit tokens");
}

async function createLP() {
  console.log("Creating LP on Uniswap V2");
  const [wallet] = await ethers.getSigners();

  const router = new ethers.Contract(UNISWAP_V2_ROUTER, UNISWAP_V2_ROUTER_ABI, wallet);
  const factory = new ethers.Contract(UNISWAP_V2_FACTORY, UNISWAP_V2_FACTORY_ABI, wallet);
  const donut = new ethers.Contract(DONUT_ADDRESS, ERC20_ABI, wallet);

  // Check balances
  const unitBalance = await unit.balanceOf(wallet.address);
  const donutBalance = await donut.balanceOf(wallet.address);
  console.log("Unit balance:", ethers.utils.formatEther(unitBalance));
  console.log("Donut balance:", ethers.utils.formatEther(donutBalance));

  if (unitBalance.lt(UNIT_FOR_LP)) {
    throw new Error("Insufficient Unit balance for LP");
  }
  if (donutBalance.lt(DONUT_FOR_LP)) {
    throw new Error("Insufficient Donut balance for LP");
  }

  // Approve router
  console.log("Approving Unit for router...");
  const unitApproveTx = await unit.approve(UNISWAP_V2_ROUTER, UNIT_FOR_LP);
  await unitApproveTx.wait();
  console.log("Unit approved");

  console.log("Approving Donut for router...");
  const donutApproveTx = await donut.approve(UNISWAP_V2_ROUTER, DONUT_FOR_LP);
  await donutApproveTx.wait();
  console.log("Donut approved");

  // Add liquidity
  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
  console.log("Adding liquidity...");
  const addLiquidityTx = await router.addLiquidity(
    unit.address,
    DONUT_ADDRESS,
    UNIT_FOR_LP,
    DONUT_FOR_LP,
    UNIT_FOR_LP.mul(95).div(100), // 5% slippage
    DONUT_FOR_LP.mul(95).div(100), // 5% slippage
    wallet.address,
    deadline
  );
  const receipt = await addLiquidityTx.wait();
  console.log("Liquidity added! Tx:", receipt.transactionHash);

  // Get LP token address
  const lpAddress = await factory.getPair(unit.address, DONUT_ADDRESS);
  console.log("LP Token Address:", lpAddress);

  return lpAddress;
}

async function getLPAddress() {
  const [wallet] = await ethers.getSigners();
  const factory = new ethers.Contract(UNISWAP_V2_FACTORY, UNISWAP_V2_FACTORY_ABI, wallet);
  const lpAddress = await factory.getPair(unit.address, DONUT_ADDRESS);
  console.log("LP Token Address:", lpAddress);
  return lpAddress;
}

async function deployAuction(lpAddress) {
  console.log("Starting Auction Deployment");
  const auctionArtifact = await ethers.getContractFactory("Auction");
  const auctionContract = await auctionArtifact.deploy(
    MIN_INIT_PRICE,
    lpAddress,
    ADDRESS_DEAD,
    AUCTION_PERIOD,
    PRICE_MULTIPLIER,
    MIN_INIT_PRICE,
    {
      gasPrice: ethers.gasPrice,
    }
  );
  auction = await auctionContract.deployed();
  await sleep(5000);
  console.log("Auction Deployed at:", auction.address);
}

async function deployRig() {
  console.log("Starting Rig Deployment");
  const rigArtifact = await ethers.getContractFactory("Rig");
  const rigContract = await rigArtifact.deploy(
    unit.address,
    WETH_ADDRESS,
    ENTROPY_ADDRESS,
    auction.address,
    {
      gasPrice: ethers.gasPrice,
    }
  );
  rig = await rigContract.deployed();
  await sleep(5000);
  console.log("Rig Deployed at:", rig.address);
}

async function setRigOnUnit() {
  console.log("Transferring minting rights to Rig");
  await unit.setRig(rig.address);
  console.log("Unit minting rights transferred to Rig");
}

async function deployMulticall() {
  console.log("Starting Multicall Deployment");
  const multicallArtifact = await ethers.getContractFactory("Multicall");
  const multicallContract = await multicallArtifact.deploy(
    rig.address,
    auction.address,
    DONUT_ADDRESS,
    {
      gasPrice: ethers.gasPrice,
    }
  );
  multicall = await multicallContract.deployed();
  await sleep(5000);
  console.log("Multicall Deployed at:", multicall.address);
}

async function deployTimelock() {
  console.log("Starting TimelockController Deployment");
  console.log("----------------------------------------");
  console.log("Settings:");
  console.log("  - Min Delay:", TIMELOCK_MIN_DELAY, "seconds (", TIMELOCK_MIN_DELAY / 3600, "hours )");
  console.log("  - Proposer (Safe):", MULTISIG_ADDRESS);
  console.log("  - Executor: Anyone (open)");
  console.log("  - Admin: None (trustless)");
  console.log("----------------------------------------");

  const timelockArtifact = await ethers.getContractFactory("TimelockController");
  const timelockContract = await timelockArtifact.deploy(
    TIMELOCK_MIN_DELAY,
    [MULTISIG_ADDRESS], // proposers - only Safe can propose
    [AddressZero], // executors - anyone can execute after delay
    AddressZero, // admin - no admin (trustless)
    {
      gasPrice: ethers.gasPrice,
    }
  );
  timelock = await timelockContract.deployed();
  await sleep(5000);
  console.log("TimelockController Deployed at:", timelock.address);
}

async function transferUnitOwnershipToTimelock() {
  console.log("Transferring Unit ownership to Timelock...");
  const tx = await unit.transferOwnership(timelock.address);
  await tx.wait();
  console.log("Unit ownership transferred to Timelock");
  console.log("New Unit owner:", await unit.owner());
}

async function verifyUnit() {
  console.log("Starting Unit Verification");
  await hre.run("verify:verify", {
    address: unit.address,
    contract: "contracts/Unit.sol:Unit",
    constructorArguments: [UNIT_NAME, UNIT_SYMBOL],
  });
  console.log("Unit Verified");
}

async function verifyAuction(lpAddress) {
  console.log("Starting Auction Verification");
  await hre.run("verify:verify", {
    address: auction.address,
    contract: "contracts/Auction.sol:Auction",
    constructorArguments: [
      MIN_INIT_PRICE,
      lpAddress,
      ADDRESS_DEAD,
      AUCTION_PERIOD,
      PRICE_MULTIPLIER,
      MIN_INIT_PRICE,
    ],
  });
  console.log("Auction Verified");
}

async function verifyRig() {
  console.log("Starting Rig Verification");
  await hre.run("verify:verify", {
    address: rig.address,
    contract: "contracts/Rig.sol:Rig",
    constructorArguments: [unit.address, WETH_ADDRESS, ENTROPY_ADDRESS, auction.address],
  });
  console.log("Rig Verified");
}

async function verifyMulticall() {
  console.log("Starting Multicall Verification");
  await hre.run("verify:verify", {
    address: multicall.address,
    contract: "contracts/Multicall.sol:Multicall",
    constructorArguments: [rig.address, auction.address, DONUT_ADDRESS],
  });
  console.log("Multicall Verified");
}

async function verifyTimelock() {
  console.log("Starting TimelockController Verification");
  await hre.run("verify:verify", {
    address: timelock.address,
    contract: "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController",
    constructorArguments: [
      TIMELOCK_MIN_DELAY,
      [MULTISIG_ADDRESS],
      [AddressZero],
      AddressZero,
    ],
  });
  console.log("TimelockController Verified");
}

async function printDeployment(lpAddress) {
  console.log("**************************************************************");
  console.log("Unit:      ", unit.address);
  console.log("LP Token:  ", lpAddress);
  console.log("Auction:   ", auction.address);
  console.log("Rig:       ", rig.address);
  console.log("Multicall: ", multicall.address);
  if (timelock) {
    console.log("Timelock:  ", timelock.address);
  }
  console.log("**************************************************************");
}

async function printTimelockUsage() {
  console.log("\n======================================================");
  console.log("                 HOW TO USE THE TIMELOCK               ");
  console.log("======================================================");
  console.log("\n1. PROPOSE a setRig call (from Safe):");
  console.log("   - Target:", unit.address);
  console.log("   - Value: 0");
  console.log("   - Data: unit.interface.encodeFunctionData('setRig', [NEW_RIG_ADDRESS])");
  console.log("   - Predecessor: 0x0000...0000 (32 bytes of zeros)");
  console.log("   - Salt: unique bytes32 value (e.g., keccak256('setRig-1'))");
  console.log("   - Delay:", TIMELOCK_MIN_DELAY, "seconds");
  console.log("");
  console.log("2. WAIT", TIMELOCK_MIN_DELAY / 3600, "hours");
  console.log("");
  console.log("3. EXECUTE the proposal (anyone can execute):");
  console.log("   - Call timelock.execute() with same parameters");
  console.log("======================================================\n");
}

async function main() {
  const [wallet] = await ethers.getSigners();
  console.log("Using wallet: ", wallet.address);

  // await getContracts();

  //===================================================================
  // Deploy System
  // Order: Unit -> mint Unit -> create LP -> Auction -> Rig -> setRig -> Multicall -> Timelock
  //===================================================================

  // console.log("Starting System Deployment");

  // 1. Deploy Unit
  // await deployUnit();

  // 2. Mint initial Unit for LP (deployer can mint since they're initial rig)
  // await mintUnit();

  // 3. Create LP with Unit + DONUT on Uniswap V2
  // const LP_ADDRESS = await createLP();
  // OR if LP already exists:
  // const LP_ADDRESS = await getLPAddress();
  // OR set manually:
  // const LP_ADDRESS = "0x...";

  // 4. Deploy Auction with LP as payment token
  // await deployAuction(LP_ADDRESS);

  // 5. Deploy Rig with unit, weth, entropy, auction
  // await deployRig();

  // 6. Transfer minting rights from deployer to Rig
  // await setRigOnUnit();

  // 7. Deploy Multicall
  // await deployMulticall();

  // 8. Deploy Timelock (optional - for governance)
  // await deployTimelock();

  // 9. Transfer Unit ownership to Timelock (optional - for governance)
  // await transferUnitOwnershipToTimelock();

  // await printDeployment(LP_ADDRESS);
  // await printTimelockUsage();

  /*********** UPDATE getContracts() with new addresses *************/

  //===================================================================
  // Verify System
  //===================================================================

  // console.log("Starting System Verification");
  // await verifyUnit();
  // await sleep(5000);
  // await verifyAuction(LP_ADDRESS);
  // await sleep(5000);
  // await verifyRig();
  // await sleep(5000);
  // await verifyMulticall();
  // await sleep(5000);
  // await verifyTimelock();
  // await sleep(5000);

  //===================================================================
  // Transactions
  //===================================================================

  // set multipliers
  // const multipliers = [
  //   ...Array(5).fill(convert("1.0", 18)),
  //   ...Array(4).fill(convert("2.0", 18)),
  //   ...Array(3).fill(convert("3.0", 18)),
  //   ...Array(2).fill(convert("5.0", 18)),
  //   ...Array(1).fill(convert("10.0", 18)),
  // ];
  // await rig.setMultipliers(multipliers);
  // console.log("Multipliers set on Rig");

  // set ownership of rig to multisig/DAO
  // await rig.transferOwnership(DAO_ADDRESS);
  // console.log("Ownership of Rig transferred to DAO");

  // increase capacity
  // await rig.setCapacity(256);
  // console.log("Capacity set to 256");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
