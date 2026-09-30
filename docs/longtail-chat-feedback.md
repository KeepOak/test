# Long-tail live feedback (CHAT-175)

The existing live-status controller calls optional adapter methods only for allowed/paired senders, under its existing status switches, Lockdown/quiet-hours and outbound checks. Adapter errors propagate to its failure backoff. This patch adds actual optional methods to existing adapters rather than declaring unsupported capabilities.

| Adapter | Added here | Remaining |
| --- | --- | --- |
| Revolt | Message edits through PATCH; status reaction PUT and removal of the bot's previous reaction through DELETE, never another user's reactions | Typing needs a verified current gateway event contract; no method claimed |
| KOOK | Channel and DM reaction add/delete with KOOK emoji IDs; compound tool-work status maps to wrench | No verified typing API; edits remain absent because Branch sends type-1 plain text and KOOK update supports type 9/10 |
| XMPP | Negotiated direct-chat XEP-0085 composing, active on content messages, disco feature response, bounded peer state; repeated standalone composing is suppressed | Room typing intentionally absent; reactions and edits need separate negotiated extensions |
| Guilded | No change | Typing/reactions/edits require currently accessible official contracts before implementation |

XMPP typing is only emitted to direct peers that advertised chat states in received live content/standalone notifications; a content reply without states disables them. Room-wide presence is not broadcast. The owner's existing typing switch controls calls. No protocol method widens sender or tool access.

Primary contracts reviewed: [XEP-0085](https://xmpp.org/extensions/xep-0085.html), [Revolt edit route](https://github.com/revoltchat/backend/blob/main/crates/delta/src/routes/channels/message_edit.rs), [Revolt reaction route](https://github.com/revoltchat/backend/blob/main/crates/delta/src/routes/channels/message_react.rs), [Revolt unreact route](https://github.com/revoltchat/backend/blob/main/crates/delta/src/routes/channels/message_unreact.rs), [KOOK channel API](https://developer.kookapp.cn/doc/http/message), [KOOK direct-message API](https://developer.kookapp.cn/doc/http/direct-message). Revolt backend is AGPL-3.0; these are API-contract references only, and no code was copied. Existing guarded transports and bounded content limits are reused.

This is partial CHAT-175 coverage, not a claim of complete parity for every app. Static Settings capability tables may need a separate update by their owner; runtime optional-method integration is present. Source review and diff checks only; no tests/build/apps/provider/model/database/credential execution during delivery.
