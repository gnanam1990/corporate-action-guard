# Deployment artifacts

Artifacts are written here only after post-broadcast bytecode verification. No artifact
present means nothing has been deployed. Never hand-write one.

## Source provenance of the live testnet deployment

The adapter at `0x5419941472c4a42FF0D68694c2A88F1b4716C337` (X Layer testnet, block
40037372) was compiled from the source at commit `480900b`.

The source has been edited since — comments, and the removal of a declared-but-never-reverted
`UnsupportedChain` error. Those edits change the trailing CBOR **metadata hash** embedded in
the runtime bytecode, so a strict byte-for-byte comparison against the deployed address now
reports a mismatch. **The executable bytecode is unchanged.**

That is a claim, so here is how to check it rather than believe it:

```sh
set -a; . ./.env; set +a
cast code 0x5419941472c4a42FF0D68694c2A88F1b4716C337 \
  --rpc-url "${XLAYER_TESTNET_RPC_URL:-https://testrpc.xlayer.tech}" > /tmp/onchain.hex
(cd contracts && forge build >/dev/null)
node -e '
const fs = require("fs");
const on = fs.readFileSync("/tmp/onchain.hex", "utf8").trim().replace(/^0x/, "");
const art = JSON.parse(fs.readFileSync("contracts/out/ActionGuardAdapter.sol/ActionGuardAdapter.json", "utf8"));
const loc = art.deployedBytecode.object.replace(/^0x/, "");
const strip = (h) => { const n = parseInt(h.slice(-4), 16); return h.slice(0, h.length - 4 - n * 2); };
console.log("byte-for-byte identical  :", on === loc);
console.log("identical minus metadata :", strip(on) === strip(loc));
'
```

Expected: `false` then `true`. The second line is the one that matters — it says every
executed instruction is the same. It also demonstrates that the removed error really was
dead: deleting it changed no executable byte.

Anyone wanting a byte-exact match should redeploy from the current tree. Nothing in this
repo depends on the existing address, and `pnpm testnet:deploy && pnpm testnet:prove`
reproduces the whole evidence set against a fresh one.
