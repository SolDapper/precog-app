"""A worked example of what a participant sees, start to settlement.

Pro rata by shares, the decided residual policy. Prints the user-facing view
for each position: what they paid, what they are guaranteed, and what they
collect if their outcome wins. Numbers here are generated, not asserted by
hand, so anything quoted in the paper or the app can be traced to this run.
"""
from bootstrap import BootMarket

LAM = 0.5

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

print("A two outcome market, lambda = 0.5, go-live threshold 200.\n")
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
