#!/usr/bin/env node
import { GetPublicKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { ethereumAddressFromKmsPublicKey } from './signer.js';

const keyId = process.env['AWS_KMS_KEY_ID'];
const region = process.env['AWS_REGION'];
if (keyId === undefined || keyId === '') throw new Error('AWS_KMS_KEY_ID is required');
if (region === undefined || region === '') throw new Error('AWS_REGION is required');

const response = await new KMSClient({ region }).send(new GetPublicKeyCommand({ KeyId: keyId }), {
  abortSignal: AbortSignal.timeout(10_000),
});
if (
  response.PublicKey === undefined ||
  response.KeySpec !== 'ECC_SECG_P256K1' ||
  response.KeyUsage !== 'SIGN_VERIFY' ||
  !response.SigningAlgorithms?.includes('ECDSA_SHA_256')
) {
  throw new Error('KMS key must be ECC_SECG_P256K1 with SIGN_VERIFY and ECDSA_SHA_256');
}
process.stdout.write(`${ethereumAddressFromKmsPublicKey(response.PublicKey)}\n`);
