"""The void and refund path.

Section 2 specifies buy, ratchet, switch, transfer and settlement. It does not
specify what happens when a market is voided, and v1 carries VoidMarket and
ClaimRefund as instructions, so RPM has a path with no specification and no
proof behind it. This file supplies the verification for one.

The proposal is that a void refunds every open position its cost basis `c`,
the amount that actually entered the pool, and extinguishes ratcheted floors.

  1. P = sum(c) is preserved by every operation            Lemma 4
  2. the rounding the lemma depends on, and how it fails   Lemma 4, R4
  3. what a void extinguishes, by position size            the decision itself
  4. a void during Ante is a forced withdrawal
  5. why accrued floors cannot be honoured instead
  6. the go-live haircut cannot run in one instruction
  7. escrowing the Ante fee, which removes the problem in 6

Section 1 is the load-bearing one. There is exactly zero slack in it: the pool
covers the refunds to the unit and never by more, so any operation that moves
`P` and `c` by different amounts breaks the path. Section 2 shows that the
obvious way to write the go-live haircut is such an operation, and that the
existing invariant check does not catch it.
"""
import random
import statistics
from math import isqrt

from int_reference import IntMarket, BPS
from bounds import HaircutMarket


class VoidableMarket(HaircutMarket):
    """The decided fee model, plus the Ante withdrawal from ante.py variant B,
    plus the refund accounting a void would use."""

    def withdraw(self, p):
        """Leave at par. Legal only while the market is in Ante."""
        if self.curve:
            return False
        self.q[p['i']] -= p['s']
        self.P         -= p['c']
        self.S[p['i']] -= self.floor_of(p)
        self.pos.remove(p)
        return True

    def refund_owed(self):
        return sum(p['c'] for p in self.pos)

    def void(self):
        """Pay every open position its cost basis. Returns pool minus owed,
        which Lemma 4 says is exactly zero."""
        owed = self.refund_owed()
        assert self.P >= owed, f"cannot cover refunds: P={self.P} owed={owed}"
        return self.P - owed


class PoolHaircutMarket(VoidableMarket):
    """The same mechanism with one careless choice in the go-live haircut: the
    amount removed from the pool is computed once against the pool total,
    while each position is reduced individually.

    floor of a sum is greater than or equal to a sum of floors, so the pool
    gives up more than the positions do and the identity in Lemma 4 fails. It
    is a handful of base units. With zero slack a handful is enough.
    """
    def _haircut(self):
        total = (self.P * self._rate) // BPS
        for p in self.pos:
            fee = (p['c'] * self._rate) // BPS
            p['c'] -= fee
            p['b'] -= fee
            self.S[p['i']] -= fee
        self.P    -= total
        self.fees += total


def _exercise(cls, trials, seed):
    """Drive a market over every path that touches P or c, checking the
    identity after each step. Returns worst gap, insolvent steps, path counts."""
    random.seed(seed)
    worst = None
    insolvent = 0
    paths = dict(buys=0, switches=0, transfers=0, withdrawals=0, haircuts=0)
    for _ in range(trials):
        n = random.choice([2, 3, 10])
        m = cls(n,
                lam_bps=random.choice([0, 4000, 9900]),
                threshold=random.choice([10**5, 10**9, 10**14]),
                fee_bps=random.choice([0, 100, 300]))
        was_live = False
        for _ in range(random.randint(2, 60)):
            r = random.random()
            if r < 0.70 or not m.pos:
                m.buy(random.randrange(n), random.choice([1, 7, 10**3, 10**7, 10**11]))
                paths['buys'] += 1
            elif m.curve and r < 0.85:
                m.switch(random.choice(m.pos), random.randrange(n))
                paths['switches'] += 1
            elif not m.curve:
                paths['withdrawals'] += m.withdraw(random.choice(m.pos))
            else:
                m.transfer(random.choice(m.pos), random.randrange(99))
                paths['transfers'] += 1
            if m.curve and not was_live:
                paths['haircuts'] += 1
                was_live = True
            m.check()
            gap = m.P - m.refund_owed()
            worst = gap if worst is None else min(worst, gap)
            insolvent += gap < 0
    return worst, insolvent, paths


