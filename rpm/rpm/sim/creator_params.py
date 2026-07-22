"""Creator-set parameters: is there an edge worth bounding in the program?

Fee model as implemented in bounds.py: Ante is free, the fee is charged once at
go-live as a haircut against converting positions, and after go-live it is taken
at entry. A position that withdraws during Ante pays nothing.

The split of that fee between protocol and creator is a business decision with
no mechanism content, so it is not simulated here. What is simulated is the
part that does have mechanism content: if the creator also chooses lambda and
the Ante threshold, and takes a position of their own, do those choices pay
them more than they pay anyone else who entered at the same time?

  A  lambda: creator holds an early position, sweep lambda across the band
  B  threshold: sweep the Ante threshold at fixed lambda
  C  the same, for a non-creator who happened to enter at the same moment

If A and C move together, lambda is not a creator edge, it is an early-entry
edge that the creator merely happens to be first in line for. If they diverge,
the parameter needs a hard bound in the program rather than a recommendation.
"""
import random
from pmm_reference import Market

BAND = [0.25, 0.4, 0.5, 0.6]


def episode(lam, threshold_trades, rng, creator_stake=500, rival_stake=500):
    """Creator opens and takes a position. A rival enters at the same moment
    with the same money on the same outcome. Trading follows. Returns the two
    payouts conditional on outcome 0 winning."""
    m = Market(2, lam)
    m.buy(0, creator_stake)
    creator = m.pos[-1]
    m.buy(0, rival_stake)
    rival = m.pos[-1]
    m.buy(1, 100)
    for _ in range(threshold_trades):
        m.buy(rng.randrange(2), rng.choice([50, 100, 250, 500]))
    idx = [x for x in m.pos if x['i'] == 0]
    R = m.pool - sum(m.floor_of(x) for x in idx)
    q_w = sum(x['shares'] for x in idx)
    pay = lambda p: m.floor_of(p) + R * p['shares'] / q_w
    return pay(creator) / creator_stake, pay(rival) / rival_stake, m


def sweep_lambda():
    print("A and C. creator against a rival who entered at the same moment")
    print("   lambda   creator   rival    gap     creator share of winner payouts")
    for lam in BAND:
        rng = random.Random(5)
        c_tot, r_tot, share = [], [], []
        for _ in range(400):
            c, r, m = episode(lam, rng.randint(20, 50), rng)
            c_tot.append(c)
            r_tot.append(r)
            idx = [x for x in m.pos if x['i'] == 0]
            R = m.pool - sum(m.floor_of(x) for x in idx)
            q_w = sum(x['shares'] for x in idx)
            tot = sum(m.floor_of(x) + R*x['shares']/q_w for x in idx)
            me = m.floor_of(m.pos[0]) + R*m.pos[0]['shares']/q_w
            share.append(me / tot)
        c = sum(c_tot)/len(c_tot); r = sum(r_tot)/len(r_tot)
        print(f"   {lam:<8.2f} {c:>7.3f}x {r:>7.3f}x {c-r:>+7.4f}  {sum(share)/len(share):>22.1%}")
    print("   A gap of zero means lambda pays early entry, not the creator.")
    print()


def sweep_threshold():
    """The creator also picks when Ante ends. This needs BootMarket, which has
    an Ante mode. Market does not, so an earlier version of this function was
    measuring nothing. The comparison that matters is not creator against a
    rival who entered beside them, since those two move as a pair, but early
    against late: if a low threshold tilts harder toward early money, a creator
    who is always first has a reason to set it low."""
    from bootstrap import BootMarket
    print("B. Ante length at lambda = 0.4, early against late return")
    print("   threshold   converted   early    late    tilt")
    for th in [50, 200, 1000, 5000, 25000]:
        rng = random.Random(13)
        early, late, conv, n = [], [], 0, 0
        for _ in range(400):
            m = BootMarket(2, 0.4, threshold=th)
            m.buy(0, 500)
            first = m.pos[-1]
            m.buy(1, 500)
            for _ in range(rng.randint(20, 50)):
                m.buy(rng.randrange(2), rng.choice([50, 100, 250, 500]))
            m.buy(0, 500)
            last = m.pos[-1]
            conv += m.curve
            n += 1
            idx = [x for x in m.pos if x['i'] == 0]
            R = m.pool - sum(m.floor_of(x) for x in idx)
            q_w = sum(x['shares'] for x in idx)
            pay = lambda p: m.floor_of(p) + R * p['shares'] / q_w
            early.append(pay(first) / 500)
            late.append(pay(last) / 500)
        e = sum(early)/len(early); l = sum(late)/len(late)
        print(f"   {th:>9} {conv/n:>10.0%} {e:>8.3f}x {l:>7.3f}x {e/l:>6.2f}x")
    print()


def wash_farming(creator_fee_share):
    """If the creator earns a share of the fee, can they wash their own market
    to farm it back? They pay the full fee and receive their share of it, so the
    round trip is lossy unless the share reaches 1.0."""
    print("D. creator washing their own market to farm the fee back")
    print("   creator fee share   net per 10,000 cycled at 100 bps")
    for s in creator_fee_share:
        fee = 10_000 * 0.01
        print(f"   {s:>17.0%}   {fee*s - fee:>+28.2f}")
    print("   Lossy at every share below 100%. At 100% it is free, which is the")
    print("   only hard constraint the split has to respect.")
    print()


if __name__ == "__main__":
    sweep_lambda()
    sweep_threshold()
    wash_farming([0.0, 0.25, 0.5, 0.8, 1.0])
