// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IB20Multiplier, IB20Pausable, IB20Scheduled} from "./interfaces/IB20Asset.sol";

interface IB20ProtectedTarget {
    function performB20Action(uint8 actionClass, address sender, address recipient, uint256 rawAmount) external;
}

/// @title B20GuardAdapter
/// @notice Refuses a B20 operation whose authorization no longer matches chain reality.
///
/// @dev A sibling of `ActionGuardAdapter`, not a replacement. That one is deployed on X Layer
/// against a different receipt schema; changing it would reject every receipt in flight.
///
/// The adapter verifies chain facts **itself**. It does not trust the API, the console, or an
/// off-chain explanation — none of those are visible from here, and a compromised one must not
/// be able to move funds. What it re-reads, and why each matters:
///
/// - **The multiplier.** The receipt commits to the value the signer observed. If a corporate
///   action landed between issuance and execution, the operation was sized against a state
///   that no longer exists, and it is refused.
/// - **A pending activation.** Committed as a timestamp, or `0` meaning "none was pending".
///   Zero is a claim, not an absence of information: if a schedule has appeared since, the
///   receipt is stale even though its multiplier still matches.
/// - **The pause state.** A token that paused transfers after issuance would revert anyway;
///   refusing here produces a named reason instead of an opaque revert.
///
/// What it cannot verify, stated plainly: whether the off-chain price evidence agreed at
/// issuance. A compromised signer could assert agreement that never happened. The mitigations
/// are short receipt lifetimes, exact operation binding, single consumption, a signer
/// allowlist and two-step ownership — not a claim that this contract can detect a bad signer.
///
/// **Enforcement applies only to paths that route through this adapter.** A holder can call
/// the B20 token directly and bypass it entirely. `test_DirectTransferBypassesTheAdapter`
/// asserts that bypass exists rather than pretending it does not.
contract B20GuardAdapter is EIP712, Ownable2Step, ReentrancyGuard {
    /// @dev Must match `B20_RECEIPT_TYPE` in packages/receipts/src/b20-schema.ts exactly.
    /// Golden vectors assert both sides agree; a drift here rejects every receipt at
    /// execution time rather than at build time, which is why they are shared.
    bytes32 public constant RECEIPT_TYPEHASH = keccak256(
        "B20PreflightReceipt(uint16 schemaVersion,bytes32 receiptId,address asset,address sender,address recipient,uint8 actionClass,uint256 rawAmount,bytes32 operationDigest,uint256 activeMultiplierWad,uint64 pendingEffectiveAt,address feedProxy,uint80 feedRoundId,uint8 priceBasis,bytes32 policyVersionHash,uint64 issuedAt,uint64 expiresAt)"
    );

    /// @dev Must match `B20_OPERATION_DIGEST_TAG` in packages/receipts/src/b20-digest.ts.
    bytes32 public constant OPERATION_DIGEST_TAG = keccak256("CorporateActionGuard.B20.OperationDigest.v1");

    uint16 public constant SCHEMA_VERSION = 1;

    /// @notice Base mainnet. This contract refuses to exist there.
    /// @dev ADR 0007. The check is in the constructor because a deployed contract that
    /// merely refuses to execute would still be a mainnet deployment claiming a boundary it
    /// did not hold. Chain binding at execution is already enforced twice — the EIP-712
    /// domain commits to `block.chainid`, and `operationDigest` commits to `block.chainid`
    /// and `address(this)` and is recomputed from the fields presented.
    uint256 public constant FORBIDDEN_CHAIN_ID = 8453;

    /// @dev `PausableFeature.TRANSFER` is index 0 in `IB20.sol`.
    uint8 private constant PAUSABLE_TRANSFER = 0;

    uint256 private constant EXPECTED_WAD = 1e18;

    struct Receipt {
        uint16 schemaVersion;
        bytes32 receiptId;
        address asset;
        address sender;
        address recipient;
        uint8 actionClass;
        uint256 rawAmount;
        bytes32 operationDigest;
        uint256 activeMultiplierWad;
        uint64 pendingEffectiveAt;
        address feedProxy;
        uint80 feedRoundId;
        uint8 priceBasis;
        bytes32 policyVersionHash;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    mapping(address => bool) public authorizedSigner;
    /// @notice Targets permitted to be called. Without this the adapter is an arbitrary-call proxy.
    mapping(address => bool) public allowedTarget;
    /// @notice Consumed receipt ids. A consumed receipt can never become unconsumed.
    mapping(bytes32 => bool) public consumed;
    /// @notice The B20 asset this deployment protects.
    address public protectedAsset;

    event SignerAuthorized(address indexed signer, bool authorized);
    event TargetAllowed(address indexed target, bool allowed);
    event ProtectedAssetSet(address indexed asset);
    event ReceiptConsumed(bytes32 indexed receiptId, address indexed sender, uint256 rawAmount);
    event ActionExecuted(bytes32 indexed receiptId, address indexed target, uint8 actionClass);

    error MainnetDeploymentForbidden(uint256 chainId);
    error UnsupportedSchemaVersion(uint16 got, uint16 expected);
    error UnauthorizedSigner(address signer);
    error TargetNotAllowed(address target);
    error AssetMismatch(address got, address expected);
    error ReceiptAlreadyConsumed(bytes32 receiptId);
    error ReceiptNotYetValid(uint64 issuedAt);
    error ReceiptExpired(uint64 expiresAt);
    error OperationDigestMismatch(bytes32 got, bytes32 expected);
    error MultiplierChanged(uint256 committed, uint256 observed);
    error ScheduleAppeared(uint64 committed, uint256 observed);
    error TransfersPaused();
    error UnexpectedWadPrecision(uint256 observed);
    error CallerIsNotSender(address caller, address sender);
    error ZeroAmount();
    error ZeroRecipient();

    constructor(address initialOwner, address asset) EIP712("CorporateActionGuardB20", "1") Ownable(initialOwner) {
        if (block.chainid == FORBIDDEN_CHAIN_ID) revert MainnetDeploymentForbidden(block.chainid);
        protectedAsset = asset;
        emit ProtectedAssetSet(asset);
    }

    function setAuthorizedSigner(address signer, bool authorized) external onlyOwner {
        authorizedSigner[signer] = authorized;
        emit SignerAuthorized(signer, authorized);
    }

    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        allowedTarget[target] = allowed;
        emit TargetAllowed(target, allowed);
    }

    /// @notice Recompute the digest from the fields presented.
    ///
    /// @dev Never trusts the digest carried in the receipt. Recomputing is the whole point:
    /// a caller who changed a field would have to produce a matching digest, and a digest
    /// that matches was signed.
    function computeOperationDigest(
        address asset,
        address sender,
        address recipient,
        uint8 actionClass,
        uint256 rawAmount,
        address targetContract,
        uint256 expectedMultiplierWad,
        bytes32 policyVersionHash
    ) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                OPERATION_DIGEST_TAG,
                abi.encode(
                    SCHEMA_VERSION,
                    block.chainid,
                    address(this),
                    asset,
                    sender,
                    recipient,
                    actionClass,
                    rawAmount,
                    targetContract,
                    expectedMultiplierWad,
                    policyVersionHash
                )
            )
        );
    }

    /// @dev Encoded in two chunks and concatenated, not because that is nicer but because
    /// sixteen fields in one `abi.encode` exhausts the EVM stack. Every field here is a value
    /// type, so each chunk is whole 32-byte words and the concatenation is byte-identical to
    /// the single encode EIP-712 specifies. The golden vectors prove that against the
    /// TypeScript signer, which does perform the single encode.
    function hashReceipt(Receipt calldata receipt) public view returns (bytes32) {
        bytes memory head = abi.encode(
            RECEIPT_TYPEHASH,
            receipt.schemaVersion,
            receipt.receiptId,
            receipt.asset,
            receipt.sender,
            receipt.recipient,
            receipt.actionClass,
            receipt.rawAmount
        );
        bytes memory tail = abi.encode(
            receipt.operationDigest,
            receipt.activeMultiplierWad,
            receipt.pendingEffectiveAt,
            receipt.feedProxy,
            receipt.feedRoundId,
            receipt.priceBasis,
            receipt.policyVersionHash,
            receipt.issuedAt,
            receipt.expiresAt
        );
        return _hashTypedDataV4(keccak256(bytes.concat(head, tail)));
    }

    /// @notice Verify and execute, or revert with a named reason.
    ///
    /// @dev Checks-effects-interactions: every verification runs, the receipt is consumed,
    /// and only then is the target called. Consuming after the call would let a reentrant
    /// target replay the same receipt.
    function execute(Receipt calldata receipt, bytes calldata signature, address target) external nonReentrant {
        _verify(receipt, signature, target);

        // Effect before interaction. A receipt consumed here cannot be replayed by anything
        // the target does, including calling back into this function.
        consumed[receipt.receiptId] = true;
        emit ReceiptConsumed(receipt.receiptId, receipt.sender, receipt.rawAmount);

        IB20ProtectedTarget(target)
            .performB20Action(receipt.actionClass, receipt.sender, receipt.recipient, receipt.rawAmount);

        emit ActionExecuted(receipt.receiptId, target, receipt.actionClass);
    }

    /// @dev Split out so the checks are readable and so a test can assert each independently.
    function _verify(Receipt calldata receipt, bytes calldata signature, address target) private view {
        if (receipt.schemaVersion != SCHEMA_VERSION) {
            revert UnsupportedSchemaVersion(receipt.schemaVersion, SCHEMA_VERSION);
        }
        if (consumed[receipt.receiptId]) revert ReceiptAlreadyConsumed(receipt.receiptId);
        if (!allowedTarget[target]) revert TargetNotAllowed(target);
        if (receipt.asset != protectedAsset) revert AssetMismatch(receipt.asset, protectedAsset);
        if (receipt.rawAmount == 0) revert ZeroAmount();
        if (receipt.recipient == address(0)) revert ZeroRecipient();

        // The receipt names its sender. Letting anyone present it would turn a receipt issued
        // to one integrator into a bearer instrument.
        if (msg.sender != receipt.sender) revert CallerIsNotSender(msg.sender, receipt.sender);

        if (block.timestamp < receipt.issuedAt) revert ReceiptNotYetValid(receipt.issuedAt);
        if (block.timestamp >= receipt.expiresAt) revert ReceiptExpired(receipt.expiresAt);

        bytes32 expectedDigest = computeOperationDigest(
            receipt.asset,
            receipt.sender,
            receipt.recipient,
            receipt.actionClass,
            receipt.rawAmount,
            target,
            receipt.activeMultiplierWad,
            receipt.policyVersionHash
        );
        if (receipt.operationDigest != expectedDigest) {
            revert OperationDigestMismatch(receipt.operationDigest, expectedDigest);
        }

        address signer = ECDSA.recover(hashReceipt(receipt), signature);
        if (!authorizedSigner[signer]) revert UnauthorizedSigner(signer);

        _assertChainStateStillMatches(receipt);
    }

    /// @dev The half a signature cannot cover: what the chain says right now.
    function _assertChainStateStillMatches(Receipt calldata receipt) private view {
        // A token whose WAD is not 1e18 would make every conversion above it wrong. Read
        // rather than assumed, and a mismatch is a hard stop rather than a rescale.
        uint256 wad = IB20Multiplier(receipt.asset).WAD_PRECISION();
        if (wad != EXPECTED_WAD) revert UnexpectedWadPrecision(wad);

        uint256 observed = IB20Multiplier(receipt.asset).multiplier();
        if (observed != receipt.activeMultiplierWad) {
            revert MultiplierChanged(receipt.activeMultiplierWad, observed);
        }

        if (IB20Pausable(receipt.asset).isPaused(PAUSABLE_TRANSFER)) revert TransfersPaused();

        // The scheduling surface may not be dialed. A staticcall that fails tells us the
        // chain cannot answer, which is not the same as "nothing is scheduled" — so the
        // committed value is simply not contradicted, and the receipt's short lifetime is
        // what bounds the risk. Where the surface *is* live, a schedule that appeared after
        // issuance contradicts a receipt that committed to none.
        (bool ok, bytes memory data) =
            receipt.asset.staticcall(abi.encodeWithSelector(IB20Scheduled.effectiveAt.selector));
        if (ok && data.length == 32) {
            uint256 observedEffectiveAt = abi.decode(data, (uint256));
            if (observedEffectiveAt != uint256(receipt.pendingEffectiveAt)) {
                revert ScheduleAppeared(receipt.pendingEffectiveAt, observedEffectiveAt);
            }
        }
    }

    /// @notice Whether the chain exposes the scheduled-multiplier surface for this asset.
    ///
    /// @dev Exposed so an operator can see *why* a deployment's guarantees are narrower on one
    /// chain than another, rather than inferring it from behaviour.
    function scheduledSurfaceAvailable() external view returns (bool) {
        (bool ok, bytes memory data) =
            protectedAsset.staticcall(abi.encodeWithSelector(IB20Scheduled.effectiveAt.selector));
        return ok && data.length == 32;
    }
}
