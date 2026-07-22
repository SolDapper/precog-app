"""
Can Ante be made genuinely different: fully liquid until the board goes Live?

Melee's presale locks passive capital until launch. Their no-presale path is a
parimutuel bootstrap, which is Ante as currently specified. The question is
whether Ante positions can be withdrawn at par right up until conversion.

The catch: withdrawal removes value from the pool, and (I) is P >= S[i] for
EVERY outcome, so pulling money out of outcome i can break the invariant on
outcome j. Below we test two variants.

  variant A: ratchets run during Ante (floors accrue before the board is live)
  variant B: ratchets are disabled until conversion

Prediction: A breaks, B holds. If B holds, Ante becomes a no-lock, no-risk,
crowd-priced opening phase, which is a real difference rather than a rename.
"""

import random
from int_reference import IntMarket, BPS


class AnteMarket(IntMarket):
    def __init__(self, *a, ratchet_in_ante=False, **kw):
        super().__init__(*a, **kw)
        self.ratchet_in_ante = ratchet_in_ante

    def _ratchet(self, i, c):
        if not self.curve and not self.ratchet_in_ante:
            return                      # variant B: no rewards before the board is live
        # _apply_ratchet, not _ratchet: the base class gates on self.curve, and
        # variant A is precisely the case that needs to bypass that gate.
        self._apply_ratchet(i, c)

    def withdraw(self, p):
        """Leave the market at par. Only legal while the market is in Ante."""
        if self.curve:
            return False                # Live: locked, exit is peer to peer
        c = p['c']
        self.q[p['i']] -= p['s']
        self.P         -= c
        self.S[p['i']] -= self.floor_of(p)
        self.pos.remove(p)
        return True


def run(ratchet_in_ante, trials=2000):
    random.seed(23)
    breaks = 0
    for _ in range(trials):
        n = random.choice([2, 3, 3, 10])
        m = AnteMarket(n,
                       lam_bps=random.choice([2500, 5000, 9900]),
                       threshold=random.choice([10**6, 10**9, 10**12]),
                       fee_bps=random.choice([0, 30]),
                       ratchet_in_ante=ratchet_in_ante)
        try:
            for _ in range(random.randint(3, 60)):
                if random.random() < 0.65 or not m.pos:
                    m.buy(random.randrange(n), random.choice([10**3, 10**6, 10**9, 10**12]))
                else:
                    m.withdraw(random.choice(m.pos))
                m.check()
            if m.pos:
                m.settle(random.randrange(n))
        except AssertionError:
            breaks += 1
    return breaks


if __name__ == "__main__":
    for label, flag in [("A: ratchets run during Ante", True),
                        ("B: ratchets start at go-live", False)]:
        b = run(flag)
        verdict = "BREAKS" if b else "holds"
        print(f"{label:34} {verdict:7} ({b}/2000 markets violated the invariant)")

    # a withdrawal must never be possible once the board is Live
    random.seed(1)
    m = AnteMarket(3, lam_bps=5000, threshold=10**6, fee_bps=0)
    for i in range(3):
        m.buy(i, 10**6)
    assert m.curve, "expected conversion"
    assert m.withdraw(m.pos[0]) is False, "withdrawal leaked into Live mode"
    m.check()
    print("\nwithdrawal correctly refused once the board is Live.")

    # and the money-back guarantee in Ante is unconditional, not outcome-conditional
    m2 = AnteMarket(3, lam_bps=5000, threshold=10**12, fee_bps=0)
    p = m2.buy(0, 500_000)
    before = m2.P
    m2.buy(1, 250_000)
    m2.withdraw(p)
    print(f"Ante withdrawal returned the full cost basis: "
          f"pool {before} -> {m2.P} after a {p['c']} exit, no outcome risk taken.")
