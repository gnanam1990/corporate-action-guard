# Design system

## Direction

Institutional risk operations. Calm, dense, technical.

The visual job is to make an unsafe state impossible to miss and a safe state
unremarkable — the opposite of a consumer trading interface, where everything competes for
attention. An operator watching this console at 3 a.m. should be able to look away from it
safely, and be pulled back when something is wrong.

Deliberately absent: neon crypto styling, gradient washes, glassmorphism, a full-viewport
hero, emoji icons, celebratory motion, and an unmodified component-library look.

Dark-first. A light theme is **not shipped** rather than shipped broken.

## Tokens are the only colour source

Components reference semantic token names. A raw hex value in a component is a bug: it
makes status colour impossible to audit and impossible to change coherently.

```text
--surface-base / raised / overlay / muted / inset      four steps of elevation
--text-primary / secondary / muted / inverse
--border-subtle / default / strong
--status-{verified,pending,blocked,chain,unknown}-{fg,bg,border}
--action-primary / destructive
--focus-ring
```

Note that **`unknown` has its own colour**. "Not determined" is not a soft failure and not
a mild success — it is its own state, and the palette says so. That mirrors the domain,
where `UNKNOWN` is distinct from `FAIL` and neither produces an ALLOW.

## Never colour alone

Every status carries **three** signals: a colour, a distinct glyph _shape_, and a text
label.

| Status     | Glyph     | Meaning                                    |
| ---------- | --------- | ------------------------------------------ |
| `verified` | check     | Canonical, agreed, allowed                 |
| `pending`  | clock     | Scheduled or inside the guard window       |
| `blocked`  | cross     | Mismatch, stale, or refused                |
| `chain`    | crosshair | On-chain evidence, factual not a judgement |
| `unknown`  | question  | Could not be determined                    |

The glyphs are separable in greyscale. This matters because roughly one man in twelve has a
colour vision deficiency, because a screenshot pasted into an incident report can lose
colour meaning, and because a printed page has none at all. A status that is only a green
dot is not a status.

`StatusBadge` requires a `label`. There is no icon-only variant.

## Contrast is measured, not eyeballed

`pnpm check:contrast` parses the token file and asserts every meaningful pair against WCAG
2.2: **4.5:1** for text, **3:1** for large text and meaningful non-text UI. It runs in
`pnpm verify` and in CI, so a palette change that drops a status below readable fails the
build.

It found three real failures on first run — `border-default`, and the verified and blocked
badge borders, all around 1.9–2.1:1 against their backgrounds. Every border token was
raised to a measured passing value rather than adjusted by eye. **28 pairs pass**, the
tightest being the blocked badge border at 3.34:1.

## Typography

- **Fira Sans** for UI text, with a real fallback stack.
- **Fira Code** _only_ for addresses, hashes, nonces, digests, and evidence IDs — the
  values an operator compares character by character. Ligatures are disabled, because a
  ligature in a hash is actively harmful.

## Interaction and accessibility

Target: WCAG 2.2 AA.

- **Focus** is a 3px white ring with a 2px offset — high contrast against every surface
  (16.5:1 at worst) and thick enough to find on a dense table. It is never removed.
- **Keyboard** operation is complete. The skip link is the first focusable element.
- **Touch targets** are at least 44×44 CSS px, including icon-only controls. An operator
  responding to an incident may well be on a phone.
- **Icon-only controls** carry an accessible name; decorative glyphs are `aria-hidden`.
- **Truncated addresses** put the full value in the accessible name, so a screen reader
  gets what the eye cannot.
- **Copy** announces through a polite live region and does not move focus. It stops event
  propagation, so a copy control inside a clickable row never also navigates.
- **`prefers-reduced-motion`** removes all animation. Data appears immediately, with no
  entrance choreography — an operator investigating an incident should never wait on one.
- **`forced-colors`** hands the focus ring back to the system palette.
- The degraded banner sits **in the flow, not fixed**, so it can never cover a focused
  control.

## The shell tells the truth about itself

`sourceHealth` is `readonly SourceHealth[] | undefined`, and `undefined` renders as
**unknown**, not healthy.

A console that looks fine when it cannot reach its own API is the worst possible failure
mode for a product whose entire claim is about not trusting stale state. The shell has no
default that could produce a green console from no data.

The footer restates the enforcement boundary on every page: the guard covers only paths
routing through `ActionGuardAdapter`, a direct ERC-20 transfer bypasses it, and mainnet is
read-only.

## No fake product data, anywhere

The foundation pages render the status vocabulary and the primitives against declared
placeholder text. There is no asset list, no metric value, no balance, no health value, and
no transaction hash. Metric cards show `—` with "Awaiting the API".

This is not a stylistic choice. A placeholder that looked like product data is exactly the
failure [ADR 0003](architecture/decisions/0003-live-data-and-testnet-fixture-policy.md)
forbids, and the bundle scanner in CI enforces the same rule mechanically.

## Responsive

Verified widths: **390 / 768 / 1280 / 1440**. No horizontal page scroll at any of them.

Below 900px the shell stacks and navigation becomes a horizontal scroller. Below 480px the
brand text drops and the mark carries identity; the full title remains in `<title>`.

Wide tables use an explicitly labelled scroll region on tablet and become cards on phone —
critical status and freshness stay visible without opening each card.