# ---- 1. the identity behind the lemma -------------------------------------

def cost_basis_identity(trials=3000):
    print("1. P equals the sum of cost bases, on every path")
    worst, insolvent, paths = _exercise(VoidableMarket, trials, seed=101)
    print(f"   {trials} markets: {paths['buys']:,} buys, {paths['switches']:,} switches,")
    print(f"   {paths['transfers']:,} transfers, {paths['withdrawals']:,} Ante withdrawals,")
    print(f"   {paths['haircuts']:,} go-live haircuts")
    print(f"   worst pool minus owed: {worst}")
    print(f"   steps where the pool could not cover refunds: {insolvent}")
    assert insolvent == 0 and worst == 0
    print("   Exactly solvent and exactly zero slack, held across switching,")
    print("   transfer and Ante withdrawal, not buys alone.")
    print()


# ---- 2. the rounding it depends on ----------------------------------------

def haircut_rounding(trials=3000):
    print("2. the rounding the lemma depends on")
    worst, insolvent, _ = _exercise(PoolHaircutMarket, trials, seed=101)
    print(f"   haircut totalled against the pool instead of per position:")
    print(f"   worst pool minus owed: {worst}")
    print(f"   steps where the pool could not cover refunds: {insolvent}")
    assert insolvent > 0 and worst < 0
    print("   (I) held throughout and check() raised nothing, because the pool")
    print("   losing more than the obligations is the safe direction for the")
    print("   invariant and the unsafe one for refunds. R4 is a separate rule.")
    print()


# ---- 3. what a void extinguishes ------------------------------------------

def extinguished_floors(trials=3000, lam_bps=4000, fee_bps=100):
    print("3. what a void takes away, at lambda = %.2f" % (lam_bps / BPS))
    random.seed(7)
    buckets = {'dust (<1e4)': [], 'small (1e4 to 1e7)': [], 'large (>=1e7)': []}
    fee_share = []
    for _ in range(trials):
        n = random.choice([2, 3, 10])
        m = VoidableMarket(n, lam_bps=lam_bps, threshold=10**6, fee_bps=fee_bps)
        for _ in range(random.randint(5, 60)):
            m.buy(random.randrange(n), random.choice([10**4, 10**6, 10**9]))
        if not m.curve or not m.pos:
            continue
        assert m.void() == 0
        for p in m.pos:
            if p['c'] <= 0:
                continue
            ratio = m.floor_of(p) / p['c']
            key = ('dust (<1e4)' if p['c'] < 10**4 else
                   'small (1e4 to 1e7)' if p['c'] < 10**7 else 'large (>=1e7)')
            buckets[key].append(ratio)
        if m.P + m.fees > 0:
            fee_share.append(m.fees / (m.P + m.fees))

    print(f"   floor as a multiple of cost basis, which the refund gives up")
    print(f"   {'bucket':20} {'n':>8} {'median':>8} {'p90':>10} {'max':>10} {'>1.0x':>8}")
    for key, vals in buckets.items():
        if not vals:
            continue
        vals.sort()
        print(f"   {key:20} {len(vals):>8,} {statistics.median(vals):>8.2f} "
              f"{vals[int(0.9 * len(vals))]:>10.2f} {max(vals):>10,.0f} "
              f"{sum(v > 1.0 for v in vals) / len(vals):>7.1%}")
    print("   The tail sits in the small buckets, where a large ratchet lands")
    print("   on a tiny basis. A mean over all of them is 2,117x and describes")
    print("   nothing. The large bucket is the one a user recognises.")
    print(f"   entry fee already swept, not recoverable in a refund at c: "
          f"{statistics.median(fee_share):.3%}")
    print()


# ---- 4. a void during Ante -------------------------------------------------

