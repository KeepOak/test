import { readFileSync } from "node:fs";
import { type Achievement, themeNames } from "./achievements.js";

/**
 * i18n-es: the achievements' names, sentences and kinds in Spanish, as src/achievements-de.ts does for German.
 * The catalogue (src/achievements.ts) stays the one source of ids, goals and tiers; this only words each one
 * again from its measure and goal. A measure this table does not know keeps its English words, so a new
 * achievement is never lost. Goals are written as infinitives ("Terminar 5 tareas."), and the words are the
 * window's own (public/locales/es.json): Bloqueo, programaciones, disparadores, caja fuerte, revisiones.
 */
export interface Words { name: string; desc: string; kind: string }
type Say = (n: number) => string;
type Pair = [Say, Say];

const number = (n: number): string => n.toLocaleString("es-ES");
/** Spanish: only one takes the singular. */
const plural = (n: number, one: string, many: string): string => `${number(n)} ${n === 1 ? one : many}`;
const times = (n: number): string => (n === 1 ? "una vez" : `${number(n)} veces`);
const first = (n: number, name: string, many: Say): string => (n === 1 ? name : many(n));
const tasks = (n: number): string => plural(n, "tarea", "tareas");

let esWords: Record<string, string> | null = null;
/** The window's own Spanish words, for the themes' and the pets' names. */
function es(key: string, english: string): string {
  if (!esWords) {
    try { esWords = JSON.parse(readFileSync(new URL("../public/locales/es.json", import.meta.url), "utf8")) as Record<string, string>; }
    catch { esWords = {}; }
  }
  return esWords[key] ?? english;
}

/** The kinds the catalogue files each one under, in the window's Spanish words. */
const kinds: Record<string, string> = {
  "Getting started": "Primeros pasos", "Every day": "Cada día", Automations: "Automatizaciones", "Chat apps": "Apps de chat",
  Safety: "Seguridad", Tools: "Herramientas", Voice: "Voz", Looks: "Aspecto", Explorer: "Explorador", Pets: "Mascotas",
  Secrets: "Secretos", People: "Personas", Trunks: "Trunks",
};

