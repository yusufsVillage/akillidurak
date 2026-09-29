"""Akıllı Durak Takip: akıllı durak ekranları iş takip sistemi (Flask + sqlite3).

WSGI girişi:  from app import app as application
Ayarlar yalnızca ortam değişkenlerinden okunur (README.md > Ortam değişkenleri).
Sayfa (web/) tek sayfalık bir uygulamadır; veriyi /api/ altındaki JSON uçlarından alır.
"""
import datetime as dt
import functools
import hashlib
import hmac
import html
import json
import logging
import math
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
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
MAX_PHOTOS_PER_TASK = 20
DISK_QUOTA_BYTES = 512 * 1024 * 1024  # PythonAnywhere free plan, whole account
DISK_GUARD_BYTES = 450 * 1024 * 1024  # photos + database; uploads stop here so the database can still grow
SESSION_HOURS = 12                    # idle limit (renewed while used)
SESSION_MAX_DAYS = 30                 # absolute limit from login, however much the session is used
LOGIN_MAX_FAILURES = 10               # per visitor address and user name
LOGIN_MAX_FAILURES_PER_USER = 50      # per user name from all addresses
LOGIN_MAX_FAILURES_PER_IP = 100       # per visitor address over all user names
LOGIN_WINDOW_SECONDS = 15 * 60
MIN_PASSWORD_LENGTH = 8
MAX_TEXT = 500
MAX_MEMO = 10000

ID_RE = re.compile(r'^[A-Za-z0-9_.~:@+\-]{1,64}$')
USERNAME_RE = re.compile(r'^[a-z0-9._-]{3,40}$')
UPLOAD_NAME_RE = re.compile(r'^[A-Za-z0-9_\-]+\.(jpg|png|webp)$')

TASK_TYPES = {'ekran_ariza', 'yazilim_ariza', 'altyapi'}
OLD_TASK_TYPES = {'ariza': 'ekran_ariza', 'icerik': 'yazilim_ariza', 'genel': 'altyapi'}  # names before 2026-09-29
TASK_DURATION = dt.timedelta(hours=48)  # every job's deadline, counted from when it is opened
# Needed to open a job, and cannot be emptied later.
REQUIRED_TASK_FIELDS = ('type', 'screenId', 'assignedTechnicianId', 'serviceDayType', 'description')
# Cannot be changed once the job is opened (only the description stays editable). An older job that lacks
# one of them may get it once.
FIXED_TASK_FIELDS = (('type', 'tur'), ('screenId', 'ekran_id'), ('assignedTechnicianId', 'teknisyen_id'),
                     ('serviceDayType', 'servis_gunu'))
SERVICE_DAYS = {'haftaici', 'haftasonu'}
# A job is İşlemde from the moment it is opened until it is closed.
TASK_STATUSES = {'islemde', 'kapandi'}
OLD_TASK_STATUSES = {'acik': 'islemde', 'atandi': 'islemde', 'cozuldu': 'kapandi'}  # before 2026-09-29
TASK_PRIORITIES = {'dusuk', 'orta', 'yuksek', 'acil'}
ORG_TYPES = {'kurum', 'firma'}

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('durakops')

app = Flask(__name__, static_folder=None)

_secret = os.environ.get('SECRET_KEY')
if not _secret:
    _secret = secrets.token_hex(32)
    log.warning('SECRET_KEY tanimli degil: gecici bir anahtar uretildi; uygulama her yeniden basladiginda oturumlar kapanir.')
elif len(_secret) < 32:
    log.warning('SECRET_KEY cok kisa (%s karakter): en az 32 karakterlik rastgele bir deger kullanin.', len(_secret))

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
        F('adres', 'adres'), F('bolgeKod', 'bolge_kod'),
        F('enerjiBilgisi', 'enerji_bilgisi'), F('elektrikKaynagi', 'elektrik_kaynagi'), F('ekranTipi', 'ekran_tipi'),
        F('simNo', 'sim_no'), F('imei', 'imei', 'imei'), F('enlem', 'enlem', 'num'), F('boylam', 'boylam', 'num'),
        F('kontrolTarihi', 'kontrol_tarihi', 'date'), F('ozelNot', 'ozel_not', 'memo'), F('model', 'model'),
        F('serialNo', 'seri_no'), F('installDate', 'kurulum_tarihi', 'date'), F('status', 'durum'),
        F('createdAt', 'olusturma', 'date'), F('updatedAt', 'guncelleme', 'date')]),
    'materials': ('malzemeler', [
        F('name', 'ad'), F('unit', 'birim'), F('createdAt', 'olusturma', 'date'), F('updatedAt', 'guncelleme', 'date')]),
    'tasks': ('isler', [
        F('title', 'baslik'), F('type', 'tur'), F('priority', 'oncelik'), F('status', 'durum'),
        # The job's technician: a user id (users are the technicians plus the system administrator).
        F('screenId', 'ekran_id'), F('assignedTechnicianId', 'teknisyen_id'), F('serviceDayType', 'servis_gunu'),
        F('description', 'aciklama', 'memo'), F('createdAt', 'olusturma', 'date'), F('updatedAt', 'guncelleme', 'date'),
        F('resolvedAt', 'cozulme', 'date'), F('dueDate', 'son_tarih', 'date'), F('no', 'is_no', 'int')]),
}
# Given by the server, never taken from the page.
READONLY_FIELDS = {'no'}


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
    if kind == 'imei':  # stored as 15 digits; spaces and dashes as printed on labels are dropped
        digits = re.sub(r'[\s\-]', '', str(value))
        if not digits:
            return None
        if not imei_ok(digits):
            raise ApiError(400, 'bad_imei')
        return digits
    if kind == 'date':  # ISO date or date-time, as the page sends them (2026-09-28 or 2026-09-28T10:00:00.000Z)
        text = str(value)
        if len(text) > 40 or parse_iso(text) is None:
            raise ApiError(400, 'bad_value')
        return text
    text = str(value)
    if len(text) > (MAX_MEMO if kind == 'memo' else MAX_TEXT):
        raise ApiError(400, 'too_long')
    return text


