"""Where the fee is collected, and what the threshold does to it.

Two candidate rules, both with a free Ante:

  H  go-live haircut   positions converting at go-live are charged once, and
                       every Live buy is charged at entry
  L  Live only         converting positions are never charged, and only buys
                       made after go-live pay anything

Both are safe for the invariant. H was verified to 5% in bounds.py, and L takes
nothing out of the pool at conversion, so it is strictly easier. The question is
revenue, because the threshold is set by the market creator and it decides how
much of a market's volume arrives before the fee starts applying.

Fee 100 bps, lambda 0.4, which are the current defaults.
"""
import random
from int_reference import IntMarket, BPS
from bounds import HaircutMarket


class LiveOnlyMarket(IntMarket):
    """Ante is free and stays free. Nothing is charged at conversion."""
    def buy(self, i, value, owner=0):
        if not self.curve:
            saved, self.fee_bps = self.fee_bps, 0
            p = super().buy(i, value, owner)
            self.fee_bps = saved
            return p
        return super().buy(i, value, owner)


def run(cls, threshold, trials=300, seed=5):
    rng = random.Random(seed)
    takes = []
    for _ in range(trials):
        m = cls(2, lam_bps=4000, threshold=threshold, fee_bps=100)
        for _ in range(rng.randint(20, 40)):
            m.buy(rng.randrange(2), rng.choice([10**7, 5*10**7, 10**8]))
        gross = m.P + m.fees
        if gross == 0:
            continue
        takes.append((m.fees / gross, m.curve))
    rate = sum(t for t, _ in takes) / len(takes)
    conv = sum(c for _, c in takes) / len(takes)
    return rate, conv


if __name__ == "__main__":
    print("effective take as a fraction of all money paid in, headline rate 1.00%")
    print("   threshold        converted    haircut at go-live    Live buys only")
    for th in [10**6, 10**8, 5*10**8, 10**9, 2*10**9, 5*10**9]:
        h, conv = run(HaircutMarket, th)
        l, _    = run(LiveOnlyMarket, th)
        print(f"   {th:>13,} {conv:>11.0%} {h:>21.3%} {l:>17.3%}")
    print()
    print("   A creator picks the threshold. Under the haircut it moves the take")
    print("   very little, because everything in the pool at conversion is charged")
    print("   once either way. Under Live only it is a dial: set the threshold near")
    print("   the volume the market will actually attract and most of the money")
    print("   never passes a fee.")