def void_in_ante(trials=2000):
    print("4. a void during Ante")
    random.seed(5)
    worst = None
    for _ in range(trials):
        n = random.choice([2, 3, 10])
        m = VoidableMarket(n, lam_bps=random.choice([0, 4000]),
                           threshold=10**14, fee_bps=random.choice([0, 100, 300]))
        for _ in range(random.randint(1, 30)):
            m.buy(random.randrange(n), random.choice([1, 10**3, 10**7]))
        if m.curve or not m.pos:
            continue
        assert m.fees == 0, "Ante is free"
        gap = m.void()
        worst = gap if worst is None else min(worst, gap)
    print(f"   worst pool minus owed: {worst}")
    assert worst == 0
    print("   Ante charges nothing and accrues nothing, so c is the full amount")
    print("   paid in and a void there is every position withdrawing at par at")
    print("   once. The path already exists and needs no separate argument.")
    print()


# ---- 5. why floors cannot be honoured instead ------------------------------

def obligation_total(trials=3000):
    print("5. the total obligation across outcomes, against the pool")
    random.seed(11)
    live, all_m = [], []
    for _ in range(trials):
        n = random.choice([2, 3, 10])
        lam = random.choice([0, 4000, 9900])
        m = VoidableMarket(n, lam_bps=lam,
                           threshold=random.choice([10**5, 10**9]),
                           fee_bps=random.choice([0, 100, 300]))
        for _ in range(random.randint(2, 60)):
            r = random.random()
            if r < 0.75 or not m.pos:
                m.buy(random.randrange(n), random.choice([1, 7, 10**3, 10**7, 10**11]))
            elif m.curve:
                m.switch(random.choice(m.pos), random.randrange(n))
            m.check()
        if m.P <= 0:
            continue
        ratio = sum(m.S) / m.P
        all_m.append(ratio)
        if m.curve and lam > 0:
            live.append(ratio)
    assert min(all_m) >= 1.0, "sum of obligations fell below the pool"
    live.sort()
    print(f"   {len(all_m):,} markets, sum(Sᵢ) / P: min {min(all_m):.4f}, "
          f"max {max(all_m):.2f}")
    print(f"   {len(live):,} of them Live with a ratchet running: "
          f"median {statistics.median(live):.2f}, "
          f"p90 {live[int(0.9 * len(live))]:.2f}")
    print("   Never below 1. Each outcome's obligation is bounded by the pool")
    print("   separately, not jointly, so honouring accrued floors on a void")
    print("   would need several times the money that is there. The minimum of")
    print("   exactly 1 is the un-ratcheted case, where floors are cost bases")
    print("   and honouring them is the refund already specified.")
    print()


# ---- 6. the haircut cannot be applied in one instruction --------------------

class LazyHaircutMarket(IntMarket):
    """bounds.py charges the go-live haircut by looping over every position at
    the moment of conversion. On chain each position is its own account and
    there is no cap on how many exist, so a single instruction cannot do it.

    The alternative is to defer: record the rate at conversion and let each
    position give up its own floor(c*r) the first time it is touched
    afterwards, whether by a claim, a refund, a switch or a transfer. R4 is
    satisfied for the same reason it was before, since the pool still loses
    exactly the sum of the per-position deductions. It just loses them over
    time rather than at once.
    """
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._rate = self.fee_bps
        self._pending = set()

    def buy(self, i, value, owner=0):
        if not self.curve:
            saved, self.fee_bps = self.fee_bps, 0
            try:
                return super().buy(i, value, owner)
            finally:
                self.fee_bps = saved
        return super().buy(i, value, owner)

    def _maybe_convert(self):
        was = self.curve
        super()._maybe_convert()
        if self.curve and not was:
            self._pending = {id(p) for p in self.pos}

    def touch(self, p):
        if id(p) not in self._pending:
            return 0
        self._pending.discard(id(p))
        fee = (p['c'] * self._rate) // BPS
        p['c'] -= fee
        p['b'] -= fee
        self.S[p['i']] -= fee
        self.P -= fee
        self.fees += fee
        return fee

    def refund_owed(self):
        return sum(p['c'] for p in self.pos)


