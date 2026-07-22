"""What constrains lambda, measured rather than argued.

lambda is the fraction of every buy that converts into floor obligation on the
other outcomes. Solvency does not pick it: (I) holds at every lambda below 1,
because a buy of c raises the pool by c and each other outcome's obligation by
lambda*c, so headroom grows by (1 - lambda)*c on every trade. That is already
verified elsewhere. The question here is economic, and four things move with it.

  A  residual size          how much of the pool is still unallocated at the end
  B  price calibration      whether buying at a displayed price of p returns
                            about 1/p when right, which is the thing that makes
                            a prediction market readable as a forecast
  C  switch truncation      how often F_new = min(F_p, H_b) actually bites, i.e.
                            how expensive it is to reposition
  D  self dealing           whether an actor holding most of one outcome can pump
                            their own floor by buying the other side

Real arithmetic. The clock is the trade index.
"""
import random
from pmm_reference import Market, switch

GRID = [0.0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.95, 0.99]


def build(n, lam, n_trades, rng, sizes=(10, 50, 100, 500)):
    m = Market(n, lam)
    for k in range(n):
        m.buy(k, rng.choice([10, 50]))
    for _ in range(n_trades):
        m.buy(rng.randrange(n), rng.choice(sizes))
    return m


def metric_a_residual():
    print("A. residual as a fraction of the pool")
    print("   lambda   R/P     what is left for the share split")
    out = {}
    for lam in GRID:
        rng = random.Random(4)
        f = []
        for _ in range(400):
            n = rng.choice([2, 3])
            m = build(n, lam, rng.randint(10, 40), rng)
            w = rng.randrange(n)
            idx = [p for p in m.pos if p['i'] == w]
            if not idx:
                continue
            R = m.pool - sum(m.floor_of(p) for p in idx)
            f.append(R / m.pool)
        out[lam] = sum(f) / len(f)
        print(f"   {lam:<8.2f} {out[lam]:>5.3f}")
    print()
    return out


def metric_b_calibration():
    """A marginal buyer at the close pays the displayed price. If right, the
    payout should be about 1/price per unit staked. The ratio of realized
    return to 1/price is the calibration factor: 1.0 means the displayed
    probability is honest, below 1.0 means the price overstates the payout."""
    print("B. price calibration for a buyer at the close")
    print("   lambda   realized/fair   displayed price is honest at 1.00")
    out = {}
    for lam in GRID:
        rng = random.Random(9)
        ratios = []
        for _ in range(500):
            n = rng.choice([2, 3])
            m = build(n, lam, rng.randint(20, 40), rng)
            w = rng.randrange(n)
            price = m.price(w)
            if price <= 0.02 or price >= 0.98:
                continue
            stake = 100
            m.buy(w, stake)
            p = m.pos[-1]
            idx = [x for x in m.pos if x['i'] == w]
            R = m.pool - sum(m.floor_of(x) for x in idx)
            q_w = sum(x['shares'] for x in idx)
            payout = m.floor_of(p) + R * p['shares'] / q_w
            fair = stake / price
            ratios.append((payout / stake) / (1 / price) if fair else 1.0)
        out[lam] = sum(ratios) / len(ratios)
        print(f"   {lam:<8.2f} {out[lam]:>13.3f}")
    print()
    return out


def metric_c_switch_truncation():
    """How often repositioning costs you floor, and how much."""
    print("C. switch cost: F_new = min(F_p, H_b)")
    print("   lambda   truncated   mean floor kept when it bites")
    out = {}
    for lam in GRID:
        rng = random.Random(21)
        bit, tot, kept = 0, 0, []
        for _ in range(500):
            n = rng.choice([2, 3])
            m = build(n, lam, rng.randint(10, 30), rng)
            if not m.pos:
                continue
            p = rng.choice(m.pos)
            a, b = p['i'], rng.randrange(n)
            if a == b or m.q[b] == 0:
                continue
            F = m.floor_of(p)
            H_b = m.pool - m.S[b]
            tot += 1
            if H_b < F:
                bit += 1
                kept.append(H_b / F if F > 0 else 1.0)
            switch(m, p, b)
            m.check()
        rate = bit / tot if tot else 0.0
        k = sum(kept) / len(kept) if kept else 1.0
        out[lam] = rate
        print(f"   {lam:<8.2f} {rate:>9.1%}   {k:>6.3f}")
    print()
    return out


