import { readFileSync } from "node:fs";
import { type Achievement, themeNames } from "./achievements.js";

/**
 * mac7/residuals: the achievements' names and sentences in French. The catalogue (src/achievements.ts)
 * stays the one source of ids, goals and tiers; this only words each one again from its measure and
 * goal. A measure this table does not know keeps its English words, so a new achievement is never lost.
 */
export interface Words { name: string; desc: string }
type Say = (n: number) => string;
type Pair = [Say, Say];

const number = (n: number): string => n.toLocaleString("fr-FR");
/** French: one (and nought) take the singular. */
const plural = (n: number, one: string, many = `${one}s`): string => `${number(n)} ${n > 1 ? many : one}`;
const times = (n: number): string => `${number(n)} fois`;
const first = (n: number, name: string, many: Say): string => (n === 1 ? name : many(n));

let frWords: Record<string, string> | null = null;
/** The window's own French words, for the themes' and the pets' names. */
function fr(key: string, english: string): string {
  if (!frWords) {
    try { frWords = JSON.parse(readFileSync(new URL("../public/locales/fr.json", import.meta.url), "utf8")) as Record<string, string>; }
    catch { frWords = {}; }
  }
  return frWords[key] ?? english;
}

/** The long ladders and the counted records, by what they measure. */
const counted: Record<string, Pair> = {
  tasks: [(n) => first(n, "Pousse", (k) => plural(k, "tâche terminée", "tâches terminées")), (n) => `Terminer ${plural(n, "tâche")}.`],
  conversations: [(n) => plural(n, "conversation"), (n) => `Avoir ${plural(n, "conversation")}.`],
  days: [(n) => `${plural(n, "jour")} ensemble`, (n) => `Terminer une tâche sur ${plural(n, "jour différent", "jours différents")}.`],
  streak: [(n) => `Série de ${plural(n, "jour")}`, (n) => `Terminer une tâche chaque jour pendant ${plural(n, "jour")} d'affilée.`],
  "src:schedule": [(n) => plural(n, "exécution planifiée", "exécutions planifiées"), (n) => `Laisser les planifications terminer ${plural(n, "tâche")}.`],
  "src:channel": [(n) => plural(n, "tâche d'appli de discussion", "tâches d'appli de discussion"),
    (n) => `Terminer ${plural(n, "tâche demandée", "tâches demandées")} depuis une appli de discussion.`],
  "src:trigger": [(n) => plural(n, "tâche déclenchée", "tâches déclenchées"), (n) => `Terminer ${plural(n, "tâche lancée", "tâches lancées")} par un déclencheur.`],
  "audit:approval.decided": [(n) => first(n, "Oui ou non", (k) => plural(k, "approbation répondue", "approbations répondues")),
    (n) => `Répondre à ${plural(n, "question d'approbation", "questions d'approbation")}.`],
  "tool:all": [(n) => plural(n, "outil utilisé", "outils utilisés"), (n) => `Laisser les tâches utiliser des outils ${times(n)}.`],
  "tool:files": [(n) => plural(n, "étape de fichier", "étapes de fichier"), (n) => `Laisser les tâches lire ou modifier des fichiers ${times(n)}.`],
  "tool:web": [(n) => plural(n, "recherche sur le web", "recherches sur le web"), (n) => `Laisser les tâches chercher sur le web ${times(n)}.`],
  "tool:browser": [(n) => plural(n, "étape de navigateur", "étapes de navigateur"), (n) => `Laisser les tâches utiliser le navigateur ${times(n)}.`],
  "tool:code": [(n) => plural(n, "étape de code", "étapes de code"), (n) => `Laisser les tâches exécuter du code ou des commandes ${times(n)}.`],
  "tool:memory": [(n) => plural(n, "étape de mémoire", "étapes de mémoire"), (n) => `Laisser les tâches utiliser ce dont Branch se souvient ${times(n)}.`],
  "tool:documents": [(n) => plural(n, "étape de document", "étapes de document"), (n) => `Laisser les tâches lire ou écrire des documents ${times(n)}.`],
  "event:voice.transcribed": [(n) => first(n, "Mis par écrit", (k) => plural(k, "enregistrement transcrit", "enregistrements transcrits")),
    (n) => `Faire transcrire ${plural(n, "enregistrement sonore", "enregistrements sonores")}.`],
  "event:voice.live.started": [(n) => first(n, "La voix de la raison", (k) => plural(k, "conversation en direct", "conversations en direct")),
    (n) => `Parler en direct ${times(n)}.`],
  stopped: [(n) => first(n, "Halte-là", (k) => plural(k, "tâche arrêtée", "tâches arrêtées")), (n) => `Arrêter ${plural(n, "tâche en cours", "tâches en cours")}.`],
  ...recorded(),
};

