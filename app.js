import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const $ = (s) => document.querySelector(s);
const cfg = window.NOOK_CONFIG || {};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const SB_URL = (cfg.url || store.get('nook_url') || '').trim();
const SB_KEY = (cfg.key || store.get('nook_key') || '').trim();

const ICONS = {
  laptop: '<svg viewBox="0 0 24 24"><path d="M4 6h16v10H4zM2 19h20"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2"/></svg>',
  hash: '<svg viewBox="0 0 24 24"><path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 6h6l2 2h10v11H3z"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><path d="M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5"/></svg>',
  image: '<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4"/></svg>',
};

const ROOMS = [
  { id: 'all', name: 'Все', icon: 'hash' },
  { id: 'work', name: 'Работа', icon: 'folder' },
  { id: 'personal', name: 'Личное', icon: 'lock' },
  { id: 'files', name: 'Файлы', icon: 'file' },
  { id: 'photos', name: 'Фото', icon: 'image' },
];

const state = {
  user: null, items: [], room: 'all', query: '', urls: new Map(), pending: [],
  started: false, channel: null, presence: null,
};
let sb = null;

/* ---------- утилиты ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
const fmtSize = (n) => !n ? '' : n < 1024 ? n + ' Б' : n < 1048576 ? Math.round(n / 1024) + ' КБ' : (n / 1048576).toFixed(1).replace('.', ',') + ' МБ';
const fmtTime = (d) => new Date(d).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
function dayLabel(d) {
  const x = new Date(d), t = new Date();
  const k = (v) => v.getFullYear() * 400 + v.getMonth() * 32 + v.getDate();
  const y = new Date(t); y.setDate(t.getDate() - 1);
  if (k(x) === k(t)) return 'Сегодня';
  if (k(x) === k(y)) return 'Вчера';
  return x.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: x.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
}
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
const isImage = (it) => (it.file_type || '').startsWith('image/');
const isPdf = (it) => it.file_type === 'application/pdf' || /\.pdf$/i.test(it.file_name || '');
function deviceName() {
  const u = navigator.userAgent;
  if (/iPhone/.test(u)) return 'iPhone';
  if (/iPad/.test(u)) return 'iPad';
  if (/Android/.test(u)) return 'Android';
  if (/Windows/.test(u)) return 'Windows';
  if (/Mac/.test(u)) return navigator.maxTouchPoints > 1 ? 'iPad' : 'Mac';
  if (/Linux/.test(u)) return 'Linux';
  return 'Устройство';
}
const isPhoneName = (n) => ['iPhone', 'iPad', 'Android'].includes(n);
const deviceIcon = (n) => isPhoneName(n) ? ICONS.phone : ICONS.laptop;
const DEVICE = deviceName();
if (isPhoneName(DEVICE)) document.querySelector('#msg').placeholder = 'Сообщение или файл…';
let deviceId = store.get('nook_device_id');
if (!deviceId) { deviceId = crypto.randomUUID(); store.set('nook_device_id', deviceId); }
const safeName = (n) => n.replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(-80) || 'file';

function show(which) {
  for (const id of ['setup', 'auth', 'app']) $('#' + id).classList.toggle('hidden', id !== which);
}

/* ---------- запуск ---------- */
async function boot() {
  registerSW();
  setupInstall();
  if (!SB_URL || !SB_KEY) return show('setup');
  sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  sb.auth.onAuthStateChange((event, session) => {
    if (session && !state.started) start(session);
    if (!session && event === 'SIGNED_OUT') stop();
  });
  const { data } = await sb.auth.getSession();
  if (data.session) start(data.session); else show('auth');
}

async function start(session) {
  if (state.started) return;
  state.started = true; state.user = session.user;
  $('#user-email').textContent = $('#user-email-m').textContent = session.user.email || '';
  show('app');
  renderRooms(); renderDevices([]);
  await loadItems();
  subscribe();
  render(true);
}

function stop() {
  state.started = false; state.user = null; state.items = []; state.urls.clear();
  if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
  if (state.presence) { sb.removeChannel(state.presence); state.presence = null; }
  show('auth');
}