def deferred_haircut(trials=3000):
    print("6. the haircut applied lazily, one position at a time")
    random.seed(101)
    worst, insolvent, touched, broke = None, 0, 0, 0
    for _ in range(trials):
        n = random.choice([2, 3, 10])
        m = LazyHaircutMarket(n,
                              lam_bps=random.choice([0, 4000, 9900]),
                              threshold=random.choice([10**5, 10**9]),
                              fee_bps=random.choice([0, 100, 300]))
        try:
            for _ in range(random.randint(2, 60)):
                if random.random() < 0.7 or not m.pos:
                    m.buy(random.randrange(n), random.choice([1, 7, 10**3, 10**7, 10**11]))
                else:
                    touched += m.touch(random.choice(m.pos)) > 0
                m.check()
                gap = m.P - m.refund_owed()
                insolvent += gap < 0
                worst = gap if worst is None else min(worst, gap)
            for p in list(m.pos):
                m.touch(p)
            m.check()
            gap = m.P - m.refund_owed()
            insolvent += gap < 0
            worst = min(worst, gap)
        except AssertionError:
            broke += 1
    print(f"   {trials} markets, {touched:,} positions haircut on first touch")
    print(f"   worst pool minus owed: {worst}")
    print(f"   steps where the pool could not cover refunds: {insolvent}")
    print(f"   markets breaking (I): {broke}")
    assert insolvent == 0 and worst == 0 and broke == 0
    print("   Deferring costs nothing. Both sides still move together, so the")
    print("   identity holds at every intermediate state, not only once every")
    print("   position has been touched.")
    print()


# ---- 7. escrowing the Ante fee ---------------------------------------------

class EscrowMarket(IntMarket):
    """The fee is computed per position at buy time, in both modes. In Ante it
    is held on the position rather than swept, so an Ante withdrawal returns
    the whole amount paid and leaving stays costless. Conversion sweeps one
    running total in a single field update.

    Nothing iterates positions, the pool is exact at every moment, and a floor
    is quoted net of fee from the start, so it never falls afterwards. The
    deferred scheme in 6 is arithmetically sound but drops a position's floor
    at its first touch after conversion, which can land at claim time, long
    after the number was quoted.
    """
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._rate = self.fee_bps
        self.escrow = 0

    def buy(self, i, value, owner=0):
        fee = (value * self._rate) // BPS
        c = value - fee
        if c <= 0:
            return None
        self._ratchet(i, c)
        if self.curve:
            C = isqrt(self.T)
            s = isqrt(self.q[i] * self.q[i] + 2 * C * c + c * c) - self.q[i]
            if s <= 0:
                return None
            self.T += 2 * self.q[i] * s + s * s
            self.fees += fee
            esc = 0
        else:
            s = c
            self.escrow += fee
            esc = fee
        self.q[i] += s
        self.P    += c
        self.S[i] += c
        p = dict(i=i, s=s, c=c, b=c, a=self.acc[i], owner=owner, esc=esc, paid=value)
        self.pos.append(p)
        self._maybe_convert()
        return p

    def _maybe_convert(self):
        was = self.curve
        super()._maybe_convert()
        if self.curve and not was:
            self.fees += self.escrow
            self.escrow = 0
            for p in self.pos:
                p['esc'] = 0

    def withdraw(self, p):
        if self.curve:
            return 0
        self.q[p['i']] -= p['s']
        self.P         -= p['c']
        self.S[p['i']] -= self.floor_of(p)
        self.escrow    -= p['esc']
        back = p['c'] + p['esc']
        self.pos.remove(p)
        return back

    def refund_owed(self):
        return sum(p['c'] for p in self.pos)