def imei_ok(digits):
    """15 digits whose last one is the Luhn check digit, as in every real IMEI; catches most typing mistakes."""
    if not re.fullmatch(r'\d{15}', digits):
        return False
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
    return total % 10 == 0


def from_db(value, kind):
    if kind == 'bool':
        return bool(value)
    if value is None:
        return None
    if kind == 'num':
        return float(value)
    if kind == 'int':
        return int(value)
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
        # Drop comments, whole-line and trailing ones (the schema has no "--" inside strings).
        lines = [ln.split('--', 1)[0].rstrip() for ln in fh.read().splitlines()]
        lines = [ln for ln in lines if ln.strip()]
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
    fields = [f for f in fields if f.js not in READONLY_FIELDS]
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


def migrate_technicians(conn):
    """Jobs used to be assigned to a separate technician list; now they are assigned to users.
    An old technician id is moved to the user with the same name; unmatched ones show as unassigned."""
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='teknisyenler'").fetchone():
        return
    by_name = {' '.join(fold(f"{r['ad'] or ''} {r['soyad'] or ''}").split()): r['id']
               for r in conn.execute('SELECT [id],[ad],[soyad] FROM [kullanicilar]')}
    old = conn.execute('SELECT DISTINCT i.[teknisyen_id] AS tid, t.[ad_soyad] AS name FROM [isler] AS i '
                       'JOIN [teknisyenler] AS t ON t.[id] = i.[teknisyen_id]').fetchall()
    for row in old:
        uid = by_name.get(' '.join(fold(row['name']).split()))
        if uid:
            conn.execute('UPDATE [isler] SET [teknisyen_id]=? WHERE [teknisyen_id]=?', (uid, row['tid']))
            log.info('eski teknisyen atamasi kullaniciya baglandi: %s', row['tid'])


def number_tasks(conn):
    """Jobs from before job numbers existed get the next numbers, oldest first."""
    rows = conn.execute('SELECT [id] FROM [isler] WHERE [is_no] IS NULL ORDER BY [olusturma], rowid').fetchall()
    if not rows:
        return
    start = conn.execute('SELECT COALESCE(MAX([is_no]), 0) FROM [isler]').fetchone()[0]
    for n, row in enumerate(rows, start + 1):
        conn.execute('UPDATE [isler] SET [is_no]=? WHERE [id]=?', (n, row[0]))
    log.info('is numarasi verildi: %s is', len(rows))


def migrate_types_and_deadlines(conn):
    """2026-09-29: job types renamed (Arıza → Ekran Arıza, İçerik → Yazılım Arıza, Genel → Altyapı İşi), only two
    statuses left (Açık/Atandı/İşlemde → İşlemde, Çözüldü/Kapandı → Kapandı) and every job has a 48-hour deadline.
    Open jobs without one get it once, counted from the update, so none turns overdue at that moment. Job history
    keeps the statuses it was written with."""
    for old, new in OLD_TASK_TYPES.items():
        conn.execute('UPDATE [isler] SET [tur]=? WHERE [tur]=?', (new, old))
    for old, new in OLD_TASK_STATUSES.items():
        conn.execute('UPDATE [isler] SET [durum]=? WHERE [durum]=?', (new, old))
    conn.execute("UPDATE [isler] SET [durum]='islemde' WHERE [durum] IS NULL OR [durum]=''")
    if conn.execute("SELECT 1 FROM [ayarlar] WHERE [anahtar]='sure_48'").fetchone():
        return
    now = dt.datetime.now(dt.timezone.utc)
    n = conn.execute("UPDATE [isler] SET [son_tarih]=? WHERE [son_tarih] IS NULL AND [durum] <> 'kapandi'",
                     (iso(now + TASK_DURATION),)).rowcount
    conn.execute("INSERT OR REPLACE INTO [ayarlar] ([anahtar],[deger]) VALUES ('sure_48', ?)", (iso(now),))
    if n:
        log.info('48 saat son tarih verildi: %s acik is', n)


def clear_removed_screen_fields(conn):
    """2026-09-29: Bina ID No and DYS Onay No were removed from screens (IMEI took their place). Databases made
    before still have the columns; their values are emptied so the information is gone, not just hidden."""
    have = {r[1] for r in conn.execute('PRAGMA table_info([ekranlar])')}
    for col in ('bina_id_no', 'dys_onay_no'):
        if col in have:
            n = conn.execute(f'UPDATE [ekranlar] SET [{col}]=NULL WHERE [{col}] IS NOT NULL').rowcount
            if n:
                log.info('ekranlar.%s bosaltildi: %s ekran', col, n)


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
            migrate_technicians(conn)
            number_tasks(conn)
            migrate_types_and_deadlines(conn)
            clear_removed_screen_fields(conn)
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
        # Absolute limit: a session kept alive by use (the idle limit renews) still ends SESSION_MAX_DAYS after login.
        issued = session.get('iat')
        if issued is None:
            session['iat'] = int(time.time())  # sessions from before this limit start counting now
        elif time.time() - issued > SESSION_MAX_DAYS * 86400:
            session.clear()
            return None
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


