# Doc Update Criteria

Use this rubric when deciding whether a recent change deserves documentation in project-level docs.

## Good Candidates

- New repo-wide API or data-access pattern
- New state-management rule that affects multiple features
- New dependency-injection registration requirement
- New routing or bootstrap constraint
- New persistence, localization, or testing convention
- New validation command, CI expectation, or test convention
- New subtle regression trap discovered through real work

## Weak Candidates

- Single-screen implementation detail
- Private helper extraction
- Renaming or code movement with no behavior change
- Temporary experiment
- Feature-specific copy or asset changes
- Test-only detail that does not represent a broader repo convention

## Questions To Ask

1. Would this still matter in a month?
2. Does this affect more than one file, feature, or future task?
3. Would a contributor who skips this guidance likely make a real mistake?
4. Is the rule already captured clearly in one of the docs?
5. Can this be stated at a high level without teaching the implementation?

If the answer to the first three is mostly yes, document it. If the last two are no, document it carefully and concisely.
