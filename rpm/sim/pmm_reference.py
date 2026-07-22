"""Precog v2 reference simulator: cost-basis floors on a DPM curve.

Mechanism:
  curve      C(q) = sqrt(sum q_i^2);  price_i = q_i / C(q)      (Pennock 2004, DPM share-ratio)
  base floor F_p   = cost basis of the position (always affordable, see README notes)
  ratchet    a buy of $c on outcome i raises floors on every OTHER outcome j by lam*c,
             spread pro-rata by shares via a cumulative acc[j] accumulator (O(1))
  invariant  pool >= S[i] for every outcome i, checked after every mutation
  settlement winner w: each position takes its floor, residual (pool - S[w]) splits pro-rata

The board starts empty. q, qh and pool are all zero until real money arrives, so
the pool never contains a unit that nobody paid in. On chain the curve is entered
at conversion with q initialized from Ante stakes, which is the same condition:
every share on the curve was bought.

Run directly to execute the randomized stress test.
"""

import math, random

class Market:
    """DPM share-ratio curve + cost-basis floors funded by counterparty capital."""
    def __init__(self, n, lam):
        self.n = n
        self.lam = lam
        self.q = [0.0]*n                  # curve shares, funded entirely by real buys
        self.qh = [0.0]*n                 # shares actually held by positions
        self.pool = 0.0                   # no seed: every unit here was paid in
        self.S = [0.0]*n                  # sum of outstanding floors per outcome
        self.acc = [0.0]*n                # cumulative floor-reward per share
        self.pos = []                     # positions

    def C(self, q): return math.sqrt(sum(x*x for x in q))

    def price(self, i):
        c = self.C(self.q)
        return self.q[i]/c if c > 0 else 0.0

    def ratio(self, i):                              # payout per share if i wins
        return self.pool/self.q[i] if self.q[i] > 0 else 0.0

    def buy(self, i, dollars):
        # invert cost function: find shares d s.t. C(q+d*e_i)-C(q) == dollars
        lo, hi = 0.0, 1.0
        while self.C([self.q[k]+(hi if k==i else 0) for k in range(self.n)]) - self.C(self.q) < dollars:
            hi *= 2
        for _ in range(200):
            mid = (lo+hi)/2
            c = self.C([self.q[k]+(mid if k==i else 0) for k in range(self.n)]) - self.C(self.q)
            if c < dollars: lo = mid
            else: hi = mid
        d = (lo+hi)/2
        # ratchet OTHER outcomes: their counterparty capital just grew by `dollars`
        for j in range(self.n):
            if j != i and self.qh[j] > 1e-12:
                delta = self.lam*dollars
                self.acc[j] += delta/self.qh[j]
                self.S[j]   += delta
        # settle the buy: base floor == cost basis
        self.q[i]  += d
        self.qh[i] += d
        self.pool  += dollars
        self.S[i]  += dollars
        self.pos.append(dict(i=i, shares=d, cost=dollars, base=dollars, snap=self.acc[i]))
        return d

    def floor_of(self, p):
        return p['base'] + p['shares']*(self.acc[p['i']] - p['snap'])

    def check(self):
        for i in range(self.n):
            assert self.pool*(1+1e-9) + 1e-9 >= self.S[i], f"SOLVENCY BREAK outcome {i}: pool={self.pool} S={self.S[i]}"
            tot = sum(self.floor_of(p) for p in self.pos if p['i']==i)
            assert abs(tot - self.S[i]) <= 1e-6 + 1e-9*abs(self.S[i]), f"accumulator drift {tot} vs {self.S[i]}"

    def settle(self, w):
        winners = [p for p in self.pos if p['i']==w]
        floors  = sum(self.floor_of(p) for p in winners)
        residual = self.pool - floors
        assert residual >= -1e-6, "residual negative"
        sh = sum(p['shares'] for p in winners)
        out = []
        for p in winners:
            pay = self.floor_of(p) + residual*(p['shares']/sh)
            assert pay + 1e-6 >= self.floor_of(p)
            out.append((p, pay))
        return out, residual

# ---------------------------------------------------------------------------
# Switches, transfers, and the withdrawal bound
# ---------------------------------------------------------------------------

