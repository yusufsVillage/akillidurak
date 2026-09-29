# Akıllı Durak Takip

Akıllı durak ekranları için iş takip sistemi: Ekran Arıza / Yazılım Arıza / Altyapı İşi türünde işler (liste ve
kanban), ekran kayıtları, malzeme kataloğu, önce/sonra fotoğrafları, 48 saatlik süre ve mazeretli süre uzatma,
raporlar (CSV), kullanıcılar.

İş açarken tür, ekran, teknisyen, servis günü ve açıklama zorunludur. Tür, ekran, teknisyen ve servis günü iş
açıldıktan sonra değiştirilemez (eski bir işte eksik olan bir kez doldurulabilir); açıklama düzenlenebilir ama
boşaltılamaz. İş **İşlemde** durumunda açılır ve son tarihi açıldığı andan itibaren 48 saattir (elle girilmez,
değiştirilemez). Süre dolunca iş sayfasındaki "Süreyi Uzat" ile mazeret yazılarak uzatılır. İşin iki durumu
vardır: İşlemde ve Kapandı. Durum, iş sayfasında seçilip yanındaki **Kaydet** ile değişir; kapatmak için fotoğraf
gerekmez (önce/sonra fotoğrafları isteğe bağlıdır, kapanmış işin fotoğrafları silinemez). Kapanmış iş aynı yolla
yeniden İşlemde yapılabilir. Arıza istatistiklerinde (en çok arızalanan ekranlar, harita, ekran geçmişi) Ekran
Arıza ve Yazılım Arıza birlikte sayılır. Ekran seçimlerinde ekranlar durak numarası ve yönüyle, "#48A - Çınaraltı"
biçiminde listelenir.

Eski sürümden geçişte (uygulama ilk açıldığında kendiliğinden) türler Arıza → Ekran Arıza, İçerik → Yazılım
Arıza, Genel → Altyapı İşi; durumlar Açık/Atandı/İşlemde → İşlemde, Çözüldü/Kapandı → Kapandı olur. Son tarihi
olmayan kapanmamış işlere bir kez 48 saat verilir. Eski işlerin başlık ve öncelik bilgisi silinmez, başlık
görünmeye devam eder.

Python + Flask ile yazılmıştır, veritabanı SQLite'tır (Python'un kendi `sqlite3` modülü). PythonAnywhere'in
ücretsiz planında çalışacak şekilde hazırlanmıştır.

Aşağıda **KULLANICI** geçen her yere kendi PythonAnywhere kullanıcı adınızı yazın.

## Dosyalar

| Dosya / klasör | Ne işe yarar |
| --- | --- |
| `app.py` | Sunucu (Flask). WSGI girişi: `from app import app as application` |
| `schema.sql` | Veritabanı şeması. Uygulama her açılışta çalıştırır; eksik tablo/sütunu ekler, veriye dokunmaz |
| `web/` | Sayfa (HTML, CSS, JavaScript) |
| `seed/` | İlk veri: 174 ekran (Excel listesinden; 84'ünün Bina ID ve DYS Onay No'su eski listeden) ve 48 malzeme. Yalnızca veritabanı ilk kez oluşturulurken yüklenir. SIM numaraları depoya konmadığı için boştur; uygulamada sonradan girilir |
| `baslat.bat`, `yerel_baslat.py` | Kendi bilgisayarınızda çalıştırmak için (aşağıda). Zip'e girmez |
| `requirements.txt` | Gerekli paketler (Flask), sabit sürümlerle |
| `build_zip.py` | GitHub kullanılmadan kurulum için yüklenecek zip'i hazırlar |
| `yedek_windows_surumu/` | Eski Windows sürümü (run.bat ile çalışan). Zip'e girmez |

## Ortam değişkenleri

Ayarlar koda, depoya veya zip'e yazılmaz; PythonAnywhere'deki WSGI dosyasında tanımlanır (aşağıda).

