// Window-only opt-in. Never persisted or inferred from a household selection.
export const isolatedWindow = { profileId: null, name: "", actor: null, revision: 0 };
export const isolatedActor = (profiles) => JSON.stringify([profiles?.isOwner, profiles?.active?.id ?? profiles?.active ?? null]);