def is_company_user(user):
    """A contractor's employee (firma çalışanı, not the administrator): works on jobs, but does not manage screens
    or the materials catalogue and does not see reports. Jobs still read screens and materials."""
    return bool(user) and not user['isAdmin'] and user['orgType'] == 'firma'


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
    # API answers carry personal data and one-time passwords: keep them out of the browser cache.
    if request.path.startswith('/api/') and 'Cache-Control' not in resp.headers:
        resp.headers['Cache-Control'] = 'no-store'
    if app.config['SESSION_COOKIE_SECURE']:  # served over HTTPS: tell browsers never to use plain HTTP here
        resp.headers.setdefault('Strict-Transport-Security', 'max-age=31536000')
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


_failed_logins = {}  # key -> times of recent failed attempts (this process)
_dummy_hash = generate_password_hash(secrets.token_hex(16))


def client_ip():
    """Behind PythonAnywhere's proxy the visitor's address comes in X-Real-IP, set by the proxy itself."""
    if os.environ.get('PYTHONANYWHERE_DOMAIN'):
        return request.headers.get('X-Real-IP') or request.remote_addr or '?'
    return request.remote_addr or '?'


def _recent_failures(key):
    cutoff = time.monotonic() - LOGIN_WINDOW_SECONDS
    fails = [t for t in _failed_logins.get(key, ()) if t > cutoff]
    if fails:
        _failed_logins[key] = fails
    else:
        _failed_logins.pop(key, None)
    return len(fails)


def _note_failure(*keys):
    if len(_failed_logins) > 10000:
        # Forget expired and small counts; never an entry that is blocking someone right now.
        for key in list(_failed_logins):
            if _recent_failures(key) < LOGIN_MAX_FAILURES:
                _failed_logins.pop(key, None)
    stamp = time.monotonic()
    for key in keys:
        _failed_logins.setdefault(key, []).append(stamp)


def _login_keys(username):
    ip = client_ip()
    return {'pair': f'pair|{ip}|{username}', 'user': f'user|{username}', 'ip': f'ip|{ip}'}


def _login_blocked(keys):
    return (_recent_failures(keys['pair']) >= LOGIN_MAX_FAILURES
            or _recent_failures(keys['user']) >= LOGIN_MAX_FAILURES_PER_USER
            or _recent_failures(keys['ip']) >= LOGIN_MAX_FAILURES_PER_IP)


@app.get('/api/auth/csrf')
def auth_csrf():
    return jsonify(csrfToken=csrf_token())


@app.post('/api/auth/login')
def auth_login():
    body = json_body()
    username = str(body.get('username') or '').strip().lower()[:64]
    password = str(body.get('password') or '')[:256]
    # Limits per (address, name), per name and per address: one attacker cannot lock others out,
    # and flooding with other names does not reset a block.
    keys = _login_keys(username)
    if _login_blocked(keys):
        raise ApiError(429, 'too_many_attempts')
    row = db().execute('SELECT * FROM [kullanicilar] WHERE [kullanici_adi]=?', (username,)).fetchone()
    # A hash is checked even for unknown names, so response time does not reveal which names exist.
    valid = check_password_hash(row['sifre_ozeti'] if row and row['sifre_ozeti'] else _dummy_hash, password)
    if not (row and valid and row['aktif']):
        _note_failure(*keys.values())
        raise ApiError(401, 'invalid_credentials')
    _failed_logins.pop(keys['pair'], None)
    session.clear()  # new session id-equivalent: nothing from before the login carries over
    session.permanent = True
    session['uid'] = row['id']
    session['sv'] = row['oturum_surumu']
    session['iat'] = int(time.time())
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
    current = str(body.get('currentPassword') or '')[:256]
    new = str(body.get('newPassword') or '')
    # Someone holding a stolen session must not be able to try passwords here without limit.
    guess_key = f"pw|{user['id']}"
    if _recent_failures(guess_key) >= LOGIN_MAX_FAILURES:
        raise ApiError(429, 'too_many_attempts')
    conn = db()
    row = conn.execute('SELECT * FROM [kullanicilar] WHERE [id]=?', (user['id'],)).fetchone()
    if not check_password_hash(row['sifre_ozeti'] or _dummy_hash, current):
        _note_failure(guess_key)
        raise ApiError(400, 'wrong_password')
    _failed_logins.pop(guess_key, None)
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


@app.get('/api/people')
@login_required
def people_list():
    """Names for assigning jobs, readable by every user (the full user list stays with the administrator)."""
    rows = db().execute('SELECT [id],[ad],[soyad],[yonetici],[aktif] FROM [kullanicilar] ORDER BY [ad], [soyad]').fetchall()
    return json_list_response([{'id': r['id'], 'fullName': f"{r['ad'] or ''} {r['soyad'] or ''}".strip(),
                                'isAdmin': bool(r['yonetici']), 'active': bool(r['aktif'])} for r in rows])


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


# ---------------------------------------------------------------- collections: screens, materials, tasks
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