async function loadItems() {
  const { data, error } = await sb.from('items').select('*').order('created_at', { ascending: false }).limit(300);
  if (error) { setStatus('ошибка загрузки'); toast('Не удалось загрузить ленту: ' + error.message, 5000); return; }
  state.items = data.reverse();
  await ensureUrls(state.items);
}

function setStatus(t) { $('#status').textContent = t; }

function subscribe() {
  state.channel = sb.channel('items-' + state.user.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items', filter: `user_id=eq.${state.user.id}` }, async (p) => {
      if (p.eventType === 'INSERT') {
        if (state.items.some((i) => i.id === p.new.id)) return;
        state.items.push(p.new); await ensureUrls([p.new]); render(true);
      } else if (p.eventType === 'DELETE') {
        state.items = state.items.filter((i) => i.id !== p.old.id); render(false);
      }
    })
    .subscribe((s) => { if (s === 'SUBSCRIBED') setStatus('синхронизировано'); else if (s === 'CLOSED' || s === 'CHANNEL_ERROR') setStatus('нет соединения'); });

  state.presence = sb.channel('presence-' + state.user.id, { config: { presence: { key: deviceId } } });
  state.presence.on('presence', { event: 'sync' }, () => {
    const st = state.presence.presenceState();
    renderDevices(Object.entries(st).map(([k, v]) => ({ id: k, name: v[0]?.device || 'Устройство', me: k === deviceId })));
  }).subscribe(async (s) => { if (s === 'SUBSCRIBED') await state.presence.track({ device: DEVICE }); });
}

async function ensureUrls(items) {
  const now = Date.now();
  const need = items.filter((i) => i.file_path && (!state.urls.has(i.file_path) || state.urls.get(i.file_path).exp < now + 600000));
  if (!need.length) return;
  const { data } = await sb.storage.from('files').createSignedUrls(need.map((i) => i.file_path), 3600);
  (data || []).forEach((d) => { if (d.signedUrl) state.urls.set(d.path, { url: d.signedUrl, exp: now + 3600000 }); });
}
const urlOf = (it) => state.urls.get(it.file_path)?.url || '';

/* ---------- отрисовка ---------- */
function filtered() {
  const q = state.query.trim().toLowerCase();
  return state.items.filter((i) => {
    if (state.room === 'work' && i.room !== 'work') return false;
    if (state.room === 'personal' && i.room !== 'personal') return false;
    if (state.room === 'files' && i.kind !== 'file') return false;
    if (state.room === 'photos' && !(i.kind === 'file' && isImage(i))) return false;
    if (q && !((i.body || '') + ' ' + (i.file_name || '')).toLowerCase().includes(q)) return false;
    return true;
  });
}
function count(room) {
  return state.items.filter((i) => room === 'all' ? true : room === 'files' ? i.kind === 'file' : room === 'photos' ? (i.kind === 'file' && isImage(i)) : i.room === room).length;
}
function renderRooms() {
  const side = ROOMS.map((r) => `<button class="room ${state.room === r.id ? 'on' : ''}" data-room="${r.id}">${ICONS[r.icon]}<span>${r.name}</span><span class="n">${count(r.id) || ''}</span></button>`).join('');
  $('#rooms-side').innerHTML = side;
  $('#rooms-sheet').innerHTML = side;
  $('#chips').innerHTML = ROOMS.map((r) => `<div class="chip ${state.room === r.id ? 'on' : ''}" data-room="${r.id}">${r.name}</div>`).join('');
  $('#room-title').textContent = ROOMS.find((r) => r.id === state.room).name;
}
function renderDevices(list) {
  const known = new Map(list.map((d) => [d.id, d]));
  if (!known.has(deviceId)) known.set(deviceId, { id: deviceId, name: DEVICE, me: true });
  const html = [...known.values()].map((d) => `<div class="dev">${deviceIcon(d.name)}<span>${esc(d.name)}${d.me ? ' · этот' : ''}</span><span class="dot"></span></div>`).join('');
  $('#devices').innerHTML = html; $('#devices-sheet').innerHTML = html;
}

