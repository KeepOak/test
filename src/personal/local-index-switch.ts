/** RES-718: the local index's switch on its own, so the switch table (src/feature-switches.ts) can read it without loading the index. */
export const localIndexKey = "local-index";
export const localIndexShipsAs = "off"; // (e) heavy disk: a copy of the owner's mail and calendars
export const localIndexTools = ["index.search"] as const;
