```
head:      abc1234
base:      origin/main
checks:
  generic-boundary          exit=0  PASS
claims:
  claim:          the check fires on an adopter name in docs/
  verified at:    scripts/check-generic-boundary.mjs:60
  invalidated by: that case exiting 0

  claim:          the field would have caught three past instances
  verified at:    report: the reviewer's message — NOT independently checked, because it is a
                  counterfactual about past claims and cannot be
  invalidated by: an instance whose author would have written a file:line truthfully anyway
does not:  it does not establish the checks are correct, only faithfully reported.
```