function itemHTML(it, pending = false) {
  const tag = `<div class="tag">${deviceIcon(it.device)}<span>${esc(it.device || 'Устройство')} · ${fmtTime(it.created_at)}</span>${pending ? '' : `<span class="acts">${it.kind === 'text' ? `<button data-act="copy" data-id="${it.id}">Копировать</button>` : ''}<button data-act="del" data-id="${it.id}">Удалить</button></span>`}</div>`;
  let body = '';
  if (it.kind === 'text') {
    body = `<div class="card">${linkify(it.body)}</div>`;
  } else if (isImage(it)) {
    body = `<div class="photo" data-act="open" data-id="${it.id}"><img loading="lazy" alt="${esc(it.file_name)}" src="${esc(urlOf(it))}"></div>`;
  } else {
    const ext = ((it.file_name || '').split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
    body = `<div class="card file"><div class="badge ${isPdf(it) ? 'pdf' : ''}">${isPdf(it) ? 'PDF' : esc(ext)}</div><div class="meta"><div class="name">${esc(it.file_name)}</div><div class="muted small">${fmtSize(it.file_size)}</div></div><button class="btn small-btn" data-act="open" data-id="${it.id}">${isPdf(it) ? 'Открыть' : 'Скачать'}</button></div>`;
  }
  return `<div class="msg ${pending ? 'pending' : ''}" data-id="${it.id}">${tag}${body}</div>`;
}

function render(scroll) {
  renderRooms();
  const feed = $('#feed');
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 160;
  const list = filtered();
  let html = '', last = '';
  for (const it of list) {
    const d = dayLabel(it.created_at);
    if (d !== last) { html += `<div class="day">${d}</div>`; last = d; }
    html += itemHTML(it);
  }
  for (const p of state.pending) html += itemHTML(p, true);
  if (!html) html = `<div class="empty"><b>Здесь пока пусто</b>Напиши заметку, вставь скриншот или перетащи файл — он появится на всех твоих устройствах.</div>`;
  feed.innerHTML = html;
  if (scroll && (nearBottom || scroll === 'force')) requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
}

/* ---------- отправка ---------- */
function currentRoom() { return state.room === 'work' ? 'work' : 'personal'; }

async function sendText() {
  const ta = $('#msg'); const text = ta.value.trim();
  if (!text) return;
  ta.value = ''; autosize();
  const { data, error } = await sb.from('items').insert({ kind: 'text', body: text, room: currentRoom(), device: DEVICE }).select().single();
  if (error) { ta.value = text; autosize(); return toast('Не отправилось: ' + error.message, 5000); }
  if (!state.items.some((i) => i.id === data.id)) state.items.push(data);
  render('force');
}

async function uploadBlob(blob, name, type) {
  const path = `${state.user.id}/${crypto.randomUUID()}-${safeName(name)}`;
  const up = await sb.storage.from('files').upload(path, blob, { contentType: type || 'application/octet-stream', upsert: false });
  if (up.error) throw up.error;
  const { data, error } = await sb.from('items').insert({
    kind: 'file', file_path: path, file_name: name, file_type: type || 'application/octet-stream',
    file_size: blob.size, room: currentRoom(), device: DEVICE,
  }).select().single();
  if (error) { await sb.storage.from('files').remove([path]); throw error; }
  if (!state.items.some((i) => i.id === data.id)) state.items.push(data);
  await ensureUrls([data]);
  return data;
}

async function sendFiles(files) {
  const list = [...files];
  for (const f of list) {
    if (f.size > 50 * 1024 * 1024) { toast(`«${f.name}» больше 50 МБ — лимит бесплатного плана`, 5000); continue; }
    const tmp = { id: 'p' + Math.random(), kind: 'file', file_name: f.name, file_type: f.type, file_size: f.size, device: DEVICE, created_at: new Date().toISOString() };
    state.pending.push(tmp); render('force');
    try { await uploadBlob(f, f.name || 'файл', f.type); }
    catch (e) { toast('Не загрузилось: ' + (e.message || e), 5000); }
    state.pending = state.pending.filter((p) => p !== tmp); render('force');
  }
}

function autosize() { const ta = $('#msg'); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; }

/* ---------- действия над записями ---------- */
function openViewer(it) {
  const url = urlOf(it); if (!url) return toast('Ссылка ещё не готова, попробуй снова');
  if (!isImage(it) && !isPdf(it)) { const a = document.createElement('a'); a.href = url; a.download = it.file_name; document.body.appendChild(a); a.click(); a.remove(); return; }
  $('#viewer-name').textContent = it.file_name;
  const dl = $('#viewer-dl'); dl.href = url; dl.setAttribute('download', it.file_name);
  $('#viewer-body').innerHTML = isImage(it) ? `<img alt="" src="${esc(url)}">` : `<iframe src="${esc(url)}" title="PDF"></iframe>`;
  $('#viewer').classList.remove('hidden');
}
async function removeItem(id) {
  const it = state.items.find((i) => i.id === id); if (!it) return;
  if (!confirm('Удалить запись на всех устройствах?')) return;
  const { error } = await sb.from('items').delete().eq('id', id);
  if (error) return toast('Не удалось удалить: ' + error.message, 5000);
  if (it.file_path) await sb.storage.from('files').remove([it.file_path]);
  state.items = state.items.filter((i) => i.id !== id); render(false);
}

/* ---------- PDF-инструменты (всё в браузере) ---------- */
const pdf = { sel: [], locals: [] };
async function loadPdfLib() {
  if (window.PDFLib) return window.PDFLib;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
    s.onload = res; s.onerror = () => rej(new Error('Не удалось загрузить PDF-модуль'));
    document.head.appendChild(s);
  });
  return window.PDFLib;
}
function pdfSources() {
  const feedSrc = state.items.filter((i) => i.kind === 'file' && (isPdf(i) || isImage(i))).reverse()
    .map((i) => ({ key: 'i:' + i.id, name: i.file_name, size: i.file_size, pdf: isPdf(i), img: isImage(i), get: async () => (await fetch(urlOf(i))).arrayBuffer() }));
  const localSrc = pdf.locals.map((f, n) => ({ key: 'l:' + n, name: f.name, size: f.size, pdf: f.type === 'application/pdf' || /\.pdf$/i.test(f.name), img: f.type.startsWith('image/'), get: () => f.arrayBuffer(), blob: f }));
  return [...localSrc, ...feedSrc];
}
function renderPdfList() {
  const src = pdfSources();
  $('#pdf-list').innerHTML = src.length ? src.map((s) => {
    const idx = pdf.sel.indexOf(s.key);
    return `<div class="src ${idx >= 0 ? 'sel' : ''}" data-key="${esc(s.key)}"><div class="num">${idx >= 0 ? idx + 1 : ''}</div><div class="badge ${s.pdf ? 'pdf' : ''}">${s.pdf ? 'PDF' : 'IMG'}</div><div class="meta"><div class="name">${esc(s.name)}</div><div class="muted small">${fmtSize(s.size)}</div></div></div>`;
  }).join('') : '<div class="muted small">В ленте пока нет PDF и картинок. Добавь файлы с устройства.</div>';
}
const pdfStatus = (t, cls = '') => { const el = $('#pdf-status'); el.textContent = t; el.className = 'status ' + cls; };

