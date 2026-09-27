# Orchard and Canopy

Orchard is the task board in **Automations → Orchard**, replacing the old Board. It is available by default, with its
tools loaded when a task needs them. Boards belong to projects. Each card moves through **Seed → Growing → Ripe →
Picked**, or **Blocked**. Ripe means the task finished; only your review moves it to Picked.

Cards you post or assign can be pulled in parallel within the board's limit. Trunks keep their own limits and pause
settings. Every card runs under your existing approval rules. Cards posted by a Trunk, chat app or key wait for your
permission. Lockdown prevents automatic pulls. Drag a card onto a Trunk to assign it, or use the card menu. Add comments
and dependencies in the card detail. Dependencies wait until their parent cards are Picked. Questions appear on the
card and each answer applies only to the exact request displayed. A repeated failure blocks the card until you reset it.

`/orchard` lists the active project's board in chats. `show`, `add` and `comment` work there. Starting, assigning and
reviewing cards requires the owner in the app or terminal. Chat comments are displayed as outside text and are not
inserted into a card's task instructions.

Canopy is the live panel in **Overview**. It shows Trunks, active tasks and their helpers, computers and all boards.
Open a task's conversation, steer its next step, pause, resume or stop it using the task's own controls. Trunk pause
holds new work while the current task finishes. Open a board to see its cards. The owner alone can see this panel.
Canopy only reads and controls existing work; it has no background model calls.

Both features use the existing engine records. The old board migrates once without starting its existing cards.
Completed cards and comments survive a restart. Canopy follows a resumed task's new identity and omits the paused
task it replaced.
