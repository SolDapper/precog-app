"""Buying into an outcome you already hold.

v1 seeds a position at [POSITION_SEED, market, bettor, outcome_index], so there
is exactly one position account per bettor per outcome and a second bet tops up
the first. Every simulator here appends a fresh position on every buy instead,
so the program and the reference model would be describing different mechanisms.
That is error 11 again, and a second bet on the same outcome is ordinary user
behaviour rather than an edge case.

A top-up cannot simply add shares. The position carries an accumulator snapshot
`a`, and its accrued floor is `b + s·(acc[i] − a) / ACC`. Raising `s` while
leaving `a` behind would pay the new shares rewards that landed before they
existed; resetting `a` without crystallising would delete everything the
position had ratcheted. So the merge has to bank the accrued floor into the base
first, then reset:

    b ← floor_of(p) + c_new        accrued floor banked into the base
    s ← s + s_new
    a ← acc[i]                     snapshot moves to now
    c ← c + c_new                  cost basis accumulates

Switching into an outcome the owner already holds has the same shape, with the
incoming floor being min(Fₚ, H_b) rather than a fresh cost basis.

  1. the merge preserves (I), Lemma 4 and share conservation
  2. no floor ever falls across a merge
  3. crystallising is load-bearing, and what happens without it
  4. merging against appending, on identical inputs
"""
import random
from math import isqrt

from int_reference import IntMarket, BPS, ACC


class MergeMarket(IntMarket):
    """One position per (owner, outcome), as the PDA seed enforces."""

    _uid = 0

    def _next_uid(self):
        MergeMarket._uid += 1
        return MergeMarket._uid

    def _find(self, owner, i):
        for p in self.pos:
            if p['owner'] == owner and p['i'] == i:
                return p
        return None

    def _bank(self, p, add_floor, new_shares, new_cost, outcome):
        """Crystallise, then extend. The order is the whole point."""
        banked = self.floor_of(p)
        p['b'] = banked + add_floor
        p['s'] += new_shares
        p['a'] = self.acc[outcome]
        p['c'] += new_cost

    def buy(self, i, value, owner=0):
        fee = (value * self.fee_bps) // BPS
        c = value - fee
        if c <= 0:
            return None
        self.fees += fee
        self._ratchet(i, c)

        if self.curve:
            C = isqrt(self.T)
            s = isqrt(self.q[i] * self.q[i] + 2 * C * c + c * c) - self.q[i]
            if s <= 0:
                return None
            self.T += 2 * self.q[i] * s + s * s
        else:
            s = c

        self.q[i] += s
        self.P    += c
        self.S[i] += c

        held = self._find(owner, i)
        if held is None:
            p = dict(i=i, s=s, c=c, b=c, a=self.acc[i], owner=owner,
                     uid=self._next_uid())
            self.pos.append(p)
        else:
            p = held
            self._bank(p, c, s, c, i)
        self._maybe_convert()
        return p

    def switch(self, p, b):
        a = p['i']
        if a == b or not self.curve or self.q[b] == 0:
            return p
        qa, qb, sa = self.q[a], self.q[b], p['s']
        sb = isqrt(qb * qb + qa * qa - (qa - sa) ** 2) - qb
        if sb <= 0:
            return p
        F     = self.floor_of(p)
        F_new = min(F, self.P - self.S[b])

        self.q[a] -= sa
        self.S[a] -= F
        self.q[b] += sb
        self.S[b] += F_new
        self.T = sum(x * x for x in self.q)

        target = self._find(p['owner'], b)
        if target is None:
            p.update(i=b, s=sb, b=F_new, a=self.acc[b])
            return p
        self._bank(target, F_new, sb, p['c'], b)
        self.pos.remove(p)
        return target

    def owed(self):
        return sum(p['c'] for p in self.pos)


class NoBankMarket(MergeMarket):
    """The merge written the careless way: shares and cost added, snapshot
    reset, accrued floor never banked. Everything the position had ratcheted
    since its last snapshot is silently discarded."""
    def _bank(self, p, add_floor, new_shares, new_cost, outcome):
        p['b'] += add_floor
        p['s'] += new_shares
        p['a']  = self.acc[outcome]
        p['c'] += new_cost