/** The long ladders and the counted records, by what they measure. */
const counted: Record<string, Pair> = {
  tasks: [(n) => first(n, "Brote", (k) => plural(k, "tarea terminada", "tareas terminadas")), (n) => `Terminar ${tasks(n)}.`],
  conversations: [(n) => plural(n, "conversación", "conversaciones"), (n) => `Tener ${plural(n, "conversación", "conversaciones")}.`],
  days: [(n) => `${plural(n, "día", "días")} juntos`,
    (n) => (n === 1 ? "Terminar una tarea un día." : `Terminar una tarea en ${number(n)} días distintos.`)],
  streak: [(n) => `Racha de ${plural(n, "día", "días")}`, (n) => `Terminar una tarea cada día durante ${plural(n, "día seguido", "días seguidos")}.`],
  "src:schedule": [(n) => plural(n, "ejecución programada", "ejecuciones programadas"), (n) => `Dejar que las programaciones terminen ${tasks(n)}.`],
  "src:channel": [(n) => plural(n, "tarea de app de chat", "tareas de app de chat"),
    (n) => `Terminar ${plural(n, "tarea pedida", "tareas pedidas")} desde una app de chat.`],
  "src:trigger": [(n) => plural(n, "tarea disparada", "tareas disparadas"), (n) => `Terminar ${plural(n, "tarea iniciada", "tareas iniciadas")} por un disparador.`],
  "audit:approval.decided": [(n) => first(n, "Sí o no", (k) => plural(k, "aprobación respondida", "aprobaciones respondidas")),
    (n) => `Responder ${plural(n, "pregunta de aprobación", "preguntas de aprobación")}.`],
  "tool:all": [(n) => plural(n, "herramienta usada", "herramientas usadas"), (n) => `Dejar que las tareas usen herramientas ${times(n)}.`],
  "tool:files": [(n) => plural(n, "paso con archivos", "pasos con archivos"), (n) => `Dejar que las tareas lean o cambien archivos ${times(n)}.`],
  "tool:web": [(n) => plural(n, "búsqueda en la web", "búsquedas en la web"), (n) => `Dejar que las tareas busquen cosas en la web ${times(n)}.`],
  "tool:browser": [(n) => plural(n, "paso en el navegador", "pasos en el navegador"), (n) => `Dejar que las tareas usen el navegador ${times(n)}.`],
  "tool:code": [(n) => plural(n, "paso de código", "pasos de código"), (n) => `Dejar que las tareas ejecuten código o comandos ${times(n)}.`],
  "tool:memory": [(n) => plural(n, "paso de memoria", "pasos de memoria"), (n) => `Dejar que las tareas usen lo que Branch recuerda ${times(n)}.`],
  "tool:documents": [(n) => plural(n, "paso con documentos", "pasos con documentos"), (n) => `Dejar que las tareas lean o escriban documentos ${times(n)}.`],
  "event:voice.transcribed": [(n) => first(n, "Por escrito", (k) => plural(k, "grabación transcrita", "grabaciones transcritas")),
    (n) => `Hacer que las tareas transcriban ${plural(n, "grabación de sonido", "grabaciones de sonido")}.`],
  "event:voice.live.started": [(n) => first(n, "La voz de la razón", (k) => plural(k, "conversación en directo", "conversaciones en directo")),
    (n) => `Hablar en directo ${times(n)}.`],
  stopped: [(n) => first(n, "¡Alto ahí!", (k) => plural(k, "tarea detenida", "tareas detenidas")), (n) => `Detener ${plural(n, "tarea en marcha", "tareas en marcha")}.`],
  ...recorded(),
};

