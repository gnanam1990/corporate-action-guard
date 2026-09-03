# Test fixtures — captured from live production

**TEST FIXTURES.** Not runtime data. These files exist only so unit tests are
deterministic; they are never used as a fallback when a production call fails (ADR 0003).

| File                    | Source                                                                            | Captured (UTC) |
| ----------------------- | --------------------------------------------------------------------------------- | -------------- |
| `aaplx-asset.json`      | `GET https://api.xstocks.fi/api/v2/public/assets/AAPLx`                           | 2026-09-03     |
| `aaplx-multiplier.json` | `GET https://api.xstocks.fi/api/v2/public/assets/AAPLx/multiplier?network=XLayer` | 2026-09-03     |

`aaplx-asset.json` is trimmed to the X Layer deployment and the fields this product reads.
`aaplx-multiplier.json` is the verbatim response body, byte for byte, because the exact
numeric literal is the point of the test.

Nothing here contains a credential, a key, or personal data.