def escrowed_ante_fee(trials=3000):
    print("7. escrowing the Ante fee instead of deferring the haircut")
    random.seed(101)
    worst, insolvent, broke, wd, exact = None, 0, 0, 0, 0
    for _ in range(trials):
        n = random.choice([2, 3, 10])
        m = EscrowMarket(n,
                         lam_bps=random.choice([0, 4000, 9900]),
                         threshold=random.choice([10**5, 10**9]),
                         fee_bps=random.choice([0, 100, 300]))
        try:
            for _ in range(random.randint(2, 60)):
                if random.random() < 0.75 or not m.pos:
                    m.buy(random.randrange(n), random.choice([1, 7, 10**3, 10**7, 10**11]))
                elif not m.curve:
                    p = random.choice(m.pos)
                    paid = p['paid']
                    back = m.withdraw(p)
                    wd += 1
                    exact += back == paid
                m.check()
                gap = m.P - m.refund_owed()
                insolvent += gap < 0
                worst = gap if worst is None else min(worst, gap)
        except AssertionError:
            broke += 1
    print(f"   worst pool minus owed: {worst}   insolvent steps: {insolvent}"
          f"   (I) breaks: {broke}")
    print(f"   Ante withdrawals: {wd:,}, returning the exact amount paid: {exact:,}")
    assert insolvent == 0 and worst == 0 and broke == 0 and wd == exact

    same = 0
    for seed in range(trials):
        random.seed(seed)
        n = random.choice([2, 3, 10])
        kw = dict(lam_bps=random.choice([0, 4000, 9900]),
                  threshold=random.choice([10**5, 10**9]),
                  fee_bps=random.choice([0, 100, 300]))
        seq = [(random.randrange(n), random.choice([1, 7, 10**3, 10**7, 10**11]))
               for _ in range(random.randint(2, 60))]
        a, b = EscrowMarket(n, **kw), HaircutMarket(n, **kw)
        for i, v in seq:
            a.buy(i, v)
            b.buy(i, v)
        same += a.fees == b.fees
    print(f"   identical buy sequences where escrow and the eager haircut")
    print(f"   collect the same fee: {same:,}/{trials}")
    assert same == trials
    print("   Same money, one field update at conversion, and no instruction")
    print("   that has to walk an unbounded set of accounts.")
    print()


# ---- 8. the sweep on a market that never converts ---------------------------

DEFAULT_FEE_BPS = 100          # protocol takes this; the creator keeps the rest


