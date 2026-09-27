const words = {
  en: { title: 'Your screen', stop: 'Stop', confirm: 'Confirm this session in Settings › Chat apps, or enter your PIN.', pin: 'PIN', find: 'Find application windows', target: 'Application window', open: 'Open view', take: 'Take over', hand: 'Hand back', controls: 'Control this window', text: 'Text to type', type: 'Type text', press: 'Press key', up: 'Scroll up', down: 'Scroll down', watching: 'Watching. Take over to use this window.', driving: 'You’re driving. Branch’s screen actions wait.', stopped: 'The screen session stopped. Send /screen for a fresh session.', fresh: 'Open a fresh screen link in your own direct chat with Branch.', empty: 'No external application window is available. Open an application on your computer, then try again.', wait: 'Wait for the current screen request to finish.', badImage: 'The screen image could not be read. Start a fresh session.', failedStop: 'Stop was not confirmed. Use Stop on your computer, or send /screen stop.' },
  fr: { title: 'Votre écran', stop: 'Arrêter', confirm: 'Confirmez cette session dans Paramètres › Applications de discussion, ou saisissez votre code PIN.', pin: 'Code PIN', find: 'Trouver les fenêtres', target: 'Fenêtre d’application', open: 'Ouvrir la vue', take: 'Prendre le contrôle', hand: 'Rendre le contrôle', controls: 'Contrôler cette fenêtre', text: 'Texte à saisir', type: 'Saisir le texte', press: 'Appuyer sur la touche', up: 'Défiler vers le haut', down: 'Défiler vers le bas', watching: 'Vous regardez. Prenez le contrôle pour utiliser cette fenêtre.', driving: 'Vous pilotez. Les actions de Branch sur l’écran attendent.', stopped: 'La session est arrêtée. Envoyez /screen pour une nouvelle session.', fresh: 'Ouvrez un nouveau lien dans votre discussion privée avec Branch.', empty: 'Aucune fenêtre externe n’est disponible. Ouvrez une application sur votre ordinateur et réessayez.', wait: 'Attendez la fin de la demande en cours.', badImage: 'L’image de l’écran est illisible. Démarrez une nouvelle session.', failedStop: 'L’arrêt n’est pas confirmé. Utilisez Arrêter sur votre ordinateur, ou envoyez /screen stop.' },
  es: { title: 'Tu pantalla', stop: 'Detener', confirm: 'Confirma esta sesión en Ajustes › Aplicaciones de chat, o introduce tu PIN.', pin: 'PIN', find: 'Buscar ventanas', target: 'Ventana de aplicación', open: 'Abrir vista', take: 'Tomar el control', hand: 'Devolver el control', controls: 'Controlar esta ventana', text: 'Texto para escribir', type: 'Escribir texto', press: 'Pulsar tecla', up: 'Desplazar arriba', down: 'Desplazar abajo', watching: 'Observando. Toma el control para usar esta ventana.', driving: 'Tienes el control. Las acciones de Branch en la pantalla esperan.', stopped: 'La sesión se detuvo. Envía /screen para una nueva sesión.', fresh: 'Abre un enlace nuevo en tu chat privado con Branch.', empty: 'No hay ventanas externas disponibles. Abre una aplicación en tu ordenador e inténtalo de nuevo.', wait: 'Espera a que termine la solicitud actual.', badImage: 'No se pudo leer la imagen. Inicia una nueva sesión.', failedStop: 'No se confirmó la detención. Usa Detener en tu ordenador o envía /screen stop.' },
  de: { title: 'Ihr Bildschirm', stop: 'Stoppen', confirm: 'Bestätigen Sie diese Sitzung unter Einstellungen › Chat-Apps oder geben Sie Ihre PIN ein.', pin: 'PIN', find: 'Anwendungsfenster suchen', target: 'Anwendungsfenster', open: 'Ansicht öffnen', take: 'Steuerung übernehmen', hand: 'Steuerung zurückgeben', controls: 'Dieses Fenster steuern', text: 'Einzugebender Text', type: 'Text eingeben', press: 'Taste drücken', up: 'Nach oben scrollen', down: 'Nach unten scrollen', watching: 'Sie sehen zu. Übernehmen Sie die Steuerung, um dieses Fenster zu nutzen.', driving: 'Sie steuern. Die Bildschirmaktionen von Branch warten.', stopped: 'Die Sitzung wurde beendet. Senden Sie /screen für eine neue Sitzung.', fresh: 'Öffnen Sie einen neuen Link in Ihrem privaten Chat mit Branch.', empty: 'Kein externes Anwendungsfenster verfügbar. Öffnen Sie eine Anwendung auf Ihrem Computer und versuchen Sie es erneut.', wait: 'Warten Sie, bis die aktuelle Anfrage abgeschlossen ist.', badImage: 'Das Bildschirmbild konnte nicht gelesen werden. Starten Sie eine neue Sitzung.', failedStop: 'Das Stoppen wurde nicht bestätigt. Nutzen Sie Stoppen am Computer oder senden Sie /screen stop.' },
};
const sdk = window.Telegram?.WebApp;
const lang = (sdk?.initDataUnsafe?.user?.language_code ?? navigator.language ?? 'en').split('-')[0];
const say = key => (words[lang] ?? words.en)[key];
const el = id => document.getElementById(id), status = text => { el('status').textContent = text; };
document.documentElement.lang = Object.hasOwn(words, lang) ? lang : 'en';
document.querySelectorAll('[data-word]').forEach(node => { node.textContent = say(node.dataset.word); });
document.title = say('title');
const request = new URL(location.href).searchParams.get('request');
const initData = sdk?.initData ?? '';
let key = null, inputFrame = null, selected = null, running = false, driving = false, busy = false;
let choices = [], timer, expiry = 0, generation = 0, ended = false;
const canvas = el('screen'), context = canvas.getContext('2d');
async function post(route, body, keepalive = false) {
  const answer = await fetch(`/api/chat-screen/${route}`, { method: 'POST', credentials: 'omit', cache: 'no-store', keepalive,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await answer.json();
  if (!answer.ok) throw new Error(result.error ?? say('fresh'));
  return result;
}
function controls() {
  el('stop').disabled = ended || !initData; el('take').disabled = !running || busy || driving; el('hand').disabled = !running || busy || !driving;
  el('input').disabled = !running || busy || !driving || !inputFrame;
  el('find').disabled = ended || busy || !initData; el('start').disabled = ended || busy;
}
async function locked(work) {
  if (busy) { status(say('wait')); return; }
  busy = true; controls();
  try { await work(); } catch (error) { status(error.message); }
  finally { busy = false; controls(); }
}
async function find() {
  await locked(async () => {
    const epoch = generation;
    const found = await post('targets', { request, initData, ...(el('pin').value ? { pin: el('pin').value } : {}) });
    if (epoch !== generation) return;
    el('pin').value = ''; choices = found.targets; el('target').replaceChildren();
    for (const choice of choices) { const option = document.createElement('option'); option.value = choice.id; option.textContent = choice.label; el('target').append(option); }
    el('choose').hidden = choices.length === 0;
    status(choices.length ? say('target') : say('empty'));
  });
}
async function start() {
  await locked(async () => {
    const epoch = generation;
    selected = choices.find(choice => choice.id === el('target').value);
    if (!selected) return;
    const session = await post('start', { request, initData, target: selected.id });
    if (epoch !== generation) { await post('stop', { key: session.key }, true); return; }
    key = session.key; expiry = session.expires; running = true;
    el('confirm').hidden = true; el('choose').hidden = true; el('view').hidden = false;
    status(say('watching'));
  });
  if (running) tick();
}
async function draw(frame) {
  const image = new Image(); image.src = `data:${frame.type};base64,${frame.frame}`;
  await image.decode().catch(() => { throw new Error(say('badImage')); });
  if (!running) return;
  canvas.width = frame.width; canvas.height = frame.height; context.drawImage(image, 0, 0);
  if (frame.cursor) {
    const x = frame.cursor.x * canvas.width, y = frame.cursor.y * canvas.height;
    context.fillStyle = '#4d9bff'; context.strokeStyle = '#fff'; context.lineWidth = 2;
    context.beginPath(); context.moveTo(x, y); context.lineTo(x + 4, y + 18); context.lineTo(x + 10, y + 11); context.closePath(); context.fill(); context.stroke();
  }
  inputFrame = frame.inputFrame; driving = frame.control === 'owner'; status(say(driving ? 'driving' : 'watching'));
  controls();
}
async function tick() {
  if (!running) return;
  if (Date.now() >= expiry || document.hidden) { await stop(); return; }
  if (!busy) {
    busy = true; controls();
    try { await draw(await post('frame', { key, width: Math.max(320, Math.min(1920, Math.round(canvas.clientWidth * devicePixelRatio))) })); }
    catch (error) { status(error.message); await stop(true); }
    finally { busy = false; controls(); }
  }
  if (running) timer = setTimeout(tick, 200);
}
async function action(value) {
  if (!driving || !inputFrame || !selected) return;
  await locked(async () => {
    const proof = inputFrame; inputFrame = null;
    await post('action', { key, inputFrame: proof, action: { ...value, window: selected.label } });
    if (value.action === 'type') el('text').value = '';
  });
}
async function control(owner) {
  await locked(async () => { await post('control', { key, owner }); driving = owner; inputFrame = null; });
}
async function stop(preserveMessage = false) {
  const old = key; clearView();
  try { await post('stop', old ? { key: old } : { request, initData }, true); if (!preserveMessage) status(say('stopped')); }
  catch { if (!preserveMessage) status(say('failedStop')); }
}
function leave() {
  if (ended) return;
  const old = key; clearView(); status(say('stopped'));
  navigator.sendBeacon('/api/chat-screen/stop', new Blob([JSON.stringify(old ? { key: old } : { request, initData })], { type: 'application/json' }));
}
function clearView() {
  generation++; ended = true; key = null; running = false; driving = false; inputFrame = null; clearTimeout(timer);
  canvas.width = canvas.width; el('text').value = ''; el('pin').value = ''; el('find').disabled = true; el('start').disabled = true; controls();
}
el('find').addEventListener('click', find); el('start').addEventListener('click', start);
el('stop').addEventListener('click', () => stop()); el('take').addEventListener('click', () => control(true)); el('hand').addEventListener('click', () => control(false));
el('type').addEventListener('click', () => { if (el('text').value) action({ action: 'type', text: el('text').value }); });
el('press').addEventListener('click', () => action({ action: 'key', chord: el('key').value }));
el('up').addEventListener('click', () => action({ action: 'scroll', steps: 2 })); el('down').addEventListener('click', () => action({ action: 'scroll', steps: -2 }));
canvas.addEventListener('click', event => { const box = canvas.getBoundingClientRect(); action({ action: 'click', x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height }); });
window.addEventListener('pagehide', leave); document.addEventListener('visibilitychange', () => { if (document.hidden) leave(); });
if (!initData || !/^[a-f0-9-]{36}$/i.test(request ?? '')) { el('find').disabled = true; status(say('fresh')); }
else { sdk?.ready(); sdk?.expand(); status(say('confirm')); controls(); }