def check_task_rules(conn, body, row):
    """- type, screen, technician, service day and description are required; the first four are fixed once opened
       - a new job starts as İşlemde; closing needs no photos (they are optional since 2026-09-29)
       - the deadline is set when the job is opened; afterwards it moves only through /extend (with an excuse)"""
    # A page still open from before the 2026-09-29 renames may send the old names.
    if body.get('type') in OLD_TASK_TYPES:
        body['type'] = OLD_TASK_TYPES[body['type']]
    if body.get('status') in OLD_TASK_STATUSES:
        body['status'] = OLD_TASK_STATUSES[body['status']]
    if row is None:
        body['status'] = 'islemde'
        body['resolvedAt'] = None
    def blank(key):
        return not str(body.get(key) or '').strip()

    if row is None and any(blank(k) for k in REQUIRED_TASK_FIELDS):
        raise ApiError(400, 'required_fields')
    if row is not None and any(k in body and blank(k) for k in REQUIRED_TASK_FIELDS):
        raise ApiError(400, 'required_fields')
    if row is not None and any(key in body and row[col] and str(body[key]) != row[col] for key, col in FIXED_TASK_FIELDS):
        raise ApiError(409, 'task_fields_fixed')
    for key, allowed in (('type', TASK_TYPES), ('status', TASK_STATUSES), ('priority', TASK_PRIORITIES),
                         ('serviceDayType', SERVICE_DAYS)):
        if body.get(key) is not None and body[key] not in allowed:
            raise ApiError(400, 'bad_value')
    if body.get('screenId') and not conn.execute('SELECT 1 FROM [ekranlar] WHERE [id]=?', (str(body['screenId']),)).fetchone():
        raise ApiError(400, 'bad_value')
    assignee = body.get('assignedTechnicianId')
    if assignee:
        person = conn.execute('SELECT [aktif] FROM [kullanicilar] WHERE [id]=?', (str(assignee),)).fetchone()
        current = row['teknisyen_id'] if row else None
        # A deactivated user may stay on the jobs they had, but gets no new ones.
        if not person or (assignee != current and not person['aktif']):
            raise ApiError(400, 'bad_assignee')
    # Every job gets TASK_DURATION when it is opened; afterwards the deadline moves only through /extend,
    # which needs an excuse (and only once it has passed).
    if row and 'dueDate' in body and (body['dueDate'] or None) != row['son_tarih']:
        raise ApiError(409, 'due_fixed')


MAX_MATERIAL_QTY = 100000
MAX_HISTORY_PER_REQUEST = 1000


def set_task_materials(conn, rid, items):
    if not isinstance(items, list) or len(items) > 200:
        raise ApiError(400, 'bad_value')
    # Catalogue items, plus ones already on this job (still valid if later removed from the catalogue).
    allowed = {r[0] for r in conn.execute('SELECT [id] FROM [malzemeler]')}
    allowed |= {r[0] for r in conn.execute('SELECT [malzeme_id] FROM [is_malzemeleri] WHERE [is_id]=?', (rid,))}
    rows = []
    for item in items:
        if not isinstance(item, dict):
            raise ApiError(400, 'bad_value')
        material = check_id(item.get('materialId'))
        qty = to_db(item.get('qty'), 'num')
        if material not in allowed or qty is None or not 0 < qty <= MAX_MATERIAL_QTY:
            raise ApiError(400, 'bad_value')
        rows.append((rid, material, qty))
    conn.execute('DELETE FROM [is_malzemeleri] WHERE [is_id]=?', (rid,))
    conn.executemany('INSERT INTO [is_malzemeleri] ([is_id],[malzeme_id],[miktar]) VALUES (?,?,?)', rows)


def append_task_history(conn, rid, entries):
    """History is append-only: entries already stored are kept as they are (with their author);
    new ones are stamped with the session user, whatever name the page sent."""
    if not isinstance(entries, list) or len(entries) > MAX_HISTORY_PER_REQUEST:
        raise ApiError(400, 'bad_value')
    known = {(r['zaman'] or '') + '|' + (r['notlar'] or '')
             for r in conn.execute('SELECT [zaman],[notlar] FROM [is_gecmisi] WHERE [is_id]=?', (rid,))}
    for h in entries:
        if not isinstance(h, dict):
            raise ApiError(400, 'bad_value')
        ts = to_db(h.get('ts'), 'date') or now_iso()
        note = to_db(h.get('note'), 'memo')
        status = h.get('status') or None
        status = OLD_TASK_STATUSES.get(status, status)
        if status is not None and status not in TASK_STATUSES:
            raise ApiError(400, 'bad_value')
        key = ts + '|' + (note or '')
        if key in known:
            continue
        known.add(key)
        conn.execute('INSERT INTO [is_gecmisi] ([is_id],[zaman],[durum],[notlar],[yazan]) VALUES (?,?,?,?,?)',
                     (rid, ts, status, note, g.user['fullName']))


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
    if col in ('screens', 'materials') and is_company_user(g.user):
        raise ApiError(403, 'forbidden_firma')
    table, fields = COLLECTIONS[col]
    conn = db()
    row = conn.execute(f'SELECT * FROM [{table}] WHERE [id]=?', (rid,)).fetchone()

    if request.method == 'DELETE':
        # A closed job's photos are its evidence (they cannot be deleted one by one), so only the
        # system administrator may delete the whole job.
        if col == 'tasks' and row and is_closed(row['durum']) and not g.user['isAdmin']:
            raise ApiError(403, 'closed_task_delete')
        files = []
        with conn:
            if col == 'tasks':
                if row:  # the message is written while the job (and its photos) can still be read
                    enqueue_notification(conn, 'silindi', rid, g.user['fullName'])
                files = [r[0] for r in conn.execute('SELECT [dosya] FROM [is_fotograflari] WHERE [is_id]=?', (rid,))]
                for child in ('is_malzemeleri', 'is_gecmisi', 'is_fotograflari', 'is_sure_uzatmalari'):
                    conn.execute(f'DELETE FROM [{child}] WHERE [is_id]=?', (rid,))
            conn.execute(f'DELETE FROM [{table}] WHERE [id]=?', (rid,))
        for f in files:
            remove_upload(f)
        return jsonify(ok=True)

    body = json_body()
    if col == 'screens' and body.get('imei'):
        # One device, one screen: the same IMEI on two screens is almost always a typing mistake.
        imei = to_db(body['imei'], 'imei')
        if imei and conn.execute('SELECT 1 FROM [ekranlar] WHERE [imei]=? AND [id]<>?', (imei, rid)).fetchone():
            raise ApiError(409, 'imei_taken')
    if request.method == 'PUT':
        # PUT creates a new record; changes go through PATCH, where the task rules apply.
        if row:
            raise ApiError(409, 'exists')
        if col == 'tasks':
            check_task_rules(conn, body, None)
        with conn:
            insert_record(conn, col, rid, body)
            if col == 'tasks':
                # Next job number, taken inside this write transaction so two new jobs cannot share it.
                conn.execute('UPDATE [isler] SET [is_no]=(SELECT COALESCE(MAX([is_no]), 0) + 1 FROM [isler]) WHERE [id]=?', (rid,))
                # The deadline is set here, whatever the page sent.
                conn.execute('UPDATE [isler] SET [son_tarih]=? WHERE [id]=?',
                             (iso(dt.datetime.now(dt.timezone.utc) + TASK_DURATION), rid))
                set_task_materials(conn, rid, body.get('usedMaterials') or [])
                append_task_history(conn, rid, body.get('history') or [])
                remember_near_due(conn, rid)
                enqueue_notification(conn, 'yeni', rid, g.user['fullName'], public_base_url())
        return jsonify(ok=True)

    if not row:
        raise ApiError(404, 'not_found')
    if col == 'tasks':
        check_task_rules(conn, body, row)
    present = [f for f in fields if f.js in body and f.js not in READONLY_FIELDS]
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
            event = status_event(row['durum'], body.get('status', row['durum']))
            if event:
                enqueue_notification(conn, event, rid, g.user['fullName'], public_base_url())
    return jsonify(ok=True)


