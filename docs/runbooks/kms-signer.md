# Runbook — AWS KMS receipt signer

## Required key

Create an asymmetric AWS KMS key with key spec `ECC_SECG_P256K1` and key usage
`SIGN_VERIFY`. Give it a stable alias only after the key policy has been reviewed. The API
requests `ECDSA_SHA_256` over the already-computed EIP-712 digest (`MessageType=DIGEST`),
normalizes high-s results, derives the recovery bit, and rejects a signature that does not
recover the configured address.

Derive the address through KMS `GetPublicKey`:

```bash
AWS_REGION=ap-south-1 AWS_KMS_KEY_ID=alias/cag-receipt-signer \
  pnpm signer:kms-address
```

The API role needs no decrypt, encrypt, key-management, or data-key permission. Replace the
resource ARN below with the exact key ARN; never use `Resource: "*"`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SignReceiptDigestsOnly",
      "Effect": "Allow",
      "Action": "kms:Sign",
      "Resource": "arn:aws:kms:REGION:ACCOUNT:key/KEY_ID",
      "Condition": {
        "StringEquals": { "kms:SigningAlgorithm": "ECDSA_SHA_256" }
      }
    },
    {
      "Sid": "VerifyConfiguredSignerIdentity",
      "Effect": "Allow",
      "Action": "kms:GetPublicKey",
      "Resource": "arn:aws:kms:REGION:ACCOUNT:key/KEY_ID"
    }
  ]
}
```

Set `RECEIPT_SIGNER_MODE=aws-kms`, `AWS_REGION`, `AWS_KMS_KEY_ID`, and the derived
`RECEIPT_SIGNER_ADDRESS`. Leave `RECEIPT_SIGNER_PRIVATE_KEY` absent. Production startup
rejects any other arrangement.

## Readiness and incident response

`/v1/health/ready` calls `GetPublicKey` (cached for 30 seconds) and checks key spec, usage,
signing algorithm, and Ethereum address. A KMS/IAM outage makes the API not ready; signing
also times out and returns no placeholder receipt. Use the correlation-id and idempotency
procedure in [`signer-unknown.md`](signer-unknown.md).

Enable CloudTrail KMS data-event visibility in the target account, alert on denied or
unexpected `Sign` calls, and keep AWS request details in the restricted log backend. The
public readiness response reports only an error class, never a key ARN or AWS request text.

## Two-step rotation

1. Create a new key and derive its Ethereum address.
2. Grant the API role access to both keys temporarily.
3. Add the new address to `ActionGuardAdapter` using the contract owner's authorized
   rotation path. Verify the transaction and bytecode/chain identity.
4. Change the API KMS key id and signer address together; wait for readiness and issue a
   canary receipt through the normal preflight path.
5. Wait longer than the maximum receipt lifetime, then remove the old signer from the
   adapter.
6. Remove old IAM access, schedule KMS key disablement according to incident/retention
   policy, and retain the transaction, CloudTrail, and release identifiers.

Never remove the old signer before the new API is healthy; never keep both indefinitely.
An emergency compromise skips the overlap only when accepting that all outstanding old
receipts must be invalidated.
