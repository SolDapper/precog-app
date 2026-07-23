"""Claims that come from comparing variants or paths, rather than from the
main mechanism. These were originally computed in throwaway scripts, which is
the failure recorded as error 15. Each figure below is quoted somewhere in
prose, so it needs to live here where it can be rechecked.

  1. Ante ratchet crossed with the go-live haircut       whitepaper 2.5, error 12
  2. Headroom is not other-outcome stake                 handoff section 3

Refund solvency after a void used to live here as a third check. It exercised
buys only, so it never touched the switch, transfer or withdrawal paths that
the claim depends on. It now lives in void_refund.py, which covers all of them
and carries Lemma 4. One claim, one home.
"""
import random

from int_reference import IntMarket
from bounds import HaircutMarket
from pmm_reference import Market


# ---- 1. the interaction that breaks (I) ------------------------------------
# Neither running the ratchet during Ante nor charging a haircut at go-live
# breaks the invariant alone. Together they do. This is why the ratchet gate
# lives in IntMarket._ratchet and why _apply_ratchet is exposed separately:
# variant A is precisely the case that has to bypass the gate.

class _AnteRatchet:
    """Variant A: rewards accrue during Ante. The rejected design."""
    def _ratchet(self, i, c):
        self._apply_ratchet(i, c)


class A_haircut(_AnteRatchet, HaircutMarket):
    pass


class B_haircut(HaircutMarket):
    pass


class A_plain(_AnteRatchet, IntMarket):
    pass


class B_plain(IntMarket):
    pass


def variant_matrix(trials=2000):
    print("1. Ante ratchet crossed with the go-live haircut")
    print("   variant                                  markets breaking (I)")
    rows = [("ratchet in Ante  + go-live haircut", A_haircut),
            ("ratchet gated    + go-live haircut", B_haircut),
            ("ratchet in Ante,   no haircut     ", A_plain),
            ("ratchet gated,     no haircut     ", B_plain)]
    results = {}
    for name, cls in rows:
        random.seed(47)
        breaks = 0
        for _ in range(trials):
            n = random.choice([2, 3, 10])
            m = cls(n,
                    lam_bps=random.choice([2500, 9900]),
                    threshold=random.choice([10**6, 10**9]),
                    fee_bps=random.choice([30, 100, 500]))
            try:
                for _ in range(random.randint(3, 50)):
                    m.buy(random.randrange(n),
                          random.choice([10**4, 10**7, 10**11]))
                    m.check()
                if m.pos:
                    m.settle(random.randrange(n))
            except AssertionError:
                breaks += 1
        results[name] = breaks
        print(f"   {name}   {breaks:>4}/{trials}")
    assert results["ratchet gated    + go-live haircut"] == 0
    assert results["ratchet gated,     no haircut     "] == 0
    assert results["ratchet in Ante,   no haircut     "] == 0
    assert results["ratchet in Ante  + go-live haircut"] > 0
    print("   Only the pair breaks it, which is the claim in whitepaper 2.5.")
    print()


# ---- 2. the headroom identity that was false -------------------------------
# The reference card claimed H_i = P - S_i equals the value staked on every
# other outcome. It does not: floors already ratcheted onto i sit inside S_i.
# The two coincide only at lambda = 0.

def headroom_gap(trials=400):
    print("2. headroom against other-outcome stake")
    random.seed(3)
    worst, n_obs = 0.0, 0
    at_zero_lambda = 0.0
    for _ in range(trials):
        n = random.choice([2, 3])
        lam = random.choice([0.0, 0.4, 0.9])
        m = Market(n, lam)
        for k in range(n):
            m.buy(k, 200)
        for _ in range(random.randint(5, 30)):
            m.buy(random.randrange(n), random.choice([50, 500, 5000]))
        for i in range(n):
            gap = abs((m.pool - m.S[i]) -
                      sum(p['cost'] for p in m.pos if p['i'] != i))
            worst = max(worst, gap)
            if lam == 0.0:
                at_zero_lambda = max(at_zero_lambda, gap)
            n_obs += 1
    print(f"   {n_obs} samples, worst gap {worst:,.0f} base units")
    print(f"   worst gap at lambda = 0: {at_zero_lambda:,.2f}")
    assert worst > 1.0, "expected a gap; the identity is false in general"
    assert at_zero_lambda < 1e-6, "expected exactness at lambda = 0"
    print("   Not an identity. Headroom is other-outcome stake less whatever")
    print("   has already been ratcheted onto i. Exact only at lambda = 0.")
    print()


if __name__ == "__main__":
    variant_matrix()
    headroom_gap()
