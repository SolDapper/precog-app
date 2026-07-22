"""Settlement residual: pro rata by shares against exposure weighted.

Payout to a winning position is F_p + (its share of the residual R = P - S_w).
Two candidate splits:

  P1  pro rata by shares      add_p = R * s_p / q_w
  P2  weighted by exposure    add_p = R * s_p * (T - t_p) / sum_p s_p * (T - t_p)

Both keep payout >= F_p, so Theorem 1 survives either way and solvency is not
the deciding question. What this file measures instead:

  1. how large R is relative to the pool as lambda varies, which sets how much
     P2 has to work with in the first place
  2. how much early entry advantage the ratchet already delivers under P1, and
     how much P2 adds on top of it
  3. whether a position can acquire exposure weight it did not earn on the
     winning outcome, by parking early on a cheap outcome and switching late

Clock is the trade index. On chain it would be a slot number, which is monotone
in the same way. Real arithmetic throughout, since the question is economic.
"""
import random
from pmm_reference import Market, switch

LAMBDAS = [0.0, 0.25, 0.5, 0.75, 0.9, 0.99]


def build(n, lam, n_trades, rng):
    """Fund every outcome, then trade. Returns the market and entry times."""
    m = Market(n, lam)
    t_entry = []
    for k in range(n):
        m.buy(k, rng.choice([10, 50]))
        t_entry.append(0)
    for t in range(1, n_trades + 1):
        m.buy(rng.randrange(n), rng.choice([10, 50, 100, 500]))
        t_entry.append(t)
    return m, t_entry, n_trades + 1


def payouts(m, t_entry, T, w, policy):
    """Payout per winning position under the named policy."""
    idx = [k for k, p in enumerate(m.pos) if p['i'] == w]
    if not idx:
        return {}
    R = m.pool - sum(m.floor_of(m.pos[k]) for k in idx)
    if policy == "P1":
        denom = sum(m.pos[k]['shares'] for k in idx)
        wt = {k: m.pos[k]['shares'] for k in idx}
    else:
        wt = {k: m.pos[k]['shares'] * (T - t_entry[k]) for k in idx}
        denom = sum(wt.values())
    out = {}
    for k in idx:
        share = (wt[k] / denom) if denom > 0 else 0.0
        out[k] = m.floor_of(m.pos[k]) + R * share
    return out


def residual_fraction():
    """How much of the pool is still unallocated at settlement, by lambda."""
    print("residual as a fraction of pool at settlement")
    print("  lambda   mean R/P   this is the base P2 divides up")
    for lam in LAMBDAS:
        rng = random.Random(4)
        fracs = []
        for _ in range(400):
            n = rng.choice([2, 3])
            m, t_entry, T = build(n, lam, rng.randint(10, 40), rng)
            w = rng.randrange(n)
            idx = [k for k, p in enumerate(m.pos) if p['i'] == w]
            if not idx:
                continue
            R = m.pool - sum(m.floor_of(m.pos[k]) for k in idx)
            fracs.append(R / m.pool)
        print(f"  {lam:<8.2f} {sum(fracs)/len(fracs):>7.3f}")
    print()


def early_advantage():
    """Return multiple for the earliest quartile against the latest quartile."""
    print("early entry advantage on the winning outcome, mean return multiple")
    print("  lambda   P1 early  P1 late   P2 early  P2 late   P1 tilt  P2 tilt")
    for lam in LAMBDAS:
        rng = random.Random(9)
        acc = {("P1", "e"): [], ("P1", "l"): [], ("P2", "e"): [], ("P2", "l"): []}
        for _ in range(600):
            n = rng.choice([2, 3])
            m, t_entry, T = build(n, lam, rng.randint(20, 40), rng)
            w = rng.randrange(n)
            idx = [k for k, p in enumerate(m.pos) if p['i'] == w]
            if len(idx) < 8:
                continue
            order = sorted(idx, key=lambda k: t_entry[k])
            cut = max(1, len(order) // 4)
            early, late = order[:cut], order[-cut:]
            for pol in ("P1", "P2"):
                pay = payouts(m, t_entry, T, w, pol)
                for grp, ks in (("e", early), ("l", late)):
                    acc[(pol, grp)] += [pay[k] / m.pos[k]['cost'] for k in ks]
        r = {key: sum(v)/len(v) for key, v in acc.items()}
        t1 = r[("P1", "e")] / r[("P1", "l")]
        t2 = r[("P2", "e")] / r[("P2", "l")]
        print(f"  {lam:<8.2f} {r[('P1','e')]:>8.3f}  {r[('P1','l')]:>7.3f}   "
              f"{r[('P2','e')]:>8.3f}  {r[('P2','l')]:>7.3f}   "
              f"{t1:>6.2f}x  {t2:>6.2f}x")
    print()


def parking_attack():
    """Buy the cheapest outcome at t=0, switch into the favourite at the close.

    Under P2 the clock has to either carry across the switch or reset. If it
    carries, the position collects exposure weight for time it spent on an
    outcome it did not hold at settlement. This measures what that is worth.
    """
    print("clock parking: enter early on a cheap outcome, switch to the winner at the close")
    print("  lambda   honest late buyer   parked attacker   attacker gain")
    for lam in LAMBDAS:
        rng = random.Random(21)
        gains = []
        for _ in range(400):
            n = 3
            m = Market(n, lam)
            t_entry = []
            for k in range(n):
                m.buy(k, 50)
                t_entry.append(0)
            # attacker parks on outcome 2 at t=0 with the same money as the honest buyer
            m.buy(2, 200)
            t_entry.append(0)
            atk = len(m.pos) - 1
            for t in range(1, 31):
                m.buy(rng.randrange(n), rng.choice([10, 50, 100, 500]))
                t_entry.append(t)
            # honest buyer takes outcome 0 at the close with the same 200
            m.buy(0, 200)
            t_entry.append(31)
            honest = len(m.pos) - 1
            T = 32
            switch(m, m.pos[atk], 0)          # attacker arrives late, clock carries
            pay = payouts(m, t_entry, T, 0, "P2")
            if atk in pay and honest in pay:
                gains.append((pay[atk] / 200, pay[honest] / 200))
        a = sum(g[0] for g in gains) / len(gains)
        h = sum(g[1] for g in gains) / len(gains)
        print(f"  {lam:<8.2f} {h:>17.3f}   {a:>15.3f}   {a/h:>12.2f}x")
    print()


if __name__ == "__main__":
    residual_fraction()
    early_advantage()
    parking_attack()
