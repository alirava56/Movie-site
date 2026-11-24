import { useId, useMemo, useRef, useState } from "react";
import { catalogItemKey, normalizeQuery } from "./catalog.js";
import { indexTitles, LIMITS, localDate, normalizePoster, normalizeYear, parseBackup, serializeBackup } from "./library.js";
import { readLegacy } from "./storage.js";
import { useCatalog } from "./use-catalog.js";
import { CatalogActions } from "./discover.jsx";
import { Button, formatNumber, Icon, ItemMeta, Modal, Poster, SearchForm, Segmented, StatusPanel } from "./ui.jsx";

const STATUSES = [["watch", "فهرست تماشا"], ["watched", "دیده‌ها"]];
const KINDS = [["movie", "فیلم"], ["series", "سریال"]];
const EMPTY_MANUAL = { title: "", year: "", kind: "movie", url: "", uploaded: "", status: "watch" };
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function errorMessage(error) {
  switch (error?.code) {
    case "backup-size": return "اندازهٔ پشتیبان از ۲۴ مگابایت بیشتر است.";
    case "library-size": return "حداکثر ظرفیت فهرست ۳۰۰۰ عنوان است.";
    case "backup-version": return "نسخهٔ این فایل پشتیبان پشتیبانی نمی‌شود.";
    case "backup-format": return "فایل یا متن پشتیبان معتبر نیست.";
    case "title": return "نام عنوان را بررسی کنید.";
    case "conflict": return "همین اطلاعات در زبانهٔ دیگری تغییر کرده است. اطلاعات تازه را بارگیری کنید.";
    case "missing": return "این عنوان دیگر در فهرست وجود ندارد.";
    default: return "ذخیره در مرورگر انجام نشد. فضای ذخیره‌سازی و تنظیمات مرورگر را بررسی کنید.";
  }
}

