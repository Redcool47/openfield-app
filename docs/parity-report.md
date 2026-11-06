# Parity report

Generated from `parity/ledger.csv`. Every number here is derived from the
ledger, never estimated by hand. `DONE` counts 1, `PARTIAL` counts 0.5,
everything else 0.

Catalogued features: **172**

- Tier 1 coverage: 98% (134.0/137)
- Tier 2 coverage: 35% (12.0/34)
- Weighted parity across all tiers (T1 3, T2 2, T3 1, T4 0.25): **88.8%**

Every DONE row has a proof path that exists on disk.

## What this does and does not mean

This measures coverage of the *catalogued* feature list, which was written
from public documentation before the reference application could be
observed. It is not a measurement of behavioural fidelity. A row can be
DONE and still differ from the reference in ways this ledger does not
capture, which is why each row also carries a source tag: `HINT` rows are
unverified hypotheses and should be read as such.

See `docs/gaps.md` for what is known to be missing.