def status_event(old, new):
    """Which status change is announced: closing a job, or taking a closed one back into work."""
    if is_closed(new) and not is_closed(old):
        return 'kapandi'
    if is_closed(old) and not is_closed(new):
        return 'yeniden_acildi'
    return None


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
    if conn.execute('SELECT COUNT(*) FROM [is_fotograflari] WHERE [is_id]=?', (rid,)).fetchone()[0] >= MAX_PHOTOS_PER_TASK:
        raise ApiError(409, 'too_many_photos')
    data = request.get_data(cache=False)
    if len(data) > MAX_PHOTO_BYTES:
        raise ApiError(413, 'too_large')
    ext = image_ext(data)
    if not ext:
        raise ApiError(415, 'bad_image')
    # Keep room for the database: a full disk would stop every save, not just photos.
    if storage_usage()[1] + os.path.getsize(DATABASE_PATH) + len(data) > DISK_GUARD_BYTES:
        raise ApiError(507, 'disk_full')
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
        remember_near_due(conn, rid)
        enqueue_notification(conn, 'uzatildi', rid, author, public_base_url(),
                             {'old': stored, 'new': iso(new_due), 'reason': reason})
    return jsonify(ok=True)


def storage_usage():
    """(number of photo files, their total bytes)"""
    photo_count = photo_bytes = 0
    with os.scandir(UPLOAD_DIR) as entries:
        for e in entries:
            if e.is_file():
                photo_count += 1
                photo_bytes += e.stat().st_size
    return photo_count, photo_bytes


@app.get('/api/stats/storage')
@login_required
def storage_stats():
    if is_company_user(g.user):  # shown only on Raporlar
        raise ApiError(403, 'forbidden_firma')
    photo_count, photo_bytes = storage_usage()
    return jsonify(photoCount=photo_count, uploadBytes=photo_bytes, dbBytes=os.path.getsize(DATABASE_PATH),
                   quotaBytes=DISK_QUOTA_BYTES)


# ---------------------------------------------------------------- Telegram notifications
# Settings (env): TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_CHAT_ID (the group that gets the messages);
# optional PUBLIC_URL for the links in messages. An event is written to the bildirimler table in the same
# transaction as the change, then sent after the response has gone out (Response.call_on_close), so nobody waits
# for Telegram and nothing is lost when it is unreachable (retried every DEADLINE_CHECK_SECONDS). Deadline
# reminders are checked at that pace too, as long as the site receives requests (the open page polls it).
TELEGRAM_TIMEOUT = 8
DEADLINE_CHECK_SECONDS = 300
REMIND_BEFORE = dt.timedelta(hours=24)
OVERDUE_NEWS_WINDOW = dt.timedelta(days=2)   # older overdue jobs are not announced (e.g. right after setup)
MAX_SEND_ATTEMPTS = 5
try:
    from zoneinfo import ZoneInfo
    LOCAL_TZ = ZoneInfo('Europe/Istanbul')
except Exception:  # no time zone database (Windows without tzdata); Turkey is UTC+3 all year
    LOCAL_TZ = dt.timezone(dt.timedelta(hours=3))

TYPE_TEXT = {'ekran_ariza': ('🖥', 'Ekran Arıza'), 'yazilim_ariza': ('💻', 'Yazılım Arıza'), 'altyapi': ('🏗', 'Altyapı İşi')}
STATUS_TEXT = {'acik': 'Açık', 'atandi': 'Atandı', 'islemde': 'İşlemde', 'cozuldu': 'Çözüldü', 'kapandi': 'Kapandı'}


class TelegramError(Exception):
    pass


_notify_lock = threading.Lock()
_outbox_dirty = False
_last_deadline_check = 0.0


def telegram_configured():
    return bool(os.environ.get('TELEGRAM_BOT_TOKEN', '').strip() and os.environ.get('TELEGRAM_CHAT_ID', '').strip())