function parseRange(str, total) {
  const out = [];
  for (const part of str.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`Не понял «${part}»`);
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b > total || a > b) throw new Error(`Страницы «${part}» вне диапазона 1–${total}`);
    for (let p = a; p <= b; p++) out.push(p - 1);
  }
  if (!out.length) throw new Error('Укажи страницы');
  return out;
}
async function toJpeg(buf, mime) {
  const bmp = await createImageBitmap(new Blob([buf], { type: mime || 'image/jpeg' }));
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: c.width, h: c.height };
}

async function runTool(tool) {
  const all = pdfSources(); const chosen = pdf.sel.map((k) => all.find((s) => s.key === k)).filter(Boolean);
  const btns = document.querySelectorAll('.tool'); btns.forEach((b) => (b.disabled = true));
  try {
    pdfStatus('Работаю…');
    const { PDFDocument, degrees } = await loadPdfLib();
    let out, name;
    if (tool === 'merge') {
      const pdfs = chosen.filter((s) => s.pdf);
      if (pdfs.length < 2) throw new Error('Выбери минимум два PDF');
      out = await PDFDocument.create();
      for (const s of pdfs) {
        const d = await PDFDocument.load(await s.get(), { ignoreEncryption: true });
        (await out.copyPages(d, d.getPageIndices())).forEach((p) => out.addPage(p));
      }
      name = 'Объединённый.pdf';
    } else if (tool === 'images') {
      const imgs = chosen.filter((s) => s.img);
      if (!imgs.length) throw new Error('Выбери хотя бы одну картинку');
      out = await PDFDocument.create();
      for (const s of imgs) {
        const j = await toJpeg(await s.get(), s.blob?.type);
        const img = await out.embedJpg(j.bytes);
        const W = 595, H = Math.round((j.h / j.w) * W);
        const page = out.addPage([W, H]); page.drawImage(img, { x: 0, y: 0, width: W, height: H });
      }
      name = 'Из фото.pdf';
    } else if (tool === 'rotate') {
      const pdfs = chosen.filter((s) => s.pdf);
      if (!pdfs.length) throw new Error('Выбери PDF');
      for (const s of pdfs) {
        const d = await PDFDocument.load(await s.get(), { ignoreEncryption: true });
        d.getPages().forEach((p) => p.setRotation(degrees((p.getRotation().angle + 90) % 360)));
        await saveResult(await d.save(), s.name.replace(/\.pdf$/i, '') + ' (повёрнут).pdf');
      }
      pdfStatus('Готово — файлы в ленте', 'ok'); return;
    } else if (tool === 'pages') {
      const pdfs = chosen.filter((s) => s.pdf);
      if (pdfs.length !== 1) throw new Error('Выбери ровно один PDF');
      const src = await PDFDocument.load(await pdfs[0].get(), { ignoreEncryption: true });
      const idx = parseRange($('#pdf-range').value, src.getPageCount());
      out = await PDFDocument.create();
      (await out.copyPages(src, idx)).forEach((p) => out.addPage(p));
      name = pdfs[0].name.replace(/\.pdf$/i, '') + ` (стр. ${$('#pdf-range').value.trim()}).pdf`;
    }
    await saveResult(await out.save(), name);
    pdfStatus('Готово — файл в ленте', 'ok');
  } catch (e) { pdfStatus(e.message || String(e), 'bad'); }
  finally { btns.forEach((b) => (b.disabled = false)); }
}
async function saveResult(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  await uploadBlob(blob, name, 'application/pdf'); render('force'); renderPdfList();
}

