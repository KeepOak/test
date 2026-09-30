# Reach it anywhere

## What this is for

Branch runs on this computer, and that is the whole point of it. This chapter is about reaching it
from somewhere else anyway — from a chat app you already use, from your phone, and while the window
is closed — without ever putting it on the open internet.

## In one minute

- **Settings → Channels** connects Telegram, Discord, Slack, WhatsApp, email and fourteen more.
- **Settings → How Branch runs on this computer** starts Branch with Windows and keeps it working
  when the window is closed.
- Your phone reaches it over your own private network, never over the internet.
- A stranger who messages one of your chats gets a six-digit code that you approve, or nothing.
- Replies that could not be sent wait in order and go out when the app is back.

## Chat apps

**Settings → Channels** connects your assistant to a chat you already use. Five have a connection of
their own — **Telegram**, **Discord**, **Slack**, **WhatsApp** and plain-text **email** — and fourteen
more work through one shared connection: Mattermost, Rocket.Chat, Google Chat, Microsoft Teams, Zulip,
Matrix, Feishu/Lark, DingTalk, WeCom, LINE, Viber, Signal (through a program you install yourself),
Facebook Messenger and Instagram.

Whichever you use, five things work the same way:

- **Each chat keeps its own conversation**, so a group and a direct message do not run into each other.
- **Strangers pair with a six-digit code** you approve in **Settings → Channels**. The code is sent only in
  a direct chat; in a group the request just waits for you there. Turn pairing off and a stranger is sent nothing.
- **An allowlist** names the people who never have to pair.
- **Reply when mentioned** decides whether it answers everything in a group or only messages that
  mention it or reply to it.
- **A yes can be answered from the chat.** When a task stops for your permission, the question goes out
  as words and you answer `y` for yes, `a` for yes always, or `n` for no.

Every credential a channel needs is read from the locker or from an environment variable; nothing is
ever written into a settings file. Each channel shows whether it is **connected**, **reconnecting** or
**needs attention**, with a plain reason and a **Check the connection** button.

You can also **link a chat to a conversation you already have open**, so a Telegram thread continues
the very conversation on your screen.

**What is only partly there:** the fourteen shared-connection services carry words only — no files, no
voice notes, no buttons — so a question that needs an answer goes out as words with *"reply y for yes,
a for yes always, or n for no"*. Microsoft Teams is an incoming and an outgoing webhook rather than a
full Teams app, so one-to-one chats, cards and file sharing are out of reach. A WeCom group robot can
only be posted to, never asked. Matrix cannot read end-to-end encrypted rooms and says how many
arrived rather than pretending nothing happened. X / Twitter direct messages are not built at all.

**Voice notes** that arrive on Telegram, Discord or WhatsApp are written out and handled exactly like
a typed message, and the reply quotes back what was heard. Telegram is the one channel that can send
sound back today.

## Messages that could not be sent

Every message going out through a chat is written down before it is sent. If the chat app is
unreachable, the pieces wait and go out **in order** when it is back, and are never duplicated.
Repeated failures back off, and after the fifth the piece is parked under **Messages still to send**
in **Settings → Channels**, where **Try again** re-queues it.

## Quiet hours and days off

A reply or a scheduled result that lands during quiet hours is written down and sent when they end,
rather than waking you. Days off work the same way.

## Your phone

**Branch never opens itself to the internet or to the network you happen to be on.** Your phone
reaches it over [Tailscale](https://tailscale.com), a private network you sign in to on both devices.

1. Install Tailscale on this computer and on the phone, and sign both in.
2. Turn on **Reach Branch from my phone** in **Settings → How Branch runs on this computer**.
3. Press **Show the square code for my phone**, point the phone's camera at it, and type the six-digit
   code.

The web app installs onto the phone like any other app, keeps its own files on the device, and shows a
clear banner when your computer cannot be reached. It is never registered inside the desktop app.

## Keeping it working

**Settings → How Branch runs on this computer** carries three switches:

- **Start Branch when I sign in to Windows.**
- **Keep Branch working when the window is closed** — so timed jobs and chat replies still happen.
  Closing the window keeps the assistant in the tray; use **Quit** in the tray menu to stop it.
- **Reach Branch from my phone**, described above.

Branch has to be running for a schedule, a watch or a chat reply to happen. If the computer was
asleep, the missed times become one task the next time it looks; nothing that failed is retried by
itself.

## Sending without being asked

Two things send on the assistant's own initiative rather than answering somebody: sending one message
to several linked chats at once, and sending the morning brief as it stands right now to one chat.
Both go through the same waiting line as every reply, so quiet hours and retries apply unchanged.
Both are yours alone — somebody else using this computer under their own profile is refused, and
neither is available to a task started from a chat message, so somebody you have paired cannot make
the assistant write to everyone else.

## Where to go next

- [Automate](06-automate.md) — having it start work on its own and send you the result.
- [Permissions and safety](04-permissions-and-safety.md#when-to-check-with-me) — a task from a chat is
  never given more freedom than *Ask before changes*.
- [Troubleshooting](08-troubleshooting.md) — when a channel says it needs attention.