/** What the audit log, the saved records and the task events count. */
function recorded(): Record<string, Pair> {
  return {
    "audit:lockdown.changed": [(n) => first(n, "Exercice de verrouillage", (k) => `Verrouillage ${times(k)}`), (n) => `Activer ou désactiver le Verrouillage ${times(n)}.`],
    "audit:channel.paired": [(n) => first(n, "Associé", (k) => plural(k, "appli de discussion associée", "applis de discussion associées")),
      (n) => `Associer ${plural(n, "appli de discussion", "applis de discussion")}.`],
    "audit:secret.used": [(n) => first(n, "Bien gardé", (k) => plural(k, "secret remis en sûreté", "secrets remis en sûreté")),
      (n) => `Laisser une tâche utiliser un secret du coffre ${times(n)}.`],
    "audit:connection.changed": [(n) => first(n, "Connecté", (k) => plural(k, "changement de connexion", "changements de connexion")),
      (n) => `Ajouter ou retirer une connexion à un modèle ${times(n)}.`],
    "audit:data.exported": [(n) => first(n, "Trace écrite", (k) => plural(k, "export")), (n) => `Exporter quelque chose ${times(n)}.`],
    "audit:data.imported": [(n) => first(n, "Emménagement", (k) => plural(k, "import")), (n) => `Importer depuis un autre assistant ${times(n)}.`],
    "audit:token.issued": [(n) => first(n, "Serrurier", (k) => plural(k, "clé faite ou reprise", "clés faites ou reprises")),
      (n) => `Faire ou reprendre une clé temporaire ${times(n)}.`],
    "audit:browser.borrowed": [(n) => first(n, "Navigateur prêté", (k) => `Navigateur prêté ${times(k)}`), (n) => `Prêter votre propre navigateur à Branch ${times(n)}.`],
    "audit:network.connected": [(n) => first(n, "Ligne ouverte", (k) => plural(k, "ligne ouverte", "lignes ouvertes")),
      (n) => `Garder une connexion en direct, comme un appel vocal, ${times(n)}.`],
    "audit:hook.blocked": [(n) => first(n, "Règles de la maison", (k) => `Vos contrôles ont tenu ${times(k)}`),
      (n) => `Voir l'un de vos propres contrôles arrêter ou retenir quelque chose ${times(n)}.`],
    "audit:profile.switched": [(n) => first(n, "En famille", (k) => plural(k, "changement de profil", "changements de profil")), (n) => `Changer de profil ${times(n)}.`],
    "audit:practice.switched": [() => "Répétition", () => "Activer ou désactiver le mode essai."],
    "audit:mcp.tried": [(n) => first(n, "Serveur d'outils", (k) => plural(k, "serveur d'outils essayé", "serveurs d'outils essayés")),
      (n) => `Essayer le serveur d'un autre outil d'IA ${times(n)}.`],
    "audit:history.pruned": [(n) => first(n, "Grand ménage", (k) => plural(k, "tri", "tris")), (n) => `Faire le tri dans les anciennes conversations ${times(n)}.`],
    "audit:policy.changed": [(n) => first(n, "Faiseur de règles", (k) => plural(k, "changement de règle", "changements de règle")),
      (n) => `Changer quand Branch vous demande votre avis ${times(n)}.`],
    "audit:limit.reached": [() => "Limitation de vitesse", () => "Voir une limite que vous avez fixée retenir quelque chose."],
    ...saved(),
  };
}
function saved(): Record<string, Pair> {
  return {
    "records:schedules": [(n) => first(n, "À l'heure", (k) => plural(k, "planification")), (n) => `Avoir ${plural(n, "planification")}.`],
    "records:procedures": [(n) => first(n, "Étapes enregistrées", (k) => plural(k, "procédure")), (n) => `Enregistrer ${plural(n, "procédure")}.`],
    "records:specialists": [(n) => first(n, "Spécialiste", (k) => plural(k, "spécialiste")), (n) => `Avoir ${plural(n, "spécialiste")}.`],
    "records:triggers": [(n) => first(n, "Fil tendu", (k) => plural(k, "déclencheur")), (n) => `Avoir ${plural(n, "déclencheur")}.`],
    "records:webhooks": [(n) => first(n, "Bonjour webhook", (k) => plural(k, "webhook")), (n) => `Avoir ${plural(n, "webhook sortant", "webhooks sortants")}.`],
    "records:workflows": [(n) => first(n, "Enchaînement", (k) => plural(k, "enchaînement")), (n) => `Avoir ${plural(n, "enchaînement")}.`],
    "records:memory": [(n) => first(n, "Souvenirs", (k) => plural(k, "chose retenue", "choses retenues")), (n) => `Faire retenir ${plural(n, "chose")} à Branch.`],
    ...happened(),
  };
}
function happened(): Record<string, Pair> {
  return {
    "event:trunk.turn": [(n) => first(n, "Parole de Trunk", (k) => plural(k, "tour de Trunk", "tours de Trunk")),
      (n) => `Laisser les Trunks prendre ${plural(n, "tour")} de parole dans une conversation.`],
    "event:team.ran": [(n) => first(n, "Esprit d'équipe", (k) => plural(k, "travail d'équipe", "travaux d'équipe")),
      (n) => `Faire travailler une équipe d'assistants ${times(n)}.`],
    "event:heartbeat.notified": [(n) => first(n, "Point régulier", (k) => plural(k, "point régulier", "points réguliers")),
      (n) => `Recevoir ${plural(n, "point régulier", "points réguliers")} avec des nouvelles.`],
    "event:skill.candidate_drafted": [(n) => first(n, "Montée en compétence", (k) => plural(k, "compétence esquissée", "compétences esquissées")),
      (n) => `Faire esquisser ${plural(n, "compétence")} par Branch.`],
    "event:learning.reviewed": [(n) => first(n, "Leçons retenues", (k) => plural(k, "tâche revue", "tâches revues")),
      (n) => `Laisser Branch revoir ${plural(n, "tâche")} pour en tirer des leçons.`],
    "event:voice.spoken": [(n) => first(n, "Lu à voix haute", (k) => plural(k, "réponse lue", "réponses lues") + " à voix haute"),
      (n) => `Entendre ${plural(n, "réponse lue", "réponses lues")} à voix haute.`],
    "event:voice.live.interrupted": [(n) => first(n, "Pardon", (k) => `Coupé la parole ${times(k)}`), (n) => `Couper la parole à une réponse vocale en direct ${times(n)}.`],
    "event:documents.question": [(n) => first(n, "Demandez aux documents", (k) => plural(k, "question aux documents", "questions aux documents")),
      (n) => `Poser ${plural(n, "question")} à vos documents.`],
    "event:wasm.ran": [(n) => first(n, "Petit programme", (k) => plural(k, "petit programme lancé", "petits programmes lancés")),
      (n) => `Lancer un module WebAssembly ${times(n)}.`],
    "noticed:themes": [(n) => (n === themeNames().length ? "Toutes les feuilles de l'arbre" : plural(n, "thème essayé", "thèmes essayés")),
      (n) => `Porter ${plural(n, "thème différent", "thèmes différents")}.`],
    "noticed:seasons": [() => "Quatre saisons", () => "Voir le chêne à chaque saison."],
    "noticed:pages": [(n) => first(n, "Bien installé", (k) => plural(k, "page des Réglages", "pages des Réglages")), (n) => `Ouvrir ${plural(n, "page")} des Réglages.`],
    "noticed:pats": [(n) => first(n, "Caresse", (k) => plural(k, "caresse")), (n) => `Caresser votre animal ${times(n)}.`],
    weekend: [(n) => first(n, "Travail du week-end", (k) => plural(k, "tâche du week-end", "tâches du week-end")), (n) => `Terminer ${plural(n, "tâche")} un week-end.`],
    earned: [(n) => `Collection : ${number(n)}`, (n) => `Obtenir ${plural(n, "autre succès", "autres succès")}.`],
  };
}

