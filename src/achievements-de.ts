import { readFileSync } from "node:fs";
import { type Achievement, themeNames } from "./achievements.js";

/**
 * i18n-de: the achievements' names, sentences and kinds in German, as src/achievements-fr.ts does for French.
 * The catalogue (src/achievements.ts) stays the one source of ids, goals and tiers; this only words each one
 * again from its measure and goal. A measure this table does not know keeps its English words, so a new
 * achievement is never lost. Goals are written as infinitives ("5 Aufgaben erledigen."), as German apps do.
 */
export interface Words { name: string; desc: string; kind: string }
type Say = (n: number) => string;
type Pair = [Say, Say];

const number = (n: number): string => n.toLocaleString("de-DE");
/** German: only one takes the singular. */
const plural = (n: number, one: string, many: string): string => `${number(n)} ${n === 1 ? one : many}`;
const times = (n: number): string => (n === 1 ? "einmal" : `${number(n)}-mal`);
const upper = (text: string): string => text.charAt(0).toLocaleUpperCase("de-DE") + text.slice(1);
const first = (n: number, name: string, many: Say): string => (n === 1 ? name : many(n));
const tasks = (n: number): string => plural(n, "Aufgabe", "Aufgaben");

let deWords: Record<string, string> | null = null;
/** The window's own German words, for the themes' names. */
function de(key: string, english: string): string {
  if (!deWords) {
    try { deWords = JSON.parse(readFileSync(new URL("../public/locales/de.json", import.meta.url), "utf8")) as Record<string, string>; }
    catch { deWords = {}; }
  }
  return deWords[key] ?? english;
}

/** The kinds the catalogue files each one under, in the window's German words. */
const kinds: Record<string, string> = {
  "Getting started": "Erste Schritte", "Every day": "Jeden Tag", Automations: "Automatisierungen", "Chat apps": "Chat-Apps",
  Safety: "Sicherheit", Tools: "Werkzeuge", Voice: "Stimme", Looks: "Aussehen", Explorer: "Entdecker", Pets: "Haustiere",
  Secrets: "Verborgen", People: "Personen", Trunks: "Trunks",
};

/** The long ladders and the counted records, by what they measure. */
const counted: Record<string, Pair> = {
  tasks: [(n) => first(n, "Keimling", (k) => plural(k, "Aufgabe erledigt", "Aufgaben erledigt")), (n) => `${tasks(n)} erledigen.`],
  conversations: [(n) => plural(n, "Unterhaltung", "Unterhaltungen"), (n) => `${plural(n, "Unterhaltung", "Unterhaltungen")} führen.`],
  days: [(n) => `${plural(n, "Tag", "Tage")} zusammen`,
    (n) => (n === 1 ? "An einem Tag eine Aufgabe erledigen." : `An ${number(n)} verschiedenen Tagen eine Aufgabe erledigen.`)],
  streak: [(n) => `Serie von ${plural(n, "Tag", "Tagen")}`, (n) => `${plural(n, "Tag", "Tage")} in Folge jeden Tag eine Aufgabe erledigen.`],
  "src:schedule": [(n) => plural(n, "geplanter Lauf", "geplante Läufe"), (n) => `Zeitpläne ${tasks(n)} erledigen lassen.`],
  "src:channel": [(n) => plural(n, "Chat-App-Aufgabe", "Chat-App-Aufgaben"),
    (n) => (n === 1 ? "Eine Aufgabe erledigen, um die in einer Chat-App gebeten wurde." : `${tasks(n)} erledigen, um die in einer Chat-App gebeten wurde.`)],
  "src:trigger": [(n) => plural(n, "ausgelöste Aufgabe", "ausgelöste Aufgaben"),
    (n) => (n === 1 ? "Eine Aufgabe erledigen, die ein Auslöser gestartet hat." : `${tasks(n)} erledigen, die ein Auslöser gestartet hat.`)],
  "audit:approval.decided": [(n) => first(n, "Ja oder Nein", (k) => `${plural(k, "Freigabe", "Freigaben")} beantwortet`),
    (n) => `${plural(n, "Freigabefrage", "Freigabefragen")} beantworten.`],
  "tool:all": [(n) => `${plural(n, "Werkzeug", "Werkzeuge")} genutzt`, (n) => `Aufgaben ${times(n)} Werkzeuge nutzen lassen.`],
  "tool:files": [(n) => plural(n, "Dateischritt", "Dateischritte"), (n) => `Aufgaben ${times(n)} Dateien lesen oder ändern lassen.`],
  "tool:web": [(n) => plural(n, "Websuche", "Websuchen"), (n) => `Aufgaben ${times(n)} im Web nachschlagen lassen.`],
  "tool:browser": [(n) => plural(n, "Browserschritt", "Browserschritte"), (n) => `Aufgaben ${times(n)} den Browser nutzen lassen.`],
  "tool:code": [(n) => plural(n, "Codeschritt", "Codeschritte"), (n) => `Aufgaben ${times(n)} Code oder Befehle ausführen lassen.`],
  "tool:memory": [(n) => plural(n, "Gedächtnisschritt", "Gedächtnisschritte"), (n) => `Aufgaben ${times(n)} nutzen lassen, was Branch sich merkt.`],
  "tool:documents": [(n) => plural(n, "Dokumentschritt", "Dokumentschritte"), (n) => `Aufgaben ${times(n)} Dokumente lesen oder schreiben lassen.`],
  "event:voice.transcribed": [(n) => first(n, "Aufgeschrieben", (k) => `${plural(k, "Aufnahme", "Aufnahmen")} aufgeschrieben`),
    (n) => `${plural(n, "Tonaufnahme", "Tonaufnahmen")} aufschreiben lassen.`],
  "event:voice.live.started": [(n) => first(n, "Stimme der Vernunft", (k) => plural(k, "Live-Unterhaltung", "Live-Unterhaltungen")),
    (n) => `${upper(times(n))} live sprechen.`],
  stopped: [(n) => first(n, "Halt, stopp!", (k) => `${tasks(k)} gestoppt`), (n) => `${plural(n, "laufende Aufgabe", "laufende Aufgaben")} stoppen.`],
  ...recorded(),
};