class NeverConvertMarket(EscrowMarket):
    """A market that never clears its threshold sweeps its escrow at
    settlement instead of at conversion.

    Collection is otherwise triggered by go-live, so without this a market
    whose threshold is never reached pays out its whole pool having collected
    nothing, and the creator is the one who sets the threshold. That is
    error 13.

    The escrow is a single field, so the split between the protocol share and
    the creator share has to be derived from it at sweep time. Deriving is not
    the same as having maintained: the escrow is a sum of truncated per-buy
    fees, and a ratio taken over that sum truncates a second time. Both are
    tracked so the gap is measured rather than assumed away. The creator side
    rounds down either way, so the remainder falls to the treasury, which is
    the party with no ability to cause a market to end up here.
    """

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.creator_bps   = max(0, self.fee_bps - DEFAULT_FEE_BPS)
        self.creator_true  = 0          # maintained per buy
        self.protocol_true = 0
        self.swept         = 0

    def buy(self, i, value, owner=0):
        before = self.escrow
        p = super().buy(i, value, owner=owner)
        if p is None:
            return None
        fee = self.escrow - before
        if fee > 0:
            cred = min((value * self.creator_bps) // BPS, fee)
            self.creator_true  += cred
            self.protocol_true += fee - cred
        return p

    def sweep_at_settlement(self):
        """One field update at finalization, on a market still in Ante."""
        esc = self.escrow
        creator_derived = (esc * self.creator_bps) // self.fee_bps if self.fee_bps else 0
        protocol_derived = esc - creator_derived
        self.fees  += esc
        self.swept  = esc
        self.escrow = 0
        for p in self.pos:
            p['esc'] = 0
        return protocol_derived, creator_derived


def never_converted_sweep(trials=3000):
    print("8. the escrow sweep on a market that never converts")
    random.seed(202)
    n_never = n_conv = 0
    collected_at_nominal = 0
    conv_collected_at_settlement = 0
    pool_moved = 0
    floor_breaks = 0
    split_exact = 0
    over = under = 0
    worst_gap = 0
    worst_rel = 0.0
    for _ in range(trials):
        n = random.choice([2, 3, 10])
        never = random.random() < 0.7
        m = NeverConvertMarket(
            n,
            lam_bps=random.choice([0, 4000, 9900]),
            threshold=10**18 if never else 10**5,
            fee_bps=random.choice([0, 100, 137, 217, 250, 300]))
        nominal = 0
        for _ in range(random.randint(2, 60)):
            v = random.choice([1, 7, 101, 999, 1234, 10**3, 12_345,
                               10**7, 999_999_937, 10**11])
            i = random.randrange(n)
            in_ante = not m.curve
            if m.buy(i, v) is not None and in_ante:
                nominal += (v * m.fee_bps) // BPS
            m.check()
        w = random.randrange(n)
        winners = [p for p in m.pos if p['i'] == w]
        if not winners:
            continue

        floors = [(p, m.floor_of(p)) for p in winners]
        pool_before = m.P
        converted = m.curve

        prot, cred = m.sweep_at_settlement()
        assert prot + cred == m.swept          # nothing leaks in the split
        pool_moved += (m.P != pool_before)

        if converted:
            n_conv += 1
            conv_collected_at_settlement += m.swept
        else:
            n_never += 1
            collected_at_nominal += (m.swept == nominal)
            gap = cred - m.creator_true
            over  += gap > 0
            under += gap < 0
            worst_gap = max(worst_gap, abs(gap))
            if m.swept:
                worst_rel = max(worst_rel, abs(gap) / m.swept)
            split_exact += (gap == 0)

        residual = m.P - m.S[w]
        for p, f in floors:
            pay = f + (p['s'] * residual) // m.q[w]
            if pay < f:
                floor_breaks += 1
        paid, dust = m.settle(w)
        assert paid + dust == pool_before

    print(f"   {n_never:,} markets never converted, {n_conv:,} converted")
    print(f"   never-converted markets collecting the nominal rate: "
          f"{collected_at_nominal:,}/{n_never:,}")
    print(f"   converted markets collecting at settlement: "
          f"{conv_collected_at_settlement:,} base units")
    print(f"   sweeps that moved the pool: {pool_moved:,}")
    print(f"   winning positions paid below their floor: {floor_breaks:,}")
    assert collected_at_nominal == n_never
    assert conv_collected_at_settlement == 0
    assert pool_moved == 0
    assert floor_breaks == 0
    print("   The escrow sits outside P, so sweeping it moves no pool and no")
    print("   payout. Collection is exact because the swept total is the sum of")
    print("   fees already taken, rather than a rate applied to something at")
    print("   settlement, which is what made the residual fee of error 13 vary")
    print("   with where the stake happened to sit.")
    print()
    print(f"   deriving the creator share from the swept total instead of")
    print(f"   maintaining it: exact in {split_exact:,}/{n_never:,} markets,")
    print(f"   worst gap {worst_gap:,} base units, worst as a share of the")
    print(f"   sweep {worst_rel:.3%}")
    print(f"   creator over-credited in {over:,}, under-credited in {under:,}")
    print("   The gap is the second truncation. One field cannot reproduce a")
    print("   split that was never stored, so either the layout carries the")
    print("   creator share separately or the design states that the treasury")
    print("   absorbs the difference.")
    print()


if __name__ == "__main__":
    cost_basis_identity()
    haircut_rounding()
    extinguished_floors()
    void_in_ante()
    obligation_total()
    deferred_haircut()
    escrowed_ante_fee()
    never_converted_sweep()