/** One of a kind: its measure's last part names it. */
const flags: Record<string, [string, string]> = {
  "acorn-shown": ["Gardien de l’arbre", "Garder l’arbre au pied de la liste."],
  "acorn-turned": ["Changement de saison", "Changer vous-même la saison derrière la vitre."],
  still: ["Nature morte", "Activer Garder les choses immobiles."],
  everything: ["Tout, partout", "Choisir Technique dans Quantité d'éléments affichés."],
  "follow-system": ["Suivre le soleil", "Laisser Branch suivre le mode clair ou sombre de votre ordinateur."],
  language: ["Polyglotte", "Changer la langue."],
  "pet-named": ["Médaille gravée", "Donner un nom à votre animal."],
  "pet-talks-off": ["Compagnon discret", "Demander à votre animal de se taire."],
  quiet: ["Silence, s'il vous plaît", "Garder les succès discrets (celui-ci ne s'affiche pas)."],
  "style-3d": ["Troisième dimension", "Dessiner le gland et l'animal en 3D."],
  lonely: ["On se sent seul ici", "Masquer tout ce qui peut l'être."],
};
const seasonWords: Record<string, [string, string]> = { spring: ["printemps", "au"], summer: ["été", "en"], autumn: ["automne", "en"], winter: ["hiver", "en"] };
const backgrounds: Record<string, [string, string]> = {
  picture: ["Votre propre vue", "une image"], video: ["Images animées", "une vidéo"], animation: ["Folioscope", "une animation"], "3d": ["Jardin de sculptures", "un objet 3D"],
};
const hours: Record<string, [string, string]> = {
  night: ["Oiseau de nuit", "après minuit et avant cinq heures"], early: ["Lève-tôt", "entre cinq et sept heures du matin"], noon: ["Pause déjeuner", "entre midi et une heure"],
};
const days = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const secrets: Record<string, [string, string]> = {
  "sss:streak": ["Dix ans d'affilée", "Terminer une tâche chaque jour pendant dix ans."],
  "sss:earned": ["L'arbre entier", "Obtenir chacun des 500 autres succès."],
  "sss:tasks": ["Un million de tâches", `Terminer ${number(1000000)} tâches.`],
  "sss:noticed:leaves": ["Chaque feuille, chaque saison, chaque lumière", "Porter chaque thème, clair et sombre, à chacune des quatre saisons."],
  "sss:solstice": ["Solstice à minuit", "Terminer une tâche dans la première heure du 21 décembre."],
};
/** "le renard", "la chouette", "l'écureuil": a vowel takes the elision ("hérisson" has a silent h that does not). */
const feminine = new Set(["owl"]);
const the = (kind: string, word: string): string =>
  (/^[aeiouyéèêàâ]/i.test(word) ? `l'${word}` : `${feminine.has(kind) ? "la" : "le"} ${word}`);