/** What the audit log, the saved records and the task events count. */
function recorded(): Record<string, Pair> {
  return {
    "audit:lockdown.changed": [(n) => first(n, "Simulacro de bloqueo", (k) => `Bloqueo ${times(k)}`), (n) => `Activar o desactivar el bloqueo ${times(n)}.`],
    "audit:channel.paired": [(n) => first(n, "Emparejado", (k) => plural(k, "app de chat emparejada", "apps de chat emparejadas")),
      (n) => `Emparejar ${plural(n, "app de chat", "apps de chat")}.`],
    "audit:secret.used": [(n) => first(n, "Bien guardado", (k) => plural(k, "secreto entregado con seguridad", "secretos entregados con seguridad")),
      (n) => `Dejar que una tarea use un secreto de la caja fuerte ${times(n)}.`],
    "audit:connection.changed": [(n) => first(n, "Conectado", (k) => plural(k, "cambio de conexión", "cambios de conexión")),
      (n) => `Añadir o quitar una conexión de modelo ${times(n)}.`],
    "audit:data.exported": [(n) => first(n, "Rastro de papel", (k) => plural(k, "exportación", "exportaciones")), (n) => `Exportar algo ${times(n)}.`],
    "audit:data.imported": [(n) => first(n, "Mudanza", (k) => plural(k, "importación", "importaciones")), (n) => `Traer cosas de otro asistente ${times(n)}.`],
    "audit:token.issued": [(n) => first(n, "Cerrajero", (k) => plural(k, "clave creada o retirada", "claves creadas o retiradas")),
      (n) => `Crear o retirar una clave de corta duración ${times(n)}.`],
    "audit:browser.borrowed": [(n) => first(n, "Navegador prestado", (k) => `Navegador prestado ${times(k)}`), (n) => `Prestar a Branch tu propio navegador ${times(n)}.`],
    "audit:network.connected": [(n) => first(n, "Línea abierta", (k) => plural(k, "línea abierta", "líneas abiertas")),
      (n) => `Mantener una conexión en directo, como una llamada de voz, ${times(n)}.`],
    "audit:hook.blocked": [(n) => first(n, "Normas de la casa", (k) => `Tus comprobaciones aguantaron ${times(k)}`),
      (n) => `Ver cómo una de tus propias comprobaciones detiene o retiene algo ${times(n)}.`],
    "audit:profile.switched": [(n) => first(n, "Familia", (k) => plural(k, "cambio de perfil", "cambios de perfil")), (n) => `Cambiar de perfil ${times(n)}.`],
    "audit:practice.switched": [() => "Ensayo", () => "Activar o desactivar el modo práctica."],
    "audit:mcp.tried": [(n) => first(n, "Servidor de herramientas", (k) => plural(k, "servidor de herramientas probado", "servidores de herramientas probados")),
      (n) => `Probar el servidor de otra herramienta de IA ${times(n)}.`],
    "audit:history.pruned": [(n) => first(n, "Limpieza de primavera", (k) => plural(k, "limpieza", "limpiezas")), (n) => `Limpiar conversaciones antiguas ${times(n)}.`],
    "audit:policy.changed": [(n) => first(n, "Legislador", (k) => plural(k, "cambio de regla", "cambios de regla")),
      (n) => `Cambiar cuándo te consulta Branch ${times(n)}.`],
    "audit:limit.reached": [() => "Límite de velocidad", () => "Ver cómo un límite que pusiste frena algo."],
    ...saved(),
  };
}
function saved(): Record<string, Pair> {
  return {
    "records:schedules": [(n) => first(n, "Según lo previsto", (k) => plural(k, "programación", "programaciones")), (n) => `Tener ${plural(n, "programación", "programaciones")}.`],
    "records:procedures": [(n) => first(n, "Pasos guardados", (k) => plural(k, "procedimiento", "procedimientos")), (n) => `Guardar ${plural(n, "procedimiento", "procedimientos")}.`],
    "records:specialists": [(n) => first(n, "Especialista", (k) => plural(k, "especialista", "especialistas")), (n) => `Tener ${plural(n, "especialista", "especialistas")}.`],
    "records:triggers": [(n) => first(n, "Cable trampa", (k) => plural(k, "disparador", "disparadores")), (n) => `Tener ${plural(n, "disparador", "disparadores")}.`],
    "records:webhooks": [(n) => first(n, "Hola, webhook", (k) => plural(k, "webhook", "webhooks")), (n) => `Tener ${plural(n, "webhook de salida", "webhooks de salida")}.`],
    "records:workflows": [(n) => first(n, "Flujo de trabajo", (k) => plural(k, "flujo de trabajo", "flujos de trabajo")), (n) => `Tener ${plural(n, "flujo de trabajo", "flujos de trabajo")}.`],
    "records:memory": [(n) => first(n, "Recuerdos", (k) => plural(k, "cosa recordada", "cosas recordadas")), (n) => `Hacer que Branch recuerde ${plural(n, "cosa", "cosas")}.`],
    ...happened(),
  };
}
function happened(): Record<string, Pair> {
  return {
    "event:trunk.turn": [(n) => first(n, "Charla de Trunks", (k) => plural(k, "turno de Trunk", "turnos de Trunk")),
      (n) => `Dejar que los Trunks tomen ${plural(n, "turno", "turnos")} en una conversación.`],
    "event:team.ran": [(n) => first(n, "Jugador de equipo", (k) => plural(k, "trabajo en equipo", "trabajos en equipo")),
      (n) => `Poner a trabajar un equipo de asistentes ${times(n)}.`],
    "event:heartbeat.notified": [(n) => first(n, "Revisión", (k) => plural(k, "revisión", "revisiones")),
      (n) => `Recibir ${plural(n, "revisión", "revisiones")} con novedades.`],
    "event:skill.candidate_drafted": [(n) => first(n, "Subir de nivel", (k) => plural(k, "habilidad esbozada", "habilidades esbozadas")),
      (n) => `Hacer que Branch esboce ${plural(n, "habilidad", "habilidades")}.`],
    "event:learning.reviewed": [(n) => first(n, "Lecciones aprendidas", (k) => plural(k, "tarea repasada", "tareas repasadas")),
      (n) => `Dejar que Branch repase ${tasks(n)} para aprender de ${n === 1 ? "ella" : "ellas"}.`],
    "event:voice.spoken": [(n) => first(n, "Leído en voz alta", (k) => `${plural(k, "respuesta leída", "respuestas leídas")} en voz alta`),
      (n) => `Escuchar ${plural(n, "respuesta leída", "respuestas leídas")} en voz alta.`],
    "event:voice.live.interrupted": [(n) => first(n, "Perdona", (k) => `Interrumpido ${times(k)}`), (n) => `Interrumpir una respuesta de voz en directo ${times(n)}.`],
    "event:documents.question": [(n) => first(n, "Pregunta a los documentos", (k) => plural(k, "pregunta a los documentos", "preguntas a los documentos")),
      (n) => `Hacer ${plural(n, "pregunta", "preguntas")} a tus documentos.`],
    "event:wasm.ran": [(n) => first(n, "Pequeño programa", (k) => plural(k, "pequeño programa ejecutado", "pequeños programas ejecutados")),
      (n) => `Ejecutar un complemento de WebAssembly ${times(n)}.`],
    "noticed:themes": [(n) => (n === themeNames().length ? "Todas las hojas del árbol" : plural(n, "tema probado", "temas probados")),
      (n) => `Usar ${plural(n, "tema distinto", "temas distintos")}.`],
    "noticed:seasons": [() => "Cuatro estaciones", () => "Ver el roble en cada estación."],
    "noticed:pages": [(n) => first(n, "Como en casa", (k) => plural(k, "página de Ajustes", "páginas de Ajustes")), (n) => `Abrir ${plural(n, "página", "páginas")} de Ajustes.`],
    "noticed:pats": [(n) => first(n, "Mimos", (k) => plural(k, "caricia", "caricias")), (n) => `Acariciar a tu mascota ${times(n)}.`],
    weekend: [(n) => first(n, "Trabajo de fin de semana", (k) => plural(k, "tarea de fin de semana", "tareas de fin de semana")), (n) => `Terminar ${tasks(n)} en fin de semana.`],
    earned: [(n) => `Coleccionista: ${number(n)}`, (n) => `Conseguir ${n === 1 ? "otro logro" : `otros ${number(n)} logros`}.`],
  };
}

