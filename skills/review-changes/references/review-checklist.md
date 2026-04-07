# Review Checklist

Use this checklist while reviewing recent changes against the project's documented guidelines.

## Architecture

- Does the code belong in the shared/core layer or in the feature that owns it?
- Did the change duplicate a shared concern instead of reusing existing code?
- Did any file grow beyond roughly 800 lines without being split?

## State Management

- Does the state management approach follow the project's chosen pattern?
- If a new pattern was introduced, is there real complexity to justify it?

## Data And DI

- Are dependencies resolved via the project's DI system instead of ad hoc construction?
- Do repositories and data access layers follow the established contracts?
- Do mock or test implementations still match the real contract?

## UI And Reuse

- Is there an existing component that should have been reused?
- Could the new UI be parameterized instead of cloned?
- Should the component live in shared code because multiple features can use it?

## User-Facing Behavior

- Is all visible text localized (if the project uses i18n)?
- Were any persistence changes made in a way that could create partial or inconsistent state?

## Tests

- Did behavior change without test updates?
- If a reusable abstraction changed, were existing callers protected with tests?
- Is there any residual risk because validation was not run?
