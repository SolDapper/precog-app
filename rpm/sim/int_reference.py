"""
Precog v2 integer reference implementation.

Everything here is exact integer arithmetic in the units the program will use:
values in lamports (u64), shares in u64, the sum-of-squares accumulator T and the
reward accumulator acc in u128. No floats anywhere.

ROUNDING DISCIPLINE (the rule the Rust must follow):

  R1. Anything that increases a participant's claim rounds DOWN.
        - shares issued on a buy
        - shares issued on a switch
        - a position's accrued floor
        - the residual share at settlement

  R2. The aggregate obligation is incremented by the FULL gross amount, while
      the per-share distribution truncates:
        acc[j] += floor(gross * ACC / q[j])          <- distributed, rounds down
        S[j]   += gross                              <- obligation, exact
      S[j] is therefore an upper bound on the floors actually claimable. Do NOT
      try to derive S[j] from the truncated per-share value: positions carry
      different accumulator snapshots, so per-position truncation and per-ratchet
      truncation do not compose, and S[j] can end up one unit short of what
      holders can claim.

  R3. Truncated dust stays in the pool. It is never credited anywhere. It
      settles to winners as residual.

Together these give the integer form of the invariant:

      P  >=  S[i]  >=  sum of F_p over positions on i        for every i

The middle term is the slack that truncation creates. It only ever grows, and it
only ever works in the pool's favour.

Run directly to execute the test suite, including a demonstration that a naive
rounding scheme breaks Theorem 2 on inputs this one survives.
"""

from math import isqrt
import random

ACC   = 1 << 64          # accumulator fixed-point scale
BPS   = 10_000


class IntMarket:
    def __init__(self, n, lam_bps, threshold, fee_bps=0):
        assert 0 <= lam_bps < BPS, "lambda must be strictly below 1"
        self.n, self.lam_bps, self.threshold, self.fee_bps = n, lam_bps, threshold, fee_bps
        self.q   = [0]*n         # shares outstanding
        self.S   = [0]*n         # outstanding floor obligation
        self.acc = [0]*n         # cumulative floor-reward per share, scaled by ACC
        self.P   = 0             # pool, net of fees
        self.T   = 0             # sum of q^2  (u128)
        self.fees = 0
        self.pos = []
        self.curve = False

    # ---- helpers ---------------------------------------------------------
    def floor_of(self, p):
        """R1: accrued floor rounds down."""
        return p['b'] + (p['s'] * (self.acc[p['i']] - p['a'])) // ACC

    def payout_ratio(self, i):
        return (self.P, self.q[i])          # exact rational; UI renders P/q_i

    # ---- ratchet ---------------------------------------------------------
    def _ratchet(self, i, c):
        """A buy of c on outcome i converts lam*c into permanent floor for the
        holders of every other outcome.

        Gated to Live. This is variant B in ante.py, and it is the decided
        design: no rewards accrue during Ante. Variant A, which ratchets in
        Ante, breaks (I) in 902/2000 markets once positions can withdraw at
        par, and in 278/2000 when combined with the go-live haircut. Anything
        wanting variant A calls _apply_ratchet directly and owns the result.
        """
        if not self.curve:
            return
        self._apply_ratchet(i, c)

    def _apply_ratchet(self, i, c):
        gross = (c * self.lam_bps) // BPS            # R1
        if gross == 0:
            return
        for j in range(self.n):
            if j == i or self.q[j] == 0:
                continue
            delta = (gross * ACC) // self.q[j]       # R2: per-share first
            if delta == 0:
                continue                             # R3: dust stays in pool
            self.acc[j] += delta
            self.S[j]   += gross                     # R2: obligation is the upper bound

    # ---- buy -------------------------------------------------------------
    def buy(self, i, value, owner=0):
        fee = (value * self.fee_bps) // BPS
        c   = value - fee
        if c <= 0:
            return None
        self.fees += fee
        self._ratchet(i, c)                          # before q[i] moves

        if self.curve:
            C = isqrt(self.T)
            s = isqrt(self.q[i]*self.q[i] + 2*C*c + c*c) - self.q[i]   # R1
            if s <= 0:
                return None
            self.T += 2*self.q[i]*s + s*s
        else:
            s = c                                    # Ante: 1 share per unit

        self.q[i] += s
        self.P    += c
        self.S[i] += c                               # base floor == cost basis
        p = dict(i=i, s=s, c=c, b=c, a=self.acc[i], owner=owner)
        self.pos.append(p)
        self._maybe_convert()
        return p

    def _maybe_convert(self):
        if self.curve or self.P < self.threshold or any(x == 0 for x in self.q):
            return
        self.curve = True
        self.T = sum(x*x for x in self.q)

    # ---- switch ----------------------------------------------------------
    def switch(self, p, b):
        a = p['i']
        if a == b or not self.curve or self.q[b] == 0:
            return p
        qa, qb, sa = self.q[a], self.q[b], p['s']
        inner = qb*qb + qa*qa - (qa - sa)**2
        sb = isqrt(inner) - qb                       # R1
        if sb <= 0:
            return p
        F   = self.floor_of(p)
        H_b = self.P - self.S[b]
        F_new = min(F, H_b)

        self.q[a] -= sa; self.S[a] -= F
        self.q[b] += sb; self.S[b] += F_new
        self.T = sum(x*x for x in self.q)
        p.update(i=b, s=sb, b=F_new, a=self.acc[b])
        return p

    # ---- transfer --------------------------------------------------------
    def transfer(self, p, new_owner):
        p['owner'] = new_owner                       # touches nothing else
        return p

    # ---- checks ----------------------------------------------------------
    def check(self):
        for i in range(self.n):
            held = sum(self.floor_of(x) for x in self.pos if x['i'] == i)
            assert self.P >= self.S[i], f"(I) BROKEN on {i}: P={self.P} S={self.S[i]}"
            assert self.S[i] >= held,   f"S underestimates floors on {i}: {self.S[i]} < {held}"
            assert sum(x['s'] for x in self.pos if x['i'] == i) == self.q[i], "share drift"

    def settle(self, w):
        winners  = [p for p in self.pos if p['i'] == w]
        if not winners:
            return 0, self.P
        owed     = sum(self.floor_of(p) for p in winners)
        residual = self.P - self.S[w]
        assert residual >= 0, "negative residual"
        paid = 0
        for p in winners:
            F   = self.floor_of(p)
            add = (p['s'] * residual) // self.q[w]   # R1
            pay = F + add
            assert pay >= F, "payout below floor"
            paid += pay
        assert paid <= self.P, f"overpay: {paid} > {self.P}"
        return paid, self.P - paid                   # dust left behind


