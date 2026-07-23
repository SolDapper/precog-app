"""What a participant sees, start to settlement, and the distribution behind it.

Pro rata by shares, the decided residual policy. The first half prints the
user-facing view for each position: what they paid, what they are guaranteed,
and what they collect if their outcome wins. Numbers are generated rather than
asserted by hand, so anything quoted in the paper or the app traces to this run.

The second half exists because one walkthrough cannot support a claim about
what the mechanism rewards. This example has the early buyer ahead of the late
one by three percent at the default lambda, and a three-outcome example can be
built at the same lambda with the ordering reversed. Measured across markets
the ordering is close to a coin flip at the default and only tips to the early
buyer above it, while the buyer holding the most shares per unit paid wins at
every lambda tested. Early entry buys a floor rather than a return, which is
what copy has to say.
"""
from bootstrap import BootMarket

LAM = 0.4

m = BootMarket(2, LAM, threshold=200)
NAMES = ["Yes", "No"]
people = []

def buy(who, outcome, amount):
    before = m.price(outcome)
    mode = "Ante" if not m.curve else "Live"
    m.buy(outcome, amount)
    p = m.pos[-1]
    people.append((who, p))
    print(f"  {who:<6} pays {amount:>4} into {NAMES[outcome]:<3} in {mode:<4} mode -> "
          f"{p['shares']:>7.2f} shares, floor quoted at {m.floor_of(p):>7.2f}")

print("A two outcome market, lambda = 0.4, go-live threshold 200.\n")
buy("Alice", 0, 100)
buy("Dave",  1, 100)
buy("Carol", 1, 300)
buy("Bob",   0, 100)

print(f"\n  pool = {m.pool:.2f}, mode = {'Live' if m.curve else 'Ante'}")
print(f"  Yes shares outstanding = {m.q[0]:.2f}, No shares outstanding = {m.q[1]:.2f}")
print(f"  payout ratio if Yes wins = {m.pool/m.q[0]:.3f} per share")

print("\nfloors carried into settlement:")
for who, p in people:
    print(f"  {who:<6} on {NAMES[p['i']]:<3}: paid {p['cost']:>5.0f}, "
          f"floor now {m.floor_of(p):>7.2f} "
          f"({m.floor_of(p) - p['cost']:>+6.2f} from the ratchet)")

w = 0
winners = [(who, p) for who, p in people if p['i'] == w]
floors = sum(m.floor_of(p) for _, p in winners)
R = m.pool - floors
q_w = sum(p['shares'] for _, p in winners)

print(f"\nYes resolves true.")
print(f"  pool {m.pool:.2f} less winning floors {floors:.2f} leaves a residual of {R:.2f}")
print(f"  residual splits pro rata across {q_w:.2f} Yes shares\n")
print(f"  {'':<6} {'paid':>6} {'shares':>9} {'floor':>9} {'residual':>10} {'payout':>9} {'return':>8}")
for who, p in winners:
    s = p['shares']
    F = m.floor_of(p)
    add = R * s / q_w
    print(f"  {who:<6} {p['cost']:>6.0f} {s:>9.2f} {F:>9.2f} {add:>10.2f} "
          f"{F+add:>9.2f} {(F+add)/p['cost']:>7.2f}x")

paid = sum(m.floor_of(p) + R*p['shares']/q_w for _, p in winners)
print(f"\n  total paid out {paid:.2f} against a pool of {m.pool:.2f}")
assert paid <= m.pool + 1e-9, "overpay"
for who, p in winners:
    assert m.floor_of(p) + R*p['shares']/q_w + 1e-9 >= m.floor_of(p)
print("  every winner cleared their floor and the pool covered the total.")


# ---- the distribution behind the walkthrough --------------------------------
#
# The example above is one market. Section 9 of the handoff records a
# three-outcome walkthrough at the same lambda where the ordering is reversed,
# so a single example can be built to demonstrate either claim. Error 9 was
# recommending a parameter from one favourable statistic; quoting one worked
# example to app copy is the same mistake with a smaller sample. This measures
# which buyer the mechanism actually favours, and how reliably.
#
#   early  = the first position on the winning outcome, paid through the floor
#   late   = the last position on the winning outcome
#   cheap  = the winning position that bought the most shares per unit paid
#   dear   = the winning position that bought the fewest

import random


def _returns(m, w):
    winners = [p for p in m.pos if p['i'] == w]
    if len(winners) < 2:
        return None
    floors = sum(m.floor_of(p) for p in winners)
    R = m.pool - floors
    if R < -1e-9:
        return None
    q_w = sum(p['shares'] for p in winners)
    out = []
    for p in winners:
        pay = m.floor_of(p) + R * p['shares'] / q_w
        out.append((pay / p['cost'], p))
    return out


def framing_distribution(trials=1500,
                         lams=(0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.60)):
    print("\n\nWhich buyer does the mechanism actually favour?")
    print(f"{'lambda':>8} {'early':>9} {'late':>9} {'tied':>9} "
          f"{'cheap':>9} {'dear':>9} {'tied':>9} {'decided':>9}")
    for lam in lams:
        early_w = late_w = tie_w = 0
        cheap_w = dear_w = tie_c = 0
        n = 0
        for t in range(trials):
            random.seed(t)
            k = random.choice([2, 3])
            m = BootMarket(k, lam, threshold=random.choice([200, 2000]))
            for _ in range(random.randint(4, 20)):
                m.buy(random.randrange(k),
                      random.choice([50, 100, 300, 1000]))
            w = random.randrange(k)
            res = _returns(m, w)
            if res is None:
                continue
            n += 1
            first, last = res[0][0], res[-1][0]
            tol = 1e-9 * max(1.0, abs(first))
            if   first > last + tol: early_w += 1
            elif last > first + tol: late_w  += 1
            else:                    tie_w   += 1
            by_sh = sorted(res, key=lambda r: r[1]['shares'] / r[1]['cost'])
            lo, hi = by_sh[0][0], by_sh[-1][0]
            if   hi > lo + tol: cheap_w += 1
            elif lo > hi + tol: dear_w  += 1
            else:               tie_c   += 1
        dec = early_w + late_w
        print(f"{lam:>8.2f} {early_w:>9,} {late_w:>9,} {tie_w:>9,} "
              f"{cheap_w:>9,} {dear_w:>9,} {tie_c:>9,} "
              f"{(early_w/dec if dec else 0):>8.1%}")
    print("\n  Ties are markets where every winner returned the same multiple,")
    print("  which is what a market that never converts does: all positions are")
    print("  at par, floors equal cost, and shares are proportional to cost, so")
    print("  the residual splits back in the same ratio. The decided column is")
    print("  early as a share of the markets that were not ties.")


if __name__ == "__main__":
    framing_distribution()
