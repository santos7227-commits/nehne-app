/* =====================================================
   nehne調香ノート Service Worker
   方式: ネットワーク優先 (Network First)
   - オンライン時: 常にGitHub Pagesから最新版を取得
     → GitHubのファイルを置き換えるだけで自動更新される
   - オフライン時: 最後に取得したキャッシュで動作
   ===================================================== */

const CACHE_NAME = 'nehne-cache-v1';

/* インストール時: すぐに新しいSWを有効化 */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

/* 有効化時: 古いキャッシュを削除して全タブの制御を引き継ぐ */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* 取得時: まずネットワーク → 成功したらキャッシュ更新 → 失敗(オフライン)ならキャッシュ */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        /* 正常応答をキャッシュに保存(次回オフライン用) */
        const copy = res.clone();
        caches.open(CACHE_NAME)
          .then((cache) => cache.put(req, copy))
          .catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => {
          if (cached) return cached;
          /* ページ遷移リクエストならトップページのキャッシュで代替 */
          if (req.mode === 'navigate') {
            return caches.match('./index.html').then((idx) => idx || caches.match('./'));
          }
          return Response.error();
        })
      )
  );
});
