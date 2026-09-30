/** RES-718: the local index's switch on its own, so the switch table (src/feature-switches.ts) can read it without loading the index. */
export const localIndexKey = "local-index";
/** Ships on (the coordinator's call, 2026-09-28): a capped index of the owner's own mail on the owner's own disk is none of (a)–(f).
    "When needed" runs it for the sources already connected and switched on, and keeps its search a line in the tool index. */
export const localIndexShipsAs = "when-needed";
export const localIndexTools = ["index.search"] as const;