def telegram_api(method, params):
    """One Bot API call; errors become TelegramError with the token masked."""
    token = os.environ.get('TELEGRAM_BOT_TOKEN', '').strip()
    if not token:
        raise TelegramError('TELEGRAM_BOT_TOKEN tanımlı değil')
    req = urllib.request.Request(f'https://api.telegram.org/bot{token}/{method}', data=urllib.parse.urlencode(params).encode())

    def call(opener):
        with opener.open(req, timeout=TELEGRAM_TIMEOUT) as resp:
            return json.loads(resp.read().decode('utf-8'))

    try:
        try:
            body = call(urllib.request.build_opener())
        except urllib.error.HTTPError:
            raise
        except urllib.error.URLError:
            # PythonAnywhere free accounts reach the internet only through its proxy; use it if not set already.
            if not os.environ.get('PYTHONANYWHERE_DOMAIN') or urllib.request.getproxies().get('https'):
                raise
            body = call(urllib.request.build_opener(urllib.request.ProxyHandler({'https': 'http://proxy.server:3128'})))
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode('utf-8'))
        except Exception:
            raise TelegramError(f'HTTP {e.code}') from None
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise TelegramError(str(getattr(e, 'reason', e)).replace(token, '***')) from None
    if not body.get('ok'):
        raise TelegramError(str(body.get('description') or 'bilinmeyen hata').replace(token, '***'))
    return body.get('result')


def local_time(value):
    d = parse_iso(value) if isinstance(value, str) else value
    return d.astimezone(LOCAL_TZ).strftime('%d.%m.%Y %H:%M') if d else '—'


def span_text(seconds):
    minutes = max(1, round(abs(seconds) / 60))
    if minutes < 60:
        return f'{minutes} dakika'
    hours = round(minutes / 60)
    if hours < 48:
        return f'{hours} saat'
    days, rest = divmod(hours, 24)
    return f'{days} gün' + (f' {rest} saat' if rest else '')


def _e(text):
    return html.escape(str(text or ''), quote=False)


def _short(text, limit=300):
    text = ' '.join(str(text or '').split())
    return text if len(text) <= limit else text[:limit - 1] + '…'


def _qty(value):
    number = float(value or 0)
    return (f'{number:.2f}'.rstrip('0').rstrip('.') if number % 1 else str(int(number))).replace('.', ',')


def build_message(conn, event, task_id, actor='', base_url='', extra=None):
    """The Telegram text (HTML) for an event: job number, stop name, and what matters for that event."""
    now = dt.datetime.now(dt.timezone.utc)
    if event == 'test':
        return (f'🔔 <b>Akıllı Durak Takip</b>\nTelegram bildirimleri çalışıyor.\n'
                f'✍️ {_e(actor)} · {local_time(now)}')
    t = conn.execute('SELECT * FROM [isler] WHERE [id]=?', (task_id,)).fetchone()
    if not t:
        return None
    s = conn.execute('SELECT * FROM [ekranlar] WHERE [id]=?', (t['ekran_id'],)).fetchone() if t['ekran_id'] else None
    u = conn.execute('SELECT [ad],[soyad] FROM [kullanicilar] WHERE [id]=?', (t['teknisyen_id'],)).fetchone() if t['teknisyen_id'] else None
    tech = f"{u['ad'] or ''} {u['soyad'] or ''}".strip() if u else ''
    no = f"#{t['is_no']}" if t['is_no'] else ''
    due = parse_iso(t['son_tarih'])
    extra = extra or {}
    heads = {
        'yeni': f'🆕 <b>Yeni iş {no}</b>',
        'cozuldu': f'✅ <b>İş {no} çözüldü</b>',  # only for messages queued before 2026-09-29
        'kapandi': f'🔒 <b>İş {no} kapatıldı</b>',
        'yeniden_acildi': f'↩️ <b>İş {no} yeniden işleme alındı</b>',
        'sure_24': f'⏳ <b>İş {no}: süre dolmak üzere</b>',
        'sure_doldu': f'⚠️ <b>İş {no}: süre doldu</b>',
        'uzatildi': f'🗓 <b>İş {no}: süre uzatıldı</b>',
        'silindi': f'🗑 <b>İş {no} silindi</b>',
    }
    lines = [heads[event]]
    if s:
        code = f"#{s['durak_no']}{'-' + s['yon'] if s['yon'] else ''}" if s['durak_no'] else ''
        tail = ' · '.join(x for x in (code, s['bolge_kod']) if x)
        lines.append(f"📍 <b>{_e(s['durak_adi'] or s['adres'] or 'İsimsiz durak')}</b>" + (f' · {_e(tail)}' if tail else ''))
    else:
        lines.append('📍 Ekran seçilmedi')
    icon, type_name = TYPE_TEXT.get(t['tur'], ('📋', t['tur'] or '—'))
    # Jobs have no title any more (older ones may); the description says what the job is.
    lines.append(f"{icon} <b>{_e(type_name)}</b>" + (f" · {_e(t['baslik'])}" if t['baslik'] else ''))
    if t['aciklama']:
        lines.append(f"📝 {_e(_short(t['aciklama'], 300 if event == 'yeni' else 120))}")
    who = f'👷 {_e(tech)}' if tech else '👷 Teknisyen atanmadı'
    state_line = f"📌 Durum: {STATUS_TEXT.get(t['durum'], t['durum'] or '—')} · {who}"

    if event == 'yeni':
        service = {'haftaici': 'Hafta içi', 'haftasonu': 'Hafta sonu'}.get(t['servis_gunu'])
        lines.append(who + (f' · 📅 {service}' if service else ''))
        if due:
            left = (due - now).total_seconds()
            lines.append(f"⏰ Son tarih: {local_time(due)} ({span_text(left)} {'kaldı' if left > 0 else 'gecikti'})")
        lines.append(f'✍️ Açan: {_e(actor)}')
    elif event in ('cozuldu', 'kapandi'):
        created, resolved = parse_iso(t['olusturma']), parse_iso(t['cozulme']) or now
        lines.append(who + (f' · ⏱ Süre: {span_text((resolved - created).total_seconds())}' if created else ''))
        mats = conn.execute('SELECT m.[ad], m.[birim], im.[miktar] FROM [is_malzemeleri] AS im '
                            'LEFT JOIN [malzemeler] AS m ON m.[id] = im.[malzeme_id] WHERE im.[is_id]=? ORDER BY im.[id]',
                            (task_id,)).fetchall()
        if mats:
            used = ', '.join(f"{m['ad'] or 'Bilinmeyen'} ×{_qty(m['miktar'])}" + (f" {m['birim']}" if m['birim'] and m['birim'] != 'Adet' else '')
                             for m in mats)
            lines.append(f'🧰 Kullanılan: {_e(_short(used))}')
        lines.append(f"✍️ {'Çözen' if event == 'cozuldu' else 'Kapatan'}: {_e(actor)}")
    elif event == 'yeniden_acildi':
        lines.append(state_line)
        lines.append(f'✍️ İşleme alan: {_e(actor)}')
    elif event == 'sure_24' and due:
        lines.append(f'⏰ Son tarih: {local_time(due)} — <b>{span_text((due - now).total_seconds())} kaldı</b>')
        lines.append(state_line)
    elif event == 'sure_doldu' and due:
        lines.append(f'⏰ Son tarih: {local_time(due)} — <b>{span_text((now - due).total_seconds())} gecikti</b>')
        lines.append(state_line)
        lines.append('Süreyi uzatmak için uygulamada mazeret girilmeli.')
    elif event == 'uzatildi':
        lines.append(f"⏰ {local_time(extra.get('old'))} → <b>{local_time(extra.get('new'))}</b>")
        if extra.get('reason'):
            lines.append(f"💬 Mazeret: {_e(_short(extra['reason']))}")
        lines.append(f'✍️ Uzatan: {_e(actor)}')
    elif event == 'silindi':
        lines.append(f"📌 Son durum: {STATUS_TEXT.get(t['durum'], t['durum'] or '—')} · {who}")
        photos = conn.execute('SELECT COUNT(*) FROM [is_fotograflari] WHERE [is_id]=?', (task_id,)).fetchone()[0]
        if photos:
            lines.append(f'📷 {photos} fotoğrafı da silindi')
        lines.append(f'✍️ Silen: {_e(actor)}')
        return '\n'.join(lines)  # no link: the job no longer exists
    if base_url:
        lines.append(f'🔗 {_e(base_url)}/#task-{_e(task_id)}')
    return '\n'.join(lines)