/* ---------- установка и офлайн ---------- */
let deferredInstall = null;
function setupInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredInstall = e;
    $('#install-btn').hidden = false; $('#install-btn-m').hidden = false;
  });
  window.addEventListener('appinstalled', () => { $('#install-btn').hidden = true; $('#install-btn-m').hidden = true; toast('Nook установлен'); });
  const doInstall = async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; };
  $('#install-btn').onclick = doInstall; $('#install-btn-m').onclick = doInstall;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (/iPhone|iPad/.test(navigator.userAgent) && !standalone) {
    setTimeout(() => { if (state.started && !store.get('nook_ios_hint')) { toast('Чтобы установить: «Поделиться» → «На экран Домой»', 7000); store.set('nook_ios_hint', '1'); } }, 4000);
  }
}
function registerSW() { if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {}); }

/* ---------- события ---------- */
$('#setup-save').onclick = () => {
  const u = $('#setup-url').value.trim(), k = $('#setup-key').value.trim();
  if (!/^https:\/\/.+\.supabase\.co\/?$/.test(u) || k.length < 20) { $('#setup-err').textContent = 'Проверь адрес (https://xxxx.supabase.co) и ключ'; return; }
  store.set('nook_url', u.replace(/\/$/, '')); store.set('nook_key', k); location.reload();
};
async function doAuth(signup) {
  const email = $('#auth-email').value.trim(), password = $('#auth-pass').value;
  const msg = $('#auth-msg'); msg.className = 'err';
  if (!email || password.length < 6) { msg.textContent = 'Введи почту и пароль от 6 символов'; return; }
  msg.textContent = 'Секунду…'; msg.className = 'err ok';
  const { data, error } = signup ? await sb.auth.signUp({ email, password }) : await sb.auth.signInWithPassword({ email, password });
  if (error) { msg.className = 'err'; msg.textContent = /invalid login/i.test(error.message) ? 'Неверная почта или пароль' : error.message; return; }
  if (signup && !data.session) { msg.className = 'err ok'; msg.textContent = 'Аккаунт создан. Подтверди почту по письму, затем нажми «Войти».'; }
}
$('#auth-login').onclick = () => doAuth(false);
$('#auth-signup').onclick = () => doAuth(true);
$('#auth-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth(false); });
const logout = async () => { await sb.auth.signOut(); };
$('#logout').onclick = logout; $('#logout-m').onclick = logout;

document.addEventListener('click', (e) => {
  const room = e.target.closest('[data-room]');
  if (room) { state.room = room.dataset.room; $('#sheet').classList.add('hidden'); render('force'); return; }
  const act = e.target.closest('[data-act]');
  if (act) {
    const it = state.items.find((i) => i.id === act.dataset.id);
    if (act.dataset.act === 'del') removeItem(act.dataset.id);
    else if (act.dataset.act === 'open' && it) openViewer(it);
    else if (act.dataset.act === 'copy' && it) navigator.clipboard?.writeText(it.body).then(() => toast('Скопировано'));
  }
});
$('#menu-btn').onclick = () => $('#sheet').classList.remove('hidden');
$('#sheet-close').onclick = () => $('#sheet').classList.add('hidden');
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') $('#sheet').classList.add('hidden'); });
$('#search-toggle').onclick = () => { $('#search-bar').classList.toggle('hidden'); if (!$('#search-bar').classList.contains('hidden')) $('#search-m').focus(); };
const onSearch = (e) => { state.query = e.target.value; $('#search-d').value = $('#search-m').value = e.target.value; render(false); };
$('#search-d').oninput = onSearch; $('#search-m').oninput = onSearch;

$('#send').onclick = sendText;
$('#msg').addEventListener('input', autosize);
$('#msg').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !/iPhone|iPad|Android/.test(navigator.userAgent)) { e.preventDefault(); sendText(); }
});
$('#attach').onclick = () => $('#file-in').click();
$('#file-in').onchange = (e) => { sendFiles(e.target.files); e.target.value = ''; };
document.addEventListener('paste', (e) => {
  if (!state.started) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); sendFiles(files); }
});
let dragN = 0;
window.addEventListener('dragenter', (e) => { if (state.started && e.dataTransfer?.types?.includes('Files')) { dragN++; $('#dropzone').classList.remove('hidden'); } });
window.addEventListener('dragleave', () => { dragN = Math.max(0, dragN - 1); if (!dragN) $('#dropzone').classList.add('hidden'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); dragN = 0; $('#dropzone').classList.add('hidden'); if (state.started && e.dataTransfer?.files?.length) sendFiles(e.dataTransfer.files); });

