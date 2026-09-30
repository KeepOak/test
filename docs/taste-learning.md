# Learning preferences from feedback

Use **Teach Branch your preferences** beside an assistant reply. Choose acceptance,
rejection or an edit, explain what should carry into future tasks, and optionally
provide replacement text. Branch reads the original reply from the conversation
and asks its configured model to identify lasting style or decision preferences.
The model has no tools and receives no unrelated memories or project files.

Bare approval, factual corrections and one-time changes do not establish a lasting
preference. Every extracted preference needs an exact supporting quote from your
explanation. Saving feedback explicitly authorizes this learning step.

**Learned preferences** in the same dialog shows the preference, its evidence and
revision. Correct a preference to replace it, or forget it to stop using it. The
next task reads the current preferences even in the same conversation. Current
instructions always take precedence; preferences grant no tool authority.

Preferences apply only to the same owner, project and assistant. Temporary chats,
isolated model calls, sealed learning sessions, imported replies without a proven
source, and ambiguous replies cannot teach preferences. Only the owner's full
window access can read or change them. Each scope holds up to 30 preferences,
with up to 120 per owner and a 3,000-character context budget. The latest ten
correction revisions are retained; forgetting removes those revisions too.

Feedback deduplication retains the latest 200 receipts. Retrying a retained feedback
request never adds a duplicate or restores a preference that was forgotten.
Submitting new feedback after this retention window is a new learning request.
