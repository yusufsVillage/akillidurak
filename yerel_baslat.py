"""Akıllı Durak Takip'i bu bilgisayarda çalıştırır; baslat.bat çift tıklanınca açılır.

PythonAnywhere'de kullanılmaz (orada WSGI dosyası app.py'yi yükler) ve zip'e girmez.
Veritabanı, fotoğraflar ve oturum anahtarı yerel_veri/ klasöründe durur. Hiçbir şey sorulmaz:
ilk çalıştırmada sistem yöneticisi Windows kullanıcı adıyla ve geçici bir şifreyle oluşturulur.
Şifre yerel_veri/ILK_GIRIS_BILGILERI.txt dosyasına yazılır ve yönetici kendi şifresini belirleyene
kadar her açılışta pencerede yeniden gösterilir. Dosya silinmişse yeni bir geçici şifre üretilir.
"""
import contextlib
import getpass
import os
import pathlib
import re
import secrets
import sqlite3
import sys
import threading
import urllib.request
import webbrowser

from werkzeug.security import check_password_hash

ROOT = pathlib.Path(__file__).resolve().parent
PORT = int(os.environ.get('PORT') or 5000)
URL = f'http://127.0.0.1:{PORT}/'


def already_running():
    try:
        with urllib.request.urlopen(URL + 'healthz', timeout=2) as resp:
            return resp.read() == b'ok'
    except OSError:
        return False


def admin_state(db_path):
    """(username, must_change_password, password_hash) of the administrator, or None if there is none yet."""
    if not db_path.exists():
        return None
    try:
        with contextlib.closing(sqlite3.connect(db_path)) as conn:
            return conn.execute('SELECT kullanici_adi, sifre_degismeli, sifre_ozeti FROM kullanicilar '
                                'WHERE yonetici=1 AND aktif=1').fetchone()
    except sqlite3.Error:
        return None


def windows_username():
    """'yusuf.yilmaz' style name from the Windows account; 'yonetici' if it cannot be used."""
    try:
        raw = getpass.getuser()
    except Exception:
        raw = ''
    name = re.sub(r'[^a-z0-9._-]', '', raw.split('\\')[-1].translate(str.maketrans('çğıöşüÇĞİÖŞÜ', 'cgiosucgiosu')).lower())
    return name if 3 <= len(name) <= 40 else 'yonetici'


def write_creds(path, username, password):
    path.write_text(
        'Akıllı Durak Takip ilk giriş bilgileri (sistem yöneticisi)\n'
        f'Adres            : {URL}\n'
        f'Kullanıcı adı    : {username}\n'
        f'Geçici şifre     : {password}\n'
        'İlk girişte kendi şifrenizi belirlemeniz istenir. Şifrenizi belirledikten sonra\n'
        'program bir sonraki açılışında bu dosyayı siler.\n',
        encoding='utf-8')


def read_creds(path):
    """(username, password) from the first-login file, or None."""
    try:
        lines = dict(line.split(':', 1) for line in path.read_text(encoding='utf-8').splitlines() if ':' in line)
        values = {k.strip(): v.strip() for k, v in lines.items()}
        return (values['Kullanıcı adı'], values['Geçici şifre']) if values.get('Geçici şifre') else None
    except (OSError, KeyError, ValueError):
        return None


def temporary_password():
    letters, digits = 'abcdefghjkmnpqrstuvwxyz', '23456789'
    while True:
        pw = ''.join(secrets.choice(letters + digits) for _ in range(10))
        if any(c in digits for c in pw) and any(c in letters for c in pw):
            return pw


def main():
    open_browser = '--no-browser' not in sys.argv
    if already_running():
        print(f'Akıllı Durak Takip zaten çalışıyor: {URL}')
        if open_browser:
            webbrowser.open(URL)
        return 0
    data = ROOT / 'yerel_veri'
    if 'DATABASE_PATH' not in os.environ:
        data.mkdir(exist_ok=True)
        os.environ['DATABASE_PATH'] = str(data / 'app.db')
    if 'SECRET_KEY' not in os.environ:
        # Kept across restarts so a restart does not sign everyone out.
        data.mkdir(exist_ok=True)
        key_file = data / 'gizli_anahtar.txt'
        if not key_file.exists():
            key_file.write_text(secrets.token_hex(32), encoding='ascii')
        os.environ['SECRET_KEY'] = key_file.read_text(encoding='ascii').strip()
    db_path = pathlib.Path(os.environ['DATABASE_PATH'])
    creds_file = db_path.parent / 'ILK_GIRIS_BILGILERI.txt'
    state = admin_state(db_path)
    # While the administrator has not chosen a password, the one in the file stays valid and is shown again.
    shown = read_creds(creds_file) if state and state[1] else None
    if shown and (shown[0] != state[0] or not check_password_hash(state[2] or '', shown[1])):
        shown = None  # the file does not match the account (edited or out of date): issue a new password
    new_creds = None
    if not os.environ.get('ADMIN_USERNAME') and (state is None or (state[1] and not shown)):
        # No administrator yet, or its temporary password was lost with the file: issue a new one.
        # app.py creates the account, or resets its password because ADMIN_PASSWORD changed.
        new_creds = (state[0] if state else windows_username(), temporary_password())
        os.environ['ADMIN_USERNAME'], os.environ['ADMIN_PASSWORD'] = new_creds

    sys.path.insert(0, str(ROOT))
    from app import app

    print()
    print('  Akıllı Durak Takip çalışıyor')
    print(f'  Adres     : {URL}')
    print(f'  Veritabanı: {db_path}')
    print('  Kapatmak için bu pencereyi kapatın.')
    print()
    if new_creds:
        write_creds(creds_file, *new_creds)
    if new_creds or shown:
        user, password = new_creds or shown
        print('  ==================== İLK GİRİŞ ====================')
        print(f'  Kullanıcı adı : {user}')
        print(f'  Geçici şifre  : {password}')
        print('  İlk girişte kendi şifrenizi belirlemeniz istenecek.')
        print(f'  (Bu bilgiler şu dosyada da var: {creds_file})')
        print('  ===================================================')
        print()
    elif creds_file.exists():
        creds_file.unlink()
    if open_browser:
        threading.Timer(1.5, webbrowser.open, [URL]).start()
    app.run(host='127.0.0.1', port=PORT)
    return 0


if __name__ == '__main__':
    sys.exit(main())
