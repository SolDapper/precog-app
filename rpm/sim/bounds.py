"""
Section 3 groundwork: arithmetic bounds and the go-live haircut.

Two jobs.

1. Bound every intermediate the program computes, so the u128 claims are proved
   rather than assumed. We pick protocol constants, derive worst cases from
   them, and then run the integer reference at those magnitudes with live
   overflow assertions.

2. Check that charging the entry fee once at go-live, against the positions that
   convert, preserves the invariant.
"""

from math import isqrt
import random
from int_reference import IntMarket, BPS, ACC

U128 = (1 << 128) - 1
U64  = (1 << 64) - 1

# ---- proposed protocol constants -----------------------------------------
MAX_OUTCOMES = 10           # unchanged from v1
MAX_POOL     = 1 << 62      # base units, about 4.61e18
MAX_SHARES   = 1 << 62      # per outcome


def derive_bounds():
    rows = []
    def add(name, worst, note):
        rows.append((name, worst, worst / U128, note))

    T_max = MAX_OUTCOMES * MAX_SHARES**2
    add("T = sum q_i^2", T_max, f"{MAX_OUTCOMES} outcomes at MAX_SHARES")

    C_max = isqrt(T_max)
    D_max = MAX_SHARES**2 + 2*C_max*MAX_POOL + MAX_POOL**2
    add("buy discriminant", D_max, "q_i^2 + 2*C*c + c^2 at the cap")

    add("switch inner", 2 * MAX_SHARES**2, "q_a^2 + q_b^2, third term subtracts")
    add("ratchet numerator", MAX_POOL * ACC, "gross * ACC with gross <= P")

    # acc_j is bounded because everything it distributes has to fit under P.
    # total distributed on j  ~=  acc_j * q_j / ACC  <=  S_j  <=  P
    #   =>  acc_j <= P * ACC / q_j,  worst case q_j = 1
    acc_max = MAX_POOL * ACC
    add("acc_j", acc_max, "P*ACC/q_j, worst case q_j = 1")

    # and the product in floor_of is bounded by the same argument running the
    # other way: s <= q_j, so s*(acc-a) <= q_j * P*ACC/q_j = P*ACC
    add("s * (acc - a)", MAX_POOL * ACC, "s <= q_j cancels the q_j in acc")

    add("s * residual", MAX_SHARES * MAX_POOL, "settlement payout term")

    print(f"{'intermediate':22} {'worst case':>26} {'of u128':>9}  note")
    ok = True
    for name, worst, frac, note in rows:
        flag = "" if worst <= U128 else "  <-- OVERFLOW"
        if worst > U128: ok = False
        print(f"{name:22} {worst:26d} {frac:8.1%}  {note}{flag}")
    print(f"\nall intermediates fit in u128: {ok}")
    return ok


# ---- runtime check at extreme magnitudes ---------------------------------
class BoundedMarket(IntMarket):
    """Same mechanism, asserting every intermediate stays inside u128."""
    def _ratchet(self, i, c):
        gross = (c * self.lam_bps) // BPS
        assert gross * ACC <= U128, "ratchet numerator overflow"
        super()._ratchet(i, c)
        for j in range(self.n):
            assert self.acc[j] <= U128, "acc overflow"

    def buy(self, i, value, owner=0):
        if self.curve:
            C = isqrt(self.T)
            c = value - (value * self.fee_bps) // BPS
            assert self.q[i]**2 + 2*C*c + c*c <= U128, "discriminant overflow"
        p = super().buy(i, value, owner)
        assert self.T <= U128, "T overflow"
        assert self.P <= MAX_POOL, "pool cap exceeded"
        for x in self.q:
            assert x <= MAX_SHARES, "share cap exceeded"
        for x in self.pos:
            assert x['s'] * (self.acc[x['i']] - x['a']) <= U128, "floor product overflow"
        return p


def stress_at_scale():
    random.seed(31)
    biggest_pool = 0
    for _ in range(600):
        n = random.choice([2, 3, 10])
        m = BoundedMarket(n, lam_bps=9900, threshold=10**9, fee_bps=30)
        # deliberately mix one-share outcomes against near-cap deposits, which
        # is the shape that maximises acc_j
        m.buy(0, 1)
        for _ in range(random.randint(5, 40)):
            i = random.randrange(n)
            v = random.choice([1, 2, 10**9, 10**15, 10**17, MAX_POOL // 64])
            if m.P + v > MAX_POOL:
                break
            m.buy(i, v)
            m.check()
        biggest_pool = max(biggest_pool, m.P)
        if m.pos:
            m.settle(random.randrange(n))
    return biggest_pool


# ---- go-live fee haircut -------------------------------------------------
class HaircutMarket(IntMarket):
    """Ante is free. The entry fee is charged once, at go-live, against the
    positions that convert.

    The rate is held in _rate rather than read from self.fee_bps at haircut
    time. buy() zeroes fee_bps for the duration of an Ante buy, and
    _maybe_convert runs inside that call, so a haircut reading self.fee_bps
    sees zero and charges nothing.
    """
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._rate = self.fee_bps

    def buy(self, i, value, owner=0):
        if not self.curve:
            saved, self.fee_bps = self.fee_bps, 0     # Ante is free
            try:
                return super().buy(i, value, owner)
            finally:
                self.fee_bps = saved
        return super().buy(i, value, owner)

    def _maybe_convert(self):
        was = self.curve
        super()._maybe_convert()
        if self.curve and not was:
            self._haircut()

    def _haircut(self):
        total = 0
        for p in self.pos:
            fee = (p['c'] * self._rate) // BPS        # rounds down, R1
            p['c'] -= fee
            p['b'] -= fee
            self.S[p['i']] -= fee
            total += fee
        self.P    -= total
        self.fees += total


def haircut_test():
    random.seed(47)
    breaks = 0
    for _ in range(2000):
        n = random.choice([2, 3, 10])
        m = HaircutMarket(n,
                          lam_bps=random.choice([2500, 9900]),
                          threshold=random.choice([10**6, 10**9]),
                          fee_bps=random.choice([30, 100, 500]))
        try:
            for _ in range(random.randint(3, 50)):
                m.buy(random.randrange(n), random.choice([10**4, 10**7, 10**11]))
                m.check()
            if m.pos:
                m.settle(random.randrange(n))
        except AssertionError:
            breaks += 1
    return breaks


if __name__ == "__main__":
    print("=== bound derivation ===\n")
    derive_bounds()

    print("\n=== runtime check at extreme magnitudes ===")
    biggest = stress_at_scale()
    print(f"600 markets run up to a pool of {biggest:,} base units "
          f"({biggest/MAX_POOL:.1%} of cap): no intermediate exceeded u128.")

    print("\n=== go-live fee haircut ===")
    b = haircut_test()
    print(f"2000 markets with a free Ante and a conversion-time fee: "
          f"{b} invariant violations.")