def switch(m, p, b):
    """Move position p from its outcome to outcome b along the iso-cost surface.
    pool is unchanged, so C(q) must be unchanged:  q_a^2 + q_b^2 is invariant."""
    a = p['i']
    if a == b: return p
    s_a = p['shares']
    qa, qb = m.q[a], m.q[b]
    inner = qb*qb + qa*qa - (qa - s_a)**2
    s_b = math.sqrt(inner) - qb                      # closed form, no iteration
    F_p = m.floor_of(p)
    H_b = m.pool - m.S[b]                            # headroom on the destination
    F_new = min(F_p, H_b)
    m.q[a] -= s_a;  m.qh[a] -= s_a;  m.S[a] -= F_p
    if m.qh[a] < 1e-9:                               # float dust; exact 0 on-chain
        m.qh[a] = 0.0; m.S[a] = 0.0
    m.q[b] += s_b;  m.qh[b] += s_b;  m.S[b] += F_new
    p.update(i=b, shares=s_b, base=F_new, snap=m.acc[b])
    return p

def transfer(m, p, new_owner):
    """Ownership change only. No curve state, no pool, no floor, no accumulator."""
    p['owner'] = new_owner
    return p

def max_withdrawal(m, p):
    """Largest value that could leave the pool without breaking any floor."""
    a = p['i']
    binding = max([m.S[a] - m.floor_of(p)] + [m.S[j] for j in range(m.n) if j != a])
    return max(0.0, m.pool - binding)


if __name__ == "__main__":
    # ---- randomized stress test -------------------------------------------------
    random.seed(7)
    breaks = 0
    for trial in range(4000):
        n   = random.choice([2,3,3,3,10])
        lam = random.choice([0.0,0.25,0.5,0.75,0.9,0.99])
        m   = Market(n, lam)
        # every outcome carries stake before trading, which is the conversion condition
        hist  = [(k, random.choice([1,5,25])) for k in range(n)]
        hist += [(random.randrange(n), random.choice([1,5,25,100,1000,25000]))
                 for _ in range(random.randint(1,60))]
        for (i,amt) in hist:
            m.buy(i, amt)
            m.check()
        # monotonicity: replay and confirm no floor ever decreased
        m2 = Market(n, lam); seen = {}
        for (i,amt) in hist:
            m2.buy(i, amt)
            for idx,p in enumerate(m2.pos):
                f = m2.floor_of(p)
                if idx in seen: assert f + 1e-9 >= seen[idx], "FLOOR DECREASED"
                seen[idx] = f
        m.settle(random.randrange(n))
    print("4000 randomized markets: solvency, accumulator exactness, floor monotonicity all held.")

    random.seed(11)
    worst_roundtrip = 1.0
    for _ in range(3000):
        n   = random.choice([2,3,3,10])
        lam = random.choice([0.0,0.3,0.6,0.9,0.99])
        m   = Market(n, lam)
        for k in range(n):
            m.buy(k, random.choice([1,10,100]))
        for _ in range(random.randint(2,40)):
            act = random.random()
            if act < 0.75 or not m.pos:
                m.buy(random.randrange(n), random.choice([1,10,100,5000]))
            else:
                p = random.choice(m.pos)
                switch(m, p, random.randrange(n))
            m.check()
        # round-trip must be lossy (no wash-switch arbitrage)
        if m.pos:
            p = random.choice(m.pos); a = p['i']; b = (a+1) % n
            if m.qh[a] > 0:
                s0 = p['shares']
                switch(m, p, b); switch(m, p, a)
                worst_roundtrip = max(worst_roundtrip, p['shares']/s0)
                m.check()
        m.settle(random.randrange(n))
    print("3000 markets with switches: solvency and accumulator exactness held.")
    # In exact reals a->b->a is the identity, because the switch holds q_a^2 + q_b^2
    # fixed and the map is its own inverse. So 1.0 is the correct value here, not a
    # ceiling that excess must stay under. Any excess is cancellation error in
    # sqrt(q_b^2 + q_a^2 - (q_a - s_a)^2), which loses precision when s_a is small
    # relative to q_a. The property that actually protects the pool is strict loss
    # under integer truncation, which only the integer model can show, and it is
    # asserted in int_reference.py section 4.
    assert worst_roundtrip <= 1 + 1e-6, f"round-trip gained shares: {worst_roundtrip}"
    print(f"worst observed switch round-trip: {worst_roundtrip:.10f}x shares "
          f"(exact reals: 1.0; excess is float cancellation, bounded here at 1e-6)")