/** What the audit log, the saved records and the task events count. */
function recorded(): Record<string, Pair> {
  return {
    "audit:lockdown.changed": [(n) => first(n, "Sperrmodus-Übung", (k) => `Sperrmodus ${times(k)}`), (n) => `Den Sperrmodus ${times(n)} ein- oder ausschalten.`],
    "audit:channel.paired": [(n) => first(n, "Gekoppelt", (k) => `${plural(k, "Chat-App", "Chat-Apps")} gekoppelt`),
      (n) => `${plural(n, "Chat-App", "Chat-Apps")} koppeln.`],
    "audit:secret.used": [(n) => first(n, "Gut gehütet", (k) => `${plural(k, "Geheimnis", "Geheimnisse")} sicher übergeben`),
      (n) => `Eine Aufgabe ${times(n)} ein Geheimnis aus dem Tresor nutzen lassen.`],
    "audit:connection.changed": [(n) => first(n, "Verbunden", (k) => plural(k, "Verbindungsänderung", "Verbindungsänderungen")),
      (n) => `${upper(times(n))} eine Modellverbindung hinzufügen oder entfernen.`],
    "audit:data.exported": [(n) => first(n, "Papierspur", (k) => plural(k, "Export", "Exporte")), (n) => `${upper(times(n))} etwas exportieren.`],
    "audit:data.imported": [(n) => first(n, "Eingezogen", (k) => plural(k, "Import", "Importe")),
      (n) => `${upper(times(n))} Dinge aus einem anderen Assistenten übernehmen.`],
    "audit:token.issued": [(n) => first(n, "Schlüsselmacher", (k) => `${plural(k, "Schlüssel", "Schlüssel")} erstellt oder zurückgenommen`),
      (n) => `${upper(times(n))} einen kurzlebigen Schlüssel erstellen oder zurücknehmen.`],
    "audit:browser.borrowed": [(n) => first(n, "Geliehener Browser", (k) => `Browser ${times(k)} geliehen`), (n) => `Branch ${times(n)} deinen eigenen Browser leihen.`],
    "audit:network.connected": [(n) => first(n, "Offene Leitung", (k) => plural(k, "offene Leitung", "offene Leitungen")),
      (n) => `${upper(times(n))} eine Live-Verbindung halten, etwa einen Sprachanruf.`],
    "audit:hook.blocked": [(n) => first(n, "Hausregeln", (k) => `Deine Prüfungen haben ${times(k)} gegriffen`),
      (n) => `${upper(times(n))} erleben, wie eine deiner eigenen Prüfungen etwas stoppt oder anhält.`],
    "audit:profile.switched": [(n) => first(n, "Familie", (k) => plural(k, "Profilwechsel", "Profilwechsel")), (n) => `${upper(times(n))} das Profil wechseln.`],
    "audit:practice.switched": [() => "Probelauf", () => "Den Übungsmodus ein- oder ausschalten."],
    "audit:mcp.tried": [(n) => first(n, "Werkzeugserver", (k) => `${plural(k, "Werkzeugserver", "Werkzeugserver")} ausprobiert`),
      (n) => `${upper(times(n))} den Server eines anderen KI-Werkzeugs ausprobieren.`],
    "audit:history.pruned": [(n) => first(n, "Frühjahrsputz", (k) => plural(k, "Aufräumaktion", "Aufräumaktionen")), (n) => `${upper(times(n))} alte Unterhaltungen aufräumen.`],
    "audit:policy.changed": [(n) => first(n, "Regelmacher", (k) => plural(k, "Regeländerung", "Regeländerungen")),
      (n) => `${upper(times(n))} ändern, wann Branch bei dir nachfragt.`],
    "audit:limit.reached": [() => "Tempolimit", () => "Erleben, wie ein von dir gesetztes Limit etwas zurückhält."],
    ...saved(),
  };
}
function saved(): Record<string, Pair> {
  return {
    "records:schedules": [(n) => first(n, "Nach Plan", (k) => plural(k, "Zeitplan", "Zeitpläne")), (n) => `${plural(n, "Zeitplan", "Zeitpläne")} haben.`],
    "records:procedures": [(n) => first(n, "Gespeicherte Schritte", (k) => plural(k, "Prozedur", "Prozeduren")), (n) => `${plural(n, "Prozedur", "Prozeduren")} speichern.`],
    "records:specialists": [(n) => first(n, "Spezialist", (k) => plural(k, "Spezialist", "Spezialisten")), (n) => `${plural(n, "Spezialisten", "Spezialisten")} haben.`],
    "records:triggers": [(n) => first(n, "Stolperdraht", (k) => plural(k, "Auslöser", "Auslöser")), (n) => `${plural(n, "Auslöser", "Auslöser")} haben.`],
    "records:webhooks": [(n) => first(n, "Hallo, Webhook", (k) => plural(k, "Webhook", "Webhooks")), (n) => `${plural(n, "ausgehenden Webhook", "ausgehende Webhooks")} haben.`],
    "records:workflows": [(n) => first(n, "Ablauf", (k) => plural(k, "Ablauf", "Abläufe")), (n) => `${plural(n, "Ablauf", "Abläufe")} haben.`],
    "records:memory": [(n) => first(n, "Erinnerungen", (k) => `${plural(k, "Sache", "Sachen")} gemerkt`), (n) => `Branch ${plural(n, "Sache", "Sachen")} merken lassen.`],
    ...happened(),
  };
}
function happened(): Record<string, Pair> {
  return {
    "event:trunk.turn": [(n) => first(n, "Trunk-Gespräch", (k) => plural(k, "Trunk-Beitrag", "Trunk-Beiträge")),
      (n) => `Trunks ${plural(n, "Beitrag", "Beiträge")} in einer Unterhaltung leisten lassen.`],
    "event:team.ran": [(n) => first(n, "Teamplayer", (k) => plural(k, "Teamlauf", "Teamläufe")), (n) => `${upper(times(n))} ein Team von Assistenten arbeiten lassen.`],
    "event:heartbeat.notified": [(n) => first(n, "Check-in", (k) => plural(k, "Check-in", "Check-ins")),
      (n) => `${plural(n, "Check-in", "Check-ins")} mit Neuigkeiten bekommen.`],
    "event:skill.candidate_drafted": [(n) => first(n, "Aufgelevelt", (k) => `${plural(k, "Skill", "Skills")} entworfen`),
      (n) => `Branch ${plural(n, "Skill", "Skills")} entwerfen lassen.`],
    "event:learning.reviewed": [(n) => first(n, "Aus Erfahrung klug", (k) => `Auf ${tasks(k)} zurückgeblickt`),
      (n) => `Branch auf ${tasks(n)} zurückblicken lassen, um daraus zu lernen.`],
    "event:voice.spoken": [(n) => first(n, "Vorgelesen", (k) => `${plural(k, "Antwort", "Antworten")} vorgelesen`),
      (n) => `${plural(n, "Antwort", "Antworten")} vorgelesen bekommen.`],
    "event:voice.live.interrupted": [(n) => first(n, "Entschuldigung", (k) => `${upper(times(k))} unterbrochen`),
      (n) => `${upper(times(n))} eine Live-Sprachantwort unterbrechen.`],
    "event:documents.question": [(n) => first(n, "Frag die Dokumente", (k) => plural(k, "Dokumentfrage", "Dokumentfragen")),
      (n) => `Deinen Dokumenten ${plural(n, "Frage", "Fragen")} stellen.`],
    "event:wasm.ran": [(n) => first(n, "Kleines Programm", (k) => `${plural(k, "kleines Programm", "kleine Programme")} ausgeführt`),
      (n) => `${upper(times(n))} ein WebAssembly-Add-on ausführen.`],
    "noticed:themes": [(n) => (n === themeNames().length ? "Jedes Blatt am Baum" : `${plural(n, "Design", "Designs")} ausprobiert`),
      (n) => `${plural(n, "Design", "verschiedene Designs")} verwenden.`],
    "noticed:seasons": [() => "Vier Jahreszeiten", () => "Die Eiche in jeder Jahreszeit sehen."],
    "noticed:pages": [(n) => first(n, "Eingelebt", (k) => plural(k, "Einstellungsseite", "Einstellungsseiten")), (n) => `${plural(n, "Seite", "Seiten")} der Einstellungen öffnen.`],
    "noticed:pats": [(n) => first(n, "Streichel, streichel", (k) => plural(k, "Streicheleinheit", "Streicheleinheiten")), (n) => `Dein Haustier ${times(n)} streicheln.`],
    weekend: [(n) => first(n, "Wochenendarbeit", (k) => plural(k, "Wochenendaufgabe", "Wochenendaufgaben")), (n) => `${tasks(n)} an einem Wochenende erledigen.`],
    earned: [(n) => `Sammlung: ${number(n)}`, (n) => `${plural(n, "anderen Erfolg", "andere Erfolge")} erreichen.`],
  };
}