/** One of a kind: its measure's last part names it. */
const flags: Record<string, [string, string]> = {
  "acorn-shown": ["Guardián de la bellota", "Mostrar la bellota en la esquina."],
  "acorn-turned": ["Peonza de bellota", "Girar la bellota arrastrándola."],
  still: ["Naturaleza muerta", "Activar Mantener todo quieto."],
  everything: ["Todo en todas partes", "Activar Mostrarlo todo."],
  "follow-system": ["Seguir al sol", "Dejar que Branch siga el modo claro u oscuro de tu equipo."],
  language: ["Políglota", "Cambiar el idioma."],
  "pet-named": ["Chapa con nombre", "Ponerle nombre a tu mascota."],
  "pet-talks-off": ["Compañía callada", "Pedirle a tu mascota que deje de hablar."],
  quiet: ["Silencio, por favor", "Mantener los logros en silencio (este no aparece)."],
  "style-3d": ["Tercera dimensión", "Dibujar la bellota y la mascota en 3D."],
  lonely: ["Qué solo se está aquí", "Ocultar todo lo que se puede ocultar."],
};
const seasonWords: Record<string, string> = { spring: "primavera", summer: "verano", autumn: "otoño", winter: "invierno" };
const backgrounds: Record<string, [string, string]> = {
  picture: ["Tu propia vista", "una imagen"], video: ["Imágenes en movimiento", "un vídeo"], animation: ["Folioscopio", "una animación"], "3d": ["Jardín de esculturas", "un objeto 3D"],
};
const hours: Record<string, [string, string]> = {
  night: ["Ave nocturna", "después de medianoche y antes de las cinco"], early: ["Madrugador", "entre las cinco y las siete de la mañana"], noon: ["Pausa para comer", "entre las doce y la una"],
};
const days = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const secrets: Record<string, [string, string]> = {
  "sss:streak": ["Racha de diez años", "Terminar una tarea todos los días durante diez años."],
  "sss:earned": ["El árbol entero", "Conseguir cada uno de los otros 500 logros."],
  "sss:tasks": ["Un millón de tareas", `Terminar ${number(1000000)} tareas.`],
  "sss:noticed:leaves": ["Cada hoja, cada estación, cada luz", "Usar cada tema, claro y oscuro, en cada una de las cuatro estaciones."],
  "sss:solstice": ["Solsticio a medianoche", "Terminar una tarea en la primera hora del 21 de diciembre."],
};
/** The pets whose Spanish name is feminine ("la ardilla"); the rest take "el" ("el zorro", "al zorro"). */
const feminine = new Set(["squirrel"]);