def enqueue_notification(conn, event, task_id, actor='', base_url='', extra=None):
    """Adds a message to the queue inside the caller's transaction; nothing happens when Telegram is not set up."""
    global _outbox_dirty
    if not telegram_configured():
        return
    text = build_message(conn, event, task_id, actor, base_url, extra)
    if text:
        number = conn.execute('SELECT [is_no] FROM [isler] WHERE [id]=?', (task_id,)).fetchone() if task_id else None
        conn.execute('INSERT INTO [bildirimler] ([olay],[is_id],[is_no],[metin],[olusturma]) VALUES (?,?,?,?,?)',
                     (event, task_id, number[0] if number else None, text, now_iso()))
        _outbox_dirty = True


def remember_near_due(conn, task_id):
    """A job created or extended with less than 24 hours left already says so; skip the separate reminder."""
    row = conn.execute('SELECT [son_tarih] FROM [isler] WHERE [id]=?', (task_id,)).fetchone()
    due = parse_iso(row['son_tarih']) if row else None
    if due and due - dt.datetime.now(dt.timezone.utc) <= REMIND_BEFORE:
        conn.execute('UPDATE [isler] SET [hatirlatma_24]=? WHERE [id]=?', (row['son_tarih'], task_id))


def check_deadlines(conn, base_url):
    """Queues "24 saat kaldı" and "süre doldu" once per deadline (a new deadline after an extension counts again)."""
    now = dt.datetime.now(dt.timezone.utc)
    rows = conn.execute("SELECT [id],[son_tarih],[hatirlatma_24],[hatirlatma_doldu] FROM [isler] "
                        "WHERE [son_tarih] IS NOT NULL AND [durum] NOT IN ('cozuldu','kapandi')").fetchall()
    for r in rows:
        due = parse_iso(r['son_tarih'])
        if not due:
            continue
        if due <= now:
            if r['hatirlatma_doldu'] != r['son_tarih']:
                if now - due <= OVERDUE_NEWS_WINDOW:
                    enqueue_notification(conn, 'sure_doldu', r['id'], base_url=base_url)
                conn.execute('UPDATE [isler] SET [hatirlatma_doldu]=?, [hatirlatma_24]=? WHERE [id]=?',
                             (r['son_tarih'], r['son_tarih'], r['id']))
        elif due - now <= REMIND_BEFORE and r['hatirlatma_24'] != r['son_tarih']:
            enqueue_notification(conn, 'sure_24', r['id'], base_url=base_url)
            conn.execute('UPDATE [isler] SET [hatirlatma_24]=? WHERE [id]=?', (r['son_tarih'], r['id']))