/** One of a kind: its measure's last part names it. */
const flags: Record<string, [string, string]> = {
  "acorn-shown": ["Hüter der Eichel", "Die Eichel in der Ecke anzeigen."],
  "acorn-turned": ["Eichelkreisel", "Die Eichel durch Ziehen drehen."],
  still: ["Stillleben", "„Alles ruhig halten“ einschalten."],
  everything: ["Alles, überall", "„Alles zeigen“ einschalten."],
  "follow-system": ["Der Sonne folgen", "Branch dem hellen oder dunklen Modus deines Computers folgen lassen."],
  language: ["Mehrsprachig", "Die Sprache wechseln."],
  "pet-named": ["Namensschild", "Deinem Haustier einen Namen geben."],
  "pet-talks-off": ["Stiller Begleiter", "Dein Haustier bitten, nicht mehr zu reden."],
  quiet: ["Ruhe, bitte", "Erfolge ruhig halten (dieser hier erscheint nicht)."],
  "style-3d": ["Dritte Dimension", "Die Eichel und das Haustier in 3D zeichnen."],
  lonely: ["Ganz schön einsam hier", "Alles ausblenden, was sich ausblenden lässt."],
};
const seasonWords: Record<string, string> = { spring: "Frühling", summer: "Sommer", autumn: "Herbst", winter: "Winter" };
const backgrounds: Record<string, [string, string]> = {
  picture: ["Deine eigene Aussicht", "ein Bild"], video: ["Bewegte Bilder", "ein Video"], animation: ["Daumenkino", "eine Animation"], "3d": ["Skulpturengarten", "ein 3D-Objekt"],
};
const hours: Record<string, [string, string]> = {
  night: ["Nachteule", "nach Mitternacht und vor fünf Uhr"], early: ["Frühaufsteher", "zwischen fünf und sieben Uhr morgens"], noon: ["Mittagspause", "zwischen zwölf und ein Uhr"],
};
const days = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const secrets: Record<string, [string, string]> = {
  "sss:streak": ["Zehn Jahre in Folge", "Zehn Jahre lang jeden einzelnen Tag eine Aufgabe erledigen."],
  "sss:earned": ["Der ganze Baum", "Jeden der anderen 500 Erfolge erreichen."],
  "sss:tasks": ["Eine Million Aufgaben", `${number(1000000)} Aufgaben erledigen.`],
  "sss:noticed:leaves": ["Jedes Blatt, jede Jahreszeit, jedes Licht", "Jedes Design, hell und dunkel, in jeder der vier Jahreszeiten verwenden."],
  "sss:solstice": ["Sonnenwende um Mitternacht", "In der ersten Stunde des 21. Dezember eine Aufgabe erledigen."],
};
/** Each pet with its article: [after "mit" (dative), as the thing chosen (accusative)]. */
const pets: Record<string, [string, string]> = {
  squirrel: ["dem Eichhörnchen", "das Eichhörnchen"], owl: ["der Eule", "die Eule"], hedgehog: ["dem Igel", "den Igel"], fox: ["dem Fuchs", "den Fuchs"],
  robin: ["dem Rotkehlchen", "das Rotkehlchen"], rabbit: ["dem Kaninchen", "das Kaninchen"], snail: ["der Schnecke", "die Schnecke"], fawn: ["dem Rehkitz", "das Rehkitz"],
  redpanda: ["dem Roten Panda", "den Roten Panda"], pangolin: ["dem Schuppentier", "das Schuppentier"], quokka: ["dem Quokka", "das Quokka"],
  acornling: ["dem Eichelgeist", "den Eichelgeist"], goatkid: ["dem Zicklein", "das Zicklein"], piglet: ["dem Minischweinchen", "das Minischweinchen"],
};