async function resizePoster(file) {
  if (!IMAGE_TYPES.has(file.type) || file.size > LIMITS.imageFile) throw new Error("image-file");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > LIMITS.imagePixels) throw new Error("image-size");
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 450;
    const ratio = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const width = image.naturalWidth * ratio;
    const height = image.naturalHeight * ratio;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("image-context");
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    const result = normalizePoster(canvas.toDataURL("image/jpeg", 0.78));
    if (!result) throw new Error("image-export");
    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function ManualForm({ onAdd, writable, onBusy }) {
  const [form, setForm] = useState(EMPTY_MANUAL);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const posterInput = useRef(null);
  const errorId = useId();

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
    setError("");
    setMessage("");
  }

  async function onFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const uploaded = await resizePoster(file);
      setForm((current) => ({ ...current, uploaded, url: "" }));
    } catch {
      setError("پوستر باید تصویر JPG، PNG یا WebP، حداکثر ۸ مگابایت و ۲۴ مگاپیکسل باشد.");
    } finally {
      setUploading(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (!writable || busy || uploading) return;
    const title = form.title.trim();
    const year = normalizeYear(form.year);
    const poster = form.uploaded || normalizePoster(form.url, { allowData: false });
    if (!title) return setError("نام فیلم یا سریال را وارد کنید.");
    if (form.year.trim() && !year) return setError("سال میلادی را با چهار رقم وارد کنید.");
    if (form.url.trim() && !poster) return setError("نشانی پوستر باید با https:// شروع شود.");
    setError("");
    setMessage("");
    setBusy(true);
    onBusy(true);
    try {
      const result = await onAdd({ title, year, kind: form.kind, poster }, form.status);
      if (result.added) {
        setForm(EMPTY_MANUAL);
        setMessage("عنوان در فهرست شما ذخیره شد.");
      } else setError("این عنوان از قبل در فهرست شماست. برای تغییر وضعیت، جزئیات آن را باز کنید.");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }

  return (
    <form className="form-stack" onSubmit={submit} aria-describedby={error ? errorId : undefined}>
      <label className="field">نام فیلم یا سریال<input value={form.title} dir="auto" required maxLength={LIMITS.title}
        onChange={(event) => update("title", event.target.value)} /></label>
      <div className="field-row">
        <label className="field"><span>سال میلادی <small>اختیاری</small></span><input value={form.year} maxLength={4} inputMode="numeric" placeholder="مثلاً ۲۰۲۴"
          onChange={(event) => update("year", event.target.value)} /></label>
        <div className="field"><span>نوع عنوان</span><Segmented label="نوع عنوان دستی" options={KINDS} value={form.kind} onChange={(value) => update("kind", value)} /></div>
      </div>
      <div className="field"><span>ثبت در</span><Segmented label="وضعیت عنوان دستی" options={STATUSES} value={form.status} onChange={(value) => update("status", value)} /></div>
      <label className="field"><span>نشانی پوستر <small>اختیاری</small></span><input type="text" inputMode="url" dir="ltr" value={form.url} maxLength={2048}
        disabled={uploading} placeholder="https://" onChange={(event) => {
          const url = event.target.value;
          setForm((current) => ({ ...current, uploaded: "", url }));
          setError("");
        }} /></label>
      <input hidden ref={posterInput} type="file" accept="image/jpeg,image/png,image/webp" onChange={onFile} />
      <div className="button-row">
        <Button icon="upload" disabled={uploading} onClick={() => posterInput.current.click()}>
          {uploading ? "در حال آماده‌سازی…" : (form.uploaded ? "تغییر تصویر انتخاب‌شده" : "انتخاب تصویر")}
        </Button>
        {form.uploaded && <Button variant="ghost" onClick={() => update("uploaded", "")}>برداشتن تصویر</Button>}
      </div>
      {error && <p id={errorId} className="field-error" role="alert">{error}</p>}
      {message && <p className="success-note" role="status">{message}</p>}
      <div className="dialog-actions"><Button type="submit" variant="primary" disabled={busy || uploading || !writable}>ثبت عنوان</Button></div>
    </form>
  );
}

export function AddDialog({ items, onAdd, onOpen, onClose, writable }) {
  const [mode, setMode] = useState("search");
  const [value, setValue] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const page = useCatalog({ kind: "movie", q: query }, { both: true, enabled: mode === "search" && Boolean(query) });
  const index = useMemo(() => indexTitles(items), [items]);

  async function addFromCatalog(item, status) {
    setError("");
    try {
      await onAdd(item, status);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  return (
    <Modal title="افزودن عنوان" onClose={onClose} busy={busy}>
      <Segmented label="روش افزودن عنوان" options={[["search", "جستجو در کاتالوگ"], ["manual", "ثبت دستی"]]} value={mode}
        onChange={(next) => { if (!busy) { setMode(next); setError(""); } }} />
      <div className="dialog-content">
        {mode === "manual" ? <ManualForm onAdd={onAdd} writable={writable} onBusy={setBusy} /> : (
          <>
            <SearchForm label="عنوان برای افزودن" value={value} onChange={setValue} initialFocus
              onClear={() => { setValue(""); setQuery(""); setError(""); }}
              onSearch={() => { setQuery(normalizeQuery(value)); setError(""); }} />
            {page.status === "loading" && <p className="loading" role="status">در حال جستجو…</p>}
            {page.status === "error" && <StatusPanel title="جستجو ناموفق بود" tone="error" action={<Button onClick={page.retry}>تلاش دوباره</Button>}>ثبت دستی هم در دسترس است.</StatusPanel>}
            {page.status === "ready" && !page.items.length && <StatusPanel title="عنوانی پیدا نشد">املای عنوان را بررسی کنید یا آن را دستی ثبت کنید.</StatusPanel>}
            {page.partial && <p className="muted" role="status">بخشی از نتایج جستجو در دسترس نبود.</p>}
            {error && <p className="field-error" role="alert">{error}</p>}
            <div className="search-results">
              {page.items.map((item) => (
                <article className="search-result" key={catalogItemKey(item)}>
                  <Poster item={item} compact />
                  <div>
                    <h3 dir="auto">{item.title}</h3>
                    <ItemMeta item={item} />
                    <div className="card-actions"><CatalogActions item={item} existing={index.find(item)} onAdd={addFromCatalog} onOpen={onOpen} writable={writable} /></div>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function RatingField({ value, onChange }) {
  return (
    <fieldset className="rating-field">
      <legend>امتیاز من</legend>
      <div className="rating-buttons" dir="ltr">
        {[1, 2, 3, 4, 5].map((number) => (
          <button className="rating-button" type="button" key={number} aria-pressed={number === value}
            aria-label={`${formatNumber(number)} از ۵`} data-filled={number <= value} onClick={() => onChange(number === value ? 0 : number)}>
            <Icon name="star" size={24} />
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function detailFields(item) {
  return { status: item.status, myRating: item.myRating, watchedAt: item.watchedAt, note: item.note };
}

export function DetailDialog({ item, onClose, onSave, onDelete, writable }) {
  const noteId = useId();
  const [base, setBase] = useState(item);
  const [draft, setDraft] = useState(() => detailFields(item));
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(null);
  const first = detailFields(base);
  const dirty = Object.keys(first).some((key) => first[key] !== draft[key]);
  const imdbLink = item.imdbId ? `https://www.imdb.com/title/${item.imdbId}/` : `https://www.imdb.com/find/?${new URLSearchParams({ q: item.title })}`;

  function update(patch) {
    setDraft((previous) => ({ ...previous, ...patch }));
    setConfirm("");
  }

  async function save(event) {
    event.preventDefault();
    if (!dirty || busy || !writable || confirm) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(base, draft);
      onClose();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await onDelete(item.id);
      onClose();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={item.title} onClose={() => dirty ? setConfirm("close") : onClose()} busy={busy}>
      <div className="detail-summary">
        <Poster item={item} compact eager />
        <div>
          <ItemMeta item={item} />
          {item.genre && <p className="muted" dir="auto">{item.genre}</p>}
          {item.overview && <p className="overview" dir="auto">{item.overview}</p>}
          <a className="external-link" href={imdbLink} rel="noopener noreferrer" target="_blank">مشاهده در IMDb <Icon name="arrowUp" size={15} /></a>
        </div>
      </div>
      <form className="form-stack detail-form" onSubmit={save}>
        <Segmented label="وضعیت عنوان" options={STATUSES} value={draft.status} onChange={(status) => {
          const watchedAt = status === "watched" && !draft.watchedAt ? localDate() : draft.watchedAt;
          update({ status, watchedAt });
        }} />
        {draft.status === "watched" && (
          <div className="field-row detail-fields">
            <RatingField value={draft.myRating} onChange={(myRating) => update({ myRating })} />
            <label className="field">تاریخ تماشا<input type="date" dir="ltr" value={draft.watchedAt} min="1000-01-01" max="9999-12-31"
              onChange={(event) => update({ watchedAt: event.target.value })} /></label>
          </div>
        )}
        <div className="field">
          <label htmlFor={noteId}>یادداشت</label>
          <textarea id={noteId} rows={3} dir="auto" value={draft.note} maxLength={LIMITS.note} onChange={(event) => update({ note: event.target.value })} />
        </div>
        {error && <p className="field-error" role="alert">{errorMessage(error)}</p>}
        {error?.code === "conflict" && (
          <Button onClick={() => { setBase(item); setDraft(detailFields(item)); setError(null); }}>بارگیری اطلاعات تازه</Button>
        )}
        {!confirm && (
          <div className="dialog-actions">
            <Button type="submit" variant="primary" disabled={!dirty || busy || !writable}>ذخیره تغییرات</Button>
            <Button variant="ghost" icon="trash" disabled={!writable || busy} onClick={() => setConfirm("delete")}>حذف عنوان</Button>
          </div>
        )}
        {confirm && (
          <div className="confirm-panel">
            <p role="status">{confirm === "delete" ? "این عنوان و یادداشت‌های آن از فهرست حذف می‌شوند." : "تغییرات این عنوان هنوز ذخیره نشده‌اند."}</p>
            <div className="button-row">
              <Button variant="danger" disabled={busy} onClick={confirm === "delete" ? remove : onClose}>
                {confirm === "delete" ? "تأیید حذف" : "کنار گذاشتن تغییرات"}
              </Button>
              <Button disabled={busy} onClick={() => setConfirm("")}>بازگشت به ویرایش</Button>
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}

function downloadJson(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function BackupDialog({ items, onImport, onClose, writable, migrationWarning }) {
  const textId = useId();
  const [text, setText] = useState("");
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const input = useRef(null);
  const legacy = useMemo(() => migrationWarning ? readLegacy().raw : null, [migrationWarning]);

  function review(raw) {
    setError("");
    setMessage("");
    setSummary(null);
    try {
      setSummary(parseBackup(raw));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  async function readFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setSummary(null);
    setError("");
    setMessage("");
    if (file.size > LIMITS.backup) return setError("اندازهٔ فایل باید حداکثر ۲۴ مگابایت باشد.");
    setBusy(true);
    try {
      setText("");
      review(await file.text());
    } catch {
      setError("خواندن فایل پشتیبان ناموفق بود.");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!summary || busy || !writable) return;
    setBusy(true);
    setError("");
    try {
      const result = await onImport(summary);
      setMessage(`${formatNumber(result.added)} عنوان وارد شد، ${formatNumber(result.duplicates)} تکراری و ${formatNumber(result.skipped)} نامعتبر بود. فیلدهای ${formatNumber(result.repaired)} رکورد اصلاح شد.`);
      setSummary(null);
      setText("");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(serializeBackup(items));
      setMessage("متن پشتیبان کپی شد.");
      setError("");
    } catch {
      setError("کپی در این مرورگر در دسترس نبود. از دانلود فایل استفاده کنید.");
    }
  }

  return (
    <Modal title="پشتیبان فهرست" onClose={onClose} busy={busy}>
      <div className="form-stack">
        <p className="muted">{formatNumber(items.length)} عنوان در این فهرست است. برای انتقال به مرورگر یا نشانی دیگر، فایل پشتیبان را دانلود کنید.</p>
        <div className="button-row">
          <Button variant="primary" icon="download" onClick={() => downloadJson(serializeBackup(items), "didamesh-backup.json")}>دانلود پشتیبان</Button>
          <Button onClick={copy}>کپی متن پشتیبان</Button>
          {legacy !== null && <Button onClick={() => downloadJson(legacy, "didamesh-backup-legacy.json")}>دانلود دادهٔ قدیمی</Button>}
        </div>
        <div className="import-area form-stack">
          <h3>وارد کردن پشتیبان</h3>
          <input hidden type="file" ref={input} accept=".json,application/json" onChange={readFile} />
          <Button icon="upload" disabled={busy || !writable} onClick={() => input.current.click()}>انتخاب فایل پشتیبان</Button>
          <div className="field">
            <label htmlFor={textId}>متن پشتیبان</label>
            <textarea id={textId} dir="ltr" rows={3} value={text} disabled={busy || !writable} onChange={(event) => {
              setText(event.target.value);
              setSummary(null);
              setError("");
            }} />
          </div>
          <div className="button-row"><Button disabled={busy || !text.trim() || !writable} onClick={() => review(text)}>بررسی متن</Button></div>
          {summary && (
            <div className="confirm-panel">
              <p role="status">{formatNumber(summary.items.length)} رکورد قابل بررسی، {formatNumber(summary.skipped)} نامعتبر و {formatNumber(summary.repaired)} نیازمند اصلاح فیلد.</p>
              <Button variant="primary" disabled={busy || !summary.items.length} onClick={commit}>وارد کردن به فهرست</Button>
            </div>
          )}
          {error && <p className="field-error" role="alert">{error}</p>}
          {message && <p className="success-note" role="status">{message}</p>}
        </div>
      </div>
    </Modal>
  );
}
