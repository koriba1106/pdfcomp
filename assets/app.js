(() => {
"use strict";

// ---- クリックジャッキング対策（GitHub Pagesはレスポンスヘッダーを設定できないためJSで補完）----
if (window.top !== window.self) {
  document.body.textContent = "このページは埋め込み表示できません。";
  throw new Error("framed");
}

const $ = (id) => document.getElementById(id);
const MB = 1024 * 1024;
const MAX_FILE_BYTES = 250 * MB;
const MAX_PAGES = 1000;
const MAX_CANVAS_PIXELS = 24_000_000;
const BASE = document.baseURI;
const PDFJS_DIR = new URL("vendor/pdfjs/", BASE).href;

const state = { file: null, output: null, outputName: "", objectUrl: null, busy: false };

// ---- pdf.js は必要になった時に同一オリジンから読み込む ----
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_DIR + "pdf.min.js").then((mod) => {
      const lib = mod.getDocument ? mod : mod.default;
      lib.GlobalWorkerOptions.workerSrc = PDFJS_DIR + "pdf.worker.min.js";
      return lib;
    }).catch((e) => { pdfjsPromise = null; throw e; });
  }
  return pdfjsPromise;
}
// 信頼できないPDFを開くための安全なオプション（eval無効・XFA無効・外部通信なし）
function pdfjsOptions(data) {
  return {
    data,
    isEvalSupported: false,
    enableXfa: false,
    useSystemFonts: true,
    stopAtErrors: true,
    cMapUrl: PDFJS_DIR + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: PDFJS_DIR + "standard_fonts/",
    maxImageSize: MAX_CANVAS_PIXELS
  };
}

function setStatus(message, kind = "") {
  const el = $("status");
  el.textContent = message;
  el.className = "status" + (kind ? " " + kind : "");
  el.style.display = "block";
}
function hideStatus() { $("status").style.display = "none"; }
function fmt(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return bytes + " B";
  if (bytes < MB) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / MB).toFixed(2) + " MB";
}
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
function safeBaseName(name) {
  let base = String(name).normalize("NFC")
    .replace(/\.pdf$/i, "")
    // 制御文字・パス区切り・Windows禁止文字
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    // 双方向制御文字・ゼロ幅文字（拡張子偽装対策）
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
    .replace(/[. ]+$/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  if (!base || RESERVED.test(base)) base = "document";
  return base;
}
function releaseOutput() {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null; state.output = null; state.outputName = "";
  $("results").style.display = "none"; $("download").disabled = true;
}
function clearFile() {
  releaseOutput();
  state.file = null; $("file").value = "";
  $("file-card").style.display = "none";
  $("compress").disabled = true;
  hideStatus();
}
async function inspectPdfHeader(file) {
  const buf = await file.slice(0, 1024).arrayBuffer().catch(() => { throw new Error("ファイルを読み取れませんでした。"); });
  const text = new TextDecoder("latin1").decode(new Uint8Array(buf));
  const match = text.match(/%PDF-(\d\.\d)/);
  if (!match) throw new Error("PDFヘッダーを確認できません。破損ファイルやPDF以外のファイルは読み込めません。");
  return match[1];
}
async function acceptFile(file) {
  if (!file) return;
  clearFile();
  if (file.size <= 0) { setStatus("空のファイルは選択できません。", "bad"); return; }
  if (file.size > MAX_FILE_BYTES) { setStatus("安全上の制限により、250 MBを超えるファイルは扱えません。", "bad"); return; }
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    setStatus("PDFファイルのみ選択できます。", "bad"); return;
  }
  try {
    const version = await inspectPdfHeader(file);
    state.file = file;
    $("file-name").textContent = file.name;
    $("file-info").textContent = fmt(file.size) + " ・ PDF " + version + " ・ ヘッダー確認済み";
    $("file-card").style.display = "flex";
    $("compress").disabled = false;
    setStatus("ファイルを読み込みました。圧縮目標を設定してください。", "good");
  } catch (err) {
    setStatus(err.message || "PDFを確認できませんでした。", "bad");
  }
}
function targetBytes() {
  const value = Number($("target").value);
  if (!Number.isFinite(value) || value <= 0) throw new Error("目標値には0より大きい数値を入力してください。");
  if ($("mode").value === "mb") {
    if (value > 10000) throw new Error("目標サイズは10000 MB以下で指定してください。");
    return value * MB;
  }
  if (value >= 100 || value < 1) throw new Error("割合は1%以上、100%未満で指定してください。");
  return state.file.size * value / 100;
}
function updateMode() {
  const percent = $("mode").value === "percent";
  $("target-label").textContent = percent ? "目標割合" : "目標サイズ";
  $("target-unit").textContent = percent ? "%（元のサイズ比）" : "MB以下";
  $("target").value = percent ? "50" : "5";
  $("target").max = percent ? "99.9" : "10000";
  $("target").min = percent ? "1" : "0.1";
}
function rasterSettings(attempt) {
  const preset = document.querySelector('input[name="quality"]:checked')?.value || "standard";
  const base = preset === "high" ? 1.65 : preset === "small" ? 1.1 : 1.35;
  const scaleFactors = [1, 0.86, 0.72, 0.58];
  const qualityFactors = preset === "high" ? [0.84, 0.76, 0.68, 0.60]
    : preset === "small" ? [0.68, 0.58, 0.48, 0.40]
    : [0.76, 0.66, 0.56, 0.46];
  return { scale: Math.max(0.55, base * scaleFactors[attempt]), quality: qualityFactors[attempt] };
}
function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error("画像の生成に失敗しました。"));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/jpeg", quality);
  });
}

