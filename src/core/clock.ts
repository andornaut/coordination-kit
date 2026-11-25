// The wall clock as an explicit dependency. Library code takes a `Clock` instead of reading the
// time itself; only the CLI entry and the command layer pass the real one.

/** The current instant. */
export type Clock = () => Date;