def _drive(cls, trials, seed, owners=4):
    random.seed(seed)
    worst_gap = None
    insolvent = 0
    broke     = 0
    drops     = 0
    merges    = 0
    sw_merges = 0
    for _ in range(trials):
        n = random.choice([2, 3, 10])
        m = cls(n,
                lam_bps=random.choice([0, 4000, 9900]),
                threshold=random.choice([10**5, 10**9]),
                fee_bps=random.choice([0, 100, 300]))
        seen = {}
        try:
            for _ in range(random.randint(3, 60)):
                if random.random() < 0.8 or not m.pos:
                    o = random.randrange(owners)
                    i = random.randrange(n)
                    merges += m._find(o, i) is not None
                    m.buy(i, random.choice([1, 7, 10**3, 10**7, 10**11]), owner=o)
                elif m.curve:
                    p = random.choice(m.pos)
                    b = random.randrange(n)
                    if b != p['i'] and m.q[b] > 0:
                        sw_merges += m._find(p['owner'], b) is not None
                    m.switch(p, b)
                m.check()
                gap = m.P - m.owed()
                insolvent += gap < 0
                worst_gap = gap if worst_gap is None else min(worst_gap, gap)
                for p in m.pos:
                    f = m.floor_of(p)
                    prev = seen.get(p['uid'])
                    if prev is not None and prev[0] == p['i'] and f < prev[1]:
                        drops += 1
                    seen[p['uid']] = (p['i'], f)
        except AssertionError:
            broke += 1
    return dict(worst=worst_gap, insolvent=insolvent, broke=broke,
                drops=drops, merges=merges, sw_merges=sw_merges)


# ---- 1 and 2. the merge holds ---------------------------------------------

def merge_holds(trials=3000):
    print("1. topping up an existing position")
    r = _drive(MergeMarket, trials, seed=77)
    print(f"   {trials} markets, {r['merges']:,} buys landed on a position the")
    print(f"   owner already held, {r['sw_merges']:,} switches merged into one")
    print(f"   markets breaking (I) or share conservation: {r['broke']}")
    print(f"   worst pool minus cost bases: {r['worst']}   insolvent steps: {r['insolvent']}")
    assert r['broke'] == 0 and r['insolvent'] == 0 and r['worst'] == 0
    print()
    print("2. no floor falls across a merge")
    print(f"   floors observed to decrease, for one position while it stayed")
    print(f"   on its outcome: {r['drops']}")
    assert r['drops'] == 0
    print("   Banking first means the base absorbs everything already accrued,")
    print("   so a top-up can only raise the floor. Truncation in floor_of")
    print("   rounds down and the remainder stays in the pool, which is R3.")
    print("   Position identity is the right unit here. Keyed on (owner,")
    print("   outcome) instead, this counts a fresh position starting at cost")
    print("   basis where an earlier one had ratcheted, and the documented 2.8")
    print("   re-quote across a switch, neither of which is a floor falling.")
    print()


# ---- 3. crystallising is load-bearing --------------------------------------

def without_banking(trials=2000):
    print("3. the same merge without banking the accrued floor")
    r = _drive(NoBankMarket, trials, seed=77)
    print(f"   floors observed to decrease, same measure as above: {r['drops']:,}")
    print(f"   markets breaking (I) or share conservation: {r['broke']}")
    assert r['drops'] > 0
    print("   (I) survives, because the pool never owes more than it did. What")
    print("   breaks is the promise: a holder who buys more of an outcome they")
    print("   already back loses the ratchet they had earned on it. This is the")
    print("   failure the program will have if the top-up path is written as an")
    print("   addition rather than a bank-then-extend.")
    print()


# ---- 4. merging against appending ------------------------------------------

def merge_vs_append(trials=2000):
    print("4. merging against appending, identical inputs")
    same_pool = 0
    same_paid = 0
    n_runs    = 0
    for seed in range(trials):
        random.seed(seed)
        n  = random.choice([2, 3])
        kw = dict(lam_bps=random.choice([0, 4000]),
                  threshold=10**6, fee_bps=random.choice([0, 100]))
        seq = [(random.randrange(4), random.randrange(n),
                random.choice([10**4, 10**6, 10**9]))
               for _ in range(random.randint(4, 30))]
        w = random.randrange(n)

        a = MergeMarket(n, **kw)
        b = IntMarket(n, **kw)
        for o, i, v in seq:
            a.buy(i, v, owner=o)
            b.buy(i, v, owner=o)
        a.check(); b.check()
        pa, _ = a.settle(w)
        pb, _ = b.settle(w)
        n_runs   += 1
        same_pool += a.P == b.P
        same_paid += pa == pb
    print(f"   {n_runs} matched runs")
    print(f"   pools identical:   {same_pool:,}/{n_runs}")
    print(f"   total paid identical: {same_paid:,}/{n_runs}")
    assert same_pool == n_runs
    print("   The pool is identical because the merge changes only how claims")
    print("   are grouped, never how much enters. Payouts differ where they do")
    print("   because truncation is applied once per account rather than once")
    print("   per buy, and it rounds down either way, so dust stays in the pool.")
    print()


if __name__ == "__main__":
    merge_holds()
    without_banking()
    merge_vs_append()
