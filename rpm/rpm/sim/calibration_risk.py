"""How often does a correct buyer realize less than the displayed price implies,
and can it be driven there deliberately?

Terminology, since the earlier wording was loose. Calibration below 1.00 does
not mean a loss. The base floor is the stake net of entry fee, and payout is
never below floor, so a correct buyer always recovers what they put in. Below
1.00 means the upside is thinner than a user would infer from reading the
displayed percentage as odds.

There is a closed form for where this goes. Writing p for the displayed price,
s for shares bought, c for cost, R for the residual P - S_w:

    payout      = c + (s / q_w) * R
    fair        = c / p
    calibration = payout / fair = p * (1 + (s / c) * (R / q_w))

and since a marginal buy has s/c close to 1/p,

    calibration ~= p + R / q_w

So calibration is the displayed price plus the residual per share. As lambda
rises, S_w rises toward P, R/q_w falls toward zero, and calibration falls
toward p, at which point realized return is exactly 1.0x. The worst case is
not a loss. The worst case is getting your money back.

Three things measured here:

  1. organic frequency: what fraction of correct late buys land below 1.00
  2. the hard floor: what fraction land below 1.0x their stake (should be zero)
  3. manufactured: an adversary ratchets a victim's outcome to thin the residual,
     and what that costs the adversary
"""
import random
from pmm_reference import Market

GRID = [0.25, 0.4, 0.5, 0.6, 0.75, 0.9]


def build(n, lam, n_trades, rng, sizes=(10, 50, 100, 500)):
    m = Market(n, lam)
    for k in range(n):
        m.buy(k, rng.choice([10, 50]))
    for _ in range(n_trades):
        m.buy(rng.randrange(n), rng.choice(sizes))
    return m


def quote(m, i, value):
    """Exact payout for a hypothetical buy, computed from current state alone.
    This is what the app should display instead of a price. Returns
    (guaranteed minimum, payout at the current pool)."""
    probe = Market(m.n, m.lam)
    probe.q, probe.qh = m.q[:], m.qh[:]
    probe.pool, probe.S, probe.acc = m.pool, m.S[:], m.acc[:]
    probe.pos = [dict(x) for x in m.pos]
    p = probe.buy(i, value)
    idx = [x for x in probe.pos if x['i'] == i]
    R = probe.pool - sum(probe.floor_of(x) for x in idx)
    q_w = sum(x['shares'] for x in idx)
    me = probe.pos[-1]
    return probe.floor_of(me), probe.floor_of(me) + R * me['shares'] / q_w


def organic():
    print("1 and 2. organic frequency over 4000 correct late buys per lambda")
    print("   lambda   below 1.00 calibration   below 1.0x stake   worst calibration   worst return")
    for lam in GRID:
        rng = random.Random(31)
        below_cal, below_stake, n_obs = 0, 0, 0
        worst_cal, worst_ret = 9.9, 9.9
        for _ in range(4000):
            n = rng.choice([2, 3])
            m = build(n, lam, rng.randint(5, 60), rng)
            w = rng.randrange(n)
            price = m.price(w)
            if price <= 0.02 or price >= 0.98:
                continue
            stake = rng.choice([10, 100, 1000])
            m.buy(w, stake)
            p = m.pos[-1]
            idx = [x for x in m.pos if x['i'] == w]
            R = m.pool - sum(m.floor_of(x) for x in idx)
            q_w = sum(x['shares'] for x in idx)
            payout = m.floor_of(p) + R * p['shares'] / q_w
            cal = (payout / stake) / (1 / price)
            ret = payout / stake
            n_obs += 1
            below_cal += cal < 1.0
            below_stake += ret < 1.0 - 1e-9
            worst_cal = min(worst_cal, cal)
            worst_ret = min(worst_ret, ret)
        print(f"   {lam:<8.2f} {below_cal/n_obs:>21.1%}   {below_stake/n_obs:>16.1%}   "
              f"{worst_cal:>17.3f}   {worst_ret:>12.3f}x")
    print()


def manufactured():
    """Adversary holds outcome 0 early, then spends on outcome 1 to ratchet
    their own floor and thin the residual a later buyer on outcome 0 can reach.
    Victim then buys outcome 0 for 100. Measures the victim's calibration and
    the adversary's own profit and loss if outcome 0 resolves true."""
    print("3. manufactured: adversary ratchets to thin a victim's residual")
    print("   lambda   attack spend   victim calibration   victim return   adversary P/L")
    for lam in GRID:
        m = Market(2, lam)
        m.buy(0, 1000)
        adv = m.pos[-1]
        m.buy(1, 50)
        base_cal = None
        spend = 0
        for _ in range(40):                     # grind the ratchet
            m.buy(1, 250)
            spend += 250
        price = m.price(0)
        stake = 100
        m.buy(0, stake)
        vic = m.pos[-1]
        idx = [x for x in m.pos if x['i'] == 0]
        R = m.pool - sum(m.floor_of(x) for x in idx)
        q_w = sum(x['shares'] for x in idx)
        vic_pay = m.floor_of(vic) + R * vic['shares'] / q_w
        cal = (vic_pay / stake) / (1 / price)
        adv_pay = m.floor_of(adv) + R * adv['shares'] / q_w
        adv_pl = adv_pay - (1000 + spend)       # outcome 1 stake is lost if 0 wins
        m.check()
        print(f"   {lam:<8.2f} {spend:>12} {cal:>20.3f} {vic_pay/stake:>14.3f}x "
              f"{adv_pl:>15.1f}")
    print("   The adversary funds the pool the victim is paid from, and loses the")
    print("   outcome 1 stake outright when outcome 0 resolves true.")
    print()


def quote_is_exact():
    """The quote above must equal what actually happens on execution."""
    rng = random.Random(77)
    worst = 0.0
    for _ in range(2000):
        n = rng.choice([2, 3])
        lam = rng.choice(GRID)
        m = build(n, lam, rng.randint(5, 40), rng)
        i = rng.randrange(n)
        v = rng.choice([10, 100, 1000])
        gmin, qpay = quote(m, i, v)
        m.buy(i, v)
        p = m.pos[-1]
        idx = [x for x in m.pos if x['i'] == i]
        R = m.pool - sum(m.floor_of(x) for x in idx)
        q_w = sum(x['shares'] for x in idx)
        actual = m.floor_of(p) + R * p['shares'] / q_w
        assert abs(actual - qpay) <= 1e-6 * max(1.0, abs(actual)), "quote disagreed"
        assert gmin >= p['cost'] - 1e-9, "guaranteed minimum below cost basis"
        worst = max(worst, abs(actual - qpay))
    print(f"4. quote check: 2000 quotes matched execution exactly, worst gap {worst:.2e}")
    print("   A quote is computable from state before the trade, so the number a")
    print("   user is shown can be the payout itself rather than a price they")
    print("   have to convert into one.")


if __name__ == "__main__":
    organic()
    manufactured()
    quote_is_exact()