/** The ones named by what the window saw: a theme, a season, a background, a flag, a pet. */
function noticed(tail: string): Omit<Words, "kind"> | null {
  const [what, a, b] = tail.split(":");
  if (what === "theme" && a && b) {
    const english = themeNames().find(([id]) => id === b)?.[1] ?? b, name = de(`appearance.${b}`, english);
    return a === "light" ? { name: `${name} bei Tag`, desc: `${name} im hellen Modus verwenden.` } : { name: `${name} bei Mondschein`, desc: `${name} im dunklen Modus verwenden.` };
  }
  const season = what === "season" && a ? seasonWords[a] : undefined;
  if (season) return { name: `Die Eiche im ${season}`, desc: `Die Eiche im ${season} sehen.` };
  const bg = what === "bg" && a ? backgrounds[a] : undefined;
  if (bg) return { name: bg[0], desc: `${upper(bg[1])} hinter die Scheibe legen.` };
  const flag = what === "flag" && a ? flags[a] : undefined;
  if (flag) return { name: flag[0], desc: flag[1] };
  const pet = what === "pet" && a ? pets[a] : undefined;
  if (pet) return { name: `Begegnung mit ${pet[0]}`, desc: `${upper(pet[1])} als Haustier wählen.` };
  return null;
}
/** The ones named by when a task finished. */
function when(head: string, tail: string, n: number): Omit<Words, "kind"> | null {
  const hour = head === "hour" ? hours[tail] : undefined;
  if (hour) return { name: n === 1 ? hour[0] : `${hour[0]} ×${number(n)}`, desc: `${tasks(n)} ${hour[1]} erledigen.` };
  const day = head === "weekday" ? days[Number(tail)] : undefined;
  if (day) return { name: `Eine Aufgabe am ${day}`, desc: `An einem ${day} eine Aufgabe erledigen.` };
  return null;
}

/** An achievement's name, sentence and kind in German, or its English words when this table does not know it. */
export function inGerman(a: Achievement): Words {
  const kind = kinds[a.kind] ?? a.kind;
  const secret = secrets[a.id];
  if (secret) return { name: secret[0], desc: secret[1], kind };
  const pair = counted[a.metric];
  if (pair) return { name: pair[0](a.goal), desc: pair[1](a.goal), kind };
  const [head = "", ...rest] = a.metric.split(":"), tail = rest.join(":");
  const words = (head === "noticed" ? noticed(tail) : when(head, tail, a.goal)) ?? { name: a.name, desc: a.desc };
  return { ...words, kind };
}