| Değişken | Gerekli mi | Açıklama |
| --- | --- | --- |
| `SECRET_KEY` | Evet | Oturum çerezlerini imzalar. Uzun, rastgele bir değer olmalı ve gizli kalmalı |
| `ADMIN_USERNAME` | Evet | Tek sistem yöneticisinin kullanıcı adı (küçük harf, rakam, `.` `_` `-`) |
| `ADMIN_PASSWORD` | İlk kurulumda | Yöneticinin ilk şifresi. İlk girişte değiştirmesi istenir. Sonradan değiştirilirse yöneticinin şifresi bu değere sıfırlanır (şifre unutulursa) |
| `SESSION_COOKIE_SECURE` | PythonAnywhere'de `1` | Oturum çerezi yalnızca HTTPS üzerinden gönderilir |
| `DATABASE_PATH` | Önerilir | Veritabanı dosyası. Verilmezse kodun yanında `app.db` |
| `UPLOAD_DIR` | Hayır | Fotoğraf klasörü. Verilmezse veritabanının yanında `uploads/` |
| `TELEGRAM_BOT_TOKEN` | Hayır | Telegram bildirimleri için @BotFather'ın verdiği bot anahtarı. Gizlidir |
| `TELEGRAM_CHAT_ID` | Hayır | Bildirimlerin gideceği Telegram grubunun kimliği (aşağıda nasıl bulunur) |
| `PUBLIC_URL` | Hayır | Telegram mesajlarındaki bağlantılar için sitenin adresi; verilmezse PythonAnywhere hesap adından (`https://KULLANICI.pythonanywhere.com`) hesaplanır. Kendi alan adınız varsa yazın |

Kullanıcı ekleme, düzenleme ve şifre sıfırlama yalnızca `ADMIN_USERNAME` hesabına açıktır; yönetici dışındaki
kullanıcılar teknisyendir. Kurum çalışanı teknisyenler sistemin geri kalanını tam yetkiyle kullanır. Firma çalışanları
Panel, İşler ve Harita'yı kullanır; Ekranlar, Malzeme Kataloğu ve Raporlar sayfalarını görmez, ekran ve malzeme
kayıtlarını değiştiremez (sunucu da reddeder), işlerde katalogdan malzeme seçebilir. Kapanmış işi yalnızca yönetici
silebilir. Yeni kullanıcıya rastgele bir geçici şifre verilir ve yalnızca bir kez gösterilir. Şifreler en az 8 karakter olmalı, harf ve rakam içermeli; ad, soyad veya kullanıcı adı ve çok yaygın
şifreler kabul edilmez.

## PythonAnywhere'e ilk kurulum

Kod PythonAnywhere'e GitHub'daki depodan çekilir. Ücretsiz hesaplar GitHub'a yalnızca HTTPS ile bağlanabilir ve
depo özel olduğu için bir GitHub erişim anahtarı (token) gerekir. GitHub kullanmak istemezseniz aşağıdaki
"Zip ile kurulum" bölümüne bakın.

1. **GitHub erişim anahtarı oluşturun:** GitHub'da sağ üstteki profil resmi > **Settings** > **Developer settings**
   > **Personal access tokens** > **Fine-grained tokens** > **Generate new token**:
   - **Token name:** `pythonanywhere-durakops`
   - **Expiration:** en fazla bir yıl (süre dolunca aşağıdaki "Erişim anahtarının süresi dolunca" bölümü)
   - **Repository access:** *Only select repositories* > bu depo
   - **Permissions** > **Repository permissions** > **Contents:** *Read-only*

   **Generate token** ile oluşan anahtarı kopyalayın; yalnızca bir kez gösterilir. Anahtar salt okunur ve yalnızca
   bu depoya erişebilir.

