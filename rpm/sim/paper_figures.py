"""Every number quoted in whitepaper section 2, regenerated from the current
simulators, under both position grouping models.

Section 2 states that every claim in it is implemented in the reference
simulator and checked. Three figures in the prose had no script in the artifact
set that produced them, so they could not be re-derived after the simulators
changed, and at least one of them was computed while `pmm_reference.Market`
still credited a phantom seed. This file is the source for those numbers and it
runs with the rest of the suite.

It also settles a question the position model raises. A v2 position is seeded on
something immutable, so the protocol does not enforce one position per owner per
outcome, and a second buy on an outcome the owner already holds may either open
a separate position or be added to the existing one. Both are reachable in the
same program, chosen per transaction by the account the client passes. Every
figure quoted in the paper therefore has to hold under both, which cannot be
assumed and is measured here.

The trade sequences are identical across the two models. Owners are drawn from a
separate random stream, so the outcome and amount of every buy is the same in
both columns and only the grouping differs. The separate-position column is the
model the base simulators use and its numbers are the ones the paper quotes.

  1. the withdrawal bound as a market grows                            (2.9)
  2. whether a position could actually exit                            (2.9)
  3. truncation slack and retained settlement dust                     (2.11)
  4. switch round-trip behaviour in integer arithmetic                 (2.8)
"""
import random

from pmm_reference import Market, max_withdrawal
from int_reference import IntMarket, ACC
from position_merge import MergeMarket

OWNERS = 4


class RealMergeMarket(Market):
    """Real arithmetic, with a buy added to a position the owner already holds.

    Same bank-then-extend as position_merge.MergeMarket: the accrued floor is
    crystallised into the base before the snapshot moves, or the position loses
    every reward it had earned.
    """

    def buy(self, i, dollars, owner=0):
        d = super().buy(i, dollars)
        new = self.pos[-1]
        new['owner'] = owner
        held = next((p for p in self.pos[:-1]
                     if p.get('owner') == owner and p['i'] == i), None)
        if held is None:
            return d
        self.pos.pop()
        held['base']    = self.floor_of(held) + new['base']
        held['shares'] += new['shares']
        held['snap']    = self.acc[i]
        held['cost']   += new['cost']
        return d


def _mk(cls_append, cls_merge, merge, *a, **kw):
    return (cls_merge if merge else cls_append)(*a, **kw)


def _buy(m, i, v, owner, merge):
    return m.buy(i, v, owner=owner) if merge else m.buy(i, v)


# ---- 1. withdrawal bound ----------------------------------------------------

def withdrawal_bound(trials=600, merge=False):
    """2.9: does redemption capacity grow as the market grows?

    v <= P - max( S_a - F_p , max_{j!=a} S_j )

    A buy of c on outcome i raises P by c. It raises S_i by c, so P - S_i is
    unchanged, and it raises every other S_j by lambda*c, so P - S_j grows by
    (1 - lambda)*c. The bound is a max over the other outcomes, so it holds
    flat only while flow keeps landing on whichever outcome currently binds.
    Flow landing anywhere else lifts it.
    """
    random.seed(29)
    orng = random.Random(101)
    grew, flat, worst_ratio = 0, 0, 1.0
    for _ in range(trials):
        n = random.choice([2, 3, 10])
        lam = random.choice([0.25, 0.4, 0.6])
        m = _mk(Market, RealMergeMarket, merge, n, lam)
        for k in range(n):
            _buy(m, k, 200, orng.randrange(OWNERS), merge)
        p = m.pos[0]
        first = max_withdrawal(m, p)
        seen = first
        for _ in range(random.randint(5, 40)):
            _buy(m, random.randrange(n), random.choice([50, 200, 1000, 5000]),
                 orng.randrange(OWNERS), merge)
            v = max_withdrawal(m, p)
            if v > seen + 1e-9:
                grew += 1
            else:
                flat += 1
            seen = v
        if first > 0:
            worst_ratio = max(worst_ratio, seen / first)
    return grew, flat, worst_ratio


# ---- 2. exit reliability ----------------------------------------------------

def exit_reliability(trials=600, merge=False):
    """2.9 replacement measurement: could a position actually leave?

    Capacity growing is not the same as a position being able to use it. This
    asks, at a random moment in a market's life, what fraction of positions
    could withdraw their own floor, and what fraction could recover even their
    cost basis.
    """
    random.seed(37)
    orng = random.Random(101)
    can_floor, can_cost, total = 0, 0, 0
    for _ in range(trials):
        n = random.choice([2, 3, 10])
        lam = random.choice([0.25, 0.4, 0.6])
        m = _mk(Market, RealMergeMarket, merge, n, lam)
        for k in range(n):
            _buy(m, k, 200, orng.randrange(OWNERS), merge)
        for _ in range(random.randint(5, 40)):
            _buy(m, random.randrange(n), random.choice([50, 200, 1000, 5000]),
                 orng.randrange(OWNERS), merge)
        for p in m.pos:
            v = max_withdrawal(m, p)
            total += 1
            can_floor += v + 1e-9 >= m.floor_of(p)
            can_cost  += v + 1e-9 >= p['cost']
    return can_floor / total, can_cost / total, total


# ---- 3. truncation slack ----------------------------------------------------

