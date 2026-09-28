"""PythonAnywhere'e yüklenecek zip'i hazırlar: python build_zip.py  ->  dist/durakops.zip

Zip'in içinde her şey durakops/ klasörü altındadır; sunucuda `unzip -o durakops.zip` ile ~/durakops/ açılır.
Veritabanı, fotoğraflar, sanal ortam, yedekler ve Windows'a özel dosyalar zip'e girmez; böylece güncelleme
zip'i sunucudaki veriyi ezmez. .py dosyalarında elle yazılmış bir SECRET_KEY / ADMIN_PASSWORD /
TELEGRAM_BOT_TOKEN bulunursa zip hazırlanmaz.
"""
import fnmatch
import pathlib
import re
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / 'dist' / 'durakops.zip'
TOP = 'durakops'

SKIP_DIRS = {
    '.venv', 'venv', 'env', '.env', '__pycache__', '.git', '.idea', '.vscode', '.claude', '.pytest_cache',
    'node_modules', 'dist', 'data', 'uploads', 'yedek_windows_surumu', 'yerel_veri',
}
SKIP_FILES = [
    '*.pyc', '*.pyo', '*.db', '*.db-*', '*.sqlite', '*.sqlite3', '*.mdb', '*.ldb', '*.yedek', '*.bak',
    '.env', '.env.*', '*.log', '*.zip', '*.swp', '*~', '.DS_Store', 'Thumbs.db', 'desktop.ini',
    '*.ps1', '*.bat', '*.cmd', '*wsgi*.py', '*.pem', '*.key', 'yerel_baslat.py', '.gitignore', '.gitattributes',
]
# A literal value given to SECRET_KEY / ADMIN_PASSWORD / TELEGRAM_BOT_TOKEN: X = '...', ['X'] = '...', {'X': '...'}
SECRET_RE = re.compile(r'''(SECRET_KEY|ADMIN_PASSWORD|TELEGRAM_BOT_TOKEN)['"]?\]?\s*[:=]\s*['"][^'"]+['"]''')


def included(path):
    rel = path.relative_to(ROOT)
    if any(part in SKIP_DIRS for part in rel.parts[:-1]):
        return False
    return not any(fnmatch.fnmatch(rel.name, pattern) for pattern in SKIP_FILES)


def main():
    files = sorted(p for p in ROOT.rglob('*') if p.is_file() and included(p))
    leaks = [p for p in files if p.suffix == '.py' and SECRET_RE.search(p.read_text(encoding='utf-8'))]
    if leaks:
        print('DURDURULDU: şu dosyalarda elle yazılmış gizli değer var:', *leaks, sep='\n  ')
        return 1
    OUT.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(OUT, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for p in files:
            # Real modification times: the server's file ETags depend on them, so browsers pick up new versions.
            info = zipfile.ZipInfo.from_file(p, '/'.join((TOP, *p.relative_to(ROOT).parts)))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16  # regular file, rw-r--r-- on the Linux server
            zf.writestr(info, p.read_bytes())
    with zipfile.ZipFile(OUT) as zf:
        entries = zf.infolist()
        print(f'{OUT.relative_to(ROOT).as_posix()}:')
        for e in entries:
            print(f'  {e.file_size:>9,}  {e.filename}')
        total = sum(e.file_size for e in entries)
    print(f'{len(entries)} dosya, açılmış {total:,} bayt; zip {OUT.stat().st_size:,} bayt')
    return 0


if __name__ == '__main__':
    sys.exit(main())