2. **Kodu çekin ve paketleri kurun:** PythonAnywhere'de **Consoles** sekmesinden bir **Bash** konsolu açın.
   `GITHUB_DEPO_ADRESI` yerine deponun GitHub sayfasındaki **Code > HTTPS** adresini yazın:

   ```bash
   cd ~
   git config --global credential.helper store
   git clone GITHUB_DEPO_ADRESI durakops
   ```

   `Username` sorulunca GitHub kullanıcı adınızı, `Password` sorulunca 1. adımdaki anahtarı yapıştırın (yazarken
   görünmez). Anahtar `~/.git-credentials` dosyasında saklanır; güncellemelerde tekrar sorulmaz. Sonra:

   ```bash
   mkdir -p ~/durakops-data
   mkvirtualenv --python=/usr/bin/python3.12 durakops-venv
   pip install -r ~/durakops/requirements.txt
   ```

   Kod `/home/KULLANICI/durakops/`, veri `/home/KULLANICI/durakops-data/` klasöründe durur. Python 3.12 yoksa
   listedeki 3.10 veya üstü bir sürümü kullanın; 4. adımda da aynı sürümü seçin.

3. **Gizli anahtar üretin** (aynı konsolda). Çıkan değeri 5. adımda kullanacaksınız:

   ```bash
   python3 -c "import secrets; print(secrets.token_hex(32))"
   ```

4. **Web uygulamasını oluşturun:** **Web** sekmesi > **Add a new web app** > **Next** > **Manual configuration**
   (Flask'ı değil, *Manual configuration*'ı seçin) > **Python 3.12** > **Next**. Açılan sayfada:
   - **Code > Source code:** `/home/KULLANICI/durakops`
   - **Code > Working directory:** `/home/KULLANICI/durakops`
   - **Virtualenv:** `/home/KULLANICI/.virtualenvs/durakops-venv`
   - **Security > Force HTTPS:** açık

5. **WSGI dosyasını düzenleyin:** Aynı sayfada **Code > WSGI configuration file** bağlantısına tıklayın
   (`/var/www/KULLANICI_pythonanywhere_com_wsgi.py`). İçindekilerin tamamını silip şunu yazın; büyük harfli
   değerleri değiştirin:

   ```python
   import os
   import sys

   os.environ['SECRET_KEY'] = '3. ADIMDA URETILEN DEGER'
   os.environ['ADMIN_USERNAME'] = 'yonetici.kullanici.adi'
   os.environ['ADMIN_PASSWORD'] = 'GECICI YONETICI SIFRESI'
   os.environ['SESSION_COOKIE_SECURE'] = '1'
   os.environ['DATABASE_PATH'] = '/home/KULLANICI/durakops-data/app.db'
   # Telegram bildirimleri (isteğe bağlı, aşağıdaki "Telegram bildirimleri" bölümü):
   # os.environ['TELEGRAM_BOT_TOKEN'] = 'BOTFATHER ANAHTARI'
   # os.environ['TELEGRAM_CHAT_ID'] = 'GRUP KIMLIGI'

   project = '/home/KULLANICI/durakops'
   if project not in sys.path:
       sys.path.insert(0, project)

   from app import app as application  # noqa: E402
   ```

   **Save** ile kaydedin. Bu dosya depoda değildir; güncellemelerde ezilmez.

6. **Başlatın:** **Web** sekmesinde yeşil **Reload** düğmesine basın.
   - `https://KULLANICI.pythonanywhere.com/healthz` adresi `ok` yazmalı.
   - `https://KULLANICI.pythonanywhere.com/` adresinde `ADMIN_USERNAME` ve `ADMIN_PASSWORD` ile giriş yapın.
     Sistem yeni şifre belirlemenizi ister.
   - Adınızı **Kullanıcılar > Düzenle** ile değiştirebilirsiniz (ilk ad "Sistem Yöneticisi"dir).
   - Diğer kullanıcıları **Kullanıcılar > Yeni Kullanıcı** ile ekleyin.

Sorun olursa **Web** sekmesindeki **Log files > Error log** dosyasına bakın. Uygulama açılışta yaptıklarını
(ilk veri yüklendi, yönetici oluşturuldu vb.) oraya yazar.

## Güncelleme

1. Bash konsolunda son sürümü GitHub'dan çekin:

   ```bash
   cd ~/durakops
   git pull
   ```

2. `requirements.txt` değiştiyse:

   ```bash
   workon durakops-venv
   pip install -r ~/durakops/requirements.txt
   ```

3. **Web** sekmesinde **Reload**.

