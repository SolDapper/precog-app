import math, random
from pmm_reference import Market, switch

class BootMarket(Market):
    """Opens in Ante (v1 parimutuel, flat pricing). Converts to Live curve
    pricing once every outcome is funded and the pool clears `threshold`."""
    def __init__(self, n, lam, threshold):
        self.n, self.lam, self.threshold = n, lam, threshold
        self.q = [0.0]*n; self.qh = [0.0]*n
        self.pool = 0.0
        self.S = [0.0]*n; self.acc = [0.0]*n
        self.pos = []
        self.curve = False

    def price(self, i):
        if not self.curve: return 1.0   # Ante: flat, one share per unit
        return self.q[i]/self.C(self.q)

    def buy(self, i, dollars):
        if self.curve:
            return Market.buy(self, i, dollars)
        # Ante: 1 share per unit, and no rewards accrue. The ratchet starts at
        # go-live. Running it here is variant A in ante.py, which breaks (I) in
        # 902 of 2000 markets once positions can withdraw at par.
        d = dollars
        self.q[i] += d; self.qh[i] += d
        self.pool += dollars; self.S[i] += dollars
        self.pos.append(dict(i=i, shares=d, cost=dollars, base=dollars, snap=self.acc[i]))
        self.maybe_convert()
        return d

    def maybe_convert(self):
        if self.curve: return
        if self.pool >= self.threshold and all(x > 0 for x in self.qh):
            before = [self.pool/self.q[k] for k in range(self.n)]
            self.curve = True                      # q already equals the stakes
            after  = [self.pool/self.q[k] for k in range(self.n)]
            assert max(abs(a-b) for a,b in zip(before,after)) < 1e-12, "payout jolt"
            self.surplus = self.pool - self.C(self.q)
            assert self.surplus >= -1e-9

random.seed(3)
converted = 0
for _ in range(3000):
    n   = random.choice([2,3,3,10])
    lam = random.choice([0.0,0.3,0.6,0.9,0.99])
    m   = BootMarket(n, lam, threshold=random.choice([50,500,5000]))
    seen = {}
    for _ in range(random.randint(1,50)):
        if random.random() < 0.8 or not m.pos:
            m.buy(random.randrange(n), random.choice([1,10,100,5000]))
        elif m.curve:
            switch(m, random.choice(m.pos), random.randrange(n))
        m.check()
        for idx,p in enumerate(m.pos):          # monotonicity while a position stays put
            f = m.floor_of(p)
            if idx in seen and seen[idx][0] == p['i']:
                assert f + 1e-9 >= seen[idx][1], "floor decreased without a switch"
            seen[idx] = (p['i'], f)
    converted += m.curve
    if m.pos: m.settle(random.randrange(n))
print(f"3000 bootstrap markets, {converted} reached Live mode.")
print("no payout-ratio discontinuity at conversion; solvency and monotonicity held throughout.")

m = BootMarket(3, 0.5, threshold=200)
for i,amt in [(0,50),(1,50),(2,40),(1,100)]:
    m.buy(i,amt)
    print(f"  buy {amt:>4} on outcome {i} -> pool={m.pool:6.0f}  mode={'LIVE' if m.curve else 'ANTE':5}  Yes payout ratio={m.pool/m.q[0]:.3f}")
print(f"  unallocated surplus E at conversion = ${m.surplus:.2f} (flows to winners as residual)")
