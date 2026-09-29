/* ======================= Constants ======================= */
const TASK_TYPES = { ekran_ariza: 'Ekran Arıza', yazilim_ariza: 'Yazılım Arıza', altyapi: 'Altyapı İşi' };
// Both fault types count as "arıza" in fault statistics (most faulty screens, map, screen history).
const FAULT_TYPES = ['ekran_ariza', 'yazilim_ariza'];
function isFault(t) { return FAULT_TYPES.includes(t.type); }
// Filter choices: every fault, or one type.
const TYPE_FILTERS = { fault: 'Tüm arızalar', ...TASK_TYPES };
function matchesTypeFilter(t, filter) { return !filter || (filter === 'fault' ? isFault(t) : t.type === filter); }
const SERVICE_DAYS = { haftaici: 'Hafta İçi', haftasonu: 'Hafta Sonu' };
const TASK_DURATION_HOURS = 48; // set by the server when a job is opened
// A job is İşlemde from the moment it is opened until it is closed.
const TASK_STATUSES = ['islemde', 'kapandi'];
const STATUS_LABELS = { islemde: 'İşlemde', kapandi: 'Kapandı' };
// Older history entries may carry the statuses used before 2026-09-29.
const OLD_STATUS_LABELS = { acik: 'Açık', atandi: 'Atandı', cozuldu: 'Çözüldü' };
function statusLabel(s) { return STATUS_LABELS[s] || OLD_STATUS_LABELS[s] || s; }
// The screen's device number (15 digits); the server checks it and that no other screen has it.
const IMEI_INPUT_ATTRS = 'inputmode="numeric" autocomplete="off" maxlength="20" placeholder="15 haneli"';
const SCREEN_STATUS_LABELS = { aktif: 'Aktif', arizali: 'Arızalı', bakimda: 'Bakımda', pasif: 'Pasif' };
const ROUTE_TITLES = { panel: 'Panel', tasks: 'İşler', screens: 'Ekranlar', map: 'Harita', materials: 'Malzeme Kataloğu', reports: 'Raporlar', users: 'Kullanıcılar', taskDetail: 'İş Detayı', screenDetail: 'Ekran Geçmişi' };
const ORG_TYPE_LABELS = { kurum: 'Kurum çalışanı', firma: 'Firma çalışanı' };
const MIN_PASSWORD_LENGTH = 8;
const POLL_MS = 15000;

/* ======================= Utils ======================= */
function uid(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDate(iso) { if (!iso) return '—'; const d = new Date(iso); if (isNaN(d)) return '—'; return d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
function fmtDateTime(iso) { if (!iso) return '—'; const d = new Date(iso); if (isNaN(d)) return '—'; return d.toLocaleDateString('tr-TR') + ' ' + d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }); }
function optionsHtml(labelMap, selected) { return Object.entries(labelMap).map(([k, v]) => `<option value="${k}" ${selected === k ? 'selected' : ''}>${esc(v)}</option>`).join(''); }
function emptyStateHtml(msg) { return `<div class="empty-state"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg><p>${esc(msg)}</p></div>`; }
function bannerNoDb() { return `<div class="banner banner-warn"><svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>Sunucuya bağlanılamadı — değişiklikler kaydedilemeyebilir. İnternet bağlantınızı kontrol edin; sorun sürerse sayfayı yenileyin.</div>`; }
function fmtMB(bytes) {
  if (bytes < 1048576) return Math.round(bytes / 1024).toLocaleString('tr-TR') + ' KB';
  return (bytes / 1048576).toLocaleString('tr-TR', { maximumFractionDigits: 1 }) + ' MB';
}