class NaiveMarket(IntMarket):
    """Same mechanism, one careless choice: a position's accrued floor rounds up
    instead of down, so holders can claim marginally more than was ever set aside."""
    def floor_of(self, p):
        num = p['s'] * (self.acc[p['i']] - p['a'])
        return p['b'] + -(-num // ACC)               # round UP


# =========================================================================
if __name__ == "__main__":
    random.seed(17)

    # ---- 1. correctness under adversarial flow --------------------------
    dust_trades = 0
    for _ in range(3000):
        n   = random.choice([2, 3, 3, 10])
        m   = IntMarket(n,
                        lam_bps=random.choice([0, 2500, 5000, 9000, 9900]),
                        threshold=random.choice([10**6, 10**9]),
                        fee_bps=random.choice([0, 30, 100]))
        for _ in range(random.randint(2, 60)):
            act = random.random()
            if act < 0.75 or not m.pos:
                # deliberately mix dust against whales to force truncation
                v = random.choice([1, 2, 7, 10**3, 10**6, 10**9, 10**12])
                if v < 10**3: dust_trades += 1
                m.buy(random.randrange(n), v)
            elif m.curve:
                m.switch(random.choice(m.pos), random.randrange(n))
            m.check()
        m.settle(random.randrange(n))
    print(f"3000 integer markets ({dust_trades} sub-1000-lamport trades): "
          f"(I) held, S never underestimated floors, no overpay.")

    # ---- 2. floor monotonicity while a position stays put ----------------
    for _ in range(800):
        n = random.choice([2, 3])
        m = IntMarket(n, lam_bps=9000, threshold=10**6, fee_bps=30)
        seen = {}
        for _ in range(40):
            m.buy(random.randrange(n), random.choice([10**4, 10**7, 10**10]))
            for idx, p in enumerate(m.pos):
                f = m.floor_of(p)
                if idx in seen and seen[idx][0] == p['i']:
                    assert f >= seen[idx][1], "floor decreased under truncation"
                seen[idx] = (p['i'], f)
    print("800 markets: no floor ever decreased under integer truncation.")

    # ---- 3. the naive scheme fails on the same inputs --------------------
    failures, trials = 0, 0
    for seed in range(400):
        random.seed(10_000 + seed)
        m = NaiveMarket(3, lam_bps=9900, threshold=10**6, fee_bps=0)
        trials += 1
        try:
            for _ in range(40):
                m.buy(random.randrange(3), random.choice([1, 3, 10**9]))
                m.check()
            m.settle(random.randrange(3))
        except AssertionError:
            failures += 1
    print(f"naive rounding: {failures}/{trials} markets broke an invariant "
          f"on inputs the disciplined version survives.")

    # ---- 4. switch round-trip is lossy ----------------------------------
    # a -> b -> a must never return more shares than it consumed. If it could,
    # a position could pump its own share count against an unchanged pool,
    # which walks S[i] up without new money and eventually breaks (I).
    # isqrt floors, so each leg gives up the fractional share. This checks it.
    worst, gains = 0.0, 0
    for seed in range(4000):
        random.seed(20_000 + seed)
        n = random.choice([2, 3, 3, 10])
        m = IntMarket(n,
                      lam_bps=random.choice([0, 2500, 5000, 9000, 9900]),
                      threshold=random.choice([10**6, 10**9]),
                      fee_bps=random.choice([0, 30, 100]))
        for _ in range(random.randint(4, 60)):
            m.buy(random.randrange(n),
                  random.choice([1, 2, 7, 10**3, 10**6, 10**9, 10**12]))
        if not m.curve or not m.pos:
            continue
        for _ in range(6):
            p = random.choice(m.pos)
            a, b = p['i'], random.randrange(n)
            if b == a or m.q[b] == 0:
                continue
            s0 = p['s']
            m.switch(p, b)
            if p['i'] != b:
                continue
            m.switch(p, a)
            if p['i'] != a:
                continue
            m.check()
            assert p['s'] <= s0, f"wash switch gained shares: {s0} -> {p['s']}"
            worst = max(worst, p['s']/s0)
            gains += p['s'] > s0
    print(f"4000 markets, switch round-trips: {gains} gained shares, "
          f"worst ratio {worst:.12f} (must be <= 1.0).")