Veritabanı ve fotoğraflar `~/durakops-data/` klasöründedir ve depoda yoktur; güncelleme onlara dokunmaz. Şema
değişiklikleri (yeni tablo veya sütun) açılışta otomatik uygulanır. Güncellemeden önce yedek almanız önerilir
(aşağıda). Sunucudaki kod dosyalarını elle değiştirmeyin; `git pull` bu durumda durur.

### Erişim anahtarının süresi dolunca

`git pull` giriş hatası verirse GitHub'da yeni bir anahtar oluşturun (1. adım), sonra Bash konsolunda eski kaydı
silip çekmeyi tekrarlayın; kullanıcı adı ve yeni anahtar sorulur:

```bash
rm ~/.git-credentials
cd ~/durakops && git pull
```

### Zip ile kurulum ve güncelleme (GitHub olmadan)

Kendi bilgisayarınızda `python build_zip.py` ile `dist/durakops.zip` oluşturun (veritabanı, fotoğraflar, sanal
ortam ve gizli değer içermez). **Files** sekmesinde `/home/KULLANICI/` içine yükleyip Bash konsolunda
`cd ~ && unzip -o durakops.zip` çalıştırın; kod yine `~/durakops/` klasörüne açılır. İlk kurulumda 1. adımı ve
`git` komutlarını atlayın, diğer adımlar aynıdır.

## Telegram bildirimleri

