"""Every number quoted in litepaper section 2, regenerated from the current
simulators.

Section 2 states that every claim in it is implemented in the reference
simulator and checked. Three figures in the prose had no script in the artifact
set that produced them, so they could not be re-derived after the simulators
changed, and at least one of them was computed while `pmm_reference.Market`
still credited a phantom seed. This file closes that gap: it is the source for
the numbers in 2.9 and 2.11 and it runs with the rest of the suite.

  1. the withdrawal bound holding flat while the pool grows            (2.9)
  2. truncation slack and retained settlement dust                     (2.11)
  3. switch round-trip behaviour in integer arithmetic                 (2.8)
"""
import random
from pmm_reference import Market, max_withdrawal
from int_reference import IntMarket, ACC


def exit_reliability(trials=600):
    """2.9 replacement measurement: could a position actually leave?

    Capacity growing is not the same as a position being able to use it. This
    asks, at a random moment in a market's life, what fraction of positions
    could withdraw their own floor, and what fraction could recover even their
    cost basis.
    """
    random.seed(37)
    can_floor, can_cost, total = 0, 0, 0
    for _ in range(trials):
        n = random.choice([2, 3, 10])
        lam = random.choice([0.25, 0.4, 0.6])
        m = Market(n, lam)
        for k in range(n):
            m.buy(k, 200)
        for _ in range(random.randint(5, 40)):
            m.buy(random.randrange(n), random.choice([50, 200, 1000, 5000]))
        for p in m.pos:
            v = max_withdrawal(m, p)
            total += 1
            can_floor += v + 1e-9 >= m.floor_of(p)
            can_cost  += v + 1e-9 >= p['cost']
    print("2.9  could a position actually exit, sampled across market lives")
    print(f"     {can_floor/total:.1%} of positions could withdraw their full floor")
    print(f"     {can_cost/total:.1%} could recover at least their cost basis")
    print(f"     across {total:,} positions")
    print()
    return can_floor/total, can_cost/total, total


def withdrawal_bound(trials=600):
    """2.9: does redemption capacity grow as the market grows?

    v <= P - max( S_a - F_p , max_{j!=a} S_j )

    A buy of c on outcome i raises P by c. It raises S_i by c, so P - S_i is
    unchanged, and it raises every other S_j by lambda*c, so P - S_j grows by
    (1 - lambda)*c. The bound is a max over the other outcomes, so it holds
    flat only while flow keeps landing on whichever outcome currently binds.
    Flow landing anywhere else lifts it. This measures how often that happens.
    """
    random.seed(29)
    grew, flat, worst_ratio = 0, 0, 1.0
    for _ in range(trials):
        n = random.choice([2, 3, 10])
        lam = random.choice([0.25, 0.4, 0.6])
        m = Market(n, lam)
        for k in range(n):
            m.buy(k, 200)
        p = m.pos[0]
        first = max_withdrawal(m, p)
        seen = first
        for _ in range(random.randint(5, 40)):
            m.buy(random.randrange(n), random.choice([50, 200, 1000, 5000]))
            v = max_withdrawal(m, p)
            if v > seen + 1e-9:
                grew += 1
            else:
                flat += 1
            seen = v
        if first > 0:
            worst_ratio = max(worst_ratio, seen / first)
    print("2.9  withdrawal bound as the market grows")
    print(f"     {grew:,} buys raised the bound, {flat:,} left it flat or lower")
    print(f"     largest end-to-start ratio for a single position: {worst_ratio:,.1f}x")
    print("     The bound is not invariant to growth. What is invariant is that a")
    print("     deposit never raises the capacity of the outcome it lands on,")
    print("     since it adds as much to that outcome's obligation as to the pool.")
    print()
    return grew, flat, worst_ratio


def truncation_slack(trials=400):
    """2.11: P >= S_i >= sum of floors, and the middle gap only grows."""
    random.seed(19)
    worst_slack = 0
    total_dust = 0
    total_pool = 0
    for _ in range(trials):
        n = random.choice([2, 3, 10])
        m = IntMarket(n,
                      lam_bps=random.choice([2500, 4000, 9900]),
                      threshold=10**6,
                      fee_bps=random.choice([0, 100]))
        for _ in range(random.randint(10, 60)):
            m.buy(random.randrange(n),
                  random.choice([1, 2, 7, 10**3, 10**6, 10**9, 10**12]))
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
    print("2.11 truncation slack and retained dust, 400 markets, adversarial flow")
    print(f"     worst S_i minus the floors it covers: {worst_slack:,} base units")
    print(f"     retained settlement dust:             {total_dust:,} base units")
    print(f"     against a total pooled:               {total_pool:,} base units")
    print()
    return worst_slack, total_dust, total_pool


def switch_roundtrip(trials=2000):
    """2.8: what a round trip actually does to share count on chain."""
    random.seed(23)
    worst, gains, n_rt = 0.0, 0, 0
    for t in range(trials):
        n = random.choice([2, 3])
        m = IntMarket(n, lam_bps=4000, threshold=10**6, fee_bps=0)
        for _ in range(random.randint(6, 30)):
            m.buy(random.randrange(n), random.choice([10**5, 10**7, 10**9]))
        if not m.curve or not m.pos:
            continue
        p = random.choice(m.pos)
        a, b = p['i'], (p['i'] + 1) % n
        if m.q[b] == 0:
            continue
        s0 = p['s']
        m.switch(p, b)
        if p['i'] != b:
            continue
        m.switch(p, a)
        if p['i'] != a:
            continue
        n_rt += 1
        worst = max(worst, p['s'] / s0)
        gains += p['s'] > s0
    print("2.8  switch round trip in integer arithmetic")
    print(f"     {n_rt:,} completed round trips, {gains} returned more shares "
          f"than they consumed")
    print(f"     worst ratio {worst:.12f}")
    print("     isqrt floors on each leg, so the trip is lossy in shares as well")
    print("     as in floor. Exact reversibility is a property of the real-valued")
    print("     closed form only, and does not survive integer truncation.")
    print()
    return n_rt, gains, worst


if __name__ == "__main__":
    withdrawal_bound()
    exit_reliability()
    truncation_slack()
    switch_roundtrip()