/** The ones named by what the window saw: a theme, a season, a background, a flag, a pet. */
function noticed(tail: string): Omit<Words, "kind"> | null {
  const [what, a, b] = tail.split(":");
  if (what === "theme" && a && b) {
    const english = themeNames().find(([id]) => id === b)?.[1] ?? b, name = es(`appearance.${b}`, english);
    return a === "light"
      ? { name: `${name} a la luz del día`, desc: `Usar ${name} en modo claro.` }
      : { name: `${name} a la luz de la luna`, desc: `Usar ${name} en modo oscuro.` };
  }
  const season = what === "season" && a ? seasonWords[a] : undefined;
  if (season) return { name: `El roble en ${season}`, desc: `Ver el roble en ${season}.` };
  const bg = what === "bg" && a ? backgrounds[a] : undefined;
  if (bg) return { name: bg[0], desc: `Poner ${bg[1]} detrás del cristal.` };
  const flag = what === "flag" && a ? flags[a] : undefined;
  if (flag) return { name: flag[0], desc: flag[1] };
  if (what === "pet" && a) {
    const word = es(`delight.pet.kind.${a}`, a).toLocaleLowerCase("es");
    const she = feminine.has(a);
    return { name: `Encuentro con ${she ? "la" : "el"} ${word}`, desc: `Elegir ${she ? "a la" : "al"} ${word} como mascota.` };
  }
  return null;
}
/** The ones named by when a task finished. */
function when(head: string, tail: string, n: number): Omit<Words, "kind"> | null {
  const hour = head === "hour" ? hours[tail] : undefined;
  if (hour) return { name: n === 1 ? hour[0] : `${hour[0]} ×${number(n)}`, desc: `Terminar ${tasks(n)} ${hour[1]}.` };
  const day = head === "weekday" ? days[Number(tail)] : undefined;
  if (day) return { name: `Una tarea del ${day}`, desc: `Terminar una tarea un ${day}.` };
  return null;
}

/** An achievement's name, sentence and kind in Spanish, or its English words when this table does not know it. */
export function inSpanish(a: Achievement): Words {
  const kind = kinds[a.kind] ?? a.kind;
  const secret = secrets[a.id];
  if (secret) return { name: secret[0], desc: secret[1], kind };
  const pair = counted[a.metric];
  if (pair) return { name: pair[0](a.goal), desc: pair[1](a.goal), kind };
  const [head = "", ...rest] = a.metric.split(":"), tail = rest.join(":");
  const words = (head === "noticed" ? noticed(tail) : when(head, tail, a.goal)) ?? { name: a.name, desc: a.desc };
  return { ...words, kind };
}
