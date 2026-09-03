// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICorporateActionAsset, IWrapperAsset} from "./interfaces/ICorporateActionAsset.sol";

interface IProtectedTarget {
    function performProtectedAction(uint8 actionType, address caller, address recipient, uint256 amount) external;
}

/// @title ActionGuardAdapter
/// @notice Refuses a protected action whose authorization no longer matches chain reality.
///
/// @dev The adapter verifies chain facts **itself**. It does not trust the API, the UI, the
/// off-chain service, or an AI explanation — none of those are visible from here, and a
/// compromised one must not be able to move funds.
///
/// What it cannot verify, stated plainly: whether the off-chain xStocks API agreed with the
/// chain at issuance time. A compromised signer could assert agreement that never happened.
/// Mitigations here are short receipt lifetimes, exact operation binding, single
/// consumption, an authorized-signer allowlist, and two-step ownership. Production needs
/// HSM/KMS custody or threshold signing — see ADR 0002.
///
/// **The enforcement claim applies only to paths that route through this adapter.** A
/// holder can transfer an ERC-20 directly and bypass it entirely.
contract ActionGuardAdapter is EIP712, Ownable2Step, ReentrancyGuard {
    /// @dev Must match PREFLIGHT_RECEIPT_TYPE in packages/receipts/src/schema.ts exactly.
    /// Golden vectors in packages/receipts/vectors assert both sides agree.
    bytes32 public constant RECEIPT_TYPEHASH = keccak256(
        "PreflightReceipt(uint16 schemaVersion,bytes32 receiptId,address caller,address target,address asset,address wrapper,uint8 actionType,address recipient,uint256 amount,uint256 expectedMultiplierNonce,uint64 validAfter,uint64 validUntil,bytes32 operationDigest)"
    );

    /// @dev Must match OPERATION_DIGEST_TAG in packages/receipts/src/digest.ts.
    bytes32 public constant OPERATION_DIGEST_TAG = keccak256("CorporateActionGuard.OperationDigest.v1");

    uint16 public constant SCHEMA_VERSION = 1;

    /// @notice X Layer mainnet. This contract refuses to exist there.
    uint256 public constant FORBIDDEN_CHAIN_ID = 196;

    struct Receipt {
        uint16 schemaVersion;
        bytes32 receiptId;
        address caller;
        address target;
        address asset;
        address wrapper;
        uint8 actionType;
        address recipient;
        uint256 amount;
        uint256 expectedMultiplierNonce;
        uint64 validAfter;
        uint64 validUntil;
        bytes32 operationDigest;
    }

    /// @notice Signers permitted to authorize actions.
    mapping(address => bool) public authorizedSigner;
    /// @notice Targets permitted to be called. Prevents the adapter becoming an arbitrary-call proxy.
    mapping(address => bool) public allowedTarget;
    /// @notice Receipt IDs already consumed. A consumed receipt can never become unconsumed.
    mapping(bytes32 => bool) public consumed;

    /// @notice The asset/wrapper pair currently protected.
    address public protectedAsset;
    address public protectedWrapper;

    /// @notice Seconds before and after an activation during which actions are refused.
    uint64 public guardWindowBefore;
    uint64 public guardWindowAfter;

    /// @notice Blocks new actions. Never confiscates: withdrawals through the vault remain
    /// possible by direct call, and the vault's own withdraw path is not gated by this.
    bool public paused;

    event SignerAuthorized(address indexed signer, bool authorized);
    event TargetAllowed(address indexed target, bool allowed);
    event ProtectedPairConfigured(address indexed asset, address indexed wrapper);
    event GuardWindowConfigured(uint64 before_, uint64 after_);
    event PausedSet(bool paused);
    event ReceiptConsumed(bytes32 indexed receiptId, address indexed caller, address indexed target, uint256 amount);
    event ActionExecuted(bytes32 indexed receiptId, uint8 actionType, address recipient, uint256 amount);

    error DeploymentOnMainnetForbidden();
    error Paused();
    error UnsupportedChain(uint256 actual, uint256 expected);
    error SchemaVersionMismatch(uint16 actual, uint16 expected);
    error UnauthorizedSigner(address signer);
    error TargetNotAllowed(address target);
    error CallerMismatch(address expected, address actual);
    error AssetPairMismatch(address asset, address wrapper);
    error WrapperAssetMismatch(address reported, address expected);
    error MultiplierNonceMismatch(uint256 expected, uint256 actual);
    error InsideGuardWindow(uint256 nowTime, uint256 activationTime, uint64 before_, uint64 after_);
    error ReceiptNotYetValid(uint64 validAfter, uint256 nowTime);
    error ReceiptExpired(uint64 validUntil, uint256 nowTime);
    error ReceiptAlreadyConsumed(bytes32 receiptId);
    error OperationDigestMismatch(bytes32 expected, bytes32 actual);
    error ZeroAddress();
    error ZeroAmount();

    constructor(address owner_, address asset_, address wrapper_, uint64 before_, uint64 after_)
        EIP712("CorporateActionGuard", "1")
        Ownable(owner_)
    {
        // Never on mainnet. This build performs no X Layer mainnet writes at all.
        if (block.chainid == FORBIDDEN_CHAIN_ID) revert DeploymentOnMainnetForbidden();
        if (asset_ == address(0) || wrapper_ == address(0)) revert ZeroAddress();

        protectedAsset = asset_;
        protectedWrapper = wrapper_;
        guardWindowBefore = before_;
        guardWindowAfter = after_;

        emit ProtectedPairConfigured(asset_, wrapper_);
        emit GuardWindowConfigured(before_, after_);
    }

    // --- Administration --------------------------------------------------------

    function setAuthorizedSigner(address signer, bool authorized) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        authorizedSigner[signer] = authorized;
        emit SignerAuthorized(signer, authorized);
    }

    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        allowedTarget[target] = allowed;
        emit TargetAllowed(target, allowed);
    }

    function setProtectedPair(address asset_, address wrapper_) external onlyOwner {
        if (asset_ == address(0) || wrapper_ == address(0)) revert ZeroAddress();
        protectedAsset = asset_;
        protectedWrapper = wrapper_;
        emit ProtectedPairConfigured(asset_, wrapper_);
    }

    function setGuardWindow(uint64 before_, uint64 after_) external onlyOwner {
        guardWindowBefore = before_;
        guardWindowAfter = after_;
        emit GuardWindowConfigured(before_, after_);
    }

    /// @notice Pause new protected actions.
    /// @dev Deliberately does not touch the vault's own withdrawal path: an emergency stop
    /// that traps user funds converts an availability incident into a solvency one.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    // --- Digest and hashing ----------------------------------------------------

    /// @notice Recompute the operation digest from the fields actually presented.
    /// @dev This is what catches a payload mutated after preflight. It must reproduce
    /// `computeOperationDigest` in packages/receipts/src/digest.ts exactly.
    function computeOperationDigest(
        uint256 chainId_,
        address verifyingContract_,
        address caller_,
        address target_,
        address asset_,
        address wrapper_,
        uint8 actionType_,
        address recipient_,
        uint256 amount_,
        uint256 expectedMultiplierNonce_
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                OPERATION_DIGEST_TAG,
                abi.encode(
                    SCHEMA_VERSION,
                    chainId_,
                    verifyingContract_,
                    caller_,
                    target_,
                    asset_,
                    wrapper_,
                    actionType_,
                    recipient_,
                    amount_,
                    expectedMultiplierNonce_
                )
            )
        );
    }

    function hashReceipt(Receipt calldata receipt) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RECEIPT_TYPEHASH,
                    receipt.schemaVersion,
                    receipt.receiptId,
                    receipt.caller,
                    receipt.target,
                    receipt.asset,
                    receipt.wrapper,
                    receipt.actionType,
                    receipt.recipient,
                    receipt.amount,
                    receipt.expectedMultiplierNonce,
                    receipt.validAfter,
                    receipt.validUntil,
                    receipt.operationDigest
                )
            )
        );
    }

    // --- The guard -------------------------------------------------------------

    /// @notice Execute a protected action, or revert.
    ///
    /// @dev Verification order is chosen so the cheapest and most definitive checks run
    /// first, and so the receipt is marked consumed **before** any external call — a
    /// reentrant call finds it already spent.
    function execute(Receipt calldata receipt, bytes calldata signature) external nonReentrant {
        if (paused) revert Paused();

        // --- Shape ------------------------------------------------------------
        if (receipt.schemaVersion != SCHEMA_VERSION) {
            revert SchemaVersionMismatch(receipt.schemaVersion, SCHEMA_VERSION);
        }
        if (
            receipt.target == address(0) || receipt.asset == address(0) || receipt.wrapper == address(0)
                || receipt.recipient == address(0)
        ) revert ZeroAddress();
        if (receipt.amount == 0) revert ZeroAmount();

        // --- Binding ----------------------------------------------------------
        // The caller must be the account the receipt was issued to, so one integrator
        // cannot spend another's authorization.
        if (receipt.caller != msg.sender) revert CallerMismatch(receipt.caller, msg.sender);
        if (!allowedTarget[receipt.target]) revert TargetNotAllowed(receipt.target);
        if (receipt.asset != protectedAsset || receipt.wrapper != protectedWrapper) {
            revert AssetPairMismatch(receipt.asset, receipt.wrapper);
        }

        bytes32 expectedDigest = computeOperationDigest(
            block.chainid,
            address(this),
            receipt.caller,
            receipt.target,
            receipt.asset,
            receipt.wrapper,
            receipt.actionType,
            receipt.recipient,
            receipt.amount,
            receipt.expectedMultiplierNonce
        );
        if (expectedDigest != receipt.operationDigest) {
            revert OperationDigestMismatch(expectedDigest, receipt.operationDigest);
        }

        // --- Validity ---------------------------------------------------------
        // Inclusive at both ends, matching the off-chain predicate: valid at exactly
        // validAfter, expired at exactly validUntil. Ties resolve toward blocking.
        if (block.timestamp < receipt.validAfter) revert ReceiptNotYetValid(receipt.validAfter, block.timestamp);
        if (block.timestamp >= receipt.validUntil) revert ReceiptExpired(receipt.validUntil, block.timestamp);
        if (consumed[receipt.receiptId]) revert ReceiptAlreadyConsumed(receipt.receiptId);

        // --- Signature --------------------------------------------------------
        // ECDSA.recover rejects malleable (high-s) signatures and invalid v values.
        address signer = ECDSA.recover(hashReceipt(receipt), signature);
        if (!authorizedSigner[signer]) revert UnauthorizedSigner(signer);

        // --- Chain reality ----------------------------------------------------
        // Everything above proves the receipt is well-formed and authorized. These two
        // checks prove the world it described is still the world we are in.
        address reportedAsset = IWrapperAsset(receipt.wrapper).asset();
        if (reportedAsset != receipt.asset) revert WrapperAssetMismatch(reportedAsset, receipt.asset);

        uint256 currentNonce = ICorporateActionAsset(receipt.asset).newMultiplierNonce();
        if (currentNonce != receipt.expectedMultiplierNonce) {
            revert MultiplierNonceMismatch(receipt.expectedMultiplierNonce, currentNonce);
        }

        uint256 activation = ICorporateActionAsset(receipt.asset).newMultiplierActivationTime();
        if (activation != 0) {
            // Inclusive window. `activation == 0` is the "no schedule" sentinel and must
            // not be read as an instant, or every action would sit inside a window at the
            // epoch.
            uint256 windowStart = activation > guardWindowBefore ? activation - guardWindowBefore : 0;
            uint256 windowEnd = activation + guardWindowAfter;
            if (block.timestamp >= windowStart && block.timestamp <= windowEnd) {
                revert InsideGuardWindow(block.timestamp, activation, guardWindowBefore, guardWindowAfter);
            }
        }

        // --- Effects before interactions --------------------------------------
        // Marked consumed before the external call, so a reentrant attempt finds it spent.
        consumed[receipt.receiptId] = true;
        emit ReceiptConsumed(receipt.receiptId, receipt.caller, receipt.target, receipt.amount);

        IProtectedTarget(receipt.target)
            .performProtectedAction(receipt.actionType, receipt.caller, receipt.recipient, receipt.amount);

        emit ActionExecuted(receipt.receiptId, receipt.actionType, receipt.recipient, receipt.amount);
    }
}