async function renderRasterPdf(file, attempt, progress) {
  const pdfjsLib = await loadPdfjs();
  const jsPDF = window.jspdf?.jsPDF;
  if (!jsPDF) throw new Error("画像化エンジンを読み込めません。");
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjsLib.getDocument(pdfjsOptions(data));
  let pdf;
  try {
    pdf = await task.promise;
    if (!pdf.numPages || pdf.numPages > MAX_PAGES) {
      throw new Error("ページ数が0、または安全上限の" + MAX_PAGES + "ページを超えています。");
    }
    const { scale, quality } = rasterSettings(attempt);
    let output = null;
    for (let n = 1; n <= pdf.numPages; n++) {
      progress("画像化して再構成しています…（" + n + "/" + pdf.numPages + " ページ、試行 " + (attempt + 1) + "/4）");
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale });
      const w = Math.ceil(viewport.width), h = Math.ceil(viewport.height);
      if (!Number.isFinite(w * h) || w * h > MAX_CANVAS_PIXELS) {
        page.cleanup();
        throw new Error("ページ " + n + " の画像サイズが安全上限を超えています。");
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, w); canvas.height = Math.max(1, h);
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Canvasを初期化できませんでした。");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, background: "#ffffff" }).promise;
      const jpeg = await canvasToJpeg(canvas, quality);
      const wPt = viewport.width / scale, hPt = viewport.height / scale;
      const orient = wPt >= hPt ? "landscape" : "portrait";
      if (!output) {
        output = new jsPDF({ orientation: orient, unit: "pt", format: [wPt, hPt], compress: true, putOnlyUsedFonts: true });
      } else {
        output.addPage([wPt, hPt], orient);
      }
      output.addImage(jpeg, "JPEG", 0, 0, wPt, hPt, undefined, "FAST");
      page.cleanup();
      canvas.width = 1; canvas.height = 1;
    }
    return { bytes: output.output("arraybuffer"), pages: pdf.numPages };
  } finally {
    if (pdf) await pdf.destroy(); else await task.destroy();
  }
}

async function verifyWithPdfjs(outputBytes, expectedPages) {
  let pdfjsLib;
  try { pdfjsLib = await loadPdfjs(); } catch (_) { return false; }
  const copy = new Uint8Array(outputBytes instanceof ArrayBuffer ? outputBytes.slice(0) : new Uint8Array(outputBytes));
  const task = pdfjsLib.getDocument(pdfjsOptions(copy));
  let doc;
  try {
    doc = await task.promise;
    if (doc.numPages !== expectedPages) throw new Error("出力検証に失敗しました。ページ数が一致しません。保存は行いません。");
    return true;
  } finally {
    if (doc) await doc.destroy(); else await task.destroy();
  }
}

