// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ICorporateActionAsset} from "../interfaces/ICorporateActionAsset.sol";

/// @title FixtureAsset — TESTNET FIXTURE
/// @notice A deterministic stand-in for a corporate-action token, for chain 1952 only.
///
/// @dev **This is a TESTNET FIXTURE and identifies itself as one on chain.**
///
/// Why it exists: real corporate actions cannot be scheduled on demand, so the failure
/// paths this product exists to prove — a stale receipt rejected because a multiplier
/// changed — cannot be triggered against production xStocks contracts. This fixture makes
/// them reproducible.
///
/// What it does NOT prove: compatibility with the production xStocks scheduling semantics.
/// It reproduces the verified *read* surface (`ICorporateActionAsset`) so the same reader
/// and the same adapter work against both, and nothing more. It deliberately does not use
/// the xStocks name, ticker, or branding.
contract FixtureAsset is ERC20, ICorporateActionAsset {
    /// @notice On-chain self-identification. Present so no explorer viewer can mistake
    /// this for a production asset.
    string public constant FIXTURE_LABEL = "TESTNET FIXTURE - NOT A REAL ASSET";

    /// @notice Multipliers are scaled by 1e18, matching the production token.
    uint256 public constant MULTIPLIER_SCALE = 1e18;

    /// @notice The only chain this contract may exist on.
    uint256 public constant ALLOWED_CHAIN_ID = 1952;

    /// @dev Narrowly scoped: may schedule, override, and activate. Nothing else.
    address public immutable fixtureAdmin;

    uint256 private _currentMultiplier;
    uint256 private _newMultiplier;
    uint256 private _newMultiplierNonce;
    uint256 private _newMultiplierActivationTime;

    /// @notice Per-address faucet cap, so a publicly reachable faucet cannot be drained.
    uint256 public constant FAUCET_LIMIT_PER_ADDRESS = 1_000_000e18;
    mapping(address => uint256) public faucetMinted;

    event MultiplierScheduled(
        uint256 indexed nonce, uint256 currentMultiplier, uint256 newMultiplier, uint256 activationTime
    );
    event MultiplierOverridden(
        uint256 indexed supersededNonce, uint256 indexed newNonce, uint256 newMultiplier, uint256 activationTime
    );
    event MultiplierEffective(uint256 indexed nonce, uint256 previousMultiplier, uint256 newMultiplier);
    event FaucetMinted(address indexed to, uint256 amount);

    error NotFixtureAdmin();
    error WrongChain(uint256 actual, uint256 expected);
    error ActivationInPast(uint256 activationTime, uint256 nowTime);
    error NoPendingMultiplier();
    error NotYetActive(uint256 activationTime, uint256 nowTime);
    error MultiplierMustBePositive();
    error FaucetLimitExceeded(uint256 requested, uint256 remaining);

    modifier onlyFixtureAdmin() {
        if (msg.sender != fixtureAdmin) revert NotFixtureAdmin();
        _;
    }

    constructor(string memory name_, string memory symbol_, address admin_, uint256 initialMultiplier_)
        ERC20(name_, symbol_)
    {
        // Refuse to exist anywhere but the testnet. A fixture deployed to a production
        // chain would be indistinguishable from a real asset to anything reading it.
        if (block.chainid != ALLOWED_CHAIN_ID) revert WrongChain(block.chainid, ALLOWED_CHAIN_ID);
        if (initialMultiplier_ == 0) revert MultiplierMustBePositive();

        fixtureAdmin = admin_;
        _currentMultiplier = initialMultiplier_;
        _newMultiplier = initialMultiplier_;
        _newMultiplierNonce = 0;
        _newMultiplierActivationTime = 0;
    }

    // --- ICorporateActionAsset -------------------------------------------------

    function getCurrentMultiplier() external view returns (uint256) {
        return _currentMultiplier;
    }

    function newMultiplier() external view returns (uint256) {
        return _newMultiplier;
    }

    function newMultiplierNonce() external view returns (uint256) {
        return _newMultiplierNonce;
    }

    function newMultiplierActivationTime() external view returns (uint256) {
        return _newMultiplierActivationTime;
    }

    // --- Fixture administration ------------------------------------------------

    /// @notice Schedule a multiplier change. Increments the nonce immediately, which is
    /// what invalidates outstanding receipts bound to the previous epoch.
    /// @dev The activation must be in the future: scheduling into the past would let an
    /// operator skip the guard window entirely.
    function scheduleMultiplier(uint256 multiplier_, uint256 activationTime_) external onlyFixtureAdmin {
        if (multiplier_ == 0) revert MultiplierMustBePositive();
        if (activationTime_ <= block.timestamp) revert ActivationInPast(activationTime_, block.timestamp);

        uint256 superseded = _newMultiplierNonce;
        bool isOverride = _newMultiplierActivationTime != 0;

        _newMultiplier = multiplier_;
        _newMultiplierActivationTime = activationTime_;
        // Monotonic: never decreases, so an old receipt can never become valid again.
        _newMultiplierNonce = superseded + 1;

        if (isOverride) {
            emit MultiplierOverridden(superseded, _newMultiplierNonce, multiplier_, activationTime_);
        } else {
            emit MultiplierScheduled(_newMultiplierNonce, _currentMultiplier, multiplier_, activationTime_);
        }
    }

    /// @notice Apply a scheduled multiplier once its activation time has passed.
    /// @dev Permissionless on purpose: anyone may push the state forward, but only after
    /// the time the admin already committed to. It cannot be applied early.
    function applyScheduledMultiplier() external {
        if (_newMultiplierActivationTime == 0) revert NoPendingMultiplier();
        if (block.timestamp < _newMultiplierActivationTime) {
            revert NotYetActive(_newMultiplierActivationTime, block.timestamp);
        }

        uint256 previous = _currentMultiplier;
        _currentMultiplier = _newMultiplier;
        _newMultiplierActivationTime = 0;

        emit MultiplierEffective(_newMultiplierNonce, previous, _currentMultiplier);
    }

    // --- Faucet ---------------------------------------------------------------

    /// @notice Capped mint for testing. Bounded per address so a public faucet cannot be
    /// drained into a misleading supply figure.
    function faucet(uint256 amount) external {
        uint256 already = faucetMinted[msg.sender];
        if (already + amount > FAUCET_LIMIT_PER_ADDRESS) {
            revert FaucetLimitExceeded(amount, FAUCET_LIMIT_PER_ADDRESS - already);
        }
        faucetMinted[msg.sender] = already + amount;
        _mint(msg.sender, amount);
        emit FaucetMinted(msg.sender, amount);
    }
}
