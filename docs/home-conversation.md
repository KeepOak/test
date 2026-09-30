# Home conversation

The owner’s local unlocked Home panel has a **Home conversation** button beside Ideas and Today. It opens a chooser to pin one existing eligible conversation, create and pin an empty conversation, open the pinned conversation, or unpin it. No action sends a message, starts a task, changes the model/default Trunk, or adds global memory. The existing Home panel composer continues to use its existing default Trunk behavior.

The pin is saved in the owner’s settings on this engine, rather than browser state. Selection and opening recheck the exact retained session. Temporary, archived, deleted, copied/imported, shared-link, channel-linked and helper/private-origin sessions are excluded. Every retained task must have an explicit primary local-owner start record; missing attribution fails closed. The chooser includes the newest 100 eligible sessions, and older saved pins are validated independently of that limit. Titles use the existing redaction helper; bodies are not read by the chooser.

An invalid saved pin displays unavailable and cannot open. Unpin removes only the Home setting; it does not unpin the sidebar, delete, restore, archive or change any existing conversation/history. Create adds an empty owned session and its pin in one database transaction. Existing history is retained.

`GET/POST /api/home-conversation` require the unlocked local owner window. Household/person, remote/paired-door, task, and short-lived-key callers are refused. Mutations recheck those conditions after reading the bounded request body, along with the window key and monotonic profile/lock transition revisions, including switch-away-and-back. Client handlers also fence asynchronous replies against sign-in/profile changes and closed/replaced dialogs.

Stacked on the owner Ideas and Today feed work (#1183 and #1187). Source review only in the implementation session; no runtime, test, build, provider or database execution.