async function runCompression() {
  if (!state.file || state.busy) return;
  hideStatus(); releaseOutput();

  let limit;
  try { limit = targetBytes(); } catch (e) { setStatus(e.message, "bad"); return; }
  if (limit >= state.file.size) {
    setStatus("目標サイズが元ファイル以上です。ファイルサイズを減らす目標を指定してください。", "warn");
    return;
  }
  const rasterMode = $("raster-mode").checked;
  if (rasterMode && !window.jspdf?.jsPDF) {
    setStatus("画像化エンジンを読み込めませんでした。ページを再読み込みしてください。ファイルは送信されていません。", "bad");
    return;
  }
  if (!rasterMode && typeof window.PDFLib?.PDFDocument?.load !== "function") {
    setStatus("PDF構造最適化エンジンを読み込めませんでした。ページを再読み込みしてください。ファイルは送信されていません。", "bad");
    return;
  }

  state.busy = true;
  $("compress").disabled = true;
  const startedAt = performance.now();
  setStatus("PDFを解析しています。処理中はこのタブを閉じないでください。");
  try {
    let outputBytes, outputPages;
    if (rasterMode) {
      let best = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = await renderRasterPdf(state.file, attempt, (m) => setStatus(m));
        if (!best || r.bytes.byteLength < best.bytes.byteLength) best = r;
        if (r.bytes.byteLength <= limit) break;
      }
      outputBytes = best.bytes; outputPages = best.pages;
    } else {
      const inputBytes = await state.file.arrayBuffer();
      const opts = { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false };
      const pdf = await window.PDFLib.PDFDocument.load(inputBytes, opts);
      if (pdf.getPageCount() > MAX_PAGES) throw new Error("ページ数が安全上限の" + MAX_PAGES + "ページを超えています。");
      try {
        pdf.setTitle(""); pdf.setAuthor(""); pdf.setSubject(""); pdf.setKeywords([]);
        pdf.setProducer("PDFファイルを小さく by 武庫"); pdf.setCreator("PDFファイルを小さく by 武庫");
      } catch (_) { /* 古い/特殊なPDFではメタデータ操作が失敗することがある */ }
      setStatus("PDFの構造を再構築しています…");
      outputBytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50, updateFieldAppearances: false });
      const verified = await window.PDFLib.PDFDocument.load(outputBytes, opts);
      outputPages = verified.getPageCount();
      if (outputPages !== pdf.getPageCount()) throw new Error("出力検証に失敗しました。ページ数が一致しません。保存は行いません。");
    }

    setStatus("出力PDFを検証しています…");
    const pdfjsChecked = await verifyWithPdfjs(outputBytes, outputPages);

    state.output = new Blob([outputBytes], { type: "application/pdf" });
    state.outputName = safeBaseName(state.file.name) + "_compressed.pdf";
    state.objectUrl = URL.createObjectURL(state.output);

    const originalSize = state.file.size, outputSize = state.output.size;
    const reduction = (1 - outputSize / originalSize) * 100;
    $("original-size").textContent = fmt(originalSize);
    $("output-size").textContent = fmt(outputSize);
    $("reduction").textContent = (reduction >= 0 ? reduction.toFixed(1) : "−" + Math.abs(reduction).toFixed(1)) + "%";
    const reached = outputSize <= limit;
    $("result-note").textContent =
      "出力名: " + state.outputName + "。ページ数 " + outputPages +
      "。処理時間 " + ((performance.now() - startedAt) / 1000).toFixed(1) + " 秒。" +
      (pdfjsChecked ? "" : " ※PDF.jsによる再読込検証は実行できませんでした。") +
      (reached
        ? (rasterMode ? " 目標サイズを達成しました。画像化により文字検索・リンク等は保持されません。" : " 目標サイズを達成しました。保存後に内容を確認してください。")
        : " 目標サイズには到達しませんでした。これ以上の圧縮には別方式が必要な場合があります。");
    $("results").style.display = "block";
    $("download").disabled = false;
    if (reached) {
      setStatus(rasterMode
        ? "画像化による強力圧縮と出力検証が完了しました。文字検索やリンク等が失われているため、用途に合うか必ず確認してください。"
        : "構造最適化と出力検証が完了しました。ページ数を確認済みです。保存前に内容をご確認ください。", "good");
    } else {
      setStatus(rasterMode
        ? "画像化を含む4段階の圧縮を試しましたが、目標サイズには到達しませんでした。画質をさらに下げると読みにくくなる可能性があります。"
        : "PDFの構造最適化は完了しましたが、目標サイズには到達しませんでした。画像再圧縮など、より強い処理が必要な可能性があります。", "warn");
    }
  } catch (err) {
    const message = String((err && err.message) || err || "不明なエラー");
    if (/encrypt|password/i.test(message)) {
      setStatus("暗号化またはパスワード保護されたPDFは、このバージョンでは処理できません。元ファイルは変更されていません。", "bad");
    } else {
      setStatus("圧縮に失敗しました。破損・非対応PDF、メモリ不足、または特殊な構造の可能性があります。元ファイルは変更されていません。詳細: " + message.slice(0, 240), "bad");
    }
    releaseOutput();
  } finally {
    state.busy = false;
    $("compress").disabled = !state.file;
  }
}
function resetAll() {
  clearFile(); $("mode").value = "mb"; updateMode();
  $("raster-mode").checked = false; $("raster-warning").classList.add("hidden");
  $("qstandard").checked = true;
}

$("choose").addEventListener("click", () => $("file").click());
$("drop").addEventListener("click", (e) => { if (e.target.closest("button")) return; $("file").click(); });
$("drop").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); } });
$("file").addEventListener("change", (e) => acceptFile(e.target.files && e.target.files[0]));
$("remove").addEventListener("click", clearFile);
$("mode").addEventListener("change", updateMode);
$("raster-mode").addEventListener("change", () => {
  $("raster-warning").classList.toggle("hidden", !$("raster-mode").checked);
});
$("compress").addEventListener("click", runCompression);
$("reset").addEventListener("click", resetAll);
$("download").addEventListener("click", () => {
  if (!state.output || !state.objectUrl) return;
  const a = document.createElement("a");
  a.href = state.objectUrl; a.download = state.outputName; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
});
const drop = $("drop");
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add("drag"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove("drag"); }));
drop.addEventListener("drop", (e) => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  if (files.length !== 1) { setStatus("一度に選択できるファイルは1件です。", "warn"); return; }
  acceptFile(files[0]);
});
// ブラウザ全体でのファイルドロップ誤爆（PDFが開いてしまう）を防止
["dragover", "drop"].forEach((t) => window.addEventListener(t, (e) => { if (!e.target.closest || !e.target.closest("#drop")) e.preventDefault(); }));
window.addEventListener("beforeunload", () => { if (state.objectUrl) URL.revokeObjectURL(state.objectUrl); });
updateMode();
})();