Uygulama şu durumlarda bir Telegram grubuna mesaj gönderir: yeni iş, iş kapatıldı, iş yeniden işleme alındı,
süreye 24 saat kaldı, süre doldu, süre uzatıldı, iş silindi. Her mesajda iş numarası (#12), durak adı, iş türü ve
açıklama, silinmemiş işlerde işin bağlantısı vardır; içerik duruma göre değişir (teknisyen, servis günü, son
tarih, işin süresi, kullanılan malzemeler, mazeret, silen kişi ve silinen fotoğraf sayısı…).

1. **Bot oluşturun:** Telegram'da **@BotFather** ile konuşup `/newbot` yazın; bota bir ad (ör. Akıllı Durak Takip) ve
   `bot` ile biten bir kullanıcı adı verin. BotFather'ın verdiği anahtarı (token) kopyalayın; kimseyle paylaşmayın.
2. **Botu gruba ekleyin:** Ekibin Telegram grubuna botu üye olarak ekleyin ve grupta bir mesaj yazın (ör. `/start`).
3. **Anahtarı yazın:** WSGI dosyasındaki `TELEGRAM_BOT_TOKEN` satırının başındaki `#` işaretini silip anahtarı yazın,
   **Save** ve **Web** sekmesinde **Reload**.
4. **Grup kimliğini bulun:** Uygulamada **Kullanıcılar** > **Telegram Bildirimleri** > **Grup kimliğini bul**. Grubun
   kimliğini (eksi işaretiyle başlar) WSGI dosyasında `TELEGRAM_CHAT_ID` satırına yazın, **Save** ve **Reload**.
5. **Deneyin:** Aynı yerde **Test mesajı gönder**. Son bildirimlerin gönderilip gönderilmediği de orada görünür.

Nasıl çalışır:
- Mesaj işle aynı anda kuyruğa yazılır ve sayfaya cevap gittikten sonra gönderilir; kimse Telegram'ı beklemez.
  Telegram'a ulaşılamazsa 5 dakikada bir yeniden denenir (en fazla 5 kez; 2 günden eski mesajlar gönderilmez).
- Süre hatırlatmaları 5 dakikada bir kontrol edilir, ancak yalnızca site istek aldığında (açık sayfa kendini
  15 saniyede bir yeniler). Gece kimse sayfayı açık tutmuyorsa hatırlatma ilk istekle gider. Tam zamanında olması
  için ücretsiz bir izleme servisiyle (ör. UptimeRobot) `https://KULLANICI.pythonanywhere.com/healthz` adresini
  5 dakikada bir çağırabilirsiniz.
- Ücretsiz PythonAnywhere hesapları Telegram'a (`api.telegram.org`, izin listesinde) kendi ara sunucusu üzerinden bağlanır.

## Aylık yenileme (ücretsiz plan)

Ücretsiz plandaki web uygulamaları süreyle çalışır ve süre bitince devre dışı kalır. PythonAnywhere süre dolmadan
e-posta ile hatırlatır. Ayda bir:

1. PythonAnywhere'e giriş yapın ve **Web** sekmesini açın.
2. **Run until 1 month from today** düğmesine basın.

Süre dolmuşsa uygulama açılmaz. Aynı düğmeyle yeniden çalıştırın.

## Yedekleme

Bash konsolunda veritabanının tutarlı bir kopyasını alın ve fotoğrafları paketleyin:

```bash
cd ~
python3 -c "import sqlite3; sqlite3.connect('durakops-data/app.db').backup(sqlite3.connect('durakops-yedek.db'))"
zip -r durakops-foto-yedek.zip durakops-data/uploads
```

Oluşan `durakops-yedek.db` ve `durakops-foto-yedek.zip` dosyalarını **Files** sekmesinden bilgisayarınıza
indirin. Disk kotası küçük olduğu için indirdikten sonra sunucudan silin.

## Yönetici şifresini unutursanız

WSGI dosyasında `ADMIN_PASSWORD` değerini yeni bir değerle değiştirin ve **Reload** edin. Yöneticinin şifresi bu
değere sıfırlanır, açık oturumları kapanır ve ilk girişte yeni şifre belirlemesi istenir.

## Ücretsiz planın sınırları

- **Disk:** Hesabın tamamı için 512 MB (kod, sanal ortam, veritabanı, fotoğraflar). Fotoğraflar tarayıcıda en
  uzun kenarı 1280 piksel JPEG'e küçültülerek yüklenir (genelde 150–350 KB). Kullanım **Raporlar** sayfasındaki
  **Disk Kullanımı** kutucuğunda görünür; kapanmış işlerin fotoğrafları silinemediği için dolmaya yaklaşınca
  yedek alıp yer açmak gerekir.
- **İşlemci:** Ücretsiz planda işlemci süresi kısıtlıdır. Sayfa verileri 15 saniyede bir yeniler ve değişiklik
  yoksa boş yanıt (304) alır; sekme arka plandayken yenileme durur.
- **Adres:** Yalnızca `KULLANICI.pythonanywhere.com`; kendi alan adınızı bağlayamazsınız.
- **Süre:** Web uygulaması ayda bir yenilenmelidir (yukarıda).
- **Veritabanı:** SQLite, az sayıda eş zamanlı kullanıcı için uygundur. PythonAnywhere'in dosya sisteminde WAL
  modu kullanılmaz; uygulama klasik günlük moduna geçer.

## Kendi bilgisayarınızda çalıştırmak (Windows)

`app.py` çift tıklanarak açılmaz; o sunucunun kendisidir. Bunun yerine proje klasöründeki **`baslat.bat`**
dosyasına çift tıklayın:

- İlk seferde Python sanal ortamını hazırlar ve Flask'ı kurar (internet gerekir).
- Hiçbir şey sormaz. İlk seferde sistem yöneticisini Windows kullanıcı adınızla (ör. `ad.soyad`) oluşturur ve
  geçici şifreyi siyah pencerede ve `yerel_veri/ILK_GIRIS_BILGILERI.txt` dosyasında gösterir. İlk girişte kendi
  şifrenizi belirlersiniz; o zamana kadar aynı geçici şifre her açılışta yeniden gösterilir. Dosya silinirse
  yeni bir geçici şifre üretilir ve eskisi geçersiz olur.
- Tarayıcıda `http://127.0.0.1:5000` adresini açar. Siyah pencere açık kaldığı sürece çalışır; pencereyi
  kapatınca sunucu da kapanır.

Yerel veritabanı, fotoğraflar ve oturum anahtarı `yerel_veri/` klasöründe durur. Bu klasör, `baslat.bat` ve
`yerel_baslat.py` zip'e girmez. Yerel veri PythonAnywhere'deki veriden tamamen ayrıdır; `yerel_veri/` GitHub'a da
gönderilmez.
