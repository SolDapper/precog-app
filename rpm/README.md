# RPM: the ratcheting parimutuel market

Specification and reference simulators for the mechanism described in
`precog-rpm-whitepaper.md`.

An RPM market opens flat, with one share per unit on every outcome and no
capital committed by anyone. Positions stay liquid at par until every outcome
carries stake and the pool clears a published threshold, at which point the
market converts to share-ratio curve pricing initialized from the stakes
already present, so the payout ratio is continuous across the handoff. Every
position carries a floor, quoted when it is bought and equal to what was paid,
which rises as capital arrives on opposing outcomes. A position in the realized
outcome is paid at least its floor.

The whole construction rests on one inequality: the pool is at least the
outstanding floor obligation on every outcome, after every operation. It is
evaluable by any third party from public account state.

## Contents

| Path | What it is |
|---|---|
| `precog-rpm-whitepaper.md` | The specification. Cover, introduction, mechanism, proofs, integer arithmetic, limits |
| `sim/` | Reference simulators. Every numeric claim in the paper is regenerated here |
| `system-diagram.svg` | Appendix A. Renders inline in the whitepaper on GitHub |

## Running the simulators

No dependencies beyond a Python 3 standard library.

```
cd sim
python3 pmm_reference.py     # real arithmetic: invariant, switching, settlement
python3 int_reference.py     # integer arithmetic and the rounding discipline
python3 ante.py              # flat-price opening, withdrawal, ratchet gating
python3 bootstrap.py         # conversion from flat pricing to the curve
python3 bounds.py            # arithmetic bounds, overflow, go-live fee haircut
python3 void_refund.py       # the refund path after a void, and its rounding
python3 paper_figures.py     # every number quoted in the paper
```

Each file asserts its own results and exits non-zero on failure. The suite takes
a few minutes end to end.

## Precog

The parimutuel implementation this work extends has been running on Solana
since February 2026, MIT licensed, with no backend. RPM ships an indexer for
reads, because positions are no longer derivable from an address. It holds no
authority and settles nothing, and the solvency check in the paper is made
against chain state without it.

| | |
|---|---|
| Program | `github.com/honeygrahams2/precog` |
| SDK | `github.com/SolDapper/precog-markets`, npm `precog-markets` |
| App | `github.com/SolDapper/precog-app` |
| Program ID | `6KfoCcTUVsS8i1h31dhK8cydvDXGmRyTdya7jbjoymn9` |
| Live | precogmarket.com |

RPM ships as a separate program, SDK and app. The existing protocol stays live
and this work does not modify it.

## Licence

MIT.
