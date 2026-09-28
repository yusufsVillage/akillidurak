"""Durak Ops: akıllı durak ekranları iş takip sistemi (Flask + sqlite3).

WSGI girişi:  from app import app as application
Ayarlar yalnızca ortam değişkenlerinden okunur (README.md > Ortam değişkenleri).
Sayfa (web/) tek sayfalık bir uygulamadır; veriyi /api/ altındaki JSON uçlarından alır.
"""
import datetime as dt
import functools
import hashlib
import hmac
import json
import logging
import math
import os
import re
import secrets
import sqlite3
import time
import uuid
from collections import namedtuple
from urllib.parse import quote, urlsplit

from flask import Flask, Response, g, jsonify, redirect, request, send_from_directory, session
from werkzeug.exceptions import HTTPException, NotFound
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, 'web')
SEED_DIR = os.path.join(BASE_DIR, 'seed')
SCHEMA_PATH = os.path.join(BASE_DIR, 'schema.sql')

DATABASE_PATH = os.path.abspath(os.environ.get('DATABASE_PATH') or os.path.join(BASE_DIR, 'app.db'))
# Photos live next to the database by default, so a code update (unzip) never touches them.
UPLOAD_DIR = os.path.abspath(os.environ.get('UPLOAD_DIR') or os.path.join(os.path.dirname(DATABASE_PATH), 'uploads'))

MAX_PHOTO_BYTES = 5 * 1024 * 1024
DISK_QUOTA_BYTES = 512 * 1024 * 1024  # PythonAnywhere free plan, whole account
SESSION_HOURS = 12
LOGIN_MAX_FAILURES = 10
LOGIN_WINDOW_SECONDS = 15 * 60
MIN_PASSWORD_LENGTH = 8
MAX_TEXT = 500
MAX_MEMO = 10000

ID_RE = re.compile(r'^[A-Za-z0-9_.~:@+\-]{1,64}$')
USERNAME_RE = re.compile(r'^[a-z0-9._-]{3,40}$')
UPLOAD_NAME_RE = re.compile(r'^[A-Za-z0-9_\-]+\.(jpg|png|webp)$')

TASK_TYPES = {'ariza', 'icerik', 'genel'}
TASK_STATUSES = {'acik', 'atandi', 'islemde', 'cozuldu', 'kapandi'}
TASK_PRIORITIES = {'dusuk', 'orta', 'yuksek', 'acil'}
ORG_TYPES = {'kurum', 'firma'}

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('durakops')

app = Flask(__name__, static_folder=None)

_secret = os.environ.get('SECRET_KEY')
if not _secret:
    _secret = secrets.token_hex(32)
    log.warning('SECRET_KEY tanimli degil: gecici bir anahtar uretildi; uygulama her yeniden basladiginda oturumlar kapanir.')

app.config.update(
    SECRET_KEY=_secret,
    SESSION_COOKIE_NAME='durakops_oturum',
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=os.environ.get('SESSION_COOKIE_SECURE') == '1',
    PERMANENT_SESSION_LIFETIME=dt.timedelta(hours=SESSION_HOURS),
    MAX_CONTENT_LENGTH=MAX_PHOTO_BYTES + 64 * 1024,
)
app.json.ensure_ascii = False
app.json.sort_keys = False

# Map tiles are the only outside images (OpenStreetMap, loaded by the browser, not by this server).
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src https://fonts.gstatic.com; img-src 'self' blob: data: https://tile.openstreetmap.org; "
       "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")


# ---------------------------------------------------------------- errors
class ApiError(Exception):
    """An error for the page: HTTP status + a short code the page translates (API_ERRORS in app.js)."""

    def __init__(self, status, code):
        super().__init__(code)
        self.status = status
        self.code = code


def text_response(text, status):
    return Response(text, status, mimetype='text/plain')


@app.errorhandler(ApiError)
def _api_error(e):
    return text_response(e.code, e.status)


@app.errorhandler(HTTPException)
def _http_error(e):
    if e.code == 413:
        return text_response('too_large', 413)
    if request.path.startswith('/api/'):
        codes = {400: 'bad_request', 404: 'not_found', 405: 'method_not_allowed'}
        return text_response(codes.get(e.code, 'error'), e.code)
    return e


@app.errorhandler(Exception)
def _server_error(e):
    log.exception('HATA %s %s', request.method, request.path)
    return text_response('server_error', 500)


# ---------------------------------------------------------------- time
def iso(d):
    d = d.astimezone(dt.timezone.utc)
    return d.strftime('%Y-%m-%dT%H:%M:%S.') + f'{d.microsecond // 1000:03d}Z'


def now_iso():
    return iso(dt.datetime.now(dt.timezone.utc))