def flush_notifications(conn, limit=10):
    chat = os.environ.get('TELEGRAM_CHAT_ID', '').strip()
    now = dt.datetime.now(dt.timezone.utc)
    rows = conn.execute('SELECT [id],[metin],[olusturma] FROM [bildirimler] WHERE [gonderim] IS NULL AND [deneme] < ? '
                        'ORDER BY [id] LIMIT ?', (MAX_SEND_ATTEMPTS, limit)).fetchall()
    for r in rows:
        created = parse_iso(r['olusturma'])
        if created and now - created > OVERDUE_NEWS_WINDOW:
            with conn:
                conn.execute('UPDATE [bildirimler] SET [deneme]=?, [hata]=? WHERE [id]=?',
                             (MAX_SEND_ATTEMPTS, '2 günden eski, gönderilmedi', r['id']))
            continue
        try:
            telegram_api('sendMessage', {'chat_id': chat, 'text': r['metin'], 'parse_mode': 'HTML',
                                         'disable_web_page_preview': 'true'})
        except TelegramError as e:
            with conn:
                conn.execute('UPDATE [bildirimler] SET [deneme]=[deneme]+1, [hata]=? WHERE [id]=?', (str(e)[:300], r['id']))
            log.warning('telegram gonderilemedi (%s): %s', r['id'], e)
            break  # usually the same for the rest (network, settings); retried on the next round
        with conn:
            conn.execute('UPDATE [bildirimler] SET [gonderim]=?, [hata]=NULL WHERE [id]=?', (now_iso(), r['id']))
    with conn:
        conn.execute('DELETE FROM [bildirimler] WHERE [olusturma] < ?', (iso(now - dt.timedelta(days=30)),))


def run_notifications(base_url):
    """Deadline check (at most every DEADLINE_CHECK_SECONDS) and sending; runs after a response, own connection."""
    global _outbox_dirty, _last_deadline_check
    if not _notify_lock.acquire(blocking=False):
        return
    try:
        _outbox_dirty = False
        conn = connect()
        try:
            if time.monotonic() - _last_deadline_check >= DEADLINE_CHECK_SECONDS:
                _last_deadline_check = time.monotonic()
                with conn:
                    check_deadlines(conn, base_url)
            flush_notifications(conn)
        finally:
            conn.close()
    except Exception:
        log.exception('bildirim hatasi')
    finally:
        _notify_lock.release()


_local_base_url = ''


def public_base_url():
    """The site address for links in messages, never taken from a request's Host header on the server:
    PUBLIC_URL if set; on PythonAnywhere https://<account>.<domain>; elsewhere (local trial) the first
    address a signed-in user reached the site on."""
    global _local_base_url
    configured = os.environ.get('PUBLIC_URL', '').strip().rstrip('/')
    if configured:
        return configured
    pa_domain = os.environ.get('PYTHONANYWHERE_DOMAIN', '').strip()
    if pa_domain:
        account = os.environ.get('USER') or os.environ.get('LOGNAME') or ''
        if not account:
            import getpass
            account = getpass.getuser()
        return f'https://{account}.{pa_domain}'
    if not _local_base_url and g.get('user') and re.fullmatch(r'[A-Za-z0-9.-]+(:\d{1,5})?', request.host):
        _local_base_url = f'{request.scheme}://{request.host}'
    return _local_base_url


@app.after_request
def _schedule_notifications(resp):
    if telegram_configured() and (_outbox_dirty or time.monotonic() - _last_deadline_check >= DEADLINE_CHECK_SECONDS):
        base = public_base_url()
        resp.call_on_close(lambda: run_notifications(base))
    return resp


@app.get('/api/telegram/status')
@admin_required
def telegram_status():
    rows = db().execute('SELECT b.[id], b.[olay], b.[olusturma], b.[gonderim], b.[deneme], b.[hata], '
                        'COALESCE(b.[is_no], i.[is_no]) AS [is_no] '
                        'FROM [bildirimler] AS b LEFT JOIN [isler] AS i ON i.[id] = b.[is_id] ORDER BY b.[id] DESC LIMIT 15').fetchall()
    return jsonify(
        tokenSet=bool(os.environ.get('TELEGRAM_BOT_TOKEN', '').strip()),
        chatSet=bool(os.environ.get('TELEGRAM_CHAT_ID', '').strip()),
        recent=[{'id': r['id'], 'event': r['olay'], 'taskNo': r['is_no'], 'createdAt': r['olusturma'],
                 'sentAt': r['gonderim'], 'attempts': r['deneme'], 'error': r['hata'],
                 'gaveUp': r['gonderim'] is None and r['deneme'] >= MAX_SEND_ATTEMPTS} for r in rows])


@app.post('/api/telegram/test')
@admin_required
def telegram_test():
    if not telegram_configured():
        raise ApiError(400, 'telegram_not_configured')
    try:
        telegram_api('sendMessage', {'chat_id': os.environ['TELEGRAM_CHAT_ID'].strip(), 'parse_mode': 'HTML',
                                     'text': build_message(db(), 'test', None, g.user['fullName'])})
    except TelegramError as e:
        return jsonify(ok=False, error=str(e)), 502
    return jsonify(ok=True)


@app.get('/api/telegram/chats')
@admin_required
def telegram_chats():
    """Chats the bot has seen lately (getUpdates), so the administrator can find the group's chat id."""
    if not os.environ.get('TELEGRAM_BOT_TOKEN', '').strip():
        raise ApiError(400, 'telegram_no_token')
    try:
        updates = telegram_api('getUpdates', {'timeout': 0, 'allowed_updates': json.dumps(['message', 'my_chat_member', 'channel_post'])})
    except TelegramError as e:
        return jsonify(ok=False, error=str(e)), 502
    chats = {}
    for update in updates or []:
        for key in ('message', 'edited_message', 'my_chat_member', 'channel_post'):
            chat = (update.get(key) or {}).get('chat')
            if chat:
                name = chat.get('title') or ' '.join(filter(None, [chat.get('first_name'), chat.get('last_name')])) or chat.get('username') or ''
                chats[chat['id']] = {'id': str(chat['id']), 'title': name, 'type': chat.get('type')}
    return jsonify(ok=True, chats=list(chats.values()), current=os.environ.get('TELEGRAM_CHAT_ID', '').strip())


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