// <input type="datetime-local"> works in local time without a zone; the database stores UTC ISO strings.
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(v) { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
function humanDuration(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return m + ' dk';
  const h = Math.round(m / 60);
  if (h < 48) return h + ' saat';
  return Math.round(h / 24) + ' gün';
}

function isClosedStatus(s) { return s === 'kapandi'; }
// Job number given by the server (#1, #2, …); the same number is used in Telegram messages.
function taskNo(t) { return t && t.no ? '#' + t.no : ''; }
function taskNoHtml(t) { return t && t.no ? `<span class="task-no">#${t.no}</span> ` : ''; }
// Jobs have no title: the type names them, the description says what is to be done (older jobs may have a title).
function taskHeadline(t) { return [TASK_TYPES[t.type] || t.type, t.title].filter(Boolean).join(' · '); }
// Full text of a job for exports: its description (older jobs: title and description).
function taskText(t) { return [t.title, t.description].filter(Boolean).join(' — ').replace(/\s+/g, ' ').trim(); }
function taskSummary(t, max = 90) {
  const text = (t.description || t.title || '').split('\n')[0].trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
function dueState(t) {
  if (!t.dueDate || isClosedStatus(t.status)) return null;
  const diff = new Date(t.dueDate) - Date.now();
  if (isNaN(diff)) return null;
  if (diff < 0) return { kind: 'overdue', text: humanDuration(-diff) + ' gecikti' };
  return { kind: diff < 86400000 ? 'soon' : 'ok', text: humanDuration(diff) + ' kaldı' };
}
function isOverdue(t) { return dueState(t)?.kind === 'overdue'; }
function duePill(t) {
  if (!t.dueDate) return '—';
  const s = dueState(t);
  if (!s) return `<span class="mono">${fmtDate(t.dueDate)}</span>`;
  const cls = { overdue: 'pill-crit', soon: 'pill-warn', ok: 'pill-neutral' }[s.kind];
  return `<span class="pill ${cls}" title="Son tarih: ${esc(fmtDateTime(t.dueDate))}">${esc(s.text)}</span>`;
}


const API_ERRORS = {
  due_fixed: `Her işin süresi açıldığı andan itibaren ${TASK_DURATION_HOURS} saattir; süre dolunca mazeret gösterilerek uzatılabilir.`,
  not_overdue: 'Bu işin süresi henüz dolmadı; süre dolunca mazeret gösterilerek uzatılabilir.',
  required_fields: 'Tür, ekran, teknisyen, servis günü ve açıklama zorunludur.',
  bad_imei: 'IMEI geçersiz: 15 haneli olmalı. Rakamlardan biri yanlış yazılmış olabilir; cihaz etiketiyle karşılaştırın.',
  imei_taken: 'Bu IMEI başka bir ekranda kayıtlı.',
  task_fields_fixed: 'Tür, ekran, teknisyen ve servis günü iş açıldıktan sonra değiştirilemez.',
  reason_required: 'Süreyi uzatmak için mazeret yazmalısınız.',
  due_invalid: 'Yeni son tarih hem şimdiden hem de mevcut son tarihten sonra olmalı.',
  bad_image: 'Yalnızca JPEG, PNG veya WEBP fotoğraf yüklenebilir.',
  too_large: 'Fotoğraf çok büyük (en fazla 5 MB).',
  task_closed: 'Kapanmış işin fotoğrafları silinemez.',
  invalid_credentials: 'Kullanıcı adı veya şifre hatalı.',
  too_many_attempts: 'Çok fazla hatalı giriş denemesi yapıldı. 15 dakika sonra tekrar deneyin.',
  wrong_password: 'Mevcut şifre hatalı.',
  password_too_short: `Yeni şifre en az ${MIN_PASSWORD_LENGTH} karakter olmalı.`,
  password_weak: 'Yeni şifre en az bir harf ve bir rakam içermeli.',
  password_personal: 'Şifre adınızı, soyadınızı veya kullanıcı adınızı içeremez.',
  password_common: 'Bu şifre çok yaygın ve kolay tahmin edilir; başka bir şifre seçin.',
  password_same: 'Yeni şifre eskisiyle aynı olamaz.',
  self_reset: 'Kendi şifrenizi buradan sıfırlayamazsınız; "Şifre Değiştir"i kullanın.',
  csrf: 'Oturum doğrulanamadı; sayfayı yenileyip tekrar deneyin.',
  exists: 'Bu kayıt zaten var.',
  bad_value: 'Geçersiz bir değer girildi.',
  bad_assignee: 'Seçilen teknisyen bulunamadı; sayfayı yenileyip tekrar deneyin.',
  closed_task_delete: 'Kapanmış iş yalnızca sistem yöneticisi tarafından silinebilir (fotoğrafları kanıttır).',
  forbidden_firma: 'Bu işlem firma çalışanlarına kapalı.',
  too_many_photos: 'Bir işe en fazla 20 fotoğraf yüklenebilir.',
  disk_full: 'Sunucu diski dolmak üzere; yeni fotoğraf yüklenemiyor. Sistem yöneticisine haber verin.',
  telegram_not_configured: 'Telegram ayarları eksik: WSGI dosyasına TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID yazılıp Reload edilmeli.',
  telegram_no_token: 'Önce WSGI dosyasına TELEGRAM_BOT_TOKEN yazılıp Reload edilmeli.',
  too_long: 'Girilen metin çok uzun.',
  server_error: 'Sunucu hatası oluştu; lütfen tekrar deneyin.',
  username_taken: 'Bu kullanıcı adı zaten kullanılıyor.',
  bad_username: 'Kullanıcı adı 3-40 karakter olmalı; yalnızca küçük harf, rakam, nokta, tire ve alt çizgi içerebilir.',
  name_required: 'Ad ve soyad gerekli.',
  bad_org_type: 'Kurum veya firma çalışanı seçin.',
  last_admin: 'Ana sistem yöneticisi hesabı pasif yapılamaz ve yöneticiliği alınamaz.',
  self_admin: 'Kendi yetkinizi veya hesabınızın durumunu değiştiremezsiniz.',
  main_admin_reset: 'Ana sistem yöneticisinin şifresi buradan sıfırlanamaz; kurulumdaki ADMIN_PASSWORD ile değiştirilir.',
  forbidden: 'Bu işlem yalnızca sistem yöneticisine açık.',
  decode: 'Fotoğraf açılamadı; JPEG veya PNG kullanın.',
};
function apiErrorText(e, fallback) { return API_ERRORS[e && e.message] || fallback || 'İşlem başarısız'; }
function parseJsonOrNull(text) { try { return JSON.parse(text); } catch (e) { return null; } }

/* ======================= State & DB ======================= */
let db = null;
let dbAvailable = false;
let currentUser = null;
// people: every user's name, for assigning jobs (all users can read it); users: full records, administrator only.
const state = { screens: [], people: [], materials: [], tasks: [], users: [] };

// The server stamps authors from the session as well; this is only for the text the page composes.
function getViewerName() { return currentUser?.fullName || 'Bilinmeyen Kullanıcı'; }
// Contractor staff (firma çalışanı, not the administrator) work on jobs but do not see these pages;
// the server also refuses their changes to screens and the materials catalogue.
const COMPANY_HIDDEN_ROUTES = ['screens', 'screenDetail', 'materials', 'reports'];
function isCompanyUser() { return !!currentUser && !currentUser.isAdmin && currentUser.orgType === 'firma'; }

// Every write carries the session's CSRF token (X-CSRF-Token). A stale token is renewed once and the request retried.
let csrfToken = null;
async function ensureCsrf(renew) {
  if (csrfToken && !renew) return csrfToken;
  const res = await fetch('/api/auth/csrf', { cache: 'no-store' });
  if (!res.ok) throw new Error('csrf');
  csrfToken = (await res.json()).csrfToken;
  return csrfToken;
}
async function csrfFetch(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return fetch(url, opts);
  for (let attempt = 0; ; attempt++) {
    const headers = { ...(opts.headers || {}), 'X-CSRF-Token': await ensureCsrf(attempt > 0) };
    const res = await fetch(url, { ...opts, headers });
    if (attempt === 0 && res.status === 403 && (await res.clone().text()) === 'csrf') continue;
    return res;
  }
}

// A lost session (expired, password reset, deactivated) sends the page back to the login screen.
async function apiFetch(url, opts) {
  const res = await csrfFetch(url, opts);
  if (res.status === 401 || (res.status === 403 && (await res.clone().text()) === 'password_change_required')) {
    location.reload();
    throw new Error('unauthorized');
  }
  return res;
}

function screenById(id) { return state.screens.find(s => s.id === id); }
// Jobs are assigned to users (the technicians and the system administrator).
function personById(id) { return id ? state.people.find(p => p.id === id) : null; }
function personName(id) { return personById(id)?.fullName || ''; }
function comparePeople(a, b) { return a.fullName.localeCompare(b.fullName, 'tr'); }
// Choices for a job's technician: active users, plus the current one even if deactivated since.
// Job fields are required: an empty value shows as an unselectable "Seçin…" (older jobs may still lack one).
function placeholderOptionHtml(selected) { return selected ? '' : '<option value="" selected disabled>Seçin…</option>'; }
function requiredOptionsHtml(labelMap, selected) { return placeholderOptionHtml(selected) + optionsHtml(labelMap, selected); }
function screenOptionsHtml(sortedScreens, selectedId) {
  return placeholderOptionHtml(selectedId) + sortedScreens.map(s => `<option value="${esc(s.id)}" ${selectedId === s.id ? 'selected' : ''}>${esc(screenLabel(s))}</option>`).join('');
}
function assigneeOptionsHtml(selectedId) {
  const people = state.people.filter(p => p.active || p.id === selectedId).sort(comparePeople);
  return placeholderOptionHtml(selectedId) + people.map(p =>
    `<option value="${esc(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.fullName)}${p.isAdmin ? ' (yönetici)' : ''}${p.active ? '' : ' (pasif)'}</option>`).join('');
}
// Filters list everyone, so jobs of deactivated users can still be found.
function peopleFilterOptionsHtml(selectedId) {
  return [...state.people].sort(comparePeople).map(p =>
    `<option value="${esc(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.fullName)}${p.active ? '' : ' (pasif)'}</option>`).join('');
}
function materialById(id) { return state.materials.find(m => m.id === id); }
function toObj(d) { return { id: d.id, ...d.data() }; }
// Stop code as written on the stops: number and direction, e.g. #48A.
function screenCode(s) { return s && s.durakNo ? '#' + s.durakNo + (s.yon || '') : ''; }
// Most names are stored in capitals; lists show them in Turkish title case. Short abbreviations stay as written.
const KEEP_UPPER_WORDS = new Set(['PTT', 'SGK', 'AKL', 'TOKİ']);
function titleCaseTr(text) {
  return String(text || '').replace(/\p{L}+/gu, w => {
    if (KEEP_UPPER_WORDS.has(w) || (w === w.toLocaleUpperCase('tr') && !/[aeıioöuüAEIİOÖUÜ]/.test(w))) return w;
    return w.charAt(0).toLocaleUpperCase('tr') + w.slice(1).toLocaleLowerCase('tr');
  });
}
// "#48A - Çınaraltı", used wherever a screen is picked or listed.
function screenLabel(s) {
  if (!s) return 'Bilinmeyen ekran';
  return [screenCode(s), titleCaseTr(s.durakAdi || s.adres) || 'İsimsiz'].filter(Boolean).join(' - ');
}
// By stop number, then direction, then name.
function compareScreens(a, b) {
  const na = parseInt(a.durakNo, 10), nb = parseInt(b.durakNo, 10);
  if (isNaN(na) !== isNaN(nb)) return isNaN(na) ? 1 : -1;
  if (!isNaN(na) && na !== nb) return na - nb;
  return String(a.durakNo || '').localeCompare(String(b.durakNo || ''), 'tr', { numeric: true })
    || (a.yon || '').localeCompare(b.yon || '', 'tr') || screenLabel(a).localeCompare(screenLabel(b), 'tr');
}
function distinctBolgeler() { return [...new Set(state.screens.map(s => s.bolgeKod).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr')); }
function mapUrl(s) { return s && s.enlem != null && s.boylam != null ? `https://www.google.com/maps?q=${s.enlem},${s.boylam}` : null; }

// Server adapter (app.py). Keeps the collection/doc/onSnapshot shape the pages were written against.
// Each collection is re-read every POLL_MS while the tab is visible; the ETag makes an unchanged one an empty 304.
function createApiDb() {
  const listeners = {};
  const etags = {};
  async function refresh(col) {
    try {
      const res = await apiFetch('/api/' + col, { cache: 'no-store', headers: etags[col] ? { 'If-None-Match': etags[col] } : {} });
      if (res.status === 304) return;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rows = await res.json();
      etags[col] = res.headers.get('ETag');
      const snap = { docs: rows.map(({ id, ...rest }) => ({ id, data: () => rest })) };
      (listeners[col] || []).forEach(l => l.next(snap));
    } catch (e) {
      delete etags[col];
      (listeners[col] || []).forEach(l => l.error && l.error(e));
    }
  }
  const refreshAll = () => Object.keys(listeners).forEach(refresh);
  setInterval(() => { if (!document.hidden) refreshAll(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
  async function send(method, path, body) {
    const res = await apiFetch('/api/' + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error((await res.text()) || 'HTTP ' + res.status);
    const result = await res.json().catch(() => ({}));
    const col = path.split('/')[0];
    await refresh(col);
    if (col === 'users') await refresh('people'); // names in the technician lists
    return result;
  }
  return {
    refresh,
    post: (path, data) => send('POST', path, data),
    collection(col) {
      return {
        onSnapshot(next, error) {
          (listeners[col] = listeners[col] || []).push({ next, error });
          refresh(col);
        },
      };
    },
    doc(path) {
      return {
        set: data => send('PUT', path, data),
        update: data => send('PATCH', path, data),
        delete: () => send('DELETE', path),
      };
    },
  };
}

function subscribeCollections() {
  const onErr = () => { if (dbAvailable) { dbAvailable = false; render(); } };
  const sub = (col) => db.collection(col).onSnapshot(snap => {
    state[col] = snap.docs.map(toObj);
    dbAvailable = true;
    render();
  }, onErr);
  ['screens', 'people', 'materials', 'tasks'].forEach(sub);
  if (currentUser?.isAdmin) sub('users');
}

/* ======================= Router ======================= */
function currentRoute() {
  const h = (location.hash || '#panel').slice(1);
  if (h.startsWith('task-')) return { name: 'taskDetail', id: h.slice(5) };
  if (h.startsWith('screen-')) return { name: 'screenDetail', id: h.slice(7) };
  // #map shows every screen; #map-<screen id> opens the map on that screen.
  if (h === 'map' || h.startsWith('map-')) return { name: 'map', id: h.startsWith('map-') ? h.slice(4) : null };
  if (['panel', 'tasks', 'screens', 'materials', 'reports', 'users'].includes(h)) return { name: h };
  return { name: 'panel' };
}
const PARENT_NAV = { taskDetail: 'tasks', screenDetail: 'screens' };

function render() {
  const active = document.activeElement;
  let focusInfo = null;
  const appEl = document.getElementById('app');
  if (active && active.id && appEl.contains(active)) {
    // Keep what the user is typing: a redraw would otherwise reset the field to the stored value.
    const typing = active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && ['text', 'search', 'number'].includes(active.type));
    focusInfo = { id: active.id, start: active.selectionStart, end: active.selectionEnd, value: typing ? active.value : undefined };
  }

  const route = currentRoute();
  document.querySelectorAll('.nav-link').forEach(a => {
    const r = a.dataset.route;
    a.classList.toggle('active', r === route.name || r === PARENT_NAV[route.name]);
  });
  document.getElementById('pageTitle').textContent = ROUTE_TITLES[route.name] || '';
  const topbarActions = document.getElementById('topbarActions');
  topbarActions.innerHTML = '';
  if (route.name !== 'map') mainMapHash = null;
  if (isCompanyUser() && COMPANY_HIDDEN_ROUTES.includes(route.name)) {
    appEl.innerHTML = emptyStateHtml('Bu sayfa firma çalışanlarına kapalı. Soldaki menüden devam edin.');
    closeSidebar();
    return;
  }

  switch (route.name) {
    case 'tasks': renderTasksPage(appEl, topbarActions); break;
    case 'taskDetail': renderTaskDetailPage(appEl, topbarActions, route.id); break;
    case 'screens': renderScreensPage(appEl, topbarActions); break;
    case 'screenDetail': renderScreenDetailPage(appEl, topbarActions, route.id); break;
    case 'map': renderMapPage(appEl, topbarActions, route.id); break;
    case 'materials': renderMaterialsPage(appEl, topbarActions); break;
    case 'reports': renderReportsPage(appEl, topbarActions); break;
    case 'users': renderUsersPage(appEl, topbarActions); break;
    default: renderPanelPage(appEl, topbarActions); break;
  }

  closeSidebar();

  if (focusInfo) {
    const el = document.getElementById(focusInfo.id);
    if (el) {
      if (focusInfo.value !== undefined) el.value = focusInfo.value;
      el.focus();
      if (typeof focusInfo.start === 'number' && el.setSelectionRange) {
        try { el.setSelectionRange(focusInfo.start, focusInfo.end); } catch (e) {}
      }
    }
  }
}
function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  const overlay = document.getElementById('drawerOverlay');
  if (overlay) overlay.hidden = true;
}

/* ======================= Generic UI: modal / toast / confirm ======================= */
function openModal(title, bodyHtml, footHtml, opts = {}) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal ${opts.large ? 'modal-lg' : ''}">
        <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close" data-action="closeModal" aria-label="Kapat"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
        <div class="modal-body">${bodyHtml}</div>
        ${footHtml ? `<div class="modal-foot">${footHtml}</div>` : ''}
      </div>
    </div>`;
  const backdrop = root.querySelector('.modal-backdrop');
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeModal(); });
  const firstInput = root.querySelector('input,select,textarea');
  if (firstInput) setTimeout(() => firstInput.focus(), 30);
}
function closeModal() {
  document.getElementById('modalRoot').innerHTML = '';
}

function showToast(msg, type, ms = 2600) {
  const root = document.getElementById('toastRoot');
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' toast-crit' : '');
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, ms);
}

let pendingConfirm = null;
function confirmModal(message, onYes, confirmLabel = 'Evet, Sil', confirmClass = 'btn-danger') {
  openModal('Onay Gerekiyor', `<p>${esc(message)}</p>`, `
    <button class="btn btn-secondary" data-action="closeModal">Vazgeç</button>
    <button class="btn ${confirmClass}" data-action="confirmYes">${esc(confirmLabel)}</button>
  `);
  pendingConfirm = onYes;
}

/* ======================= Pills / badges ======================= */
function typePill(type) {
  const cls = { ekran_ariza: 'pill-type-ekran', yazilim_ariza: 'pill-type-yazilim', altyapi: 'pill-type-altyapi' }[type] || 'pill-neutral';
  return `<span class="pill ${cls}">${esc(TASK_TYPES[type] || type)}</span>`;
}
function statusPill(status) { return `<span class="pill pill-status-${esc(status)}">${esc(STATUS_LABELS[status] || status)}</span>`; }
function screenStatusPill(s) {
  const map = { aktif: 'pill-good', arizali: 'pill-crit', bakimda: 'pill-warn', pasif: 'pill-neutral' };
  return `<span class="pill ${map[s] || 'pill-neutral'}">${esc(SCREEN_STATUS_LABELS[s] || s)}</span>`;
}

/* ======================= Chart helpers ======================= */
function barRow(label, value, max, color, href) {
  const pct = max > 0 ? Math.max(Math.round((value / max) * 100), value > 0 ? 2 : 0) : 0;
  return `<div class="bar-row">
    ${href ? `<a class="bar-label" href="${esc(href)}" title="${esc(label)}">${esc(label)}</a>` : `<div class="bar-label" title="${esc(label)}">${esc(label)}</div>`}
    <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}" title="${esc(label)}: ${value}"></div></div>
    <div class="bar-value">${value}</div>
  </div>`;
}
const TYPE_COLORS = { ekran_ariza: 'var(--cat-ariza)', yazilim_ariza: 'var(--cat-icerik)', altyapi: 'var(--cat-genel)' };
function typeBarItems(counts) {
  return Object.entries(TASK_TYPES).map(([key, label]) => ({ label, value: counts[key] || 0, color: TYPE_COLORS[key] }));
}
function barChart(items) {
  const max = Math.max(...items.map(i => i.value), 1);
  return `<div class="bars-chart">${items.map(i => barRow(i.label, i.value, max, i.color)).join('')}</div>`;
}
function buildWeeklyBuckets(tasks, n) {
  const now = new Date();
  const buckets = [];
  for (let i = n - 1; i >= 0; i--) {
    const end = new Date(now.getTime() - i * 7 * 86400000);
    const start = new Date(end.getTime() - 6 * 86400000);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    const count = tasks.filter(t => { const d = new Date(t.createdAt); return d >= start && d <= end; }).length;
    buckets.push({ label: (start.getMonth() + 1) + '/' + start.getDate(), count });
  }
  return buckets;
}
function trendChartSvg(weeks) {
  const w = 680, h = 160, pad = 26;
  const max = Math.max(...weeks.map(x => x.count), 1);
  const stepX = (w - pad * 2) / Math.max(weeks.length - 1, 1);
  const points = weeks.map((wk, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (wk.count / max) * (h - pad * 2);
    return { x, y, ...wk };
  });
  const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
  const areaPath = linePath + ` L${points[points.length - 1].x.toFixed(1)},${h - pad} L${points[0].x.toFixed(1)},${h - pad} Z`;
  const gridYs = [0, 0.5, 1].map(f => h - pad - f * (h - pad * 2));
  return `<svg class="trend-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Haftalık iş trendi">
    ${gridYs.map(y => `<line class="gridline" x1="${pad}" y1="${y.toFixed(1)}" x2="${w - pad}" y2="${y.toFixed(1)}"/>`).join('')}
    <path d="${areaPath}" fill="var(--accent)" opacity="0.14" stroke="none"/>
    <path d="${linePath}" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    ${points.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.6" fill="var(--accent)"><title>${esc(p.label)}: ${p.count} iş</title></circle>`).join('')}
    ${points.filter((_, i) => i % 2 === 0 || i === points.length - 1).map(p => `<text class="axis-label" x="${p.x.toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(p.label)}</text>`).join('')}
  </svg>`;
}

/* ======================= Panel (Dashboard) ======================= */
function renderPanelPage(app, topbarActions) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const openTasks = state.tasks.filter(t => t.status !== 'kapandi');
  const dueSoon = state.tasks.filter(t => dueState(t)?.kind === 'soon');
  const overdue = state.tasks.filter(isOverdue);
  const resolvedThisWeek = state.tasks.filter(t => t.resolvedAt && new Date(t.resolvedAt) >= weekAgo);
  const arizaliScreens = state.screens.filter(s => s.status === 'arizali');

  const typeCounts = Object.fromEntries(Object.keys(TASK_TYPES).map(k => [k, 0]));
  state.tasks.forEach(t => { if (typeCounts[t.type] !== undefined) typeCounts[t.type]++; });
  const statusCounts = Object.fromEntries(TASK_STATUSES.map(k => [k, 0]));
  state.tasks.forEach(t => { if (statusCounts[t.status] !== undefined) statusCounts[t.status]++; });

  const faultCounts = {};
  state.tasks.filter(t => isFault(t) && t.screenId).forEach(t => { faultCounts[t.screenId] = (faultCounts[t.screenId] || 0) + 1; });
  const topStops = Object.entries(faultCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([screenId, count]) => ({ id: screenId, name: screenLabel(screenById(screenId)), count }));

  const recentActivity = [];
  state.tasks.forEach(t => (t.history || []).forEach(h => recentActivity.push({ ...h, taskId: t.id, taskTitle: [taskNo(t), taskHeadline(t)].filter(Boolean).join(' ') })));
  recentActivity.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const recent = recentActivity.slice(0, 8);
  const maxFault = Math.max(...topStops.map(x => x.count), 1);

  const content = `
    <div class="stat-grid">
      <div class="stat-tile"><div class="stat-label">İşlemdeki İşler</div><div class="stat-value">${openTasks.length}</div><div class="stat-sub">kapatılmamış tüm işler</div></div>
      <a class="stat-tile stat-link ${dueSoon.length ? 'accent-warn' : ''}" href="#tasks" data-action="showDueSoon"><div class="stat-label">24 Saatte Dolacak</div><div class="stat-value">${dueSoon.length}</div><div class="stat-sub">süresi yaklaşan iş</div></a>
      <a class="stat-tile stat-link ${overdue.length ? 'accent-crit' : ''}" href="#tasks" data-action="showOverdue"><div class="stat-label">Süresi Geçen</div><div class="stat-value">${overdue.length}</div><div class="stat-sub">son tarihi aşılmış iş</div></a>
      <div class="stat-tile accent-good"><div class="stat-label">Bu Hafta Kapanan</div><div class="stat-value">${resolvedThisWeek.length}</div><div class="stat-sub">son 7 gün</div></div>
      <div class="stat-tile ${arizaliScreens.length ? 'accent-crit' : ''}"><div class="stat-label">Arızalı Ekran</div><div class="stat-value">${arizaliScreens.length}</div><div class="stat-sub">toplam ${state.screens.length} ekrandan</div></div>
    </div>
    <div class="panel-grid">
      <div>
        <div class="section-card">
          <h3>İş Türü Dağılımı</h3>
          ${state.tasks.length ? barChart(typeBarItems(typeCounts)) : emptyStateHtml('Henüz iş kaydı yok.')}
        </div>
        <div class="section-card">
          <h3>Durum Dağılımı</h3>
          ${state.tasks.length ? barChart([
            { label: STATUS_LABELS.islemde, value: statusCounts.islemde, color: 'var(--status-3)' },
            { label: STATUS_LABELS.kapandi, value: statusCounts.kapandi, color: 'var(--status-5)' },
          ]) : emptyStateHtml('Henüz iş kaydı yok.')}
        </div>
      </div>
      <div>
        <div class="section-card">
          <h3>En Çok Arızalanan Ekranlar</h3>
          ${topStops.length ? `<div class="bars-chart">${topStops.map(s => barRow(s.name, s.count, maxFault, 'var(--crit)', isCompanyUser() ? null : '#screen-' + s.id)).join('')}</div>` : emptyStateHtml('Henüz arıza kaydı yok.')}
        </div>
        <div class="section-card">
          <h3>Son Aktiviteler</h3>
          ${recent.length ? `<div class="timeline">${recent.map(r => `
            <div class="timeline-item">
              <div class="timeline-dot"></div>
              <div class="timeline-body">
                <div class="timeline-meta">${esc(r.author || 'Bilinmeyen')} · ${fmtDateTime(r.ts)} · <a href="#task-${r.taskId}">${esc(r.taskTitle)}</a></div>
                <div class="timeline-note">${esc(r.note || (r.status ? 'Durum: ' + statusLabel(r.status) : ''))}</div>
              </div>
            </div>`).join('')}</div>` : emptyStateHtml('Henüz aktivite yok.')}
        </div>
      </div>
    </div>`;
  app.innerHTML = (dbAvailable ? '' : bannerNoDb()) + content;
}

/* ======================= Tasks list / kanban ======================= */
const EMPTY_TASK_FILTERS = { type: '', status: '', bolge: '', technicianId: '', due: '', q: '' };
let taskFilters = { ...EMPTY_TASK_FILTERS };
let taskViewMode = 'list';

function filteredTasks() {
  return state.tasks.filter(t => {
    if (!matchesTypeFilter(t, taskFilters.type)) return false;
    if (taskFilters.status && t.status !== taskFilters.status) return false;
    if (taskFilters.bolge && screenById(t.screenId)?.bolgeKod !== taskFilters.bolge) return false;
    if (taskFilters.technicianId && t.assignedTechnicianId !== taskFilters.technicianId) return false;
    if (taskFilters.due && dueState(t)?.kind !== taskFilters.due) return false;
    if (taskFilters.q) {
      const q = taskFilters.q.trim().toLocaleLowerCase('tr');
      const scr = screenById(t.screenId);
      const hay = [taskNo(t), t.no, TASK_TYPES[t.type], t.title, t.description, scr?.durakAdi, scr?.adres, scr?.durakNo].filter(Boolean).join(' ').toLocaleLowerCase('tr');
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function renderTasksPage(app, topbarActions) {
  topbarActions.innerHTML = `<button class="btn btn-primary" data-action="newTask"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Yeni İş</button>`;
  const list = filteredTasks();
  const content = `
    <div class="filter-bar">
      <input type="search" id="taskSearchInput" class="search-input" placeholder="Ara: iş no, açıklama, durak…" data-filter="q" value="${esc(taskFilters.q)}">
      <select data-filter="type"><option value="">Tüm Türler</option>${optionsHtml(TYPE_FILTERS, taskFilters.type)}</select>
      <select data-filter="status"><option value="">Tüm Durumlar</option>${optionsHtml(STATUS_LABELS, taskFilters.status)}</select>
      <select data-filter="bolge"><option value="">Tüm Şeflikler</option>${distinctBolgeler().map(b => `<option value="${esc(b)}" ${taskFilters.bolge === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
      <select data-filter="technicianId"><option value="">Tüm Teknisyenler</option>${peopleFilterOptionsHtml(taskFilters.technicianId)}</select>
      <select data-filter="due"><option value="">Tüm Süreler</option>${optionsHtml({ overdue: 'Süresi geçenler', soon: '24 saat içinde dolacaklar' }, taskFilters.due)}</select>
      <button class="btn btn-ghost btn-sm" data-action="clearTaskFilters">Filtreleri Temizle</button>
      <div class="view-toggle" style="margin-left:auto;">
        <button class="${taskViewMode === 'list' ? 'active' : ''}" data-action="setTaskView" data-view="list" type="button">Liste</button>
        <button class="${taskViewMode === 'kanban' ? 'active' : ''}" data-action="setTaskView" data-view="kanban" type="button">Kanban</button>
      </div>
    </div>
    ${list.length === 0 ? emptyStateHtml('Kriterlere uyan iş bulunamadı.') : (taskViewMode === 'list' ? tasksTableHtml(list) : tasksKanbanHtml(list))}
  `;
  app.innerHTML = (dbAvailable ? '' : bannerNoDb()) + content;
}

function tasksTableHtml(list) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>No</th><th>Tür</th><th>Ekran</th><th>Açıklama</th><th>Durum</th><th>Son Tarih</th><th>Teknisyen</th><th>Oluşturma</th></tr></thead>
    <tbody>
      ${list.map(t => `
        <tr class="clickable" data-action="openTask" data-id="${t.id}">
          <td class="mono nowrap">${esc(taskNo(t) || '—')}</td>
          <td>${typePill(t.type)}</td>
          <td>${esc(screenLabel(screenById(t.screenId)))}</td>
          <td class="wrap-text">${esc(taskSummary(t) || '—')}</td>
          <td>${statusPill(t.status)}</td>
          <td class="nowrap">${duePill(t)}</td>
          <td>${esc(personName(t.assignedTechnicianId) || 'Atanmadı')}</td>
          <td class="mono">${fmtDate(t.createdAt)}</td>
        </tr>`).join('')}
    </tbody>
  </table></div>`;
}
function tasksKanbanHtml(list) {
  return `<div class="kanban">
    ${TASK_STATUSES.map(st => {
      const items = list.filter(t => t.status === st);
      return `<div class="kanban-col" data-status="${st}">
        <div class="kanban-col-head"><h4>${STATUS_LABELS[st]}</h4><span class="kanban-count">${items.length}</span></div>
        <div class="kanban-cards">
          ${items.map(t => `
            <div class="kanban-card" draggable="true" data-id="${t.id}" data-action="openTask">
              <div class="kanban-card-title">${taskNoHtml(t)}${esc(screenLabel(screenById(t.screenId)))}</div>
              <div class="kanban-card-meta">${typePill(t.type)} ${dueState(t) ? duePill(t) : ''}</div>
              ${taskSummary(t) ? `<div class="kanban-card-meta">${esc(taskSummary(t, 70))}</div>` : ''}
            </div>`).join('')}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}
// The status picked on a job's page; it is saved only with the Kaydet button next to it (kept across redraws).
let pendingStatus = null;
function pendingStatusFor(task) {
  return pendingStatus && pendingStatus.taskId === task.id && pendingStatus.status !== task.status ? pendingStatus.status : null;
}
async function updateTaskStatus(id, newStatus) {
  const task = state.tasks.find(t => t.id === id);
  if (!task || !db) return;
  if (task.status === newStatus) return;
  await applyTaskStatus(task, newStatus);
}
async function applyTaskStatus(task, newStatus) {
  const id = task.id;
  const author = getViewerName();
  const closing = isClosedStatus(newStatus);
  const entry = { ts: new Date().toISOString(), status: newStatus, note: closing ? 'İş kapatıldı' : 'İş yeniden işleme alındı', author };
  const patch = { status: newStatus, updatedAt: new Date().toISOString(), history: [...(task.history || []), entry] };
  if (closing && !task.resolvedAt) patch.resolvedAt = new Date().toISOString();
  if (!closing) patch.resolvedAt = null;
  try {
    await db.doc('tasks/' + id).update(patch);
    if (pendingStatus?.taskId === id) pendingStatus = null;
    showToast(closing ? 'İş kapatıldı' : 'İş yeniden işleme alındı');
  }
  catch (e) { showToast(apiErrorText(e, 'Güncelleme başarısız'), 'error'); render(); }
}

/* ======================= Task detail ======================= */
// Type, screen, technician and service day are fixed once the job is opened (the server enforces this too).
// Only an older job that lacks one of them gets a picker here, to fill it in once.
const FIXED_TASK_FIELDS = ['type', 'screenId', 'assignedTechnicianId', 'serviceDayType'];
function fixedTaskFieldHtml(task, field, label, valueHtml, optionsFn) {
  return `<div class="detail-item">
        <div class="di-label">${label}</div>
        ${task[field]
          ? `<div class="di-value">${valueHtml}</div>`
          : `<select data-task-field="${field}" data-task-id="${esc(task.id)}">${optionsFn()}</select>`}
      </div>`;
}
function renderTaskDetailPage(app, topbarActions, id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) { app.innerHTML = (dbAvailable ? '' : bannerNoDb()) + emptyStateHtml('İş bulunamadı. Silinmiş olabilir.'); return; }
  topbarActions.innerHTML = `
    <button class="btn btn-secondary btn-sm" data-action="editTask" data-id="${task.id}">Düzenle</button>
    ${!isClosedStatus(task.status) || currentUser?.isAdmin ? `<button class="btn btn-danger btn-sm" data-action="deleteTask" data-id="${task.id}">Sil</button>` : ''}
  `;
  const usedMaterials = task.usedMaterials || [];
  const history = [...(task.history || [])].sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const sortedScreens = [...state.screens].sort(compareScreens);
  const due = dueState(task);
  const extensions = task.extensions || [];
  const pickedStatus = pendingStatusFor(task);

  const content = `
    <div class="breadcrumb"><a href="#tasks">İşler</a> / ${esc([taskNo(task), taskHeadline(task)].filter(Boolean).join(' '))}</div>
    ${due?.kind === 'overdue' ? `<div class="banner banner-crit">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
      <span>Bu işin süresi doldu: son tarih ${esc(fmtDateTime(task.dueDate))} (${esc(due.text)}). Uzatmak için mazeret gerekir.</span>
      <button class="btn btn-danger btn-sm" data-action="extendDue" data-task-id="${task.id}">Süreyi Uzat</button>
    </div>` : ''}
    <div class="detail-header">
      <div class="detail-title">
        <h2>${taskNoHtml(task)}${esc(taskHeadline(task))}</h2>
        <div class="tag-row">${typePill(task.type)}${statusPill(task.status)}</div>
      </div>
      <div class="field status-field">
        <label for="taskStatusSelect">Durum</label>
        <div class="status-save">
          <select id="taskStatusSelect" data-status-pick data-task-id="${task.id}">${optionsHtml(STATUS_LABELS, pickedStatus || task.status)}</select>
          <button class="btn btn-primary btn-sm" data-action="saveTaskStatus" data-task-id="${task.id}" ${pickedStatus ? '' : 'disabled'}>Kaydet</button>
        </div>
      </div>
    </div>

    <div class="detail-grid">
      ${fixedTaskFieldHtml(task, 'type', 'Tür', esc(TASK_TYPES[task.type] || task.type), () => requiredOptionsHtml(TASK_TYPES, ''))}
      ${fixedTaskFieldHtml(task, 'screenId', 'Ekran', screenById(task.screenId) && !isCompanyUser()
        ? `<a class="link" href="#screen-${esc(task.screenId)}">${esc(screenLabel(screenById(task.screenId)))}</a>` : esc(screenLabel(screenById(task.screenId))),
        () => screenOptionsHtml(sortedScreens, ''))}
      ${fixedTaskFieldHtml(task, 'assignedTechnicianId', 'Teknisyen', esc(personName(task.assignedTechnicianId) || 'Bilinmeyen kişi'), () => assigneeOptionsHtml(''))}
      ${fixedTaskFieldHtml(task, 'serviceDayType', 'Servis Günü', esc(SERVICE_DAYS[task.serviceDayType] || task.serviceDayType), () => requiredOptionsHtml(SERVICE_DAYS, ''))}
      <div class="detail-item">
        <div class="di-label">Son Tarih</div>
        <div class="di-value">${task.dueDate ? `<span class="mono">${esc(fmtDateTime(task.dueDate))}</span>${due ? ' ' + duePill(task) : ''}` : '—'}</div>
      </div>
      <div class="detail-item">
        <div class="di-label">Oluşturma</div>
        <div class="di-value mono">${esc(fmtDateTime(task.createdAt))}</div>
      </div>
      <div class="detail-item">
        <div class="di-label">Kapanış</div>
        <div class="di-value mono">${task.resolvedAt ? esc(fmtDateTime(task.resolvedAt)) : '—'}</div>
      </div>
    </div>

    ${screenInfoSectionHtml(task)}

    <div class="section-card">
      <h3>Açıklama</h3>
      <p style="white-space:pre-wrap;color:var(--text-secondary);margin:0;">${task.description ? esc(task.description) : 'Açıklama eklenmedi.'}</p>
    </div>

    <div class="section-card">
      <h3>Ekran Fotoğrafları</h3>
      ${photoPanelHtml(task)}
    </div>

    ${extensions.length ? `<div class="section-card">
      <h3>Süre Uzatmaları</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Tarih</th><th>Eski son tarih</th><th>Yeni son tarih</th><th>Mazeret</th><th>Uzatan</th></tr></thead>
        <tbody>${extensions.slice().reverse().map(x => `<tr>
          <td class="mono nowrap">${esc(fmtDateTime(x.ts))}</td>
          <td class="mono nowrap">${esc(fmtDateTime(x.oldDue))}</td>
          <td class="mono nowrap">${esc(fmtDateTime(x.newDue))}</td>
          <td class="wrap-text">${esc(x.reason || '')}</td>
          <td>${esc(x.author || 'Bilinmeyen')}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>` : ''}

    <div class="section-card">
      <div class="checklist-actions">
        <h3 style="margin:0;">Kullanılan Malzemeler</h3>
        <button class="btn btn-secondary btn-sm" data-action="addMaterialsToTask" data-task-id="${task.id}">+ Malzeme Ekle</button>
      </div>
      ${usedMaterials.length ? usedMaterials.map(um => {
        const mat = materialById(um.materialId);
        return `<div class="used-material-chip" style="margin-bottom:6px;">
          <span>${esc(mat?.name || 'Bilinmeyen malzeme')} — <strong>${um.qty} ${esc(mat?.unit || '')}</strong></span>
          <button class="btn btn-ghost btn-sm" data-action="removeUsedMaterial" data-task-id="${task.id}" data-material-id="${um.materialId}">Kaldır</button>
        </div>`;
      }).join('') : emptyStateHtml('Henüz malzeme eklenmedi.')}
    </div>

    <div class="section-card">
      <h3>Aktivite ve Notlar</h3>
      <form data-form="historyForm" data-task-id="${task.id}" style="display:flex;gap:8px;margin-bottom:16px;align-items:flex-start;">
        <input type="text" id="historyNoteInput" name="note" placeholder="Not ekleyin…" required style="flex:1;">
        <button class="btn btn-secondary" type="submit">Ekle</button>
      </form>
      ${history.length ? `<div class="timeline">${history.map(h => `
        <div class="timeline-item">
          <div class="timeline-dot"></div>
          <div class="timeline-body">
            <div class="timeline-meta">${esc(h.author || 'Bilinmeyen')} · ${fmtDateTime(h.ts)}</div>
            <div class="timeline-note">${esc(h.note || '')}</div>
          </div>
        </div>`).join('')}</div>` : emptyStateHtml('Henüz not eklenmedi.')}
    </div>`;
  app.innerHTML = (dbAvailable ? '' : bannerNoDb()) + content;
}

// The linked screen's record on the job page, with links to its history and its place on the map.
function screenInfoSectionHtml(task) {
  const s = screenById(task.screenId);
  if (!s) {
    const msg = task.screenId ? 'Bağlı ekran bulunamadı; silinmiş olabilir.' : 'Bu işe bağlı ekran yok. Yukarıdaki "Ekran" alanından bir kez seçebilirsiniz.';
    return `<div class="section-card"><h3>Ekran Bilgileri</h3><p class="muted-text">${msg}</p></div>`;
  }
  return screenInfoCardHtml(s, `
    ${isCompanyUser() ? '' : `<a class="btn btn-secondary btn-sm" href="#screen-${esc(s.id)}">Ekranın geçmişi</a>`}
    ${hasLocation(s) ? `<a class="btn btn-ghost btn-sm" href="#map-${esc(s.id)}">Haritada göster</a>` : ''}`, isCompanyUser());
}

// A screen's record (Excel fields + later additions), edited in place; each field saves when you leave it.
// readOnly: shown to contractor staff, who may not change screen records.
function screenInfoCardHtml(s, headLinks = '', readOnly = false) {
  const attrs = field => `id="scrf-${field}" data-screen-field="${field}" data-screen-id="${s.id}"${readOnly ? ' disabled' : ''}`;
  const text = (field, label, cls = '', extra = '') =>
    `<div class="field ${cls}"><label for="scrf-${field}">${label}</label><input type="text" ${attrs(field)} value="${esc(s[field] ?? '')}" ${extra}></div>`;
  const date = (field, label) =>
    `<div class="field"><label for="scrf-${field}">${label}</label><input type="date" ${attrs(field)} value="${esc((s[field] || '').slice(0, 10))}"></div>`;
  const map = mapUrl(s);
  const select = (field, label, options) =>
    `<div class="field"><label for="scrf-${field}">${label}</label><select ${attrs(field)}>${options}</select></div>`;
  const opts = (values, current, labelOf = v => v) =>
    '<option value="">—</option>' + values.map(v => `<option value="${esc(v)}" ${current === v ? 'selected' : ''}>${esc(labelOf(v))}</option>`).join('');
  return `<div class="section-card">
    <div class="section-head">
      <h3>Ekran Bilgileri</h3>
      ${headLinks ? `<div class="head-links">${headLinks}</div>` : ''}
    </div>
    <p class="hint" style="margin:-8px 0 12px;">${readOnly ? 'Ekran bilgilerini yalnızca kurum çalışanları değiştirebilir.' : 'Alandan çıkınca ekranın kaydına işlenir; Ekranlar sayfasında da güncellenir.'}</p>
    <div class="screen-info-grid">
      ${text('durakAdi', 'Durak Adı', 'span-2', 'required')}
      ${text('adres', 'Adres', 'span-2')}
      ${text('durakNo', 'Durak No')}
      ${select('yon', 'Yön', opts(['A', 'D'], s.yon))}
      ${text('durakId', 'Durak ID')}
      ${text('bolgeKod', 'Şeflik', '', 'list="scrfBolgeList"')}
      ${select('elektrikKaynagi', 'Elektrik Kaynağı', opts(ELEKTRIK_KAYNAGI_OPTIONS, s.elektrikKaynagi))}
      ${select('ekranTipi', 'Ekran Tipi', opts(EKRAN_TIPI_OPTIONS, s.ekranTipi, v => 'Tip ' + v))}
      ${select('status', 'Ekran Durumu', optionsHtml(SCREEN_STATUS_LABELS, s.status || 'aktif'))}
      ${date('kontrolTarihi', 'Kontrol Tarihi')}
      ${text('enerjiBilgisi', 'MEDAŞ BAKS / Enerji Alış Noktası', 'span-2')}
      ${text('simNo', 'SIM No', 'span-2')}
      ${text('ozelNot', 'Özel Not', 'span-2')}
      ${text('enlem', 'Enlem', '', 'inputmode="decimal"')}
      ${text('boylam', 'Boylam', '', 'inputmode="decimal"')}
      ${text('imei', 'IMEI', 'span-2', IMEI_INPUT_ATTRS)}
      ${text('model', 'Ekran Modeli')}
      ${text('serialNo', 'Seri No')}
    </div>
    ${map ? `<a class="btn btn-ghost btn-sm" href="${esc(map)}" target="_blank" rel="noopener">Google Maps'te aç</a>` : ''}
    <datalist id="scrfBolgeList">${distinctBolgeler().map(b => `<option value="${esc(b)}">`).join('')}</datalist>
  </div>`;
}

async function handleTaskFieldChange(taskId, field, value) {
  if (!db) return;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  if (!FIXED_TASK_FIELDS.includes(field) || task[field]) return;
  if (!value) { showToast(API_ERRORS.required_fields, 'error'); render(); return; }
  const patch = { updatedAt: new Date().toISOString(), [field]: value };
  try { await db.doc('tasks/' + taskId).update(patch); showToast('Kaydedildi'); }
  catch (e) { showToast(apiErrorText(e, 'Kaydedilemedi'), 'error'); render(); }
}
async function addHistoryNoteHandler(form) {
  const taskId = form.dataset.taskId;
  const note = (form.note.value || '').trim();
  if (!note || !db) return;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  const entry = { ts: new Date().toISOString(), note, author: getViewerName() };
  try {
    await db.doc('tasks/' + taskId).update({ history: [...(task.history || []), entry], updatedAt: new Date().toISOString() });
    form.reset();
    showToast('Not eklendi');
  } catch (e) { showToast('Not eklenemedi', 'error'); }
}
async function removeUsedMaterialFromTask(taskId, materialId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || !db) return;
  const updated = (task.usedMaterials || []).filter(um => um.materialId !== materialId);
  try { await db.doc('tasks/' + taskId).update({ usedMaterials: updated, updatedAt: new Date().toISOString() }); showToast('Malzeme kaldırıldı'); }
  catch (e) { showToast('İşlem başarısız', 'error'); }
}

function openAddMaterialsModal(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  const usedMap = {}; (task.usedMaterials || []).forEach(um => { usedMap[um.materialId] = um.qty; });
  const sorted = [...state.materials].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  const rows = sorted.map(m => {
    const checked = usedMap[m.id] !== undefined;
    const qty = usedMap[m.id] ?? 1;
    const step = m.unit === 'Adet' ? '1' : '0.1';
    return `<div class="material-row">
      <input type="checkbox" id="matchk-${m.id}" data-mat-check="${m.id}" ${checked ? 'checked' : ''}>
      <label for="matchk-${m.id}" class="m-name" style="margin:0;font-weight:400;cursor:pointer;">${esc(m.name)}</label>
      <span class="m-unit">${esc(m.unit)}</span>
      <input type="number" min="0" step="${step}" data-mat-qty="${m.id}" value="${qty}" ${checked ? '' : 'disabled'}>
    </div>`;
  }).join('');
  openModal('Kullanılan Malzemeleri Seç', `
    <div class="hint" style="margin-bottom:10px;">Kullanılan malzeme ve işlemleri işaretleyin, miktarını girin.</div>
    <div class="material-list" id="materialChecklist">${rows || emptyStateHtml('Kataloğa henüz malzeme eklenmedi.')}</div>
  `, `
    <button class="btn btn-secondary" data-action="closeModal">Vazgeç</button>
    <button class="btn btn-primary" data-action="saveMaterialsSelection" data-task-id="${taskId}">Kaydet</button>
  `, { large: true });
  document.getElementById('materialChecklist')?.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-mat-check]');
    if (cb) {
      const qtyInput = document.querySelector(`[data-mat-qty="${cb.dataset.matCheck}"]`);
      if (qtyInput) qtyInput.disabled = !cb.checked;
    }
  });
}
async function saveMaterialsSelectionHandler(taskId) {
  if (!taskId || !db) return;
  const checks = document.querySelectorAll('[data-mat-check]');
  const usedMaterials = [];
  checks.forEach(cb => {
    if (cb.checked) {
      const qtyInput = document.querySelector(`[data-mat-qty="${cb.dataset.matCheck}"]`);
      const qty = parseFloat(qtyInput?.value) || 0;
      if (qty > 0) usedMaterials.push({ materialId: cb.dataset.matCheck, qty });
    }
  });
  try {
    await db.doc('tasks/' + taskId).update({ usedMaterials, updatedAt: new Date().toISOString() });
    closeModal();
    showToast('Malzemeler kaydedildi');
  } catch (e) { showToast('Kaydedilemedi', 'error'); }
}

/* ======================= Task photos (önce / sonra) ======================= */
function photoColumnHtml(task, kind, editable) {
  const photos = (task.photos || []).filter(p => p.kind === kind);
  const label = kind === 'once' ? 'Önce' : 'Sonra';
  return `<div class="photo-col">
    <h4>${label} <span class="photo-count">${photos.length}</span></h4>
    <div class="photo-grid">
      ${photos.map(p => `<figure class="photo-thumb">
        <a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.url)}" alt="${label} fotoğrafı" loading="lazy"></a>
        <figcaption title="${esc((p.author || 'Bilinmeyen') + ' · ' + fmtDateTime(p.ts))}">${esc(p.author || 'Bilinmeyen')} · ${esc(fmtDate(p.ts))}</figcaption>
        ${editable ? `<button type="button" class="photo-del" data-action="deletePhoto" data-photo-id="${p.id}" aria-label="Fotoğrafı sil">×</button>` : ''}
      </figure>`).join('')}
      ${editable ? `<label class="photo-add">
        <svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>
        Fotoğraf ekle
        <input type="file" class="sr-only" accept="image/jpeg,image/png,image/webp" multiple data-photo-input data-kind="${kind}" data-task-id="${task.id}">
      </label>` : ''}
      ${!editable && !photos.length ? '<div class="photo-empty">Fotoğraf yok</div>' : ''}
    </div>
  </div>`;
}
function photoPanelHtml(task) {
  const editable = !isClosedStatus(task.status);
  return `<div class="photo-cols">${photoColumnHtml(task, 'once', editable)}${photoColumnHtml(task, 'sonra', editable)}</div>`;
}

// Phone photos run 5-10 MB; re-encode to a ≤1280px JPEG (~150-300 KB) before upload, the server disk is small.
function compressImage(file, maxSide = 1280, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('decode'))), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}
async function uploadPhotos(taskId, kind, files) {
  showToast(files.length > 1 ? `${files.length} fotoğraf yükleniyor…` : 'Fotoğraf yükleniyor…');
  let uploaded = 0;
  for (const file of files) {
    try {
      const blob = await compressImage(file);
      const res = await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/photos?kind=${kind}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      if (!res.ok) throw new Error(await res.text());
      uploaded++;
    } catch (e) {
      showToast(`${file.name}: ${apiErrorText(e, 'yüklenemedi')}`, 'error');
    }
  }
  if (uploaded) { await db.refresh('tasks'); showToast(`${uploaded} fotoğraf yüklendi`); }
}
async function removePhoto(photoId) {
  try {
    const res = await apiFetch('/api/photos/' + encodeURIComponent(photoId), { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    await db.refresh('tasks');
    showToast('Fotoğraf silindi');
  } catch (e) { showToast(apiErrorText(e, 'Silinemedi'), 'error'); }
}

/* ======================= Deadline extension ======================= */
function openExtendModal(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  const due = dueState(task);
  const earliest = new Date(Date.now() + 5 * 60000).toISOString();
  openModal('Süreyi Uzat', `
    <form id="extendFormInner" data-form="extendForm" data-task-id="${task.id}">
      <p class="modal-lead">Mevcut son tarih <strong>${esc(fmtDateTime(task.dueDate))}</strong>${due ? ` (${esc(due.text)})` : ''}. Uzatma, mazeretiyle birlikte işin geçmişine kaydedilir.</p>
      <div class="field"><label for="extendNewDue">Yeni son tarih</label><input type="datetime-local" id="extendNewDue" name="newDue" required min="${toLocalInput(earliest)}"></div>
      <div class="field"><label for="extendReason">Mazeret</label><textarea id="extendReason" name="reason" rows="3" required minlength="3" placeholder="Süre neden aşıldı? Örn. malzeme tedariki gecikti"></textarea></div>
      ${(task.extensions || []).length ? `<div class="hint">Bu iş daha önce ${task.extensions.length} kez uzatıldı.</div>` : ''}
    </form>
  `, `
    <button class="btn btn-secondary" data-action="closeModal">Vazgeç</button>
    <button class="btn btn-primary" type="submit" form="extendFormInner">Süreyi Uzat</button>
  `);
}
async function saveExtendForm(form) {
  const task = state.tasks.find(t => t.id === form.dataset.taskId);
  if (!task) return;
  const fd = new FormData(form);
  const newDue = fromLocalInput(fd.get('newDue'));
  const reason = (fd.get('reason') || '').toString().trim();
  if (!newDue || new Date(newDue) <= new Date()) { showToast(API_ERRORS.due_invalid, 'error'); return; }
  if (reason.length < 3) { showToast(API_ERRORS.reason_required, 'error'); return; }
  const note = `Süre uzatıldı: ${fmtDateTime(task.dueDate)} → ${fmtDateTime(newDue)}. Mazeret: ${reason}`;
  try {
    await db.post('tasks/' + task.id + '/extend', { newDue, reason, note });
    closeModal();
    showToast('Süre uzatıldı');
  } catch (e) { showToast(apiErrorText(e, 'Süre uzatılamadı'), 'error'); }
}

/* ======================= Task form modal ======================= */
// preset: starting values for a new job, e.g. { screenId, type } when opened from a screen's page or the map.
// Every field is required. The deadline is not entered: the server gives each job TASK_DURATION_HOURS from opening.
function openTaskFormModal(taskId, preset = {}) {
  const task = taskId ? state.tasks.find(t => t.id === taskId) : null;
  const isEdit = !!task;
  const sortedScreens = [...state.screens].sort(compareScreens);
  const screenId = task ? task.screenId : preset.screenId;
  const lock = field => (task && task[field] ? 'disabled' : 'required');
  openModal(isEdit ? 'İşi Düzenle' : 'Yeni İş Oluştur', `
    <form id="taskFormInner" data-form="taskForm" data-task-id="${task?.id || ''}">
      <div class="field"><label for="taskFormType">Tür</label><select id="taskFormType" name="type" ${lock('type')}>${requiredOptionsHtml(TASK_TYPES, task ? task.type : (preset.type || 'ekran_ariza'))}</select></div>
      <div class="field"><label for="taskFormScreen">Ekran</label><select id="taskFormScreen" name="screenId" ${lock('screenId')}>${screenOptionsHtml(sortedScreens, screenId)}</select></div>
      <div class="field-row">
        <div class="field"><label for="taskFormTech">Teknisyen</label><select id="taskFormTech" name="assignedTechnicianId" ${lock('assignedTechnicianId')}>${assigneeOptionsHtml(task?.assignedTechnicianId)}</select></div>
        <div class="field"><label for="taskFormDay">Servis Günü</label><select id="taskFormDay" name="serviceDayType" ${lock('serviceDayType')}>${requiredOptionsHtml(SERVICE_DAYS, task?.serviceDayType)}</select></div>
      </div>
      <div class="field"><label for="taskFormDesc">Açıklama</label><textarea id="taskFormDesc" name="description" rows="4" required placeholder="Ne yapılacak? Örn. ekran yanmıyor, güç kaynağı kontrol edilecek">${esc(task?.description || '')}</textarea></div>
      <div class="hint">${isEdit
        ? `Tür, ekran, teknisyen ve servis günü iş açıldıktan sonra değiştirilemez; burada yalnızca açıklama düzenlenir. Son tarih: <strong>${esc(fmtDateTime(task.dueDate))}</strong>; süre dolunca iş sayfasından mazeret gösterilerek uzatılabilir.`
        : `Tüm alanlar zorunludur. <strong>Tür, ekran, teknisyen ve servis günü iş açıldıktan sonra değiştirilemez.</strong> İş "İşlemde" olarak açılır ve süresi ${TASK_DURATION_HOURS} saattir; son tarih kendiliğinden verilir.`}</div>
    </form>
  `, `
    <button class="btn btn-secondary" data-action="closeModal">Vazgeç</button>
    <button class="btn btn-primary" type="submit" form="taskFormInner">${isEdit ? 'Kaydet' : 'Oluştur'}</button>
  `);
}
async function saveTaskForm(form) {
  if (!db) { showToast('Veritabanı kullanılamıyor', 'error'); return; }
  const taskId = form.dataset.taskId;
  const fields = {};
  for (const key of [...FIXED_TASK_FIELDS, 'description']) {
    const el = form.elements[key];
    if (!el.disabled) fields[key] = (el.value || '').trim(); // disabled: fixed once the job was opened
  }
  if (Object.values(fields).some(v => !v)) { showToast(API_ERRORS.required_fields, 'error'); return; }
  const now = new Date().toISOString();
  if (taskId) {
    try { await db.doc('tasks/' + taskId).update({ ...fields, updatedAt: now }); closeModal(); showToast('İş güncellendi'); }
    catch (e) { showToast(apiErrorText(e, 'Güncellenemedi'), 'error'); }
  } else {
    const id = uid('t');
    // The server sets the status (İşlemde), the job number and the deadline.
    const doc = {
      ...fields, status: 'islemde',
      usedMaterials: [],
      history: [{ ts: now, status: 'islemde', note: 'İş oluşturuldu', author: getViewerName() }],
      createdAt: now, updatedAt: now, resolvedAt: null,
    };
    try {
      await db.doc('tasks/' + id).set(doc);
      closeModal();
      const no = taskNo(state.tasks.find(t => t.id === id));
      showToast(no ? `İş ${no} oluşturuldu` : 'İş oluşturuldu');
      location.hash = '#task-' + id;
    }
    catch (e) { showToast(apiErrorText(e, 'Oluşturulamadı'), 'error'); }
  }
}
async function deleteTask(id) {
  if (!db) return;
  try {
    await db.doc('tasks/' + id).delete();
    showToast('İş silindi');
    if (currentRoute().name === 'taskDetail') location.hash = '#tasks';
  } catch (e) { showToast(apiErrorText(e, 'Silinemedi'), 'error'); }
}

/* ======================= Screens (ekran + durak birleşik kaydı) ======================= */
let screenFilters = { q: '', bolge: '', status: '', elektrikKaynagi: '', ekranTipi: '' };
const ELEKTRIK_KAYNAGI_OPTIONS = ['MEDAŞ', 'KBB', 'GES'];
const EKRAN_TIPI_OPTIONS = ['A', 'B', 'C', 'D', 'E'];
function filteredScreens() {
  return state.screens.filter(s => {
    if (screenFilters.bolge && s.bolgeKod !== screenFilters.bolge) return false;
    if (screenFilters.status && s.status !== screenFilters.status) return false;
    if (screenFilters.elektrikKaynagi && s.elektrikKaynagi !== screenFilters.elektrikKaynagi) return false;
    if (screenFilters.ekranTipi && s.ekranTipi !== screenFilters.ekranTipi) return false;
    if (screenFilters.q) {
      const q = screenFilters.q.toLocaleLowerCase('tr');
      const hay = [s.durakAdi, s.adres, s.durakNo, s.durakId, s.simNo, s.imei, s.ozelNot, s.model, s.serialNo].filter(Boolean).join(' ').toLocaleLowerCase('tr');
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort(compareScreens);
}
function renderScreensPage(app, topbarActions) {
  topbarActions.innerHTML = `<button class="btn btn-primary" data-action="newScreen"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Yeni Ekran</button>`;
  const list = filteredScreens();
  const faultStats = new Map();
  state.tasks.forEach(t => {
    if (!isFault(t) || !t.screenId) return;
    const st = faultStats.get(t.screenId) || { total: 0, open: 0 };
    st.total++;
    if (!isClosedStatus(t.status)) st.open++;
    faultStats.set(t.screenId, st);
  });
  const faultCell = s => {
    const st = faultStats.get(s.id);
    if (!st) return '<span class="muted-inline">—</span>';
    return `<a class="link" href="#screen-${esc(s.id)}">${st.total}</a>${st.open ? ` <span class="pill pill-crit">${st.open} işlemde</span>` : ''}`;
  };
  const content = `
    <div class="filter-bar">
      <input type="search" id="screenSearchInput" class="search-input" placeholder="Ara: durak adı, adres, durak no, SIM…" data-screen-filter="q" value="${esc(screenFilters.q)}">
      <select data-screen-filter="bolge"><option value="">Tüm Şeflikler</option>${distinctBolgeler().map(b => `<option value="${esc(b)}" ${screenFilters.bolge === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
      <select data-screen-filter="status"><option value="">Tüm Durumlar</option>${optionsHtml(SCREEN_STATUS_LABELS, screenFilters.status)}</select>
      <select data-screen-filter="elektrikKaynagi"><option value="">Tüm Elektrik Kaynakları</option>${ELEKTRIK_KAYNAGI_OPTIONS.map(o => `<option value="${o}" ${screenFilters.elektrikKaynagi === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
      <select data-screen-filter="ekranTipi"><option value="">Tüm Ekran Tipleri</option>${EKRAN_TIPI_OPTIONS.map(o => `<option value="${o}" ${screenFilters.ekranTipi === o ? 'selected' : ''}>Tip ${o}</option>`).join('')}</select>
    </div>
    ${!list.length ? emptyStateHtml(state.screens.length ? 'Kriterlere uyan ekran bulunamadı.' : 'Henüz ekran eklenmedi.') : `<div class="table-wrap"><table>
      <thead><tr><th>Durak No</th><th>Durak Adı</th><th>Adres</th><th>Şeflik</th><th>Arıza</th><th>Elektrik Kaynağı</th><th>Ekran Tipi</th><th>MEDAŞ BAKS</th><th>SIM No</th><th>Kontrol Tarihi</th><th>Özel Not</th><th>Konum</th><th>Durum</th><th></th></tr></thead>
      <tbody>${list.map(s => `<tr>
        <td class="mono nowrap">${esc(s.durakNo || '—')}${s.yon ? ' · ' + esc(s.yon) : ''}</td>
        <td><a class="link-strong" href="#screen-${esc(s.id)}">${esc(s.durakAdi || '—')}</a>${s.durakId ? `<div class="hint mono">ID ${esc(s.durakId)}</div>` : ''}</td>
        <td class="wrap-text">${esc(s.adres || '—')}</td>
        <td>${s.bolgeKod ? `<span class="pill pill-neutral">${esc(s.bolgeKod)}</span>` : '—'}</td>
        <td class="nowrap">${faultCell(s)}</td>
        <td><select class="inline-select" data-screen-field="elektrikKaynagi" data-screen-id="${s.id}" aria-label="Elektrik kaynağı"><option value="">—</option>${ELEKTRIK_KAYNAGI_OPTIONS.map(o => `<option value="${o}" ${s.elektrikKaynagi === o ? 'selected' : ''}>${o}</option>`).join('')}</select></td>
        <td><select class="inline-select" data-screen-field="ekranTipi" data-screen-id="${s.id}" aria-label="Ekran tipi"><option value="">—</option>${EKRAN_TIPI_OPTIONS.map(o => `<option value="${o}" ${s.ekranTipi === o ? 'selected' : ''}>Tip ${o}</option>`).join('')}</select></td>
        <td class="mono">${esc(s.enerjiBilgisi || '—')}</td>
        <td class="mono">${esc(s.simNo || '—')}</td>
        <td class="mono nowrap">${s.kontrolTarihi ? esc(fmtDate(s.kontrolTarihi)) : '—'}</td>
        <td>${esc(s.ozelNot || '—')}</td>
        <td>${hasLocation(s) ? `<a class="link" href="#map-${esc(s.id)}">Haritada</a>` : '<span class="muted-inline">yok</span>'}</td>
        <td>${screenStatusPill(s.status)}</td>
        <td class="row-actions">
          <a class="btn btn-ghost btn-sm" href="#screen-${esc(s.id)}">Geçmiş</a>
          <button class="btn btn-ghost btn-sm" data-action="editScreen" data-id="${s.id}">Düzenle</button>
          <button class="btn btn-ghost btn-sm" data-action="deleteScreen" data-id="${s.id}">Sil</button>
        </td>
      </tr>`).join('')}</tbody>
    </table></div>`}
  `;
  app.innerHTML = (dbAvailable ? '' : bannerNoDb()) + content;
}
function openScreenFormModal(screenId) {
  const screen = screenId ? screenById(screenId) : null;
  openModal(screen ? 'Ekranı Düzenle' : 'Yeni Ekran', `
    <form id="screenFormInner" data-form="screenForm" data-screen-id="${screen?.id || ''}">
      <div class="field-row">
        <div class="field"><label>Durak No</label><input name="durakNo" value="${esc(screen?.durakNo || '')}" placeholder="Örn. 1679"></div>
        <div class="field"><label>Yön</label><select name="yon"><option value="">—</option><option value="A" ${screen?.yon === 'A' ? 'selected' : ''}>A</option><option value="D" ${screen?.yon === 'D' ? 'selected' : ''}>D</option></select></div>
      </div>
      <div class="field"><label>Durak Adı</label><input name="durakAdi" required value="${esc(screen?.durakAdi || '')}" placeholder="Örn. ŞEBİ ARUS ( PTT )"></div>
      <div class="field"><label>Adres</label><input name="adres" value="${esc(screen?.adres || '')}" placeholder="Örn. NİŞANTAŞI MAH. VATAN CAD. NO: 2 SELÇUKLU"></div>
      <div class="field-row">
        <div class="field"><label>Durak ID</label><input name="durakId" value="${esc(screen?.durakId || '')}"></div>
        <div class="field"><label>Şeflik</label><input name="bolgeKod" value="${esc(screen?.bolgeKod || '')}" placeholder="Örn. KÖPRÜ" list="bolgeListDatalist"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Durum</label><select name="status">${optionsHtml(SCREEN_STATUS_LABELS, screen?.status || 'aktif')}</select></div>
        <div class="field"><label>Kontrol Tarihi</label><input type="date" name="kontrolTarihi" value="${esc((screen?.kontrolTarihi || '').slice(0, 10))}"></div>
      </div>
      <div class="field"><label>MEDAŞ BAKS / Enerji Alış Noktası</label><input name="enerjiBilgisi" value="${esc(screen?.enerjiBilgisi || '')}"></div>
      <div class="field-row">
        <div class="field"><label>SIM No</label><input name="simNo" value="${esc(screen?.simNo || '')}"></div>
        <div class="field"><label for="screenFormImei">IMEI</label><input id="screenFormImei" name="imei" value="${esc(screen?.imei || '')}" ${IMEI_INPUT_ATTRS}></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Enlem</label><input name="enlem" inputmode="decimal" value="${esc(screen?.enlem ?? '')}" placeholder="Örn. 37.876225"></div>
        <div class="field"><label>Boylam</label><input name="boylam" inputmode="decimal" value="${esc(screen?.boylam ?? '')}" placeholder="Örn. 32.48664"></div>
      </div>
      <div class="field"><label>Özel Not</label><input name="ozelNot" value="${esc(screen?.ozelNot || '')}"></div>
      <div class="field-row">
        <div class="field"><label>Elektrik Kaynağı</label><select name="elektrikKaynagi"><option value="">—</option>${ELEKTRIK_KAYNAGI_OPTIONS.map(o => `<option value="${o}" ${screen?.elektrikKaynagi === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>
        <div class="field"><label>Ekran Tipi</label><select name="ekranTipi"><option value="">—</option>${EKRAN_TIPI_OPTIONS.map(o => `<option value="${o}" ${screen?.ekranTipi === o ? 'selected' : ''}>Tip ${o}</option>`).join('')}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Ekran Modeli</label><input name="model" value="${esc(screen?.model || '')}" placeholder="Örn. P6 Tip Ekran"></div>
        <div class="field"><label>Seri No</label><input name="serialNo" value="${esc(screen?.serialNo || '')}"></div>
      </div>
      <div class="field"><label>Kurulum Tarihi</label><input type="date" name="installDate" value="${screen?.installDate ? screen.installDate.slice(0, 10) : ''}"></div>
      <datalist id="bolgeListDatalist">${distinctBolgeler().map(b => `<option value="${esc(b)}">`).join('')}</datalist>
    </form>
  `, `
    <button class="btn btn-secondary" data-action="closeModal">Vazgeç</button>
    <button class="btn btn-primary" type="submit" form="screenFormInner">${screen ? 'Kaydet' : 'Oluştur'}</button>
  `, { large: true });
}
async function saveScreenForm(form) {
  if (!db) return;
  const screenId = form.dataset.screenId;
  const fd = new FormData(form);
  const val = name => (fd.get(name) || '').toString().trim();
  const durakAdi = val('durakAdi');
  if (!durakAdi) { showToast('Durak adı gerekli', 'error'); return; }
  const data = {
    durakNo: val('durakNo'),
    yon: val('yon').toUpperCase(),
    durakAdi,
    adres: val('adres'),
    durakId: val('durakId'),
    bolgeKod: val('bolgeKod'),
    enerjiBilgisi: val('enerjiBilgisi'),
    simNo: val('simNo'),
    imei: val('imei'),
    enlem: val('enlem'),
    boylam: val('boylam'),
    kontrolTarihi: val('kontrolTarihi') || null,
    ozelNot: val('ozelNot'),
    elektrikKaynagi: (fd.get('elektrikKaynagi') || '').toString(),
    ekranTipi: (fd.get('ekranTipi') || '').toString(),
    model: (fd.get('model') || '').toString().trim(),
    serialNo: (fd.get('serialNo') || '').toString().trim(),
    installDate: fd.get('installDate') || null,
    status: fd.get('status'),
  };
  try {
    if (screenId) { await db.doc('screens/' + screenId).update({ ...data, updatedAt: new Date().toISOString() }); showToast('Ekran güncellendi'); }
    else { await db.doc('screens/' + uid('sc')).set({ ...data, createdAt: new Date().toISOString() }); showToast('Ekran eklendi'); }
    closeModal();
  } catch (e) { showToast(apiErrorText(e, 'Kaydedilemedi'), 'error'); }
}
async function updateScreenField(id, field, value) {
  if (!db) return;
  try { await db.doc('screens/' + id).update({ [field]: value, updatedAt: new Date().toISOString() }); showToast('Kaydedildi'); }
  catch (e) { showToast(apiErrorText(e, 'Kaydedilemedi'), 'error'); render(); }
}
async function deleteScreen(id) {
  if (!db) return;
  try { await db.doc('screens/' + id).delete(); showToast('Ekran silindi'); } catch (e) { showToast('Silinemedi', 'error'); }
}

/* ======================= Shared helpers: screens and their jobs ======================= */
function hasLocation(s) { return !!s && s.enlem != null && s.boylam != null; }
function fmtQty(q) { return Number((q || 0).toFixed(2)).toLocaleString('tr-TR'); }
function resolutionDays(t) { return t.resolvedAt ? (new Date(t.resolvedAt) - new Date(t.createdAt)) / 86400000 : null; }
function fmtDays(d) {
  if (d == null || isNaN(d)) return '—';
  if (d < 1) return Math.max(1, Math.round(d * 24)) + ' saat';
  return d.toLocaleString('tr-TR', { maximumFractionDigits: 1 }) + ' gün';
}
// "Adaptör ×1, Sigorta ×2 Adet" for a job's used materials / operations.
function materialsSummary(t) {
  return (t.usedMaterials || []).map(um => {
    const m = materialById(um.materialId);
    return `${m?.name || 'Bilinmeyen'} ×${fmtQty(um.qty)}${m?.unit && m.unit !== 'Adet' ? ' ' + m.unit : ''}`;
  }).join(', ');
}
function openTasksByScreen() {
  const byScreen = new Map();
  state.tasks.forEach(t => {
    if (!t.screenId || isClosedStatus(t.status)) return;
    if (!byScreen.has(t.screenId)) byScreen.set(t.screenId, []);
    byScreen.get(t.screenId).push(t);
  });
  return byScreen;
}
// Marker colour: red = open fault (or screen marked arızalı), amber = other open job or bakımda, grey = pasif.
const MARKER_KINDS = { crit: 'Arızası var', warn: 'İşi var / bakımda', ok: 'Sorunsuz', off: 'Pasif' };
function screenMarkerKind(s, openTasks) {
  if (s.status === 'arizali' || openTasks.some(isFault)) return 'crit';
  if (s.status === 'bakimda' || openTasks.length) return 'warn';
  if (s.status === 'pasif') return 'off';
  return 'ok';
}

/* ======================= Map (OpenStreetMap tiles, no outside library) ======================= */
// A small slippy map: 256 px Web-Mercator tiles as <img>, screens as marker buttons, one info popup.
// The page redraws #app often, so each map is created once and its element moved into every new render;
// the view (zoom, position) therefore survives redraws.
const MAP_TILE = 256;
const MAP_MIN_ZOOM = 5;
const MAP_MAX_ZOOM = 19;
const MAP_HOME = { lat: 37.8716, lon: 32.4846, zoom: 12 }; // Konya
function mapTileUrl(z, x, y) { return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`; }
function mapProject(lat, lon, z) {
  const size = MAP_TILE * 2 ** z;
  const sin = Math.sin(lat * Math.PI / 180);
  return { x: (lon + 180) / 360 * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
}

function createMap({ small = false, scrollZoom = true, popupHtml = null } = {}) {
  const el = document.createElement('div');
  el.className = 'map' + (small ? ' map-small' : '');
  el.innerHTML = `
    <div class="map-tiles"></div>
    <div class="map-markers"></div>
    <div class="map-popup" hidden></div>
    <div class="map-controls">
      <button type="button" class="map-btn" data-map="in" aria-label="Yakınlaştır" title="Yakınlaştır">+</button>
      <button type="button" class="map-btn" data-map="out" aria-label="Uzaklaştır" title="Uzaklaştır">−</button>
      <button type="button" class="map-btn" data-map="fit" aria-label="Tümünü göster" title="Tümünü göster"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
    </div>
    <div class="map-note" hidden>Harita altlığı yüklenemedi (internet bağlantısı?). İşaretler yine de gösteriliyor.</div>
    <div class="map-attrib">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> katkıda bulunanlar</div>`;
  const tilesEl = el.querySelector('.map-tiles');
  const markersEl = el.querySelector('.map-markers');
  const popupEl = el.querySelector('.map-popup');
  const noteEl = el.querySelector('.map-note');
  const tiles = new Map();
  const markerEls = new Map();
  let points = [];
  let zoom = MAP_HOME.zoom;
  let center = mapProject(MAP_HOME.lat, MAP_HOME.lon, zoom);
  let selected = null;
  let tilesLoaded = 0;
  let drag = null;
  let suppressClick = false;
  let fitPending = false;
  let wheelSum = 0;
  let wheelAt = 0;

  function draw() {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    const left = center.x - w / 2, top = center.y - h / 2, n = 2 ** zoom;
    const wanted = new Set();
    const y0 = Math.max(0, Math.floor(top / MAP_TILE)), y1 = Math.min(n - 1, Math.floor((top + h) / MAP_TILE));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = Math.floor(left / MAP_TILE); tx <= Math.floor((left + w) / MAP_TILE); tx++) {
        const key = `${zoom}/${tx}/${ty}`;
        wanted.add(key);
        let img = tiles.get(key);
        if (!img) {
          img = document.createElement('img');
          img.className = 'map-tile';
          img.alt = '';
          img.draggable = false;
          // OpenStreetMap asks browsers to identify the site that shows its tiles.
          img.referrerPolicy = 'strict-origin-when-cross-origin';
          img.onload = () => { img.classList.add('loaded'); tilesLoaded++; noteEl.hidden = true; };
          img.onerror = () => { noteEl.hidden = tilesLoaded > 0; };
          img.src = mapTileUrl(zoom, ((tx % n) + n) % n, ty);
          tiles.set(key, img);
          tilesEl.appendChild(img);
        }
        img.style.transform = `translate(${Math.round(tx * MAP_TILE - left)}px,${Math.round(ty * MAP_TILE - top)}px)`;
      }
    }
    for (const [key, img] of tiles) if (!wanted.has(key)) { img.remove(); tiles.delete(key); }
    for (const p of points) {
      const pt = mapProject(p.lat, p.lon, zoom);
      markerEls.get(p.id).style.transform = `translate(${Math.round(pt.x - left)}px,${Math.round(pt.y - top)}px)`;
    }
    placePopup(left, top, w);
  }

  function placePopup(left, top, w) {
    const p = selected && points.find(q => q.id === selected);
    if (!p || !popupHtml) { popupEl.hidden = true; return; }
    popupEl.hidden = false;
    const pt = mapProject(p.lat, p.lon, zoom);
    const x = pt.x - left, y = pt.y - top;
    const half = popupEl.offsetWidth / 2;
    const px = Math.min(Math.max(x, half + 8), w - half - 8);
    popupEl.classList.toggle('below', y < popupEl.offsetHeight + 28);
    popupEl.style.left = Math.round(px) + 'px';
    popupEl.style.top = Math.round(y) + 'px';
    popupEl.style.setProperty('--arrow', Math.round(x - px) + 'px');
  }

  function select(id) {
    selected = id;
    markerEls.forEach((m, key) => m.classList.toggle('selected', key === id));
    if (id && popupHtml) popupEl.innerHTML = popupHtml(id);
    draw();
  }

  function setView(lat, lon, z) {
    zoom = Math.min(MAP_MAX_ZOOM, Math.max(MAP_MIN_ZOOM, z));
    center = mapProject(lat, lon, zoom);
    fitPending = false;
    draw();
  }

  function fit(list = points) {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) { fitPending = true; return; }
    fitPending = false;
    if (!list.length) { setView(MAP_HOME.lat, MAP_HOME.lon, MAP_HOME.zoom); return; }
    let z = small ? 16 : 17;
    let box;
    for (; z >= MAP_MIN_ZOOM; z--) {
      const pts = list.map(p => mapProject(p.lat, p.lon, z));
      box = { x0: Math.min(...pts.map(q => q.x)), x1: Math.max(...pts.map(q => q.x)), y0: Math.min(...pts.map(q => q.y)), y1: Math.max(...pts.map(q => q.y)) };
      if (box.x1 - box.x0 <= w - 60 && box.y1 - box.y0 <= h - 60) break;
    }
    zoom = Math.max(z, MAP_MIN_ZOOM);
    center = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
    draw();
  }

  function zoomAt(dz, mx, my) {
    const w = el.clientWidth, h = el.clientHeight;
    const nz = Math.min(MAP_MAX_ZOOM, Math.max(MAP_MIN_ZOOM, zoom + dz));
    if (nz === zoom) return;
    if (mx === undefined) { mx = w / 2; my = h / 2; }
    const f = 2 ** (nz - zoom);
    const wx = center.x - w / 2 + mx, wy = center.y - h / 2 + my;
    center = { x: wx * f - mx + w / 2, y: wy * f - my + h / 2 };
    zoom = nz;
    draw();
  }

  function setPoints(list) {
    points = list;
    const keep = new Set(list.map(p => p.id));
    for (const [id, m] of markerEls) if (!keep.has(id)) { m.remove(); markerEls.delete(id); }
    for (const p of list) {
      let m = markerEls.get(p.id);
      if (!m) {
        m = document.createElement('button');
        m.type = 'button';
        m.dataset.id = p.id;
        markersEl.appendChild(m);
        markerEls.set(p.id, m);
      }
      m.className = `map-marker marker-${p.kind || 'ok'}${p.id === selected ? ' selected' : ''}`;
      m.title = p.title || '';
      m.setAttribute('aria-label', p.title || '');
    }
    if (selected && !keep.has(selected)) selected = null;
    if (selected && popupHtml) popupEl.innerHTML = popupHtml(selected);
    if (fitPending) fit(); else draw();
  }

  function focus(id, z = 17) {
    const p = points.find(q => q.id === id);
    if (!p) return;
    setView(p.lat, p.lon, z);
    select(popupHtml ? id : null);
  }

  // Drag to pan. Capture starts only after a few pixels, so a plain click still reaches the marker.
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('.map-controls, .map-popup, .map-attrib')) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, active: false };
  });
  el.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.active = true;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* dragging still works without capture */ }
      el.classList.add('dragging');
    }
    drag.x = e.clientX;
    drag.y = e.clientY;
    center = { x: center.x - dx, y: center.y - dy };
    draw();
  });
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.active) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      el.classList.remove('dragging');
    }
    drag = null;
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  // Wheel zooms one step at a time; trackpads send many small deltas, so they are summed first.
  el.addEventListener('wheel', e => {
    if (!scrollZoom) return;
    e.preventDefault();
    wheelSum += e.deltaY;
    const now = Date.now();
    if (Math.abs(wheelSum) < 40 || now - wheelAt < 180) return;
    const r = el.getBoundingClientRect();
    zoomAt(wheelSum < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
    wheelSum = 0;
    wheelAt = now;
  }, { passive: false });
  el.addEventListener('dblclick', e => {
    if (e.target.closest('.map-controls, .map-popup, .map-marker')) return;
    const r = el.getBoundingClientRect();
    zoomAt(1, e.clientX - r.left, e.clientY - r.top);
  });
  el.addEventListener('click', e => {
    if (suppressClick) return;
    const control = e.target.closest('[data-map]');
    if (control) {
      if (control.dataset.map === 'in') zoomAt(1);
      else if (control.dataset.map === 'out') zoomAt(-1);
      else fit();
      return;
    }
    if (e.target.closest('[data-map-close]')) { select(null); return; }
    const marker = e.target.closest('.map-marker');
    if (marker) { if (popupHtml) select(marker.dataset.id === selected ? null : marker.dataset.id); return; }
    if (!e.target.closest('.map-popup')) select(null);
  });
  new ResizeObserver(() => { if (fitPending) fit(); else draw(); }).observe(el);

  return { el, setPoints, fit, focus, setView, redraw: draw };
}

/* ======================= Map page ======================= */
let mapFilters = { q: '', bolge: '', kind: '' };
let mainMap = null;
let mainMapHash = null; // the #map… address last applied; a redraw at the same address keeps the user's view
let mainMapRefit = false;

function screenPopupHtml(id) {
  const s = screenById(id);
  if (!s) return '';
  const tasks = state.tasks.filter(t => t.screenId === id);
  const faults = tasks.filter(isFault);
  const open = tasks.filter(t => !isClosedStatus(t.status));
  const last = faults.map(t => t.createdAt).sort().pop();
  return `
    <button type="button" class="map-popup-close" data-map-close aria-label="Kapat">×</button>
    <div class="map-popup-title">${esc(s.durakAdi || s.adres || 'İsimsiz')}</div>
    <div class="map-popup-meta">${esc(screenCode(s) || '#—')} · ${esc(s.bolgeKod || 'şeflik yok')} · ${s.ekranTipi ? 'Tip ' + esc(s.ekranTipi) : 'tip yok'}</div>
    <div class="map-popup-stats">
      <span><strong>${open.length}</strong> iş işlemde</span>
      <span><strong>${faults.length}</strong> arıza</span>
      <span>son arıza: ${last ? esc(fmtDate(last)) : '—'}</span>
    </div>
    <div class="map-popup-actions">
      ${isCompanyUser() ? '' : `<a class="btn btn-primary btn-sm" href="#screen-${esc(id)}">Ekran geçmişi</a>`}
      <button type="button" class="btn btn-secondary btn-sm" data-action="newTaskForScreen" data-id="${esc(id)}">Yeni iş</button>
      <a class="btn btn-ghost btn-sm" href="${esc(mapUrl(s))}" target="_blank" rel="noopener">Google Maps</a>
    </div>`;
}

function renderMapPage(app, topbarActions, focusId) {
  const arrived = location.hash !== mainMapHash;
  // Coming from "Haritada göster": clear filters that could hide that screen.
  if (arrived && focusId) mapFilters = { q: '', bolge: '', kind: '' };
  const open = openTasksByScreen();
  const q = mapFilters.q.toLocaleLowerCase('tr');
  const matching = state.screens
    .filter(s => (!mapFilters.bolge || s.bolgeKod === mapFilters.bolge)
      && (!q || [s.durakAdi, s.adres, s.durakNo, s.durakId].filter(Boolean).join(' ').toLocaleLowerCase('tr').includes(q)))
    .map(s => ({ s, kind: screenMarkerKind(s, open.get(s.id) || []) }));
  const counts = { crit: 0, warn: 0, ok: 0, off: 0 };
  matching.forEach(x => { counts[x.kind]++; });
  const shown = matching.filter(x => !mapFilters.kind || x.kind === mapFilters.kind);
  const located = shown.filter(x => hasLocation(x.s));
  const missing = shown.filter(x => !hasLocation(x.s));
  app.innerHTML = (dbAvailable ? '' : bannerNoDb()) + `
    <div class="filter-bar">
      <input type="search" id="mapSearchInput" class="search-input" placeholder="Ara: durak adı, adres, durak no…" data-map-filter="q" value="${esc(mapFilters.q)}">
      <select data-map-filter="bolge"><option value="">Tüm Şeflikler</option>${distinctBolgeler().map(b => `<option value="${esc(b)}" ${mapFilters.bolge === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
    </div>
    <div class="map-legend">
      ${Object.entries(MARKER_KINDS).map(([k, label]) => `<button type="button" class="legend-chip ${mapFilters.kind === k ? 'active' : ''}" data-action="setMapKind" data-kind="${k}" title="Yalnızca bunları göster"><span class="legend-dot marker-${k}"></span>${label} <strong>${counts[k]}</strong></button>`).join('')}
      <span class="hint" style="margin:0;">İşarete tıklayın: ekranın bilgileri, işlemdeki işleri ve geçmişi.</span>
    </div>
    <div id="mapSlot"></div>
    ${missing.length ? `<p class="map-missing">Konumu girilmemiş ${missing.length} ekran haritada yok: ${missing.map(({ s }) => isCompanyUser() ? esc(screenLabel(s)) : `<a href="#screen-${esc(s.id)}">${esc(screenLabel(s))}</a>`).join(', ')}.${isCompanyUser() ? '' : ' Konum, ekranın sayfasındaki Enlem / Boylam alanlarından eklenir.'}</p>` : ''}`;
  if (!mainMap) mainMap = createMap({ popupHtml: screenPopupHtml });
  document.getElementById('mapSlot').appendChild(mainMap.el);
  mainMap.setPoints(located.map(({ s, kind }) => ({ id: s.id, lat: s.enlem, lon: s.boylam, kind, title: screenLabel(s) })));
  if (arrived) {
    mainMapHash = location.hash;
    if (focusId && located.some(x => x.s.id === focusId)) mainMap.focus(focusId, 17);
    else mainMap.fit();
  } else if (mainMapRefit) {
    mainMap.fit();
  }
  mainMapRefit = false;
}

/* ======================= Screen page: history of one screen ======================= */
let screenHistoryType = 'fault';
let detailMap = null;
let detailMapKey = null;

function renderScreenDetailPage(app, topbarActions, id) {
  const s = screenById(id);
  if (!s) { app.innerHTML = (dbAvailable ? '' : bannerNoDb()) + emptyStateHtml('Ekran bulunamadı. Silinmiş olabilir.'); return; }
  topbarActions.innerHTML = `
    <button class="btn btn-secondary" data-action="screenReport" data-id="${esc(s.id)}">Rapor Al</button>
    <button class="btn btn-primary" data-action="newTaskForScreen" data-id="${esc(s.id)}"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Yeni İş</button>`;
  const tasks = state.tasks.filter(t => t.screenId === s.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const faults = tasks.filter(isFault);
  const open = tasks.filter(t => !isClosedStatus(t.status));
  const openFaults = open.filter(isFault);
  const solved = faults.filter(t => t.resolvedAt);
  const avgDays = solved.length ? solved.reduce((sum, t) => sum + resolutionDays(t), 0) / solved.length : null;
  const list = tasks.filter(t => matchesTypeFilter(t, screenHistoryType));
  const mats = materialReport(list);
  const typeTabs = [['fault', 'Arızalar'], ['', 'Tümü'], ...Object.entries(TASK_TYPES)];
  const listName = screenHistoryType ? TYPE_FILTERS[screenHistoryType] : 'tüm işler';

  const content = `
    <div class="print-only print-head"><strong>Akıllı Durak Takip — Ekran Geçmişi</strong><span>${esc(screenLabel(s))}</span><span>Oluşturma: ${esc(fmtDateTime(new Date().toISOString()))}</span></div>
    <div class="breadcrumb"><a href="#screens">Ekranlar</a> / ${esc(s.durakAdi || 'İsimsiz')}</div>
    <div class="detail-header">
      <div class="detail-title">
        <h2>${esc(s.durakAdi || s.adres || 'İsimsiz')}</h2>
        <div class="tag-row">
          <span class="pill pill-neutral mono">${esc(screenCode(s) || '#—')}</span>
          ${s.bolgeKod ? `<span class="pill pill-neutral">${esc(s.bolgeKod)}</span>` : ''}
          ${s.ekranTipi ? `<span class="pill pill-neutral">Tip ${esc(s.ekranTipi)}</span>` : ''}
          ${s.elektrikKaynagi ? `<span class="pill pill-neutral">${esc(s.elektrikKaynagi)}</span>` : ''}
          ${screenStatusPill(s.status || 'aktif')}
        </div>
        ${s.adres ? `<p class="muted-text">${esc(s.adres)}</p>` : ''}
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat-tile ${faults.length ? 'accent-crit' : ''}"><div class="stat-label">Toplam Arıza</div><div class="stat-value">${faults.length}</div><div class="stat-sub">toplam ${tasks.length} iş</div></div>
      <div class="stat-tile ${openFaults.length ? 'accent-crit' : open.length ? 'accent-warn' : ''}"><div class="stat-label">İşlemdeki İş</div><div class="stat-value">${open.length}</div><div class="stat-sub">${openFaults.length} arıza işlemde</div></div>
      <div class="stat-tile"><div class="stat-label">Son Arıza</div><div class="stat-value" style="font-size:20px;">${faults.length ? esc(fmtDate(faults[0].createdAt)) : '—'}</div><div class="stat-sub">${faults.length ? esc(taskSummary(faults[0], 40) || TASK_TYPES[faults[0].type]) : 'kayıt yok'}</div></div>
      <div class="stat-tile"><div class="stat-label">Ort. Kapanış Süresi</div><div class="stat-value" style="font-size:20px;">${fmtDays(avgDays)}</div><div class="stat-sub">${solved.length} kapanan arıza</div></div>
      <div class="stat-tile"><div class="stat-label">Kullanılan Kalem</div><div class="stat-value">${mats.length}</div><div class="stat-sub">farklı malzeme / işlem</div></div>
    </div>

    <div class="section-card">
      <div class="section-head">
        <h3>Arıza ve İş Geçmişi</h3>
        <div class="view-toggle">${typeTabs.map(([v, label]) => `<button type="button" class="${screenHistoryType === v ? 'active' : ''}" data-action="setScreenHistoryType" data-type="${v}">${label}</button>`).join('')}</div>
      </div>
      ${list.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Tarih</th><th>İş</th><th>Tür</th><th>Durum</th><th>Teknisyen</th><th>Kullanılan Malzeme / İşlem</th><th>Kapanış</th><th>Süre</th></tr></thead>
        <tbody>${list.map(t => `<tr class="clickable" data-action="openTask" data-id="${t.id}">
          <td class="mono nowrap">${esc(fmtDate(t.createdAt))}</td>
          <td class="wrap-text">${taskNoHtml(t)}${esc(taskSummary(t, 60) || '—')}</td>
          <td>${typePill(t.type)}</td>
          <td>${statusPill(t.status)}</td>
          <td>${esc(personName(t.assignedTechnicianId) || '—')}</td>
          <td class="wrap-text">${esc(materialsSummary(t) || '—')}</td>
          <td class="mono nowrap">${t.resolvedAt ? esc(fmtDate(t.resolvedAt)) : '—'}</td>
          <td class="nowrap">${fmtDays(resolutionDays(t))}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : emptyStateHtml(screenHistoryType ? `Bu ekranda ${listName.toLocaleLowerCase('tr')} kaydı yok.` : 'Bu ekranda henüz iş kaydı yok.')}
    </div>

    <div class="panel-grid">
      <div class="section-card">
        <h3>Kullanılan Malzemeler / İşlemler</h3>
        <div class="section-sub">Yukarıdaki listede (${listName}) kullanılanlar</div>
        ${mats.length ? `<div class="table-wrap"><table class="compact-table">
          <thead><tr><th>Malzeme / İşlem</th><th>Birim</th><th class="num">Toplam</th><th class="num">İş</th></tr></thead>
          <tbody>${mats.map(m => `<tr><td>${esc(m.name)}</td><td>${esc(m.unit)}</td><td class="num">${fmtQty(m.qty)}</td><td class="num">${m.taskCount}</td></tr>`).join('')}</tbody>
        </table></div>` : emptyStateHtml('Malzeme kullanımı kaydedilmemiş.')}
      </div>
      <div class="section-card">
        <div class="section-head">
          <h3>Konum</h3>
          ${hasLocation(s) ? `<a class="btn btn-ghost btn-sm" href="#map-${esc(s.id)}">Büyük haritada aç</a>` : ''}
        </div>
        ${hasLocation(s) ? '<div id="detailMapSlot"></div>' : '<p class="muted-text">Bu ekranın konumu girilmemiş. Aşağıdaki Enlem / Boylam alanlarından ekleyebilirsiniz.</p>'}
      </div>
    </div>

    ${screenInfoCardHtml(s)}`;
  app.innerHTML = (dbAvailable ? '' : bannerNoDb()) + content;

  if (hasLocation(s)) {
    if (!detailMap) detailMap = createMap({ small: true, scrollZoom: false });
    document.getElementById('detailMapSlot').appendChild(detailMap.el);
    detailMap.setPoints([{ id: s.id, lat: s.enlem, lon: s.boylam, kind: screenMarkerKind(s, open), title: screenLabel(s) }]);
    const key = `${s.id}|${s.enlem}|${s.boylam}`;
    if (detailMapKey !== key) { detailMapKey = key; detailMap.setView(s.enlem, s.boylam, 16); }
  }
}

/* ======================= Materials catalog ======================= */
function renderMaterialsPage(app, topbarActions) {
  topbarActions.innerHTML = `<button class="btn btn-primary" data-action="newMaterial"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Yeni Malzeme</button>`;
  const mats = [...state.materials].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  let content;
  if (!mats.length) {
    content = emptyStateHtml('Katalog boş.');
  } else {
    content = `<div class="table-wrap"><table>
      <thead><tr><th>Malzeme / İşlem Adı</th><th>Birim</th><th class="num">Toplam Kullanım</th><th></th></tr></thead>
      <tbody>${mats.map(m => {
        const totalUsed = state.tasks.reduce((sum, t) => { const um = (t.usedMaterials || []).find(x => x.materialId === m.id); return sum + (um ? um.qty : 0); }, 0);
        return `<tr>
          <td>${esc(m.name)}</td>
          <td>${esc(m.unit)}</td>
          <td class="num mono">${totalUsed ? totalUsed + ' ' + esc(m.unit) : '—'}</td>
          <td class="row-actions">
            <button class="btn btn-ghost btn-sm" data-action="editMaterial" data-id="${m.id}">Düzenle</button>
            <button class="btn btn-ghost btn-sm" data-action="deleteMaterial" data-id="${m.id}">Sil</button>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  }
  app.innerHTML = (dbAvailable ? '' : bannerNoDb()) + content;
}
function openMaterialFormModal(matId) {
  const mat = matId ? materialById(matId) : null;
  openModal(mat ? 'Malzemeyi Düzenle' : 'Yeni Malzeme', `
    <form id="materialFormInner" data-form="materialForm" data-material-id="${mat?.id || ''}">
      <div class="field"><label>Malzeme / İşlem Adı</label><input name="name" required value="${esc(mat?.name || '')}"></div>
      <div class="field"><label>Birim</label><select name="unit">${optionsHtml({ Adet: 'Adet', Metre: 'Metre', Kilo: 'Kilo' }, mat?.unit || 'Adet')}</select></div>
    </form>
  `, `
    <button class="btn btn-secondary" data-action="closeModal">Vazgeç</button>
    <button class="btn btn-primary" type="submit" form="materialFormInner">${mat ? 'Kaydet' : 'Oluştur'}</button>
  `);
}
async function saveMaterialForm(form) {
  if (!db) return;
  const matId = form.dataset.materialId;
  const fd = new FormData(form);
  const name = (fd.get('name') || '').toString().trim();
  if (!name) { showToast('Ad gerekli', 'error'); return; }
  const data = { name, unit: fd.get('unit') };
  try {
    if (matId) { await db.doc('materials/' + matId).update(data); showToast('Malzeme güncellendi'); }
    else { await db.doc('materials/' + uid('m')).set({ ...data, createdAt: new Date().toISOString() }); showToast('Malzeme eklendi'); }
    closeModal();
  } catch (e) { showToast('Kaydedilemedi', 'error'); }
}
async function deleteMaterial(id) {
  if (!db) return;
  try { await db.doc('materials/' + id).delete(); showToast('Malzeme silindi'); } catch (e) { showToast('Silinemedi', 'error'); }
}

/* ======================= Users (admin) ======================= */
function orgPill(orgType) {
  return orgType ? `<span class="pill pill-${orgType === 'firma' ? 'firma' : 'kurum'}">${esc(ORG_TYPE_LABELS[orgType] || orgType)}</span>` : '—';
}
function userStatusPill(u) {
  if (!u.active) return '<span class="pill pill-neutral">Pasif</span>';
  if (u.mustChangePassword) return '<span class="pill pill-warn" title="Geçici şifre henüz değiştirilmedi">İlk giriş bekleniyor</span>';
  return '<span class="pill pill-good">Aktif</span>';
}
function renderUsersPage(app, topbarActions) {
  if (!currentUser?.isAdmin) { app.innerHTML = emptyStateHtml('Bu sayfayı yalnızca sistem yöneticisi görebilir.'); return; }
  topbarActions.innerHTML = `<button class="btn btn-primary" data-action="newUser"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Yeni Kullanıcı</button>`;
  const users = [...state.users].sort((a, b) => a.fullName.localeCompare(b.fullName, 'tr'));
  const openCountByPerson = new Map();
  state.tasks.forEach(t => {
    if (t.assignedTechnicianId && !isClosedStatus(t.status)) openCountByPerson.set(t.assignedTechnicianId, (openCountByPerson.get(t.assignedTechnicianId) || 0) + 1);
  });
  const content = `
    <p class="page-lead">Sistem yöneticisi olmayan kullanıcılar teknisyendir; işler bu listedeki kişilere atanır. Kullanıcı ekleme, düzenleme ve şifre sıfırlama yalnızca sistem yöneticilerine açıktır; bir kullanıcıyı yönetici yapmak için "Düzenle"de "Sistem yöneticisi"ni işaretleyin. Ana yöneticinin (kurulumda belirlenen) yetkisi ve şifresi buradan değiştirilemez. Teknisyenler sistemin geri kalanını tam yetkiyle kullanır. Yeni kullanıcıya rastgele bir geçici şifre verilir ve yalnızca bir kez gösterilir; kullanıcı ilk girişinde kendi şifresini belirler. Şifresini unutan kullanıcı için "Şifreyi Sıfırla" kullanın.</p>
    ${!users.length ? emptyStateHtml('Kullanıcı yok.') : `<div class="table-wrap"><table>
      <thead><tr><th>Ad Soyad</th><th>Kullanıcı Adı</th><th>Çalışan Türü</th><th>Yetki</th><th class="num">İşlemdeki İş</th><th>Durum</th><th>Son Giriş</th><th></th></tr></thead>
      <tbody>${users.map(u => `<tr>
        <td>${esc(u.fullName)}${u.id === currentUser.id ? ' <span class="muted-inline">(siz)</span>' : ''}</td>
        <td class="mono">${esc(u.username)}</td>
        <td>${orgPill(u.orgType)}</td>
        <td>${u.isMainAdmin ? 'Sistem yöneticisi (ana)' : u.isAdmin ? 'Sistem yöneticisi' : 'Teknisyen'}</td>
        <td class="num mono">${openCountByPerson.get(u.id) || 0}</td>
        <td>${userStatusPill(u)}</td>
        <td class="mono nowrap">${u.lastLoginAt ? esc(fmtDateTime(u.lastLoginAt)) : '—'}</td>
        <td class="row-actions">
          <button class="btn btn-ghost btn-sm" data-action="editUser" data-id="${u.id}">Düzenle</button>
          ${u.id === currentUser.id || u.isMainAdmin ? '' : `<button class="btn btn-ghost btn-sm" data-action="resetUserPassword" data-id="${u.id}">Şifreyi Sıfırla</button>`}
        </td>
      </tr>`).join('')}</tbody>
    </table></div>`}
    ${telegramCardHtml()}`;
  app.innerHTML = (dbAvailable ? '' : bannerNoDb()) + content;
  loadTelegramInfo();
}

/* ======================= Telegram notifications (administrator) ======================= */
// The bot token and group id live in the WSGI file (secrets stay out of the app); this card shows whether they are
// set, sends a test message, finds the group's chat id, and lists the latest notifications.
const TELEGRAM_EVENTS = { yeni: 'Yeni iş', cozuldu: 'Çözüldü', kapandi: 'Kapatıldı', yeniden_acildi: 'Yeniden işleme alındı', sure_24: '24 saat kaldı', sure_doldu: 'Süre doldu', uzatildi: 'Süre uzatıldı', silindi: 'Silindi' };
let telegramInfo = null;
let telegramInfoAt = 0;
function loadTelegramInfo(force) {
  if (!force && Date.now() - telegramInfoAt < 30000) return;
  telegramInfoAt = Date.now();
  apiFetch('/api/telegram/status', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(d => { if (d) { telegramInfo = d; if (currentRoute().name === 'users') render(); } })
    .catch(() => {});
}
function telegramCardHtml() {
  const info = telegramInfo;
  const flag = (ok, yes, no) => `<span class="pill ${ok ? 'pill-good' : 'pill-warn'}">${ok ? yes : no}</span>`;
  const ready = info && info.tokenSet && info.chatSet;
  const status = n => n.sentAt ? '<span class="pill pill-good">Gönderildi</span>'
    : n.gaveUp ? `<span class="pill pill-crit" title="${esc(n.error || '')}">Gönderilemedi</span>`
    : n.attempts ? `<span class="pill pill-warn" title="${esc(n.error || '')}">Yeniden denenecek (${n.attempts})</span>`
    : '<span class="pill pill-neutral">Sırada</span>';
  return `<div class="section-card telegram-card">
    <div class="section-head">
      <h3>Telegram Bildirimleri</h3>
      <div class="head-links">
        <button class="btn btn-secondary btn-sm" data-action="telegramChats" ${info?.tokenSet ? '' : 'disabled'}>Grup kimliğini bul</button>
        <button class="btn btn-primary btn-sm" data-action="telegramTest" ${ready ? '' : 'disabled'}>Test mesajı gönder</button>
      </div>
    </div>
    ${!info ? '<p class="muted-text">Yükleniyor…</p>' : `
      <div class="tag-row" style="margin-bottom:10px;">Bot anahtarı ${flag(info.tokenSet, 'tanımlı', 'tanımlı değil')} · Grup ${flag(info.chatSet, 'tanımlı', 'tanımlı değil')}</div>
      <p class="hint" style="margin:0 0 12px;">Gönderilenler: yeni iş, kapatıldı, yeniden işleme alındı, süreye 24 saat kala, süre doldu, süre uzatıldı, iş silindi. Her mesajda iş numarası ve durak adı, silinmemiş işlerde işin bağlantısı olur. ${ready ? '' : 'Kurulum: README > Telegram bildirimleri (bot anahtarı ve grup kimliği PythonAnywhere WSGI dosyasına yazılır).'}</p>
      ${info.recent.length ? `<div class="table-wrap"><table class="compact-table">
        <thead><tr><th>Zaman</th><th>Olay</th><th>İş</th><th>Durum</th></tr></thead>
        <tbody>${info.recent.map(n => `<tr>
          <td class="mono nowrap">${esc(fmtDateTime(n.createdAt))}</td>
          <td>${esc(TELEGRAM_EVENTS[n.event] || n.event)}</td>
          <td class="mono">${n.taskNo ? '#' + n.taskNo : '—'}</td>
          <td>${status(n)}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted-text">Henüz bildirim yok.</p>'}`}
  </div>`;
}
async function telegramTest(button) {
  button.setAttribute('aria-busy', 'true');
  try {
    const res = await apiFetch('/api/telegram/test', { method: 'POST' });
    const text = await res.text();
    const data = parseJsonOrNull(text);
    if (res.ok && data?.ok) showToast('Test mesajı gönderildi; Telegram grubuna bakın');
    else showToast(data?.error ? 'Telegram: ' + data.error : apiErrorText(new Error(text), 'Gönderilemedi'), 'error', 6000);
  } catch (e) { showToast('Gönderilemedi', 'error'); }
  finally { button.removeAttribute('aria-busy'); loadTelegramInfo(true); }
}
async function telegramChats(button) {
  button.setAttribute('aria-busy', 'true');
  try {
    const res = await apiFetch('/api/telegram/chats', { cache: 'no-store' });
    const text = await res.text();
    const data = parseJsonOrNull(text);
    if (!res.ok || !data?.ok) { showToast(data?.error ? 'Telegram: ' + data.error : apiErrorText(new Error(text), 'Sorgulanamadı'), 'error', 6000); return; }
    openModal('Grup kimliğini bul', `
      <p class="modal-lead">Botun son 24 saatte mesaj aldığı sohbetler. Grubunuz listede yoksa botu gruba ekleyip grupta bir mesaj yazın (ör. <span class="mono">/start</span>), sonra tekrar deneyin.</p>
      ${data.chats.length ? `<div class="table-wrap"><table class="compact-table">
        <thead><tr><th>Sohbet</th><th>Tür</th><th>Kimlik (TELEGRAM_CHAT_ID)</th></tr></thead>
        <tbody>${data.chats.map(c => `<tr>
          <td>${esc(c.title || '—')}${c.id === data.current ? ' <span class="pill pill-good">kullanılıyor</span>' : ''}</td>
          <td>${esc({ group: 'Grup', supergroup: 'Grup', private: 'Kişi', channel: 'Kanal' }[c.type] || c.type || '')}</td>
          <td class="mono">${esc(c.id)}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : emptyStateHtml('Sohbet bulunamadı.')}
      <div class="notice">Kimliği (grup kimlikleri eksi işaretiyle başlar) WSGI dosyasındaki <span class="mono">TELEGRAM_CHAT_ID</span> satırına yazıp Web sekmesinde Reload edin.</div>
    `, '<button class="btn btn-primary" data-action="closeModal">Tamam</button>', { large: true });
  } catch (e) { showToast('Sorgulanamadı', 'error'); }
  finally { button.removeAttribute('aria-busy'); }
}

// "Ayşe Çelik" -> "ayse.celik", numbered if taken.
function suggestUsername(first, last) {
  const map = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' };
  const norm = s => s.toLocaleLowerCase('tr').replace(/[çğıöşü]/g, c => map[c]).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
  const base = [norm(first), norm(last)].filter(Boolean).join('.');
  if (!base) return '';
  const taken = new Set(state.users.map(u => u.username));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = base + n;
  return name;
}

function openUserFormModal(userId) {
  const u = userId ? state.users.find(x => x.id === userId) : null;
  const isSelf = !!u && u.id === currentUser.id;
  const locked = isSelf || !!u?.isMainAdmin;
  const orgChoice = (value) => `<label class="choice"><input type="radio" name="orgType" value="${value}" ${u?.orgType === value ? 'checked' : ''} required> ${ORG_TYPE_LABELS[value]}</label>`;
  openModal(u ? 'Kullanıcıyı Düzenle' : 'Yeni Kullanıcı', `
    <form id="userFormInner" data-form="userForm" data-user-id="${u?.id || ''}">
      <div class="field-row">
        <div class="field"><label for="ufFirst">Ad</label><input id="ufFirst" name="firstName" required maxlength="100" value="${esc(u?.firstName || '')}"></div>
        <div class="field"><label for="ufLast">Soyad</label><input id="ufLast" name="lastName" required maxlength="100" value="${esc(u?.lastName || '')}"></div>
      </div>
      <fieldset class="field">
        <legend class="field-legend">Çalışan türü</legend>
        <div class="choice-row">${orgChoice('kurum')}${orgChoice('firma')}</div>
      </fieldset>
      <div class="field">
        <label for="ufUser">Kullanıcı adı</label>
        <input id="ufUser" name="username" required pattern="[a-z0-9._\\-]{3,40}" maxlength="40" autocapitalize="none" spellcheck="false" value="${esc(u?.username || '')}" ${u ? 'disabled' : ''}>
        <div class="hint">${u ? 'Kullanıcı adı sonradan değiştirilemez.' : 'Ad ve soyaddan otomatik önerilir; küçük harf, rakam ve nokta kullanın.'}</div>
      </div>
      ${u ? `<label class="choice"><input type="checkbox" name="active" ${u.active ? 'checked' : ''} ${locked ? 'disabled' : ''}> Aktif: sisteme giriş yapabilir</label>
      <label class="choice"><input type="checkbox" name="isAdmin" ${u.isAdmin ? 'checked' : ''} ${locked ? 'disabled' : ''}> Sistem yöneticisi: kullanıcıları ekler ve düzenler, şifre sıfırlar, kapanmış işleri silebilir</label>
      ${locked ? `<div class="hint">${u.isMainAdmin ? 'Ana sistem yöneticisinin yetkisi ve durumu değiştirilemez (kurulumda WSGI dosyasında belirlenir).' : 'Kendi yetkinizi ve hesabınızın durumunu değiştiremezsiniz.'}</div>` : ''}` : ''}
      <div class="notice">Firma çalışanları (sistem yöneticisi değillerse) Ekranlar, Malzeme Kataloğu ve Raporlar sayfalarını görmez ve ekran bilgilerini değiştiremez; işleri, paneli ve haritayı kullanır.</div>
      ${u ? '' : `<div class="notice">Kaydettiğinizde rastgele bir geçici şifre oluşturulur ve bir kez gösterilir. Kullanıcı ilk girişinde kendi şifresini belirleyecek.</div>`}
    </form>
  `, `
    <button class="btn btn-secondary" data-action="closeModal">Vazgeç</button>
    <button class="btn btn-primary" type="submit" form="userFormInner">${u ? 'Kaydet' : 'Kullanıcıyı Ekle'}</button>
  `);
  if (!u) {
    const form = document.getElementById('userFormInner');
    let edited = false;
    form.username.addEventListener('input', () => { edited = true; });
    const suggest = () => { if (!edited) form.username.value = suggestUsername(form.firstName.value, form.lastName.value); };
    form.firstName.addEventListener('input', suggest);
    form.lastName.addEventListener('input', suggest);
  }
}
async function saveUserForm(form) {
  const id = form.dataset.userId;
  const fd = new FormData(form);
  const body = {
    firstName: (fd.get('firstName') || '').toString().trim(),
    lastName: (fd.get('lastName') || '').toString().trim(),
    orgType: fd.get('orgType'),
  };
  if (!body.orgType) { showToast(API_ERRORS.bad_org_type, 'error'); return; }
  try {
    if (id) {
      if (form.elements.active && !form.elements.active.disabled) body.active = form.elements.active.checked;
      if (form.elements.isAdmin && !form.elements.isAdmin.disabled) body.isAdmin = form.elements.isAdmin.checked;
      await db.doc('users/' + id).update(body);
      closeModal();
      // Your own name is shown in the sidebar.
      if (id === currentUser.id) { location.reload(); return; }
      showToast('Kullanıcı güncellendi');
    } else {
      body.username = (fd.get('username') || '').toString().trim().toLowerCase();
      const result = await db.post('users', body);
      closeModal();
      showTempPasswordModal('Kullanıcı eklendi', { fullName: body.firstName + ' ' + body.lastName, username: body.username }, result.tempPassword);
    }
  } catch (e) { showToast(apiErrorText(e, 'Kaydedilemedi'), 'error'); }
}
function resetUserPassword(userId) {
  const u = state.users.find(x => x.id === userId);
  if (!u) return;
  confirmModal(`${u.fullName} için yeni bir geçici şifre oluşturulacak ve kullanıcının açık oturumları kapatılacak. Kullanıcı bir sonraki girişinde kendi şifresini belirleyecek.`, async () => {
    try {
      const result = await db.post('users/' + userId + '/reset-password', {});
      showTempPasswordModal('Şifre sıfırlandı', u, result.tempPassword);
    } catch (e) { showToast(apiErrorText(e, 'Sıfırlanamadı'), 'error'); }
  }, 'Şifreyi Sıfırla');
}
// The server keeps only a hash; this is the one time the temporary password can be seen.
function showTempPasswordModal(title, user, password) {
  openModal(title, `
    <p class="modal-lead"><strong>${esc(user.fullName)}</strong> (<span class="mono">${esc(user.username)}</span>) için geçici şifre:</p>
    <div class="temp-password"><code id="tempPasswordValue">${esc(password)}</code><button type="button" class="btn btn-secondary btn-sm" data-action="copyTempPassword">Kopyala</button></div>
    <div class="notice">Bu şifre yalnızca şimdi gösterilir; pencereyi kapatmadan önce kullanıcıya iletin. Kullanıcı ilk girişinde kendi şifresini belirleyecek.</div>
  `, `<button class="btn btn-primary" data-action="closeModal">Tamam</button>`);
}
async function copyTempPassword(button) {
  const el = document.getElementById('tempPasswordValue');
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.textContent);
    button.classList.add('is-done');
    button.textContent = 'Kopyalandı';
    setTimeout(() => { if (button.isConnected) { button.classList.remove('is-done'); button.textContent = 'Kopyala'; } }, 1600);
  } catch (e) { window.getSelection().selectAllChildren(el); showToast('Seçili şifreyi Ctrl+C ile kopyalayın'); }
}

/* ======================= Login, first-login password, session ======================= */
let pendingSetupPassword = null;
// Same mark as the sidebar in index.html and the app icons (web/*.png).
const BRAND_HTML = `<div class="sidebar-brand">${document.querySelector('.sidebar-brand').innerHTML}</div>`;

function showAuthScreen(html) {
  document.querySelector('.app-shell').hidden = true;
  const root = document.getElementById('authRoot');
  root.hidden = false;
  root.innerHTML = `<div class="auth-screen"><div class="auth-card">${BRAND_HTML}${html}</div></div>`;
  root.querySelector('input')?.focus();
}
function showAuthError(msg) {
  const el = document.getElementById('authError');
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
}

function showLogin(message) {
  showAuthScreen(`
    <h1 class="auth-title">Giriş Yap</h1>
    <p class="auth-lead">Devam etmek için kullanıcı adınız ve şifrenizle giriş yapın.</p>
    <form data-form="login">
      <div class="field"><label for="loginUser">Kullanıcı adı</label><input id="loginUser" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
      <div class="field"><label for="loginPass">Şifre</label><input id="loginPass" name="password" type="password" autocomplete="current-password" required></div>
      <div class="auth-error" id="authError" ${message ? '' : 'hidden'}>${esc(message || '')}</div>
      <button class="btn btn-primary btn-block" type="submit">Giriş Yap</button>
    </form>
    <p class="auth-foot">Hesabınız yoksa sistem yöneticisinden kullanıcı açmasını isteyin.</p>`);
}
// "?next=/uploads/..." comes from the server when a signed-out user opened a link; the server checks it at login
// and returns it only if it is a path on this site.
const requestedNext = new URLSearchParams(location.search).get('next');
if (requestedNext !== null) history.replaceState(null, '', location.pathname + location.hash);
let afterLoginNext = null;

async function submitLogin(form) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const password = form.elements.password.value;
  try {
    const res = await csrfFetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.elements.username.value.trim(), password, next: requestedNext }),
    });
    if (!res.ok) throw new Error(await res.text());
    const me = await res.json();
    csrfToken = me.csrfToken;
    afterLoginNext = me.next;
    if (me.mustChangePassword) showPasswordSetup(me, password); else enterApp(me);
  } catch (e) {
    showAuthError(apiErrorText(e, 'Sunucuya bağlanılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.'));
    form.elements.password.value = '';
    form.elements.password.focus();
  } finally { button.disabled = false; }
}
function enterApp(me) {
  if (afterLoginNext) { location.replace(afterLoginNext); return; }
  startApp(me);
}

// knownPassword: the temporary password just used to log in, so the user doesn't type it twice.
function showPasswordSetup(me, knownPassword) {
  pendingSetupPassword = knownPassword || null;
  showAuthScreen(`
    <h1 class="auth-title">Yeni şifrenizi belirleyin</h1>
    <p class="auth-lead">Hoş geldiniz, ${esc(me.fullName)}. Size verilen geçici şifreyi değiştirmeden devam edemezsiniz.</p>
    <form data-form="passwordSetup">
      ${passwordFieldsHtml(!knownPassword)}
      <div class="auth-error" id="authError" hidden></div>
      <button class="btn btn-primary btn-block" type="submit">Şifreyi Kaydet ve Devam Et</button>
    </form>
    <button type="button" class="btn btn-ghost btn-block" data-action="logout">Çıkış</button>`);
}
function passwordFieldsHtml(askCurrent) {
  return `
    ${askCurrent ? '<div class="field"><label for="pwCurrent">Mevcut şifre</label><input id="pwCurrent" name="currentPassword" type="password" autocomplete="current-password" required></div>' : ''}
    <div class="field"><label for="pwNew">Yeni şifre</label><input id="pwNew" name="newPassword" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}"><div class="hint">En az ${MIN_PASSWORD_LENGTH} karakter; en az bir harf ve bir rakam içermeli. Adınız, soyadınız veya kullanıcı adınız geçemez; 12345678, sifre123 gibi yaygın şifreler kabul edilmez.</div></div>
    <div class="field"><label for="pwNew2">Yeni şifre (tekrar)</label><input id="pwNew2" name="newPassword2" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}"></div>`;
}
async function changePassword(form, currentPassword) {
  const next = form.elements.newPassword.value;
  if (next !== form.elements.newPassword2.value) throw new Error('Yeni şifreler birbirini tutmuyor.');
  if (next.length < MIN_PASSWORD_LENGTH) throw new Error(API_ERRORS.password_too_short);
  if (!/\p{L}/u.test(next) || !/\d/.test(next)) throw new Error(API_ERRORS.password_weak);
  const res = await csrfFetch('/api/auth/change-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword: next }),
  });
  if (!res.ok) throw new Error(apiErrorText(new Error(await res.text()), 'Şifre değiştirilemedi'));
  const me = await res.json();
  csrfToken = me.csrfToken;
  return me;
}
async function submitPasswordSetup(form) {
  try {
    const me = await changePassword(form, pendingSetupPassword ?? form.elements.currentPassword.value);
    pendingSetupPassword = null;
    enterApp(me);
    showToast('Şifreniz kaydedildi');
  } catch (e) { showAuthError(e.message); }
}
function openChangePasswordModal() {
  openModal('Şifre Değiştir', `
    <form id="pwFormInner" data-form="passwordChange">
      ${passwordFieldsHtml(true)}
      <div class="auth-error" id="authError" hidden></div>
    </form>
  `, `
    <button class="btn btn-secondary" data-action="closeModal">Vazgeç</button>
    <button class="btn btn-primary" type="submit" form="pwFormInner">Şifreyi Değiştir</button>
  `);
}
async function submitPasswordChange(form) {
  try {
    await changePassword(form, form.elements.currentPassword.value);
    closeModal();
    showToast('Şifreniz değiştirildi; diğer cihazlardaki oturumlarınız kapatıldı', null, 4000);
  } catch (e) { showAuthError(e.message); }
}
async function logout() {
  try { await csrfFetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  location.reload();
}

function renderUserBox() {
  const u = currentUser;
  const initials = ((u.firstName || '').charAt(0) + (u.lastName || '').charAt(0)).toLocaleUpperCase('tr') || '?';
  document.getElementById('userBox').innerHTML = `
    <div class="user-card">
      <span class="user-avatar" aria-hidden="true">${esc(initials)}</span>
      <div class="user-text">
        <strong title="${esc(u.fullName)}">${esc(u.fullName)}</strong>
        <span>${esc(ORG_TYPE_LABELS[u.orgType] || '')} · ${u.isAdmin ? 'Sistem yöneticisi' : 'Teknisyen'}</span>
      </div>
    </div>
    <div class="user-actions">
      <button class="btn btn-ghost btn-sm" data-action="changePassword">Şifre Değiştir</button>
      <button class="btn btn-ghost btn-sm" data-action="logout">Çıkış</button>
    </div>`;
}

/* ======================= Reports ======================= */
// basis: which date the range applies to — the job's opening (created) or its resolution (resolved).
const EMPTY_REPORT_FILTERS = { start: '', end: '', basis: 'created', type: '', bolge: '', screenId: '', technicianId: '' };
let reportFilters = { ...EMPTY_REPORT_FILTERS };
let reportView = 'material';
const reportExpanded = new Set();
function reportDate(t) { return reportFilters.basis === 'resolved' ? t.resolvedAt : t.createdAt; }
function filteredReportTasks() {
  // Dates from <input type="date"> are local days; read them as local midnight, not UTC.
  const start = reportFilters.start ? new Date(reportFilters.start + 'T00:00:00') : null;
  const end = reportFilters.end ? new Date(reportFilters.end + 'T23:59:59.999') : null;
  return state.tasks.filter(t => {
    if (!matchesTypeFilter(t, reportFilters.type)) return false;
    if (reportFilters.bolge && screenById(t.screenId)?.bolgeKod !== reportFilters.bolge) return false;
    if (reportFilters.screenId && t.screenId !== reportFilters.screenId) return false;
    if (reportFilters.technicianId && t.assignedTechnicianId !== reportFilters.technicianId) return false;
    if (start || end) {
      const d = reportDate(t) ? new Date(reportDate(t)) : null;
      if (!d || (start && d < start) || (end && d > end)) return false;
    }
    return true;
  });
}
// One row per material / operation: total quantity, the jobs (services) it was used in, and on how many screens.
function materialReport(tasks) {
  const rows = new Map();
  for (const t of tasks) {
    for (const um of t.usedMaterials || []) {
      if (!rows.has(um.materialId)) {
        const m = materialById(um.materialId);
        rows.set(um.materialId, { id: um.materialId, name: m?.name || 'Bilinmeyen', unit: m?.unit || '', qty: 0, uses: [] });
      }
      const r = rows.get(um.materialId);
      r.qty += um.qty;
      r.uses.push({ task: t, qty: um.qty });
    }
  }
  return [...rows.values()].map(r => ({
    ...r,
    taskCount: new Set(r.uses.map(u => u.task.id)).size,
    screenCount: new Set(r.uses.map(u => u.task.screenId).filter(Boolean)).size,
    last: r.uses.map(u => reportDate(u.task) || u.task.createdAt).sort().pop(),
  })).sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, 'tr'));
}
function reportSummaryText(tasks) {
  const f = reportFilters;
  const day = v => fmtDate(v + 'T00:00:00');
  const parts = [f.start || f.end
    ? `${f.start ? day(f.start) : 'başlangıç yok'} – ${f.end ? day(f.end) : 'bugün'} (${f.basis === 'resolved' ? 'kapanış' : 'açılış'} tarihine göre)`
    : 'Tüm zamanlar'];
  if (f.type) parts.push('Tür: ' + TYPE_FILTERS[f.type]);
  if (f.bolge) parts.push('Şeflik: ' + f.bolge);
  if (f.screenId) parts.push('Ekran: ' + screenLabel(screenById(f.screenId)));
  if (f.technicianId) parts.push('Teknisyen: ' + (personName(f.technicianId) || '—'));
  parts.push(`${tasks.length} iş`);
  return parts.join(' · ');
}
function reportTaskSort(a, b) { return new Date(reportDate(b) || b.createdAt) - new Date(reportDate(a) || a.createdAt); }

function materialReportTableHtml(rows) {
  if (!rows.length) return emptyStateHtml('Seçili işlerde malzeme / işlem kaydı yok.');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Malzeme / İşlem</th><th>Birim</th><th class="num">Toplam Miktar</th><th class="num">Servis (İş)</th><th class="num">Ekran</th><th>Son Kullanım</th></tr></thead>
    <tbody>${rows.map(r => {
      const open = reportExpanded.has(r.id);
      return `<tr class="clickable" data-action="toggleReportRow" data-id="${esc(r.id)}" title="Hangi işlerde kullanıldığını göster">
        <td><span class="expander ${open ? 'open' : ''}">▸</span> ${esc(r.name)}</td>
        <td>${esc(r.unit)}</td>
        <td class="num">${fmtQty(r.qty)}</td>
        <td class="num">${r.taskCount}</td>
        <td class="num">${r.screenCount}</td>
        <td class="mono nowrap">${r.last ? esc(fmtDate(r.last)) : '—'}</td>
      </tr>${open ? `<tr class="report-detail"><td colspan="6"><table class="mini-table">
        <thead><tr><th>Tarih</th><th>Ekran</th><th>İş</th><th>Durum</th><th class="num">Miktar</th></tr></thead>
        <tbody>${[...r.uses].sort((a, b) => reportTaskSort(a.task, b.task)).map(u => `<tr>
          <td class="mono nowrap">${esc(fmtDate(reportDate(u.task) || u.task.createdAt))}</td>
          <td>${u.task.screenId ? `<a class="link" href="#screen-${esc(u.task.screenId)}" data-action="openScreen" data-id="${esc(u.task.screenId)}">${esc(screenLabel(screenById(u.task.screenId)))}</a>` : '—'}</td>
          <td><a class="link" href="#task-${esc(u.task.id)}" data-action="openTask" data-id="${esc(u.task.id)}">${esc([taskNo(u.task), taskSummary(u.task, 50)].filter(Boolean).join(' '))}</a></td>
          <td>${statusPill(u.task.status)}</td>
          <td class="num">${fmtQty(u.qty)} ${esc(r.unit)}</td>
        </tr>`).join('')}</tbody>
      </table></td></tr>` : ''}`;
    }).join('')}</tbody>
  </table></div>`;
}
function serviceReportTableHtml(tasks) {
  if (!tasks.length) return emptyStateHtml('Seçili ölçütlere uyan iş yok.');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Tarih</th><th>Ekran</th><th>İş</th><th>Tür</th><th>Durum</th><th>Teknisyen</th><th>Kullanılan Malzeme / İşlem</th><th>Süre</th></tr></thead>
    <tbody>${[...tasks].sort(reportTaskSort).map(t => `<tr class="clickable" data-action="openTask" data-id="${esc(t.id)}">
      <td class="mono nowrap">${esc(fmtDate(reportDate(t) || t.createdAt))}</td>
      <td>${t.screenId ? `<a class="link" href="#screen-${esc(t.screenId)}" data-action="openScreen" data-id="${esc(t.screenId)}">${esc(screenLabel(screenById(t.screenId)))}</a>` : '—'}</td>
      <td class="wrap-text">${taskNoHtml(t)}${esc(taskSummary(t, 60) || '—')}</td>
      <td>${typePill(t.type)}</td>
      <td>${statusPill(t.status)}</td>
      <td>${esc(personName(t.assignedTechnicianId) || '—')}</td>
      <td class="wrap-text">${esc(materialsSummary(t) || '—')}</td>
      <td class="nowrap">${fmtDays(resolutionDays(t))}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

/* Screen visits: every job at a screen within the report's filters counts as one visit to it. */
let showUnvisited = false;
function screenVisitReport(tasks) {
  const rows = new Map();
  for (const t of tasks) {
    // By closing date only finished jobs count, also when no date range is chosen.
    if (!t.screenId || (reportFilters.basis === 'resolved' && !t.resolvedAt)) continue;
    if (!rows.has(t.screenId)) rows.set(t.screenId, { id: t.screenId, screen: screenById(t.screenId), tasks: [], byType: {}, closed: 0 });
    const r = rows.get(t.screenId);
    r.tasks.push(t);
    r.byType[t.type] = (r.byType[t.type] || 0) + 1;
    if (isClosedStatus(t.status)) r.closed++;
  }
  return [...rows.values()].map(r => {
    const dates = r.tasks.map(t => reportDate(t) || t.createdAt).filter(Boolean).sort();
    const people = [...new Set(r.tasks.map(t => personName(t.assignedTechnicianId)).filter(Boolean))];
    return { ...r, count: r.tasks.length, first: dates[0], last: dates[dates.length - 1], people };
  }).sort((a, b) => b.count - a.count || compareScreens(a.screen || {}, b.screen || {}));
}
// Active screens in the report's area (şeflik / screen filter) with no visit in the range.
function unvisitedScreens(visitRows) {
  const seen = new Set(visitRows.map(r => r.id));
  return state.screens.filter(s => !seen.has(s.id) && s.status !== 'pasif'
    && (!reportFilters.bolge || s.bolgeKod === reportFilters.bolge)
    && (!reportFilters.screenId || s.id === reportFilters.screenId)).sort(compareScreens);
}
function screenVisitTableHtml(rows, unvisited) {
  const extra = showUnvisited ? unvisited : [];
  if (!rows.length && !extra.length) return emptyStateHtml('Seçili ölçütlerde hiçbir ekrana gidilmemiş.');
  const typeKeys = Object.keys(TASK_TYPES);
  const screenLink = (id, s) => `<a class="link" href="#screen-${esc(id)}" data-action="openScreen" data-id="${esc(id)}">${esc(screenLabel(s))}</a>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Ekran</th><th>Şeflik</th><th class="num">Ziyaret</th>${typeKeys.map(k => `<th class="num">${esc(TASK_TYPES[k])}</th>`).join('')}<th class="num">Kapanan</th><th>Son Ziyaret</th></tr></thead>
    <tbody>${rows.map(r => {
      const key = 'visit:' + r.id;
      const open = reportExpanded.has(key);
      return `<tr class="clickable" data-action="toggleReportRow" data-id="${esc(key)}" title="Bu ekrandaki işleri göster">
        <td><span class="expander ${open ? 'open' : ''}">▸</span> ${screenLink(r.id, r.screen)}</td>
        <td>${esc(r.screen?.bolgeKod || '—')}</td>
        <td class="num"><strong>${r.count}</strong></td>
        ${typeKeys.map(k => `<td class="num">${r.byType[k] || '—'}</td>`).join('')}
        <td class="num">${r.closed}</td>
        <td class="mono nowrap">${r.last ? esc(fmtDate(r.last)) : '—'}</td>
      </tr>${open ? `<tr class="report-detail"><td colspan="${typeKeys.length + 5}"><table class="mini-table">
        <thead><tr><th>Tarih</th><th>İş</th><th>Tür</th><th>Durum</th><th>Teknisyen</th></tr></thead>
        <tbody>${[...r.tasks].sort(reportTaskSort).map(t => `<tr>
          <td class="mono nowrap">${esc(fmtDate(reportDate(t) || t.createdAt))}</td>
          <td><a class="link" href="#task-${esc(t.id)}" data-action="openTask" data-id="${esc(t.id)}">${esc([taskNo(t), taskSummary(t, 50)].filter(Boolean).join(' '))}</a></td>
          <td>${typePill(t.type)}</td>
          <td>${statusPill(t.status)}</td>
          <td>${esc(personName(t.assignedTechnicianId) || '—')}</td>
        </tr>`).join('')}</tbody>
      </table></td></tr>` : ''}`;
    }).join('')}${extra.map(s => `<tr class="muted-row">
        <td><span class="expander-space"></span> ${screenLink(s.id, s)}</td>
        <td>${esc(s.bolgeKod || '—')}</td>
        <td class="num">0</td>
        ${typeKeys.map(() => '<td class="num">—</td>').join('')}
        <td class="num">—</td>
        <td>—</td>
      </tr>`).join('')}</tbody>
  </table></div>`;
}
async function exportVisitsCsv() {
  const rows = screenVisitReport(filteredReportTasks());
  const typeKeys = Object.keys(TASK_TYPES);
  const lines = rows.map(r => [screenCode(r.screen).slice(1), r.screen ? (r.screen.durakAdi || r.screen.adres || '') : 'Bilinmeyen ekran', r.screen?.bolgeKod || '',
    r.count, ...typeKeys.map(k => r.byType[k] || 0), r.closed, r.first ? fmtDate(r.first) : '', r.last ? fmtDate(r.last) : '', r.people.join(', ')]);
  if (showUnvisited) {
    for (const s of unvisitedScreens(rows)) lines.push([screenCode(s).slice(1), s.durakAdi || s.adres || '', s.bolgeKod || '', 0, ...typeKeys.map(() => 0), 0, '', '', '']);
  }
  await downloadCsv(reportFileName('ekran-ziyaretleri'),
    ['Durak No', 'Ekran', 'Şeflik', 'Ziyaret', ...typeKeys.map(k => TASK_TYPES[k]), 'Kapanan', 'İlk Ziyaret', 'Son Ziyaret', 'Teknisyenler'], lines);
}
// Disk use on the server (photos + database), re-read at most once a minute while Raporlar is open.
let storageStats = null;
let storageStatsAt = 0;
function loadStorageStats() {
  if (Date.now() - storageStatsAt < 60000) return;
  storageStatsAt = Date.now();
  apiFetch('/api/stats/storage', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(s => { if (s) { storageStats = s; if (currentRoute().name === 'reports') render(); } })
    .catch(() => {});
}
function storageTileHtml() {
  if (!storageStats) return '';
  const used = storageStats.uploadBytes + storageStats.dbBytes;
  const share = used / storageStats.quotaBytes;
  return `<div class="stat-tile ${share > 0.8 ? 'accent-crit' : share > 0.5 ? 'accent-warn' : ''}" title="Ücretsiz planda hesabın tüm dosyaları için toplam ${fmtMB(storageStats.quotaBytes)} disk vardır.">
    <div class="stat-label">Disk Kullanımı</div><div class="stat-value">${fmtMB(used)}</div>
    <div class="stat-sub">${storageStats.photoCount} fotoğraf ${fmtMB(storageStats.uploadBytes)} · veritabanı ${fmtMB(storageStats.dbBytes)} · kota ${fmtMB(storageStats.quotaBytes)}</div>
  </div>`;
}

function renderReportsPage(app, topbarActions) {
  loadStorageStats();
  topbarActions.innerHTML = `
    <button class="btn btn-secondary" data-action="printPage">Yazdır / PDF</button>
    <button class="btn btn-secondary" data-action="exportTasksCsv">İş Listesini CSV İndir</button>`;
  const tasks = filteredReportTasks();
  const total = tasks.length;
  const resolved = tasks.filter(t => t.resolvedAt);
  const avgResolutionDays = resolved.length ? (resolved.reduce((sum, t) => sum + (new Date(t.resolvedAt) - new Date(t.createdAt)) / 86400000, 0) / resolved.length) : 0;
  const openShare = total ? Math.round((tasks.filter(t => t.status !== 'kapandi').length / total) * 100) : 0;
  const overdueCount = tasks.filter(isOverdue).length;
  const extendedTasks = tasks.filter(t => (t.extensions || []).length);
  const extensionCount = extendedTasks.reduce((sum, t) => sum + t.extensions.length, 0);

  const typeCounts = Object.fromEntries(Object.keys(TASK_TYPES).map(k => [k, 0]));
  tasks.forEach(t => { if (typeCounts[t.type] !== undefined) typeCounts[t.type]++; });

  const matRows = materialReport(tasks);
  const topMat = matRows.slice(0, 10);
  const maxMat = Math.max(...topMat.map(x => x.qty), 1);

  const stopFaults = {};
  tasks.filter(t => isFault(t) && t.screenId).forEach(t => { stopFaults[t.screenId] = (stopFaults[t.screenId] || 0) + 1; });
  const topStops = Object.entries(stopFaults).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, count]) => ({ id, name: screenLabel(screenById(id)), count }));
  const summary = reportSummaryText(tasks);
  const maxStopFault = Math.max(...topStops.map(x => x.count), 1);

  const weeks = buildWeeklyBuckets(tasks, 12);

  const visitRows = screenVisitReport(tasks);
  const visitTotal = visitRows.reduce((sum, r) => sum + r.count, 0);
  const unvisited = unvisitedScreens(visitRows);

  const f = reportFilters;
  const content = `
    <div class="print-only print-head"><strong>Akıllı Durak Takip — Rapor</strong><span>${esc(summary)}</span><span>Oluşturma: ${esc(fmtDateTime(new Date().toISOString()))}</span></div>
    <div class="filter-bar report-filters">
      <div class="field" style="margin:0;"><label>Başlangıç</label><input type="date" data-report-filter="start" value="${f.start}"></div>
      <div class="field" style="margin:0;"><label>Bitiş</label><input type="date" data-report-filter="end" value="${f.end}"></div>
      <div class="field" style="margin:0;"><label>Tarih ölçütü</label><select data-report-filter="basis">${optionsHtml({ created: 'İşin açılışı', resolved: 'İşin kapanışı' }, f.basis)}</select></div>
      <div class="field" style="margin:0;"><label>Tür</label><select data-report-filter="type"><option value="">Tümü</option>${optionsHtml(TYPE_FILTERS, f.type)}</select></div>
      <div class="field" style="margin:0;"><label>Şeflik</label><select data-report-filter="bolge"><option value="">Tümü</option>${distinctBolgeler().map(b => `<option value="${esc(b)}" ${f.bolge === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></div>
      <div class="field" style="margin:0;"><label>Ekran</label><select data-report-filter="screenId"><option value="">Tüm ekranlar</option>${[...state.screens].sort(compareScreens).map(s => `<option value="${esc(s.id)}" ${f.screenId === s.id ? 'selected' : ''}>${esc(screenLabel(s))}</option>`).join('')}</select></div>
      <div class="field" style="margin:0;"><label>Teknisyen</label><select data-report-filter="technicianId"><option value="">Tümü</option>${peopleFilterOptionsHtml(f.technicianId)}</select></div>
      <button class="btn btn-ghost btn-sm" data-action="clearReportFilters">Filtreleri Temizle</button>
    </div>

    <div class="stat-grid">
      <div class="stat-tile"><div class="stat-label">Toplam İş</div><div class="stat-value">${total}</div><div class="stat-sub">seçili aralıkta</div></div>
      <a class="stat-tile stat-link" href="#reports" data-action="showVisits"><div class="stat-label">Gidilen Ekran</div><div class="stat-value">${visitRows.length}</div><div class="stat-sub">${visitTotal} ziyaret${unvisited.length ? ` · ${unvisited.length} ekrana gidilmedi` : ''}</div></a>
      <div class="stat-tile"><div class="stat-label">Ort. Kapanış Süresi</div><div class="stat-value">${avgResolutionDays.toFixed(1)}</div><div class="stat-sub">gün</div></div>
      <div class="stat-tile"><div class="stat-label">İşlemde Oranı</div><div class="stat-value">%${openShare}</div><div class="stat-sub">kapatılmamış</div></div>
      <div class="stat-tile"><div class="stat-label">Kullanılan Kalem</div><div class="stat-value">${matRows.length}</div><div class="stat-sub">farklı malzeme/işlem</div></div>
      <div class="stat-tile ${overdueCount ? 'accent-crit' : ''}"><div class="stat-label">Süresi Geçen</div><div class="stat-value">${overdueCount}</div><div class="stat-sub">şu an gecikmede</div></div>
      <div class="stat-tile ${extensionCount ? 'accent-warn' : ''}"><div class="stat-label">Süre Uzatma</div><div class="stat-value">${extensionCount}</div><div class="stat-sub">${extendedTasks.length} işte, mazeretli</div></div>
      ${storageTileHtml()}
    </div>

    <div class="section-card">
      <h3>Haftalık İş Trendi</h3>
      <div class="section-sub">Son 12 hafta, oluşturulan iş sayısı</div>
      ${trendChartSvg(weeks)}
    </div>

    <div class="panel-grid">
      <div>
        <div class="section-card">
          <h3>En Çok Kullanılan Malzemeler / İşlemler</h3>
          ${topMat.length ? `<div class="bars-chart">${topMat.map(m => barRow(m.name + ' (' + m.unit + ')', m.qty, maxMat, 'var(--accent)')).join('')}</div>`
            : emptyStateHtml('Seçili aralıkta malzeme kullanımı yok.')}
        </div>
      </div>
      <div>
        <div class="section-card">
          <h3>En Çok Arızalanan Ekranlar</h3>
          ${topStops.length ? `<div class="bars-chart">${topStops.map(s => barRow(s.name, s.count, maxStopFault, 'var(--crit)', '#screen-' + s.id)).join('')}</div>` : emptyStateHtml('Arıza kaydı yok.')}
        </div>
        <div class="section-card">
          <h3>Tür Dağılımı</h3>
          ${barChart(typeBarItems(typeCounts))}
        </div>
      </div>
    </div>

    <div class="section-card" id="screenVisits">
      <div class="section-head">
        <h3>Ekran Ziyaretleri</h3>
        ${unvisited.length ? `<button type="button" class="btn btn-ghost btn-sm" data-action="toggleUnvisited">${showUnvisited ? 'Gidilmeyenleri gizle' : `Gidilmeyenleri göster (${unvisited.length})`}</button>` : ''}
      </div>
      <div class="section-sub">${visitRows.length} ekrana toplam ${visitTotal} kez gidildi${unvisited.length ? `, ${unvisited.length} aktif ekrana hiç gidilmedi` : ''} · ${esc(summary)}</div>
      <div class="hint" style="margin:-4px 0 10px;">Her iş bir ziyaret sayılır. Yalnızca tamamlanan ziyaretleri saymak için "Tarih ölçütü"nde "İşin kapanışı"nı seçin. Satıra tıklayınca o ekrandaki işler açılır.</div>
      ${screenVisitTableHtml(visitRows, unvisited)}
      <div class="report-actions">
        <button class="btn btn-secondary btn-sm" data-action="exportVisitsCsv">Ziyaret listesini CSV indir</button>
      </div>
    </div>

    <div class="section-card" id="serviceReport">
      <div class="section-head">
        <h3>Malzeme / İşlem ve Servis Raporu</h3>
        <div class="view-toggle">
          <button type="button" class="${reportView === 'material' ? 'active' : ''}" data-action="setReportView" data-view="material">Malzeme / işlem bazında</button>
          <button type="button" class="${reportView === 'service' ? 'active' : ''}" data-action="setReportView" data-view="service">Servis (iş) bazında</button>
        </div>
      </div>
      <div class="section-sub">${esc(summary)}${reportView === 'material' && matRows.length ? ' · satıra tıklayınca kullanıldığı işler açılır' : ''}</div>
      ${reportView === 'material' ? materialReportTableHtml(matRows) : serviceReportTableHtml(tasks)}
      <div class="report-actions">
        <button class="btn btn-secondary btn-sm" data-action="exportMaterialsCsv">Malzeme özetini CSV indir</button>
        <button class="btn btn-secondary btn-sm" data-action="exportServiceCsv">Servis listesini CSV indir</button>
        <button class="btn btn-secondary btn-sm" data-action="exportDetailCsv" title="Her iş ve kullanılan her malzeme ayrı satır; Excel'de pivot için">Ayrıntılı CSV (iş × malzeme)</button>
      </div>
    </div>`;
  app.innerHTML = (dbAvailable ? '' : bannerNoDb()) + content;
}

// Text starting with = + - @ (or a tab/CR) would run as a formula in Excel ("CSV injection"); prefix it with '
// so it stays plain text. Numbers like -1,5 are left as they are.
function csvEscape(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = "'" + s;
  if (/[",\n\r;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
async function downloadCsv(filename, headers, rows) {
  const lines = [headers, ...rows].map(r => r.map(csvEscape).join(';'));
  const csv = '﻿' + lines.join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Dosya indirildi');
}
async function exportTasksCsv() {
  const tasks = filteredReportTasks();
  const headers = ['İş No', 'Tür', 'Açıklama', 'Durum', 'Ekran', 'Şeflik', 'Teknisyen', 'Servis Günü', 'Oluşturma', 'Son Tarih', 'Kapanış', 'Süre Uzatma', 'Önce Foto', 'Sonra Foto'];
  const rows = tasks.map(t => {
    const scr = screenById(t.screenId);
    const photoCount = kind => (t.photos || []).filter(p => p.kind === kind).length;
    return [t.no ?? '', TASK_TYPES[t.type] || t.type, taskText(t), statusLabel(t.status),
      screenLabel(scr), scr?.bolgeKod || '', personName(t.assignedTechnicianId), SERVICE_DAYS[t.serviceDayType] || '', fmtDateTime(t.createdAt),
      t.dueDate ? fmtDateTime(t.dueDate) : '', t.resolvedAt ? fmtDateTime(t.resolvedAt) : '', (t.extensions || []).length, photoCount('once'), photoCount('sonra')];
  });
  await downloadCsv('is-listesi.csv', headers, rows);
}
// File names carry the date range and screen, e.g. servis-raporu_2026-09-01_2026-09-30_scr-7-a.csv
function reportFileName(base) {
  const f = reportFilters;
  return [base, f.start || (f.end ? 'bas' : ''), f.end, f.screenId].filter(Boolean).join('_') + '.csv';
}
function taskCsvColumns(t) {
  const scr = screenById(t.screenId);
  return [t.no ?? '', fmtDateTime(reportDate(t) || t.createdAt), scr ? (scr.durakAdi || scr.adres || '') : '', scr ? screenCode(scr).slice(1) : '',
    scr?.bolgeKod || '', TASK_TYPES[t.type] || t.type, taskText(t), statusLabel(t.status), personName(t.assignedTechnicianId)];
}
const TASK_CSV_HEADERS = ['İş No', 'Tarih', 'Ekran', 'Durak No', 'Şeflik', 'Tür', 'Açıklama', 'Durum', 'Teknisyen'];
async function exportMaterialsReportCsv() {
  const rows = materialReport(filteredReportTasks()).map(r => [r.name, r.unit, fmtQty(r.qty), r.taskCount, r.screenCount, r.last ? fmtDate(r.last) : '']);
  await downloadCsv(reportFileName('malzeme-raporu'), ['Malzeme / İşlem', 'Birim', 'Toplam Miktar', 'Servis (İş) Sayısı', 'Ekran Sayısı', 'Son Kullanım'], rows);
}
async function exportServiceCsv() {
  const rows = filteredReportTasks().sort(reportTaskSort).map(t => {
    const days = resolutionDays(t);
    return [...taskCsvColumns(t), materialsSummary(t), t.resolvedAt ? fmtDateTime(t.resolvedAt) : '', days == null ? '' : days.toFixed(1).replace('.', ',')];
  });
  await downloadCsv(reportFileName('servis-raporu'), [...TASK_CSV_HEADERS, 'Kullanılan Malzeme / İşlem', 'Kapanış', 'Kapanış Süresi (gün)'], rows);
}
// One row per job and material used (a job without materials gets one row with the material columns empty).
async function exportDetailCsv() {
  const rows = [];
  for (const t of filteredReportTasks().sort(reportTaskSort)) {
    const used = t.usedMaterials || [];
    if (!used.length) rows.push([...taskCsvColumns(t), '', '', '']);
    for (const um of used) {
      const m = materialById(um.materialId);
      rows.push([...taskCsvColumns(t), m?.name || 'Bilinmeyen', fmtQty(um.qty), m?.unit || '']);
    }
  }
  await downloadCsv(reportFileName('servis-malzeme-ayrintili'), [...TASK_CSV_HEADERS, 'Malzeme / İşlem', 'Miktar', 'Birim'], rows);
}

/* ======================= Actions / delegation ======================= */
const actions = {
  toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('drawerOverlay');
    const isOpen = sidebar.classList.toggle('open');
    overlay.hidden = !isOpen;
  },
  closeSidebar() { closeSidebar(); },
  closeModal() { closeModal(); },
  confirmYes() { const fn = pendingConfirm; pendingConfirm = null; closeModal(); if (fn) fn(); },

  newTask() { openTaskFormModal(); },
  editTask(el) { openTaskFormModal(el.dataset.id); },
  deleteTask(el) { const id = el.dataset.id; confirmModal('Bu iş kalıcı olarak silinecek. Emin misiniz?', () => deleteTask(id)); },
  openTask(el) { location.hash = '#task-' + el.dataset.id; },
  setTaskView(el) { taskViewMode = el.dataset.view; render(); },
  clearTaskFilters() { taskFilters = { ...EMPTY_TASK_FILTERS }; render(); },
  showOverdue() {
    taskFilters = { ...EMPTY_TASK_FILTERS, due: 'overdue' };
    if (location.hash === '#tasks') render(); else location.hash = '#tasks';
  },
  showDueSoon() {
    taskFilters = { ...EMPTY_TASK_FILTERS, due: 'soon' };
    if (location.hash === '#tasks') render(); else location.hash = '#tasks';
  },
  saveTaskStatus(el) {
    const task = state.tasks.find(t => t.id === el.dataset.taskId);
    const picked = task && pendingStatusFor(task);
    if (picked) return updateTaskStatus(task.id, picked);
  },
  extendDue(el) { openExtendModal(el.dataset.taskId); },
  // Two-step delete without a confirmation window.
  deletePhoto(el) {
    if (!el.dataset.armed) {
      el.dataset.armed = '1';
      el.textContent = 'Sil?';
      el.classList.add('armed');
      setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; el.textContent = '×'; el.classList.remove('armed'); } }, 3000);
      return;
    }
    removePhoto(el.dataset.photoId);
  },

  addMaterialsToTask(el) { openAddMaterialsModal(el.dataset.taskId); },
  removeUsedMaterial(el) { removeUsedMaterialFromTask(el.dataset.taskId, el.dataset.materialId); },
  saveMaterialsSelection(el) { saveMaterialsSelectionHandler(el.dataset.taskId); },

  newScreen() { openScreenFormModal(); },
  editScreen(el) { openScreenFormModal(el.dataset.id); },
  deleteScreen(el) { const id = el.dataset.id; confirmModal('Bu ekran silinecek. Emin misiniz?', () => deleteScreen(id)); },


  newMaterial() { openMaterialFormModal(); },
  editMaterial(el) { openMaterialFormModal(el.dataset.id); },
  deleteMaterial(el) { const id = el.dataset.id; confirmModal('Bu malzeme kataloğundan silinecek. Emin misiniz?', () => deleteMaterial(id)); },

  exportTasksCsv() { exportTasksCsv(); },
  exportMaterialsCsv() { exportMaterialsReportCsv(); },
  exportServiceCsv() { exportServiceCsv(); },
  exportDetailCsv() { exportDetailCsv(); },
  exportVisitsCsv() { return exportVisitsCsv(); },
  toggleUnvisited() { showUnvisited = !showUnvisited; render(); },
  showVisits() { document.getElementById('screenVisits')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  printPage() { window.print(); },
  setReportView(el) { reportView = el.dataset.view; render(); },
  toggleReportRow(el) {
    const id = el.dataset.id;
    if (reportExpanded.has(id)) reportExpanded.delete(id); else reportExpanded.add(id);
    render();
  },
  clearReportFilters() { reportFilters = { ...EMPTY_REPORT_FILTERS }; render(); },
  // From a screen's page: that screen's report, all dates.
  screenReport(el) {
    reportFilters = { ...EMPTY_REPORT_FILTERS, screenId: el.dataset.id };
    location.hash = '#reports';
    setTimeout(() => document.getElementById('serviceReport')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  },
  openScreen(el) { location.hash = '#screen-' + el.dataset.id; },
  newTaskForScreen(el) { openTaskFormModal(null, { screenId: el.dataset.id, type: 'ekran_ariza' }); },
  setScreenHistoryType(el) { screenHistoryType = el.dataset.type; render(); },
  setMapKind(el) { mapFilters.kind = mapFilters.kind === el.dataset.kind ? '' : el.dataset.kind; mainMapRefit = true; render(); },

  newUser() { openUserFormModal(); },
  editUser(el) { openUserFormModal(el.dataset.id); },
  resetUserPassword(el) { resetUserPassword(el.dataset.id); },
  copyTempPassword(el) { copyTempPassword(el); },
  telegramTest(el) { telegramTest(el); },
  telegramChats(el) { telegramChats(el); },
  changePassword() { openChangePasswordModal(); },
  logout() { logout(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el, e); }
});

const forms = {
  taskForm: saveTaskForm,
  screenForm: saveScreenForm,
  materialForm: saveMaterialForm,
  historyForm: addHistoryNoteHandler,
  extendForm: saveExtendForm,
  userForm: saveUserForm,
  login: submitLogin,
  passwordSetup: submitPasswordSetup,
  passwordChange: submitPasswordChange,
};
// While a form is being saved its submit button shows a spinner (aria-busy) and further submits are ignored,
// so a double click cannot create the same record twice. Modal buttons sit outside the form (form="...").
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fn = forms[form.dataset.form];
  if (!fn) return;
  const button = (form.id && document.querySelector(`button[type="submit"][form="${form.id}"]`)) || form.querySelector('button[type="submit"]');
  if (button?.getAttribute('aria-busy') === 'true') return;
  const result = fn(form);
  if (button && result && typeof result.finally === 'function') {
    button.setAttribute('aria-busy', 'true');
    result.finally(() => button.removeAttribute('aria-busy'));
  }
});

document.addEventListener('change', (e) => {
  const photoInput = e.target.closest('[data-photo-input]');
  if (photoInput) {
    const files = [...photoInput.files];
    photoInput.value = '';
    if (files.length) uploadPhotos(photoInput.dataset.taskId, photoInput.dataset.kind, files);
    return;
  }
  const filterEl = e.target.closest('[data-filter]');
  if (filterEl) { taskFilters[filterEl.dataset.filter] = filterEl.value; render(); return; }
  const reportEl = e.target.closest('[data-report-filter]');
  if (reportEl) { reportFilters[reportEl.dataset.reportFilter] = reportEl.value; render(); return; }
  const screenFilterEl = e.target.closest('[data-screen-filter]');
  if (screenFilterEl) { screenFilters[screenFilterEl.dataset.screenFilter] = screenFilterEl.value; render(); return; }
  // Map filters: a finished change (select, or Enter / leaving the search box) zooms to what is left.
  const mapFilterEl = e.target.closest('[data-map-filter]');
  if (mapFilterEl) { mapFilters[mapFilterEl.dataset.mapFilter] = mapFilterEl.value; mainMapRefit = true; render(); return; }
  const screenFieldEl = e.target.closest('[data-screen-field]');
  if (screenFieldEl) {
    const { screenId, screenField } = screenFieldEl.dataset;
    const value = screenFieldEl.tagName === 'INPUT' ? screenFieldEl.value.trim() : screenFieldEl.value;
    if (screenField === 'durakAdi' && !value) {
      showToast('Durak adı boş bırakılamaz', 'error');
      screenFieldEl.value = screenById(screenId)?.durakAdi || '';
      return;
    }
    updateScreenField(screenId, screenField, value);
    return;
  }
  const statusPick = e.target.closest('[data-status-pick]');
  if (statusPick) {
    // Only remembered here; the Kaydet button next to it saves the change.
    pendingStatus = { taskId: statusPick.dataset.taskId, status: statusPick.value };
    const btn = statusPick.parentElement.querySelector('[data-action="saveTaskStatus"]');
    const task = state.tasks.find(t => t.id === statusPick.dataset.taskId);
    if (btn) btn.disabled = !task || statusPick.value === task.status;
    return;
  }
  const taskFieldEl = e.target.closest('[data-task-field]');
  if (taskFieldEl) { handleTaskFieldChange(taskFieldEl.dataset.taskId, taskFieldEl.dataset.taskField, taskFieldEl.value); return; }
});
document.addEventListener('input', (e) => {
  if (e.target.matches('[data-filter="q"]')) { taskFilters.q = e.target.value; render(); }
  if (e.target.matches('[data-screen-filter="q"]')) { screenFilters.q = e.target.value; render(); }
  if (e.target.matches('[data-map-filter="q"]')) { mapFilters.q = e.target.value; render(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('modalRoot').innerHTML.trim()) closeModal();
});

/* Kanban drag & drop */
document.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.kanban-card');
  if (!card) return;
  e.dataTransfer.setData('text/plain', card.dataset.id);
  e.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
document.addEventListener('dragend', (e) => {
  const card = e.target.closest('.kanban-card');
  if (card) card.classList.remove('dragging');
});
document.addEventListener('dragover', (e) => {
  const col = e.target.closest('.kanban-col');
  if (!col) return;
  e.preventDefault();
  col.classList.add('drag-over');
});
document.addEventListener('dragleave', (e) => {
  const col = e.target.closest('.kanban-col');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over');
});
document.addEventListener('drop', (e) => {
  const col = e.target.closest('.kanban-col');
  if (!col) return;
  e.preventDefault();
  col.classList.remove('drag-over');
  const taskId = e.dataTransfer.getData('text/plain');
  const newStatus = col.dataset.status;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || !newStatus || task.status === newStatus) return;
  // Like the job page, a status change needs a Kaydet.
  confirmModal(`İş ${taskNo(task)} "${STATUS_LABELS[newStatus]}" durumuna alınsın mı?`, () => updateTaskStatus(task.id, newStatus), 'Kaydet', 'btn-primary');
});

/* ======================= Boot ======================= */
function startApp(me) {
  currentUser = me;
  const authRoot = document.getElementById('authRoot');
  authRoot.hidden = true;
  authRoot.innerHTML = '';
  document.querySelector('.app-shell').hidden = false;
  document.getElementById('navUsers').hidden = !me.isAdmin;
  document.querySelectorAll('.nav-link').forEach(a => {
    if (COMPANY_HIDDEN_ROUTES.includes(a.dataset.route)) a.hidden = isCompanyUser();
  });
  renderUserBox();
  db = createApiDb();
  dbAvailable = true;
  subscribeCollections();
  window.addEventListener('hashchange', render);
  render();
  // "X saat kaldı / gecikti" labels age without data changes; redraw each minute unless the user is mid-edit.
  setInterval(() => {
    const tag = document.activeElement?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !document.querySelector('#modalRoot .modal')) render();
  }, 60000);
}

async function boot() {
  let res;
  try { res = await fetch('/api/auth/me', { cache: 'no-store' }); }
  catch (e) { showLogin('Sunucuya bağlanılamadı. İnternet bağlantınızı kontrol edip sayfayı yenileyin.'); return; }
  if (!res.ok) { showLogin(); return; }
  const me = await res.json();
  csrfToken = me.csrfToken;
  if (me.mustChangePassword) showPasswordSetup(me); else startApp(me);
}
boot();
