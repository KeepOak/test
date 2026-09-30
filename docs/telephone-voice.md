# Telephone voice calls (CHAT-098 / RES-174)

Calls ship disabled. Settings → Voice prepares Twilio account/from number,
owner's exact personal number, configured HTTPS callback origin and existing
secret names. No secrets appear in the UI. An immutable fingerprint using
Branch's existing install-key approval digest covers one recipient, number,
purpose, duration, carrier quote, token reservation and expiry. Local unlocked
owner approval is required; tasks, short-lived keys and remote callers cannot
configure, approve or dial. Approving consumes the proposal before provider I/O.
No automatic retries/redials occur after ambiguous carrier responses. A saved
open-call fence survives restart; inspected recovery checks carrier account,
recipient, SID and creation time before ending the exact call.

Outbound calls actually use Twilio Calls REST API with TimeLimit, recording off,
20-second ringing timeout and signed status callbacks. Inbound slots are owner
approved for ten minutes and require the owner's exact caller number plus a
saved 6–12 digit DTMF PIN before any model conversation. Configure that slot's
provided Twilio webhook address manually; no number/account changes are made.
A consumed slot never accepts another CallSid. Twilio duration limits and local
termination timers cap accepted calls; lock/shutdown cancels known calls. A
failed hangup remains uncertain and blocks another call approval.

TwiML Gather/Say implements actual turn-based speech: signed SpeechResult
callbacks enter a tool-free isolated Branch runtime conversation and return
spoken replies. Isolated telephone messages contain only approved purpose and
bounded call history; owner memory, skills, projects and conversation context
are omitted. Channel source identity, runtime model selection/budgets/abort and
secret scrubbing are retained. Fixed telephone system role avoids the existing
isolated grader role without changing grader defaults. At most eight turns and
a conservative total token reservation are allowed; empty speech ends a call.
The agent cannot negotiate, transact, use tools or authorize owner actions.

Signature validation uses exact configured public URL plus all sorted form
parameters and constant-time HMAC-SHA1 comparison, matching Twilio's documented
SDK pattern. Duplicate fields, wrong account/from/to/SID, oversized bodies,
expired slots and replayed turn nonces are refused. Callback rates are bounded.
Unsigned/borrowed Media Streams WebSocket upgrades are rejected. Continuous
media streaming, live interruption, caller tool use, outbound dialing from model
tools and arbitrary incoming callers are not implemented. SMS is unchanged.

Fresh Twilio destination/origination pricing is required and rechecked before
approval. Carrier quote rounds duration upward to whole minutes and refuses
unknown/non-USD rates or increased prices. It is not an invoice-total guarantee:
taxes, speech recognition and model charges are excluded and disclosed in the
proposal. Duration and token bounds limit usage; configure provider billing
limits independently before authorizing production calls.

No call, provider/model, app/runtime, test, build, DB or credential operation was
executed in this delivery. Source review/diff checks provide no telephony proof.
Authorized validation of proxy/public URL fidelity, Twilio callbacks, cost
behavior, speech turns, cancellation/recovery and privacy is still required.

Primary sources reviewed: [Call resource](https://www.twilio.com/docs/voice/api/call-resource),
[Gather](https://www.twilio.com/docs/voice/twiml/gather),
[signature security](https://www.twilio.com/docs/usage/webhooks/webhooks-security),
[voice pricing](https://www.twilio.com/docs/voice/pricing),
[Media Streams contract](https://www.twilio.com/docs/voice/media-streams/websocket-messages),
[official SDK signature source](https://github.com/twilio/twilio-node/blob/main/src/webhooks/webhooks.ts)
(MIT license read), and OpenClaw's MIT voice-call manager plus Hermes telephony
source. The larger plugin managers were not copied into Branch; the implementation
uses Branch's own owner/caller, fingerprint, secrets, network and runtime paths.
