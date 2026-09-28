-- Durak Ops veritabanı şeması (SQLite, Python'un yerleşik sqlite3 modülü).
-- Uygulama her açılışta bu dosyayı çalıştırır; tüm komutlar IF NOT EXISTS olduğu için
-- tekrar çalıştırmak zararsızdır. Var olan bir tabloya buraya yeni eklenen sütunlar,
-- açılışta otomatik olarak (boş değerle) eklenir.
-- Tarih/saat alanları ISO-8601 metindir (UTC), örn. 2026-09-24T12:00:00.000Z; evet/hayır alanları 1/0.

-- Ekranlar: her kayıt bir durak noktasındaki ekrandır (durak no + yön).
CREATE TABLE IF NOT EXISTS [ekranlar] (
  [id] TEXT PRIMARY KEY,
  [durak_no] TEXT,
  [yon] TEXT,
  [durak_id] TEXT,
  [durak_adi] TEXT,
  [adres] TEXT,
  [bolge_kod] TEXT,
  [bina_id_no] TEXT,
  [dys_onay_no] TEXT,
  [enerji_bilgisi] TEXT,
  [elektrik_kaynagi] TEXT,
  [ekran_tipi] TEXT,
  [sim_no] TEXT,
  [enlem] REAL,
  [boylam] REAL,
  [kontrol_tarihi] TEXT,
  [ozel_not] TEXT,
  [model] TEXT,
  [seri_no] TEXT,
  [kurulum_tarihi] TEXT,
  [durum] TEXT,
  [olusturma] TEXT,
  [guncelleme] TEXT
);

CREATE TABLE IF NOT EXISTS [teknisyenler] (
  [id] TEXT PRIMARY KEY,
  [ad_soyad] TEXT,
  [telefon] TEXT,
  [aktif] INTEGER,
  [olusturma] TEXT,
  [guncelleme] TEXT
);

-- Malzeme / işlem kataloğu.
CREATE TABLE IF NOT EXISTS [malzemeler] (
  [id] TEXT PRIMARY KEY,
  [ad] TEXT,
  [birim] TEXT,
  [olusturma] TEXT,
  [guncelleme] TEXT
);

-- İşler: tur = ariza | icerik | genel ; durum = acik | atandi | islemde | cozuldu | kapandi
CREATE TABLE IF NOT EXISTS [isler] (
  [id] TEXT PRIMARY KEY,
  [baslik] TEXT,
  [tur] TEXT,
  [oncelik] TEXT,
  [durum] TEXT,
  [ekran_id] TEXT,
  [teknisyen_id] TEXT,
  [servis_gunu] TEXT,
  [aciklama] TEXT,
  [olusturma] TEXT,
  [guncelleme] TEXT,
  [cozulme] TEXT,
  [son_tarih] TEXT
);

-- Bir işte kullanılan malzemeler ve miktarları.
CREATE TABLE IF NOT EXISTS [is_malzemeleri] (
  [id] INTEGER PRIMARY KEY AUTOINCREMENT,
  [is_id] TEXT NOT NULL,
  [malzeme_id] TEXT NOT NULL,
  [miktar] REAL
);

-- İş geçmişi: durum değişiklikleri ve notlar (eklenme sırasıyla).
CREATE TABLE IF NOT EXISTS [is_gecmisi] (
  [id] INTEGER PRIMARY KEY AUTOINCREMENT,
  [is_id] TEXT NOT NULL,
  [zaman] TEXT,
  [durum] TEXT,
  [notlar] TEXT,
  [yazan] TEXT
);

-- İş fotoğrafları: tur = once | sonra. Dosyalar UPLOAD_DIR klasöründe.
CREATE TABLE IF NOT EXISTS [is_fotograflari] (
  [id] INTEGER PRIMARY KEY AUTOINCREMENT,
  [is_id] TEXT NOT NULL,
  [tur] TEXT NOT NULL,
  [dosya] TEXT NOT NULL,
  [yukleme] TEXT,
  [yukleyen] TEXT
);

-- Süresi geçen işlerde mazeret gösterilerek yapılan son tarih uzatmaları.
CREATE TABLE IF NOT EXISTS [is_sure_uzatmalari] (
  [id] INTEGER PRIMARY KEY AUTOINCREMENT,
  [is_id] TEXT NOT NULL,
  [zaman] TEXT,
  [eski_tarih] TEXT,
  [yeni_tarih] TEXT,
  [mazeret] TEXT,
  [yazan] TEXT
);

-- Kullanıcılar. calisan_turu = kurum | firma. yonetici = 1 yalnızca ADMIN_USERNAME hesabıdır;
-- kullanıcı ekleme, düzenleme ve şifre sıfırlama yalnızca ona açıktır.
-- sifre_ozeti: werkzeug özeti (şifrenin kendisi saklanmaz).
-- oturum_surumu: şifre sıfırlanınca / hesap pasif yapılınca artar; eski oturumlar geçersiz olur.
CREATE TABLE IF NOT EXISTS [kullanicilar] (
  [id] TEXT PRIMARY KEY,
  [kullanici_adi] TEXT NOT NULL COLLATE NOCASE,
  [ad] TEXT,
  [soyad] TEXT,
  [calisan_turu] TEXT,
  [yonetici] INTEGER NOT NULL DEFAULT 0,
  [aktif] INTEGER NOT NULL DEFAULT 1,
  [sifre_ozeti] TEXT,
  [sifre_degismeli] INTEGER NOT NULL DEFAULT 1,
  [oturum_surumu] INTEGER NOT NULL DEFAULT 0,
  [olusturma] TEXT,
  [son_giris] TEXT
);

-- Uygulamanın kendi kayıtları: ilk veri yüklendi mi (ilk_veri), yönetici şifresinin izi (yonetici_sifre_izi;
-- ADMIN_PASSWORD değiştirilince yönetici şifresi sıfırlanır).
CREATE TABLE IF NOT EXISTS [ayarlar] (
  [anahtar] TEXT PRIMARY KEY,
  [deger] TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS [ux_kullanicilar_adi] ON [kullanicilar] ([kullanici_adi]);
CREATE INDEX IF NOT EXISTS [ix_isler_ekran] ON [isler] ([ekran_id]);
CREATE INDEX IF NOT EXISTS [ix_isler_teknisyen] ON [isler] ([teknisyen_id]);
CREATE INDEX IF NOT EXISTS [ix_is_malzemeleri_is] ON [is_malzemeleri] ([is_id]);
CREATE INDEX IF NOT EXISTS [ix_is_malzemeleri_malzeme] ON [is_malzemeleri] ([malzeme_id]);
CREATE INDEX IF NOT EXISTS [ix_is_gecmisi_is] ON [is_gecmisi] ([is_id]);
CREATE INDEX IF NOT EXISTS [ix_is_fotograflari_is] ON [is_fotograflari] ([is_id]);
CREATE INDEX IF NOT EXISTS [ix_is_sure_uzatmalari_is] ON [is_sure_uzatmalari] ([is_id]);
