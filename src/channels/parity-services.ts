// Wave mac3 (channels-parity): the chat services built in, each in its own file. This list is loaded the first time a
// service is built, listed or switched (parity-config.ts), not with the engine: their code is a few megabytes.
import type { ParityService } from "./parity-common.js";
import { gotifyService } from "./gotify.js";
import { ircService, twitchService } from "./irc.js";
import { imessageService } from "./imessage.js";
import { blueBubblesService } from "./bluebubbles.js"; // CHAT-153
import { whatsappWebService } from "./whatsapp-web.js";
import { teamsBotService } from "./teams-bot.js";
import { webexService } from "./webex.js";
import { synologyChatService } from "./synology-chat.js";
import { zaloService } from "./zalo.js";
import { flockService } from "./flock.js";
import { pumbleService } from "./pumble.js";
import { mastodonService } from "./mastodon.js";
import { blueskyService } from "./bluesky.js";
import { redditService } from "./reddit.js";
import { discourseService } from "./discourse.js";
import { xService } from "./x-dm.js";
import { twistService } from "./twist.js";
import { nextcloudTalkService } from "./nextcloud-talk.js";
import { smsService } from "./twilio-sms.js";
import { ntfyService } from "./ntfy.js";
import { pushoverService } from "./pushover.js";
import { threemaService } from "./threema.js";
import { homeassistantService } from "./homeassistant.js";
import { xmppService } from "./xmpp.js";
import { mqttService } from "./mqtt.js";
import { keybaseService } from "./keybase.js";
import { simplexService } from "./simplex.js";
import { deltachatService } from "./deltachat.js";
import { nostrService } from "./nostr.js";
import { vkService } from "./vk.js";
import { qqBotService } from "./qq-bot.js";
import { guildedService } from "./guilded.js";
import { revoltService } from "./revolt.js";
import { mumbleService } from "./mumble.js";
import { kookService } from "./kook.js"; // mac6/bucket-16
import { wechatOfficialService, wecomAppService } from "./wechat.js"; // mac6/bucket-16

/**
 * Wave mac3 (channels-parity): every chat service added to match the other assistants. Each is
 * written in the connections file as `{ "type": "<kind>", "id": ... }`, built by
 * src/channels/parity-config.ts, and sits behind its own off / on / when-needed switch, off until
 * the owner turns it on. Adding a service is one file and one line here.
 */
export const parityServices: ParityService[] = [
  ircService, twitchService, gotifyService, imessageService,
  teamsBotService, webexService, synologyChatService, zaloService, flockService, pumbleService,
  mastodonService, blueskyService, redditService, discourseService, xService, twistService,
  nextcloudTalkService, smsService, ntfyService, pushoverService, threemaService, homeassistantService,
  xmppService, mqttService, keybaseService, simplexService, deltachatService, nostrService,
  vkService, qqBotService, guildedService, revoltService, mumbleService,
  // mac6/bucket-16: the rest of the chat apps.
  kookService, wechatOfficialService, wecomAppService,
  // CHAT-153: iMessage from any computer, through the owner's own Mac.
  blueBubblesService,
  // A personal WhatsApp number through the WAHA bridge the owner runs (src/channels/whatsapp-web.ts).
  whatsappWebService,
];