def parse_iso(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        d = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


def is_past(value):
    d = parse_iso(value)
    return d is not None and d < dt.datetime.now(dt.timezone.utc)


def is_closed(status):
    return status in ('cozuldu', 'kapandi')


# ---------------------------------------------------------------- database
def connect():
    conn = sqlite3.connect(DATABASE_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def db():
    if 'db' not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def _close_db(exc):
    conn = g.pop('db', None)
    if conn is not None:
        conn.close()


# API field name -> SQL column. kind: text | memo (long text) | num | bool
Field = namedtuple('Field', 'js col kind')


def F(js, col, kind='text'):
    return Field(js, col, kind)


COLLECTIONS = {
    'screens': ('ekranlar', [
        F('durakNo', 'durak_no'), F('yon', 'yon'), F('durakId', 'durak_id'), F('durakAdi', 'durak_adi'),
        F('adres', 'adres'), F('bolgeKod', 'bolge_kod'), F('binaIdNo', 'bina_id_no'), F('dysOnayNo', 'dys_onay_no'),
        F('enerjiBilgisi', 'enerji_bilgisi'), F('elektrikKaynagi', 'elektrik_kaynagi'), F('ekranTipi', 'ekran_tipi'),
        F('simNo', 'sim_no'), F('enlem', 'enlem', 'num'), F('boylam', 'boylam', 'num'),
        F('kontrolTarihi', 'kontrol_tarihi'), F('ozelNot', 'ozel_not', 'memo'), F('model', 'model'),
        F('serialNo', 'seri_no'), F('installDate', 'kurulum_tarihi'), F('status', 'durum'),
        F('createdAt', 'olusturma'), F('updatedAt', 'guncelleme')]),
    'technicians': ('teknisyenler', [
        F('name', 'ad_soyad'), F('phone', 'telefon'), F('active', 'aktif', 'bool'),
        F('createdAt', 'olusturma'), F('updatedAt', 'guncelleme')]),
    'materials': ('malzemeler', [
        F('name', 'ad'), F('unit', 'birim'), F('createdAt', 'olusturma'), F('updatedAt', 'guncelleme')]),
    'tasks': ('isler', [
        F('title', 'baslik'), F('type', 'tur'), F('priority', 'oncelik'), F('status', 'durum'),
        F('screenId', 'ekran_id'), F('assignedTechnicianId', 'teknisyen_id'), F('serviceDayType', 'servis_gunu'),
        F('description', 'aciklama', 'memo'), F('createdAt', 'olusturma'), F('updatedAt', 'guncelleme'),
        F('resolvedAt', 'cozulme'), F('dueDate', 'son_tarih')]),
}


def to_db(value, kind):
    """Validates a value from the page. Empty strings are stored as NULL, so "not filled in" has one form."""
    if kind == 'bool':
        return 1 if value is True else 0
    if value is None or value == '':
        return None
    if kind == 'num':
        if isinstance(value, bool):
            raise ApiError(400, 'bad_value')
        try:
            number = float(value.strip().replace(',', '.')) if isinstance(value, str) else float(value)
        except (TypeError, ValueError):
            raise ApiError(400, 'bad_value')
        if not math.isfinite(number):
            raise ApiError(400, 'bad_value')
        return number
    if isinstance(value, (dict, list)):
        raise ApiError(400, 'bad_value')
    text = str(value)
    if len(text) > (MAX_MEMO if kind == 'memo' else MAX_TEXT):
        raise ApiError(400, 'too_long')
    return text


def from_db(value, kind):
    if kind == 'bool':
        return bool(value)
    if value is None:
        return None
    if kind == 'num':
        return float(value)
    return str(value)


def check_id(value):
    if not isinstance(value, str) or not ID_RE.match(value):
        raise ApiError(400, 'bad_id')
    return value


def json_body():
    if not request.is_json:
        raise ApiError(415, 'json_expected')
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise ApiError(400, 'bad_body')
    return body


def json_list_response(data):
    """JSON with an ETag: the page polls every few seconds and gets an empty 304 while nothing changed."""
    body = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    tag = hashlib.sha1(body).hexdigest()
    if request.if_none_match.contains(tag):
        resp = Response(status=304)
    else:
        resp = Response(body, mimetype='application/json')
    resp.set_etag(tag)
    resp.headers['Cache-Control'] = 'private, no-store'
    return resp


# ---------------------------------------------------------------- schema and first data
def sync_schema(conn):
    """Runs schema.sql (all IF NOT EXISTS) and adds columns that were added to a table later."""
    with open(SCHEMA_PATH, encoding='utf-8') as fh:
        lines = [ln for ln in fh.read().splitlines() if not ln.strip().startswith('--')]
    for stmt in '\n'.join(lines).split(';'):
        stmt = stmt.strip()
        if not stmt:
            continue
        conn.execute(stmt)
        m = re.match(r'CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+\[(\w+)\]', stmt, re.I)
        if not m:
            continue
        table = m.group(1)
        have = {row[1] for row in conn.execute(f'PRAGMA table_info([{table}])')}
        for line in stmt.splitlines():
            cm = re.match(r'\s*\[(\w+)\]\s+(.+?),?\s*$', line)
            if not cm or cm.group(1) in have:
                continue
            # ADD COLUMN cannot add a key, nor NOT NULL without a default; such columns start out empty.
            ctype = re.sub(r'\s+PRIMARY\s+KEY(\s+AUTOINCREMENT)?', '', cm.group(2), flags=re.I)
            if 'DEFAULT' not in ctype.upper():
                ctype = re.sub(r'\s+NOT\s+NULL', '', ctype, flags=re.I)
            conn.execute(f'ALTER TABLE [{table}] ADD COLUMN [{cm.group(1)}] {ctype.strip()}')
            log.info('sutun eklendi: %s.%s', table, cm.group(1))


def insert_record(conn, name, rid, body):
    table, fields = COLLECTIONS[name]
    cols = ', '.join(f'[{f.col}]' for f in fields)
    marks = ', '.join('?' for _ in fields)
    values = [to_db(body.get(f.js), f.kind) for f in fields]
    conn.execute(f'INSERT INTO [{table}] ([id], {cols}) VALUES (?, {marks})', [rid, *values])


def import_seed(conn):
    """Loads seed/*.json into an empty database (screens from the Excel list, the materials catalog)."""
    for name, filename in (('screens', 'screens.json'), ('materials', 'materials.json')):
        path = os.path.join(SEED_DIR, filename)
        if not os.path.exists(path):
            continue
        with open(path, encoding='utf-8') as fh:
            records = json.load(fh)
        for rec in records:
            insert_record(conn, name, check_id(rec['id']), rec)
        log.info('ilk veri: %s kayit (%s)', len(records), name)


def seed_once(conn):
    if conn.execute("SELECT 1 FROM [ayarlar] WHERE [anahtar]='ilk_veri'").fetchone():
        return
    has_data = any(conn.execute(f'SELECT 1 FROM [{t}] LIMIT 1').fetchone() for t in ('ekranlar', 'malzemeler', 'isler'))
    if not has_data:
        import_seed(conn)
    conn.execute("INSERT OR REPLACE INTO [ayarlar] ([anahtar],[deger]) VALUES ('ilk_veri', ?)", (now_iso(),))


def ensure_admin(conn):
    """ADMIN_USERNAME is the one system administrator; created with ADMIN_PASSWORD if missing.
    Changing ADMIN_PASSWORD later resets the administrator's password to it (for a forgotten password)."""
    username = (os.environ.get('ADMIN_USERNAME') or '').strip().lower()
    password = os.environ.get('ADMIN_PASSWORD') or ''
    if not username:
        return
    if not USERNAME_RE.match(username):
        log.error('ADMIN_USERNAME gecersiz (3-40 karakter; kucuk harf, rakam, . _ -): yonetici ayarlanmadi.')
        return
    row = conn.execute('SELECT * FROM [kullanicilar] WHERE [kullanici_adi]=?', (username,)).fetchone()
    if row is None and not password:
        log.warning('ADMIN_PASSWORD tanimli degil: yonetici hesabi olusturulmadi.')
        return
    mark = conn.execute("SELECT [deger] FROM [ayarlar] WHERE [anahtar]='yonetici_sifre_izi'").fetchone()
    changed = bool(password) and (mark is None or not check_password_hash(mark[0], password))
    if row is None:
        conn.execute(
            'INSERT INTO [kullanicilar] ([id],[kullanici_adi],[ad],[soyad],[calisan_turu],[yonetici],[aktif],'
            '[sifre_ozeti],[sifre_degismeli],[oturum_surumu],[olusturma]) VALUES (?,?,?,?,?,1,1,?,1,0,?)',
            ('u_' + uuid.uuid4().hex[:16], username, 'Sistem', 'Yöneticisi', 'kurum',
             generate_password_hash(password), now_iso()))
        log.info('sistem yoneticisi olusturuldu: %s (ilk giriste sifre degistirilecek)', username)
    elif changed and mark is not None:
        conn.execute('UPDATE [kullanicilar] SET [sifre_ozeti]=?, [sifre_degismeli]=1, [oturum_surumu]=[oturum_surumu]+1 '
                     'WHERE [id]=?', (generate_password_hash(password), row['id']))
        log.info('ADMIN_PASSWORD degismis: yonetici sifresi sifirlandi (%s)', username)
    if changed:
        conn.execute("INSERT OR REPLACE INTO [ayarlar] ([anahtar],[deger]) VALUES ('yonetici_sifre_izi', ?)",
                     (generate_password_hash(password),))
    conn.execute('UPDATE [kullanicilar] SET [yonetici]=0 WHERE [kullanici_adi]<>? AND [yonetici]<>0', (username,))
    conn.execute('UPDATE [kullanicilar] SET [yonetici]=1, [aktif]=1 WHERE [kullanici_adi]=?', (username,))


def init_db():
    os.makedirs(os.path.dirname(DATABASE_PATH), exist_ok=True)
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    conn = connect()
    try:
        conn.isolation_level = None  # explicit transaction below
        # Rollback-journal mode; WAL is not suitable for PythonAnywhere's network file system.
        conn.execute('PRAGMA journal_mode=DELETE')
        conn.execute('BEGIN IMMEDIATE')
        try:
            sync_schema(conn)
            seed_once(conn)
            ensure_admin(conn)
            conn.execute('COMMIT')
        except BaseException:
            conn.execute('ROLLBACK')
            raise
    finally:
        conn.close()


# ---------------------------------------------------------------- users, passwords, sessions
_TR_ASCII = str.maketrans('çğıöşüÇĞİÖŞÜ', 'cgiosuCGIOSU')
COMMON_PASSWORDS = {
    '12345678', '123456789', '1234567890', '87654321', '11111111', '00000000', '12341234', '11223344',
    'password', 'password1', 'password12', 'password123', 'passw0rd', 'qwerty12', 'qwerty123', 'qwertyui',
    'asdf1234', 'asdfgh12', 'abc12345', 'abcd1234', 'a1234567', 'a12345678', '1q2w3e4r', '1qaz2wsx', 'q1w2e3r4',
    'zaq12wsx', 'iloveyou1', 'welcome1', 'admin123', 'admin1234', 'administrator1', 'letmein1', 'test1234',
    'sifre123', 'sifre1234', 'parola123', 'parola1234', 'sifre12345', 'konya123', 'konya1234', 'konya42',
    'durak123', 'durak1234', 'ekran123', 'kullanici1', 'yonetici1', 'galatasaray1', 'fenerbahce1', 'besiktas1',
    'trabzonspor1', 'konyaspor1', 'turkiye1', 'istanbul1', 'ankara06', 'merhaba1', 'deneme123', 'deneme1',
}


def fold(text):
    """Lowercase ASCII form for comparisons: 'Yılmaz' and 'YILMAZ' both become 'yilmaz'."""
    return (text or '').translate(_TR_ASCII).lower()


def check_password_policy(password, username, first_name, last_name):
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ApiError(400, 'password_too_short')
    if len(password) > 128:
        raise ApiError(400, 'too_long')
    if not re.search(r'[^\W\d_]', password) or not re.search(r'\d', password):
        raise ApiError(400, 'password_weak')
    folded = fold(password)
    personal = {fold(username), *re.split(r'[._-]+', fold(username)), fold(first_name), fold(last_name)}
    personal.update(fold(part) for name in (first_name, last_name) for part in (name or '').split())
    if any(len(p) >= 3 and p in folded for p in personal):
        raise ApiError(400, 'password_personal')
    if folded in COMMON_PASSWORDS or len(set(folded)) <= 2:
        raise ApiError(400, 'password_common')


def temporary_password():
    """10 characters without look-alikes (no l/1, o/0); always has a letter and a digit."""
    letters, digits = 'abcdefghjkmnpqrstuvwxyz', '23456789'
    while True:
        pw = ''.join(secrets.choice(letters + digits) for _ in range(10))
        if any(c in digits for c in pw) and any(c in letters for c in pw):
            return pw


def user_json(row):
    first, last = row['ad'] or '', row['soyad'] or ''
    return {
        'id': row['id'], 'username': row['kullanici_adi'],
        'firstName': first, 'lastName': last, 'fullName': f'{first} {last}'.strip(),
        'orgType': row['calisan_turu'], 'isAdmin': bool(row['yonetici']), 'active': bool(row['aktif']),
        'mustChangePassword': bool(row['sifre_degismeli']),
        'createdAt': row['olusturma'], 'lastLoginAt': row['son_giris'],
    }


def load_user():
    """The session's user, or None. A session ends when its user is deactivated or its password reset
    (oturum_surumu goes up)."""
    if 'user' in g:
        return g.user
    g.user = None
    uid = session.get('uid')
    if uid:
        row = db().execute('SELECT * FROM [kullanicilar] WHERE [id]=?', (uid,)).fetchone()
        if row and row['aktif'] and row['oturum_surumu'] == session.get('sv'):
            g.user = user_json(row)
        else:
            session.pop('uid', None)
            session.pop('sv', None)
    return g.user


def login_required(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        user = load_user()
        if not user:
            raise ApiError(401, 'unauthorized')
        if user['mustChangePassword']:
            raise ApiError(403, 'password_change_required')
        return fn(*args, **kwargs)
    return wrapper


def admin_required(fn):
    @login_required
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        if not g.user['isAdmin']:
            raise ApiError(403, 'forbidden')
        return fn(*args, **kwargs)
    return wrapper


def csrf_token():
    token = session.get('csrf')
    if not token:
        token = session['csrf'] = secrets.token_urlsafe(32)
    return token


@app.before_request
def _csrf_protect():
    # Every write needs the token the page got from /api/auth/csrf (sent in the X-CSRF-Token header).
    if request.method in ('POST', 'PUT', 'PATCH', 'DELETE'):
        token = session.get('csrf')
        sent = request.headers.get('X-CSRF-Token', '')
        if not token or not hmac.compare_digest(token.encode(), sent.encode()):
            raise ApiError(403, 'csrf')


@app.after_request
def _security_headers(resp):
    resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
    resp.headers.setdefault('X-Frame-Options', 'DENY')
    resp.headers.setdefault('Referrer-Policy', 'same-origin')
    resp.headers.setdefault('Content-Security-Policy', CSP)
    return resp


def safe_next(value):
    """Only a path on this site: '/...' but not '//host' or '/\\host' (no open redirect)."""
    if not isinstance(value, str) or not value or len(value) > 500:
        return None
    if not value.startswith('/') or value.startswith('//') or any(c in value for c in '\\\r\n\t'):
        return None
    parts = urlsplit(value)
    if parts.scheme or parts.netloc:
        return None
    return value


_failed_logins = {}
_dummy_hash = generate_password_hash(secrets.token_hex(16))


def _recent_failures(username):
    cutoff = time.monotonic() - LOGIN_WINDOW_SECONDS
    fails = [t for t in _failed_logins.get(username, []) if t > cutoff]
    if fails:
        _failed_logins[username] = fails
    else:
        _failed_logins.pop(username, None)
    return fails


@app.get('/api/auth/csrf')
def auth_csrf():
    return jsonify(csrfToken=csrf_token())


@app.post('/api/auth/login')
def auth_login():
    body = json_body()
    username = str(body.get('username') or '').strip().lower()[:64]
    password = str(body.get('password') or '')
    if len(_recent_failures(username)) >= LOGIN_MAX_FAILURES:
        raise ApiError(429, 'too_many_attempts')
    row = db().execute('SELECT * FROM [kullanicilar] WHERE [kullanici_adi]=?', (username,)).fetchone()
    # A hash is checked even for unknown names, so response time does not reveal which names exist.
    valid = check_password_hash(row['sifre_ozeti'] if row and row['sifre_ozeti'] else _dummy_hash, password)
    if not (row and valid and row['aktif']):
        if len(_failed_logins) > 5000:
            _failed_logins.clear()
        _failed_logins.setdefault(username, []).append(time.monotonic())
        raise ApiError(401, 'invalid_credentials')
    _failed_logins.pop(username, None)
    session.clear()  # new session id-equivalent: nothing from before the login carries over
    session.permanent = True
    session['uid'] = row['id']
    session['sv'] = row['oturum_surumu']
    conn = db()
    with conn:
        conn.execute('UPDATE [kullanicilar] SET [son_giris]=? WHERE [id]=?', (now_iso(), row['id']))
    log.info('giris: %s', username)
    return jsonify({**user_json(row), 'csrfToken': csrf_token(), 'next': safe_next(body.get('next'))})


@app.post('/api/auth/logout')
def auth_logout():
    session.clear()
    return jsonify(ok=True)


@app.get('/api/auth/me')
def auth_me():
    user = load_user()
    if not user:
        raise ApiError(401, 'unauthorized')
    return jsonify({**user, 'csrfToken': csrf_token()})


@app.post('/api/auth/change-password')
def auth_change_password():
    user = load_user()
    if not user:
        raise ApiError(401, 'unauthorized')
    body = json_body()
    current = str(body.get('currentPassword') or '')
    new = str(body.get('newPassword') or '')
    conn = db()
    row = conn.execute('SELECT * FROM [kullanicilar] WHERE [id]=?', (user['id'],)).fetchone()
    if not check_password_hash(row['sifre_ozeti'] or _dummy_hash, current):
        raise ApiError(400, 'wrong_password')
    if new == current:
        raise ApiError(400, 'password_same')
    check_password_policy(new, row['kullanici_adi'], row['ad'], row['soyad'])
    version = row['oturum_surumu'] + 1
    with conn:
        conn.execute('UPDATE [kullanicilar] SET [sifre_ozeti]=?, [sifre_degismeli]=0, [oturum_surumu]=? WHERE [id]=?',
                     (generate_password_hash(new), version, row['id']))
    # Other browsers signed in as this user are logged out; this one stays.
    session['sv'] = version
    return jsonify({**user, 'mustChangePassword': False, 'csrfToken': csrf_token()})


@app.get('/login')
def login_page():
    target = safe_next(request.args.get('next'))
    return redirect('/?next=' + quote(target, safe='/') if target else '/')


# ---------------------------------------------------------------- users (system administrator only)
def check_user_fields(first, last, org):
    if not first or not last:
        raise ApiError(400, 'name_required')
    if len(first) > 100 or len(last) > 100:
        raise ApiError(400, 'too_long')
    if org not in ORG_TYPES:
        raise ApiError(400, 'bad_org_type')


@app.get('/api/users')
@admin_required
def users_list():
    rows = db().execute('SELECT * FROM [kullanicilar] ORDER BY [ad], [soyad]').fetchall()
    return json_list_response([user_json(r) for r in rows])


@app.post('/api/users')
@admin_required
def users_create():
    body = json_body()
    username = str(body.get('username') or '').strip().lower()
    first = str(body.get('firstName') or '').strip()
    last = str(body.get('lastName') or '').strip()
    org = body.get('orgType')
    check_user_fields(first, last, org)
    if not USERNAME_RE.match(username):
        raise ApiError(400, 'bad_username')
    conn = db()
    if conn.execute('SELECT 1 FROM [kullanicilar] WHERE [kullanici_adi]=?', (username,)).fetchone():
        raise ApiError(409, 'username_taken')
    uid = 'u_' + uuid.uuid4().hex[:16]
    password = temporary_password()
    # New users never get user-management rights; that stays with the system administrator.
    with conn:
        conn.execute(
            'INSERT INTO [kullanicilar] ([id],[kullanici_adi],[ad],[soyad],[calisan_turu],[yonetici],[aktif],'
            '[sifre_ozeti],[sifre_degismeli],[oturum_surumu],[olusturma]) VALUES (?,?,?,?,?,0,1,?,1,0,?)',
            (uid, username, first, last, org, generate_password_hash(password), now_iso()))
    log.info('kullanici eklendi: %s (%s)', username, g.user['username'])
    return jsonify(ok=True, id=uid, username=username, tempPassword=password)


@app.patch('/api/users/<uid>')
@admin_required
def users_update(uid):
    check_id(uid)
    body = json_body()
    conn = db()
    row = conn.execute('SELECT * FROM [kullanicilar] WHERE [id]=?', (uid,)).fetchone()
    if not row:
        raise ApiError(404, 'not_found')
    cur = user_json(row)
    first = str(body['firstName']).strip() if 'firstName' in body else cur['firstName']
    last = str(body['lastName']).strip() if 'lastName' in body else cur['lastName']
    org = body['orgType'] if 'orgType' in body else cur['orgType']
    active = body['active'] is True if 'active' in body else cur['active']
    check_user_fields(first, last, org)
    # The administrator flag cannot be changed here, and the administrator account cannot be deactivated.
    if cur['isAdmin'] and not active:
        raise ApiError(409, 'last_admin')
    bump = 1 if cur['active'] and not active else 0
    with conn:
        conn.execute('UPDATE [kullanicilar] SET [ad]=?, [soyad]=?, [calisan_turu]=?, [aktif]=?, '
                     '[oturum_surumu]=[oturum_surumu]+? WHERE [id]=?', (first, last, org, int(active), bump, uid))
    return jsonify(ok=True)


@app.post('/api/users/<uid>/reset-password')
@admin_required
def users_reset_password(uid):
    check_id(uid)
    if uid == g.user['id']:
        raise ApiError(400, 'self_reset')
    conn = db()
    if not conn.execute('SELECT 1 FROM [kullanicilar] WHERE [id]=?', (uid,)).fetchone():
        raise ApiError(404, 'not_found')
    password = temporary_password()
    with conn:
        conn.execute('UPDATE [kullanicilar] SET [sifre_ozeti]=?, [sifre_degismeli]=1, [oturum_surumu]=[oturum_surumu]+1 '
                     'WHERE [id]=?', (generate_password_hash(password), uid))
    log.info('sifre sifirlandi: %s (%s)', uid, g.user['username'])
    return jsonify(ok=True, tempPassword=password)


# ---------------------------------------------------------------- collections: screens, technicians, materials, tasks
def task_children(conn):
    kids = {}

    def entry(tid):
        return kids.setdefault(tid, {'usedMaterials': [], 'history': [], 'photos': [], 'extensions': []})

    for r in conn.execute('SELECT [is_id],[malzeme_id],[miktar] FROM [is_malzemeleri] ORDER BY [id]'):
        entry(r['is_id'])['usedMaterials'].append({'materialId': r['malzeme_id'], 'qty': from_db(r['miktar'], 'num')})
    for r in conn.execute('SELECT [is_id],[zaman],[durum],[notlar],[yazan] FROM [is_gecmisi] ORDER BY [id]'):
        entry(r['is_id'])['history'].append({'ts': r['zaman'], 'status': r['durum'], 'note': r['notlar'], 'author': r['yazan']})
    for r in conn.execute('SELECT [id],[is_id],[tur],[dosya],[yukleme],[yukleyen] FROM [is_fotograflari] ORDER BY [id]'):
        entry(r['is_id'])['photos'].append({'id': r['id'], 'kind': r['tur'], 'url': '/uploads/' + r['dosya'],
                                            'ts': r['yukleme'], 'author': r['yukleyen']})
    for r in conn.execute('SELECT [is_id],[zaman],[eski_tarih],[yeni_tarih],[mazeret],[yazan] FROM [is_sure_uzatmalari] ORDER BY [id]'):
        entry(r['is_id'])['extensions'].append({'ts': r['zaman'], 'oldDue': r['eski_tarih'], 'newDue': r['yeni_tarih'],
                                                'reason': r['mazeret'], 'author': r['yazan']})
    return kids


def get_collection(name):
    table, fields = COLLECTIONS[name]
    conn = db()
    kids = task_children(conn) if name == 'tasks' else None
    out = []
    for row in conn.execute(f'SELECT * FROM [{table}] ORDER BY rowid'):
        rec = {'id': row['id']}
        for f in fields:
            rec[f.js] = from_db(row[f.col], f.kind)
        if kids is not None:
            rec.update(kids.get(row['id']) or {'usedMaterials': [], 'history': [], 'photos': [], 'extensions': []})
        out.append(rec)
    return out


def check_task_rules(conn, rid, body, row):
    """- a task tied to a screen needs before and after photos to become cozuldu/kapandi
       - once its deadline has passed, the deadline only moves through /extend (with an excuse)"""
    for key, allowed in (('type', TASK_TYPES), ('status', TASK_STATUSES), ('priority', TASK_PRIORITIES)):
        if body.get(key) is not None and body[key] not in allowed:
            raise ApiError(400, 'bad_value')
    old_status = row['durum'] if row else None
    new_status = body.get('status', old_status)
    if 'status' in body and is_closed(new_status) and not is_closed(old_status):
        screen_id = body['screenId'] if 'screenId' in body else (row['ekran_id'] if row else None)
        if screen_id:
            kinds = {r[0] for r in conn.execute('SELECT DISTINCT [tur] FROM [is_fotograflari] WHERE [is_id]=?', (rid,))}
            if not {'once', 'sonra'} <= kinds:
                raise ApiError(409, 'photos_required')
    if row and 'dueDate' in body:
        stored = row['son_tarih']
        if stored and (body['dueDate'] or None) != stored and is_past(stored):
            raise ApiError(409, 'due_locked')


def set_task_materials(conn, rid, items):
    if not isinstance(items, list):
        raise ApiError(400, 'bad_value')
    conn.execute('DELETE FROM [is_malzemeleri] WHERE [is_id]=?', (rid,))
    for item in items:
        if not isinstance(item, dict):
            raise ApiError(400, 'bad_value')
        conn.execute('INSERT INTO [is_malzemeleri] ([is_id],[malzeme_id],[miktar]) VALUES (?,?,?)',
                     (rid, check_id(item.get('materialId')), to_db(item.get('qty'), 'num')))


def append_task_history(conn, rid, entries):
    """History is append-only: entries already stored are kept as they are (with their author);
    new ones are stamped with the session user, whatever name the page sent."""
    if not isinstance(entries, list):
        raise ApiError(400, 'bad_value')
    known = {(r['zaman'] or '') + '|' + (r['notlar'] or '')
             for r in conn.execute('SELECT [zaman],[notlar] FROM [is_gecmisi] WHERE [is_id]=?', (rid,))}
    for h in entries:
        if not isinstance(h, dict):
            raise ApiError(400, 'bad_value')
        ts = to_db(h.get('ts'), 'text') or now_iso()
        note = to_db(h.get('note'), 'memo')
        key = ts + '|' + (note or '')
        if key in known:
            continue
        known.add(key)
        conn.execute('INSERT INTO [is_gecmisi] ([is_id],[zaman],[durum],[notlar],[yazan]) VALUES (?,?,?,?,?)',
                     (rid, ts, to_db(h.get('status'), 'text'), note, g.user['fullName']))


def remove_upload(filename):
    if filename and UPLOAD_NAME_RE.match(filename):
        try:
            os.remove(os.path.join(UPLOAD_DIR, filename))
        except FileNotFoundError:
            pass


@app.get('/api/<col>')
@login_required
def collection_list(col):
    if col not in COLLECTIONS:
        raise ApiError(404, 'unknown_collection')
    return json_list_response(get_collection(col))


@app.route('/api/<col>/<rid>', methods=['PUT', 'PATCH', 'DELETE'])
@login_required
def collection_record(col, rid):
    if col not in COLLECTIONS:
        raise ApiError(404, 'unknown_collection')
    check_id(rid)
    table, fields = COLLECTIONS[col]
    conn = db()
    row = conn.execute(f'SELECT * FROM [{table}] WHERE [id]=?', (rid,)).fetchone()

    if request.method == 'DELETE':
        files = []
        with conn:
            if col == 'tasks':
                files = [r[0] for r in conn.execute('SELECT [dosya] FROM [is_fotograflari] WHERE [is_id]=?', (rid,))]
                for child in ('is_malzemeleri', 'is_gecmisi', 'is_fotograflari', 'is_sure_uzatmalari'):
                    conn.execute(f'DELETE FROM [{child}] WHERE [is_id]=?', (rid,))
            conn.execute(f'DELETE FROM [{table}] WHERE [id]=?', (rid,))
        for f in files:
            remove_upload(f)
        return jsonify(ok=True)

    body = json_body()
    if request.method == 'PUT':
        # PUT creates a new record; changes go through PATCH, where the task rules apply.
        if row:
            raise ApiError(409, 'exists')
        if col == 'tasks':
            check_task_rules(conn, rid, body, None)
        with conn:
            insert_record(conn, col, rid, body)
            if col == 'tasks':
                set_task_materials(conn, rid, body.get('usedMaterials') or [])
                append_task_history(conn, rid, body.get('history') or [])
        return jsonify(ok=True)

    if not row:
        raise ApiError(404, 'not_found')
    if col == 'tasks':
        check_task_rules(conn, rid, body, row)
    present = [f for f in fields if f.js in body]
    values = [to_db(body[f.js], f.kind) for f in present]
    with conn:
        if present:
            assignments = ', '.join(f'[{f.col}]=?' for f in present)
            conn.execute(f'UPDATE [{table}] SET {assignments} WHERE [id]=?', [*values, rid])
        if col == 'tasks':
            if 'usedMaterials' in body:
                set_task_materials(conn, rid, body['usedMaterials'])
            if 'history' in body:
                append_task_history(conn, rid, body['history'])
    return jsonify(ok=True)


# ---------------------------------------------------------------- task photos and deadline extensions
def image_ext(data):
    if data[:3] == b'\xff\xd8\xff':
        return 'jpg'
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'webp'
    return None


@app.post('/api/tasks/<rid>/photos')
@login_required
def photo_add(rid):
    check_id(rid)
    kind = request.args.get('kind')
    if kind not in ('once', 'sonra'):
        raise ApiError(400, 'bad_kind')
    conn = db()
    if not conn.execute('SELECT 1 FROM [isler] WHERE [id]=?', (rid,)).fetchone():
        raise ApiError(404, 'not_found')
    data = request.get_data(cache=False)
    if len(data) > MAX_PHOTO_BYTES:
        raise ApiError(413, 'too_large')
    ext = image_ext(data)
    if not ext:
        raise ApiError(415, 'bad_image')
    filename = f'p_{uuid.uuid4().hex}.{ext}'
    with open(os.path.join(UPLOAD_DIR, filename), 'xb') as fh:
        fh.write(data)
    try:
        with conn:
            conn.execute('INSERT INTO [is_fotograflari] ([is_id],[tur],[dosya],[yukleme],[yukleyen]) VALUES (?,?,?,?,?)',
                         (rid, kind, filename, now_iso(), g.user['fullName']))
    except Exception:
        remove_upload(filename)
        raise
    return jsonify(ok=True, url='/uploads/' + filename)


@app.delete('/api/photos/<int:photo_id>')
@login_required
def photo_delete(photo_id):
    conn = db()
    row = conn.execute('SELECT f.[dosya], i.[durum] FROM [is_fotograflari] AS f LEFT JOIN [isler] AS i ON f.[is_id]=i.[id] '
                       'WHERE f.[id]=?', (photo_id,)).fetchone()
    if not row:
        raise ApiError(404, 'not_found')
    # Photos of a closed task are its evidence and cannot be removed.
    if is_closed(row['durum']):
        raise ApiError(409, 'task_closed')
    with conn:
        conn.execute('DELETE FROM [is_fotograflari] WHERE [id]=?', (photo_id,))
    remove_upload(row['dosya'])
    return jsonify(ok=True)


@app.post('/api/tasks/<rid>/extend')
@login_required
def task_extend(rid):
    check_id(rid)
    body = json_body()
    conn = db()
    row = conn.execute('SELECT [son_tarih] FROM [isler] WHERE [id]=?', (rid,)).fetchone()
    if not row:
        raise ApiError(404, 'not_found')
    stored = row['son_tarih']
    if not stored or not is_past(stored):
        raise ApiError(409, 'not_overdue')
    reason = str(body.get('reason') or '').strip()
    if len(reason) < 3:
        raise ApiError(400, 'reason_required')
    if len(reason) > MAX_MEMO:
        raise ApiError(400, 'too_long')
    new_due = parse_iso(body.get('newDue'))
    now = dt.datetime.now(dt.timezone.utc)
    if new_due is None or new_due <= now or new_due <= parse_iso(stored):
        raise ApiError(400, 'due_invalid')
    stamp, author = iso(now), g.user['fullName']
    with conn:
        conn.execute('UPDATE [isler] SET [son_tarih]=?, [guncelleme]=? WHERE [id]=?', (iso(new_due), stamp, rid))
        conn.execute('INSERT INTO [is_sure_uzatmalari] ([is_id],[zaman],[eski_tarih],[yeni_tarih],[mazeret],[yazan]) '
                     'VALUES (?,?,?,?,?,?)', (rid, stamp, stored, iso(new_due), reason, author))
        conn.execute('INSERT INTO [is_gecmisi] ([is_id],[zaman],[durum],[notlar],[yazan]) VALUES (?,?,?,?,?)',
                     (rid, stamp, None, to_db(body.get('note'), 'memo'), author))
    return jsonify(ok=True)


@app.get('/api/stats/storage')
@login_required
def storage_stats():
    photo_count = photo_bytes = 0
    with os.scandir(UPLOAD_DIR) as entries:
        for e in entries:
            if e.is_file():
                photo_count += 1
                photo_bytes += e.stat().st_size
    return jsonify(photoCount=photo_count, uploadBytes=photo_bytes, dbBytes=os.path.getsize(DATABASE_PATH),
                   quotaBytes=DISK_QUOTA_BYTES)


# ---------------------------------------------------------------- pages and files
@app.get('/healthz')
def healthz():
    try:
        db().execute('SELECT 1').fetchone()
    except sqlite3.Error:
        return text_response('db_error', 503)
    resp = text_response('ok', 200)
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@app.get('/uploads/<name>')
def uploads(name):
    user = load_user()
    if not user or user['mustChangePassword']:
        return redirect('/?next=' + quote(request.path, safe='/'))
    if not UPLOAD_NAME_RE.match(name):
        raise NotFound()
    resp = send_from_directory(UPLOAD_DIR, name, max_age=31536000)
    # Upload names are unique, so the browser may keep them; "private" keeps shared caches out.
    resp.headers['Cache-Control'] = 'private, max-age=31536000, immutable'
    return resp


def send_web(filename):
    resp = send_from_directory(WEB_DIR, filename, max_age=0)
    resp.headers['Cache-Control'] = 'no-cache'
    return resp


@app.get('/')
def index():
    return send_web('index.html')


@app.get('/<path:filename>')
def web_files(filename):
    return send_web(filename)


init_db()

if __name__ == '__main__':
    # Local trial only; on PythonAnywhere the WSGI file imports `app`.
    app.run(host='127.0.0.1', port=int(os.environ.get('PORT') or 5000))
