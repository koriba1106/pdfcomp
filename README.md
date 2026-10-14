# PDFファイルを小さく by 武庫

ブラウザ内でPDFを再構築し、出力サイズを検証する静的Webアプリです。**GitHub Actions不要**で、`main` ブランチのルートをそのまま公開できます。

## 公開手順（Actionsなし）

1. GitHubで新しいリポジトリを作成します。
2. このフォルダの中身（`index.html`、`assets/`、`vendor/`、`.nojekyll` など）を **リポジトリのルート**へアップロードして `main` に commit します。
3. **Settings → Pages → Build and deployment** で
   **Source: Deploy from a branch** → **Branch: `main` / `/ (root)`** → **Save**。
4. 1〜2分後、Pages画面に表示されるURLで公開されます。以後は `main` に保存（push）するだけで自動更新されます。

> 以前の版を使っている場合: `.github/workflows/pages.yml` は削除してください。Sourceが「GitHub Actions」のままだと公開されません。

## 構成

```
index.html        画面（インラインJS/CSSなし）
assets/app.js     アプリ本体
assets/style.css  スタイル
vendor/           同梱ライブラリ（固定版・CDN不使用）
  pdf-lib.min.js        1.17.1
  jspdf.umd.min.js      4.2.1
  pdfjs/                pdf.js 4.10.38（legacy build, cmaps, standard_fonts）
  licenses/             各ライセンス
  SHA256SUMS            改ざん確認用ハッシュ
```

## 機能

- PDFのドラッグ＆ドロップ／ファイル選択、ヘッダー確認、入力上限250 MB・1000ページ
- MBまたは元サイズ比（%）で目標指定
- 通常モード（構造最適化）と、明示選択の強力圧縮モード（ページ画像化。4段階で試行し最小の出力を採用）
- 元ファイルは変更せず `_compressed.pdf` の別名で保存
- 出力PDFをpdf-libとPDF.jsで再読込し、ページ数を検証
- PDFデータは外部へ送信しません

## セキュリティ対策（v2）

| 対策 | 内容 |
|---|---|
| CDN依存の排除 | 外部CDNからの読み込みをやめ、固定版をリポジトリに同梱。CDN側の改ざん・障害の影響を受けません |
| 脆弱なライブラリの更新 | pdf.js 3.11.174 → 4.10.38（CVE-2024-4367：細工PDFで任意JS実行 の修正版）、jsPDF 2.5.1 → 4.2.1（ReDoS・DoS等の既知脆弱性の修正版） |
| 厳格なCSP | `default-src 'none'`、スクリプト/CSS/通信はすべて同一オリジンのみ。外部への送信自体をブラウザが拒否します |
| 信頼できないPDFの安全な処理 | pdf.js: `isEvalSupported:false`、`enableXfa:false`、画像サイズ上限 |
| DoS対策 | 入力250 MB・1000ページ・キャンバス2400万画素の上限 |
| ファイル名の無害化 | 制御文字・パス区切り・双方向制御文字（拡張子偽装）・Windows予約名を除去 |
| 出力のXSS対策 | ファイル名やエラー文は `textContent` のみで表示（`innerHTML` 不使用） |
| 埋め込み防止 | iframe内では動作しないクリックジャッキング対策 |
| Referrer遮断 | `referrer: no-referrer` |
| 日本語PDFの描画改善 | CMap/標準フォントを同梱（画像化モードで非埋め込みCJKフォントも描画しやすく） |

### 既知の制限

- GitHub Pagesはレスポンスヘッダーを設定できないため、CSPは `<meta>` で指定しています。`frame-ancestors`、`X-Frame-Options`、HSTSのカスタム設定はできません（iframe対策はJSで補完）。厳密なヘッダー制御が必要な場合は、Cloudflare Pages等の前段を検討してください。
- pdf-lib 1.17.1 は更新が止まっているライブラリです（既知の脆弱性報告はありません）。
- 通常モードは画像の再圧縮を行わないため、すべてのPDFが小さくなるわけではありません。
- 画像化モードでは文字検索・リンク・フォーム・注釈・電子署名などが失われます。
- PDFを再保存すると電子署名の有効性が失われる場合があります。重要書類は元ファイルを保管してください。
- 暗号化・破損・特殊構造のPDFは処理できないことがあります。

## ライブラリ更新時

`npm pack <pkg>@<version>` で配布物を取得し、`vendor/` の対応ファイルを置き換えて `vendor/SHA256SUMS` を更新してください。更新状況は定期的に確認することをおすすめします。

確認: `cd vendor && sha256sum -c SHA256SUMS`

## ローカル確認

ES module/動的importを使うため、`file://` ではなく簡易サーバーで確認してください。

```
python3 -m http.server 8000
```
