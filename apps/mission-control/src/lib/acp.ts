/**
 * The suite's ACP log parser — see `@managoat/fountain-app/acp`.
 *
 * fountain-team is the one app that does not use this: it parses
 * `session/request_permission` too, which adds a variant to the `Block`
 * union, so it keeps its own extended copy in `apps/fountain-team/src/lib`.
 */
export * from "@managoat/fountain-app/acp";