def metric_d_self_dealing():
    """An actor holds most of outcome 0, then buys outcome 1 to ratchet their
    own floor. Their buy raises acc[0] by lambda*c/q_0, and they capture the
    fraction of that equal to their share of outcome 0. Question: does the
    round trip return more than it cost?"""
    print("D. self dealing: hold outcome 0, buy outcome 1 to pump your own floor")
    print("   lambda   spent   floor gained   net   profitable")
    for lam in GRID:
        m = Market(2, lam)
        m.buy(0, 1000)          # attacker takes essentially all of outcome 0
        atk = m.pos[-1]
        m.buy(1, 10)            # a token holder exists on the other side
        m.buy(0, 1)             # a small rival on the attacker's outcome
        F0 = m.floor_of(atk)
        spend = 500
        m.buy(1, spend)         # the attack: fund the other side
        gain = m.floor_of(atk) - F0
        m.check()
        net = gain - spend
        print(f"   {lam:<8.2f} {spend:>5} {gain:>14.2f} {net:>7.2f}   "
              f"{'YES' if net > 0 else 'no'}")
    print("   The buy also leaves them holding outcome 1, so the full position is")
    print("   hedged rather than free. Net above counts only the floor pump.")
    print()


def metric_e_sensitivity():
    """Metric B assumes one market shape. The crossover where calibration passes
    1.00 moves with depth, trade size and stake size, so a single lambda cannot
    be honest everywhere. This locates the crossover across conditions."""
    print("E. where calibration crosses 1.00, by market condition")
    cols = [0.4, 0.5, 0.6, 0.7, 0.75]
    print(f"   {'condition':<34}" + "".join(f"{l:>8.2f}" for l in cols))
    cases = [
        ("baseline, 20-40 trades, stake 100", (20, 40), (10, 50, 100, 500), 100),
        ("thin, 5-12 trades, stake 100",      (5, 12),  (10, 50, 100, 500), 100),
        ("deep, 60-120 trades, stake 100",    (60, 120), (10, 50, 100, 500), 100),
        ("whale sizes, stake 100",            (20, 40), (500, 2000, 10000), 100),
        ("small stake 10",                    (20, 40), (10, 50, 100, 500), 10),
    ]
    for name, (lo, hi), sizes, stake in cases:
        vals = []
        for lam in cols:
            rng = random.Random(9)
            r = []
            for _ in range(500):
                n = rng.choice([2, 3])
                m = build(n, lam, rng.randint(lo, hi), rng, sizes)
                w = rng.randrange(n)
                price = m.price(w)
                if price <= 0.02 or price >= 0.98:
                    continue
                m.buy(w, stake)
                p = m.pos[-1]
                idx = [x for x in m.pos if x['i'] == w]
                R = m.pool - sum(m.floor_of(x) for x in idx)
                q_w = sum(x['shares'] for x in idx)
                payout = m.floor_of(p) + R * p['shares'] / q_w
                r.append((payout / stake) / (1 / price))
            vals.append(sum(r) / len(r))
        print(f"   {name:<34}" + "".join(f"{v:>8.3f}" for v in vals))
    print("   Above 1.00 the payout beats the displayed price, which reads to a user")
    print("   as a surprise in their favour. Below 1.00 the price overstates the")
    print("   payout, which reads as the protocol shorting them. The second error")
    print("   is the worse one, so the choice is the lambda whose worst case across")
    print("   these conditions sits closest to 1.00 from above.")
    print()


if __name__ == "__main__":
    a = metric_a_residual()
    b = metric_b_calibration()
    c = metric_c_switch_truncation()
    metric_d_self_dealing()
    metric_e_sensitivity()

    print("summary")
    print("   lambda   R/P    calibration   switch truncation")
    for lam in GRID:
        print(f"   {lam:<8.2f} {a[lam]:>5.3f}  {b[lam]:>11.3f}   {c[lam]:>16.1%}")