$('#viewer-close').onclick = () => { $('#viewer').classList.add('hidden'); $('#viewer-body').innerHTML = ''; };
$('#pdf-open').onclick = () => { pdf.sel = []; pdfStatus(''); renderPdfList(); $('#pdf-modal').classList.remove('hidden'); };
$('#pdf-close').onclick = () => $('#pdf-modal').classList.add('hidden');
$('#pdf-modal').addEventListener('click', (e) => { if (e.target.id === 'pdf-modal') $('#pdf-modal').classList.add('hidden'); });
$('#pdf-local').onchange = (e) => { pdf.locals.push(...e.target.files); e.target.value = ''; renderPdfList(); };
$('#pdf-list').addEventListener('click', (e) => {
  const row = e.target.closest('.src'); if (!row) return;
  const k = row.dataset.key; const i = pdf.sel.indexOf(k);
  if (i >= 0) pdf.sel.splice(i, 1); else pdf.sel.push(k);
  renderPdfList();
});
document.querySelectorAll('.tool').forEach((b) => (b.onclick = () => runTool(b.dataset.tool)));

// когда вкладка снова активна — дотянуть пропущенное и обновить ссылки
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.started) { await loadItems(); render(false); }
});
window.addEventListener('online', () => setStatus('синхронизировано'));
window.addEventListener('offline', () => setStatus('офлайн'));

boot();
