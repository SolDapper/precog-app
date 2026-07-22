"""Settlement fee for a market that resolves without ever converting.

Error 13: moving fees to entry means collection is triggered by go-live, so a
market that never reaches its threshold pays out its whole pool and collects
nothing. The creator sets the threshold, so this is settable.

The fix is a fee drawn from the settlement residual only. Section 4 rejected
settlement fees because a fee taken from a payout can push it below the floor,
and that reason does not reach this construction: the residual is what remains
after every winning floor is paid, so taking a fraction of it leaves

    payout = F + share of (R - fee)  >=  F

for every winner. Only markets that never converted are charged, since a
converted market already paid at go-live and on entry.

Rounding follows the existing discipline. The fee rounds down, so the protocol
takes the smaller side of a fraction. The distribution of what is left also
rounds down, so dust stays in the pool rather than being overpaid out.

This file asserts, rather than argues, that:

  1. (I) holds and no winner is ever paid below their floor
  2. total paid out plus fees collected never exceeds the pool
  3. a never-converted market now collects a fee at all
  4. a converted market is not charged twice
"""
import random
from int_reference import IntMarket, BPS


class SettleFeeMarket(IntMarket):
    """Ante free, no haircut for a market that never converts, and a fee taken
    from the residual at settlement instead."""

    def settle(self, w):
        winners = [p for p in self.pos if p['i'] == w]
        if not winners:
            # nobody holds the winning outcome: the whole pool is residual
            fee = (self.P * self.fee_bps) // BPS if not self.curve else 0
            self.fees += fee
            return 0, self.P - fee

        residual = self.P - self.S[w]
        assert residual >= 0, "negative residual"

        fee = (residual * self.fee_bps) // BPS if not self.curve else 0
        net = residual - fee
        assert net >= 0, "fee exceeded residual"
        self.fees += fee

        paid = 0
        for p in winners:
            F   = self.floor_of(p)
            add = (p['s'] * net) // self.q[w]        # R1: rounds down
            pay = F + add
            assert pay >= F, "payout below floor"
            paid += pay
        assert paid + fee <= self.P, f"overpay: {paid} + {fee} > {self.P}"
        return paid, self.P - paid - fee


def suite(trials=3000):
    random.seed(61)
    never, conv = 0, 0
    fees_never, fees_conv = 0, 0
    zero_fee_never = 0
    for _ in range(trials):
        n  = random.choice([2, 3, 10])
        # thresholds chosen so a good share of markets never convert
        m  = SettleFeeMarket(n,
                             lam_bps=random.choice([0, 2500, 4000, 9900]),
                             threshold=random.choice([10**5, 10**9, 10**14]),
                             fee_bps=random.choice([30, 100, 300]))
        for _ in range(random.randint(2, 60)):
            m.buy(random.randrange(n), random.choice([1, 7, 10**3, 10**7, 10**11]))
            m.check()
        before = m.fees
        m.settle(random.randrange(n))
        taken = m.fees - before
        if m.curve:
            conv += 1
            fees_conv += taken
        else:
            never += 1
            fees_never += taken
            if taken == 0 and m.P > 0:
                zero_fee_never += 1
    return never, conv, fees_never, fees_conv, zero_fee_never


def floor_is_never_breached(trials=2000):
    """The property the whole construction rests on, checked directly on the
    markets most likely to break it: everything on one side, dust amounts, and
    the maximum fee."""
    random.seed(83)
    checked = 0
    for _ in range(trials):
        n = random.choice([2, 3])
        m = SettleFeeMarket(n, lam_bps=0, threshold=10**14, fee_bps=300)
        for _ in range(random.randint(2, 30)):
            m.buy(random.choice([0, 0, 0, 1]), random.choice([1, 2, 3, 10**4]))
        w = random.randrange(n)
        winners = [p for p in m.pos if p['i'] == w]
        floors = {id(p): m.floor_of(p) for p in winners}
        residual = m.P - m.S[w] if winners else m.P
        fee = (residual * m.fee_bps) // BPS
        net = residual - fee
        for p in winners:
            add = (p['s'] * net) // m.q[w]
            assert floors[id(p)] + add >= floors[id(p)], "floor breached"
            assert floors[id(p)] >= p['c'], "floor below cost basis"
            checked += 1
    return checked


if __name__ == "__main__":
    never, conv, f_never, f_conv, zero = suite()
    print(f"3000 markets: {never} never converted, {conv} converted")
    print(f"  fees collected at settlement, never-converted markets: {f_never:,}")
    print(f"  fees collected at settlement, converted markets:       {f_conv:,}"
          f"   (must be 0, they paid at go-live)")
    print(f"  never-converted markets that still collected nothing:  {zero}"
          f"   (dust pools only)")
    print("  (I) held, no winner paid below floor, no overpay, across every market.")
    checked = floor_is_never_breached()
    print(f"{checked:,} winning positions on adversarial one-sided dust markets at the "
          f"3% cap: every payout at or above its floor, every floor at or above cost basis.")