/** The ones named by what the window saw: a theme, a season, a background, a flag, a pet. */
function noticed(tail: string): Words | null {
  const [what, a, b] = tail.split(":");
  if (what === "theme" && a && b) {
    const english = themeNames().find(([id]) => id === b)?.[1] ?? b, name = fr(`appearance.${b}`, english);
    return a === "light" ? { name: `${name} de jour`, desc: `Porter ${name} en mode clair.` } : { name: `${name} au clair de lune`, desc: `Porter ${name} en mode sombre.` };
  }
  const season = what === "season" && a ? seasonWords[a] : undefined;
  if (season) return { name: `Le chêne ${season[1]} ${season[0]}`, desc: `Voir le chêne ${season[1]} ${season[0]}.` };
  const bg = what === "bg" && a ? backgrounds[a] : undefined;
  if (bg) return { name: bg[0], desc: `Mettre ${bg[1]} derrière la vitre.` };
  const flag = what === "flag" && a ? flags[a] : undefined;
  if (flag) return { name: flag[0], desc: flag[1] };
  if (what === "pet" && a) {
    const pet = the(a, fr(`delight.pet.kind.${a}`, a).toLowerCase());
    return { name: `Rencontre avec ${pet}`, desc: `Choisir ${pet} comme animal.` };
  }
  return null;
}
/** The ones named by when a task finished. */
function when(head: string, tail: string, n: number): Words | null {
  const hour = head === "hour" ? hours[tail] : undefined;
  if (hour) return { name: n === 1 ? hour[0] : `${hour[0]} ×${number(n)}`, desc: `Terminer ${plural(n, "tâche")} ${hour[1]}.` };
  const day = head === "weekday" ? days[Number(tail)] : undefined;
  if (day) return { name: `Une tâche du ${day}`, desc: `Terminer une tâche un ${day}.` };
  return null;
}

/** An achievement's name and sentence in French, or its English words when this table does not know it. */
export function inFrench(a: Achievement): Words {
  const secret = secrets[a.id];
  if (secret) return { name: secret[0], desc: secret[1] };
  const pair = counted[a.metric];
  if (pair) return { name: pair[0](a.goal), desc: pair[1](a.goal) };
  const [head = "", ...rest] = a.metric.split(":"), tail = rest.join(":");
  return (head === "noticed" ? noticed(tail) : when(head, tail, a.goal)) ?? { name: a.name, desc: a.desc };
}