def truncation_slack(trials=400, merge=False):
    """2.11: P >= S_i >= sum of floors, and the middle gap only grows."""
    random.seed(19)
    orng = random.Random(101)
    worst_slack = 0
    total_dust = 0
    total_pool = 0
    for _ in range(trials):
        n = random.choice([2, 3, 10])
        m = _mk(IntMarket, MergeMarket, merge, n,
                lam_bps=random.choice([2500, 4000, 9900]),
                threshold=10**6,
                fee_bps=random.choice([0, 100]))
        for _ in range(random.randint(10, 60)):
            _buy(m, random.randrange(n),
                 random.choice([1, 2, 7, 10**3, 10**6, 10**9, 10**12]),
                 orng.randrange(OWNERS), merge)
            m.check()
            for i in range(n):
                held = sum(m.floor_of(x) for x in m.pos if x['i'] == i)
                worst_slack = max(worst_slack, m.S[i] - held)
        w = random.randrange(n)
        if not any(x['i'] == w for x in m.pos):
            continue                 # no holder on the winning outcome: the whole
                                     # pool is unclaimed, which is not dust
        total_pool += m.P
        paid, dust = m.settle(w)
        total_dust += dust
    return worst_slack, total_dust, total_pool


# ---- 4. switch round trip ---------------------------------------------------

def switch_roundtrip(trials=2000, merge=False):
    """2.8: what a round trip actually does to share count on chain.

    Under the merged model a leg can land on a position the owner already
    holds, which absorbs the moving position and leaves a round-trip share
    ratio undefined against the original count. Those trips are counted and
    excluded rather than measured against the wrong denominator, which is the
    mistake recorded as error 22.
    """
    random.seed(23)
    orng = random.Random(101)
    worst, gains, n_rt, absorbed = 0.0, 0, 0, 0
    for t in range(trials):
        n = random.choice([2, 3])
        m = _mk(IntMarket, MergeMarket, merge, n,
                lam_bps=4000, threshold=10**6, fee_bps=0)
        for _ in range(random.randint(6, 30)):
            _buy(m, random.randrange(n), random.choice([10**5, 10**7, 10**9]),
                 orng.randrange(OWNERS), merge)
        if not m.curve or not m.pos:
            continue
        p = random.choice(m.pos)
        a, b = p['i'], (p['i'] + 1) % n
        if m.q[b] == 0:
            continue
        s0 = p['s']
        out = m.switch(p, b)
        if out is not p:
            absorbed += 1
            continue
        if p['i'] != b:
            continue
        out = m.switch(p, a)
        if out is not p:
            absorbed += 1
            continue
        if p['i'] != a:
            continue
        n_rt += 1
        worst = max(worst, p['s'] / s0)
        gains += p['s'] > s0
    return n_rt, gains, worst, absorbed


# ---- reporting --------------------------------------------------------------

def _row(label, *cells):
    print(f"     {label:<24}" + "".join(f"{c:>24}" for c in cells))


def main():
    print("Separate: every buy opens its own position, which is what the base")
    print("simulators do and what the paper quotes. Merged: a buy is added to a")
    print("position the same owner already holds. Identical trades either way.")
    print()

    a = withdrawal_bound(merge=False)
    b = withdrawal_bound(merge=True)
    print("2.9  withdrawal bound as the market grows")
    _row("", "separate", "merged")
    _row("buys raising it", f"{a[0]:,}", f"{b[0]:,}")
    _row("flat or lower", f"{a[1]:,}", f"{b[1]:,}")
    _row("largest ratio", f"{a[2]:,.1f}x", f"{b[2]:,.1f}x")
    print("     The bound is not invariant to growth. What is invariant is that a")
    print("     deposit never raises the capacity of the outcome it lands on,")
    print("     since it adds as much to that outcome's obligation as to the pool.")
    print("     That is a statement about the buy arithmetic, which grouping does")
    print("     not touch, so it holds under both.")
    print()

    a = exit_reliability(merge=False)
    b = exit_reliability(merge=True)
    print("2.9  could a position actually exit, sampled across market lives")
    _row("", "separate", "merged")
    _row("could take its floor", f"{a[0]:.1%}", f"{b[0]:.1%}")
    _row("could take its basis", f"{a[1]:.1%}", f"{b[1]:.1%}")
    _row("positions sampled", f"{a[2]:,}", f"{b[2]:,}")
    print()

    a = truncation_slack(merge=False)
    b = truncation_slack(merge=True)
    print("2.11 truncation slack and retained dust, 400 markets, adversarial flow")
    _row("", "separate", "merged")
    _row("worst S_i less floors", f"{a[0]:,}", f"{b[0]:,}")
    _row("retained dust", f"{a[1]:,}", f"{b[1]:,}")
    _row("total pooled", f"{a[2]:,}", f"{b[2]:,}")
    print("     All base units. Dust is retained by the pool under both, so the")
    print("     direction of the claim in 2.11 does not depend on grouping.")
    print()

    a = switch_roundtrip(merge=False)
    b = switch_roundtrip(merge=True)
    print("2.8  switch round trip in integer arithmetic")
    _row("", "separate", "merged")
    _row("completed trips", f"{a[0]:,}", f"{b[0]:,}")
    _row("share-positive trips", f"{a[1]:,}", f"{b[1]:,}")
    _row("worst ratio", f"{a[2]:.12f}", f"{b[2]:.12f}")
    _row("absorbed, excluded", f"{a[3]:,}", f"{b[3]:,}")
    assert a[1] == 0 and b[1] == 0
    print("     isqrt floors on each leg, so the trip is lossy in shares as well")
    print("     as in floor. Exact reversibility is a property of the real-valued")
    print("     closed form only, and does not survive integer truncation. No trip")
    print("     returned more shares than it consumed under either model.")
    print()


if __name__ == "__main__":
    main()
