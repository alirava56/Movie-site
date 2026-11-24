import { Component, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Discover } from "./discover.jsx";
import { AddDialog, BackupDialog, DetailDialog, errorMessage } from "./dialogs.jsx";
import { addTitle, editTitle, mergeBackup, removeTitle, searchKey } from "./library.js";
import { useLibrary } from "./use-library.js";
import { Button, formatNumber, Icon, ItemMeta, Poster, Segmented, StatusPanel } from "./ui.jsx";

const VIEWS = [["discover", "کشف", "search"], ["watched", "دیده‌ها", "eye"], ["watch", "فهرست تماشا", "bookmark"]];
const TITLE_KINDS = [["all", "همه"], ["movie", "فیلم"], ["series", "سریال"]];

function LibraryView({ view, items, status, onOpen, onAdd }) {
  const [kind, setKind] = useState("all");
  const [query, setQuery] = useState("");
  const heading = view === "watched" ? "دیده‌ها" : "فهرست تماشا";
  const list = useMemo(() => {
    const term = searchKey(query);
    return items.filter((item) => item.status === view && (kind === "all" || item.kind === kind) && searchKey(item.title).includes(term))
      .sort((a, b) => (view === "watched" ? b.watchedAt.localeCompare(a.watchedAt) : 0) || b.addedAt - a.addedAt);
  }, [items, view, kind, query]);
  const hasItems = items.some((item) => item.status === view);

  return (
    <>
      <section className="view-heading library-heading" aria-labelledby="library-title">
        <div>
          <h1 id="library-title">{heading}</h1>
          <p>{view === "watched" ? "فیلم‌ها و سریال‌هایی که دیده‌اید، همراه امتیاز و یادداشت‌هایتان." : "فیلم‌ها و سریال‌هایی که برای تماشای بعدی ذخیره کرده‌اید."}</p>
        </div>
        {hasItems && (
          <div className="search-field library-search">
            <Icon name="search" />
            <input aria-label="جستجو در فهرست شخصی" type="search" dir="auto" placeholder="جستجو در فهرست شخصی" value={query}
              onChange={(event) => setQuery(event.target.value)} />
            {query && <Button variant="ghost" className="icon-button search-clear" icon="close" aria-label="پاک کردن جستجوی فهرست" onClick={() => setQuery("")} />}
          </div>
        )}
      </section>

      {status === "loading" && <p className="loading" role="status">در حال بارگیری فهرست…</p>}
      {hasItems && (
        <div className="catalog-toolbar">
          <Segmented label="نوع عنوان در فهرست" options={TITLE_KINDS} value={kind} onChange={setKind} />
          <span className="muted">{formatNumber(list.length)} عنوان</span>
        </div>
      )}
      {status === "ready" && !list.length && (
        <StatusPanel title={hasItems ? "عنوانی با این جستجو و فیلتر پیدا نشد" : "این فهرست هنوز خالی است"}
          action={hasItems ? <Button onClick={() => { setQuery(""); setKind("all"); }}>پاک کردن فیلترها</Button> : <Button variant="primary" icon="plus" onClick={onAdd}>افزودن عنوان</Button>}>
          {hasItems ? "نام کوتاه‌تر یا نوع دیگری را امتحان کنید." : "اولین فیلم یا سریال را از کاتالوگ یا به‌صورت دستی ثبت کنید."}
        </StatusPanel>
      )}
      <div className="title-grid">
        {list.map((item, position) => (
          <button type="button" className="title-card library-card" key={item.id} onClick={() => onOpen(item.id)} aria-label={item.title}>
            <Poster item={item} eager={position < 5} />
            <div className="card-body">
              <strong className="card-title" dir="auto">{item.title}</strong>
              <ItemMeta item={item} />
              {item.status === "watched" && item.myRating > 0 && (
                <span className="personal-rating" aria-label={`امتیاز شما ${formatNumber(item.myRating)} از ۵`}>
                  <Icon name="star" size={15} />{formatNumber(item.myRating)} از ۵
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

function App() {
  const library = useLibrary();
  const [view, setView] = useState("discover");
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState(null);
  const writable = library.status === "ready";
  const counts = useMemo(() => {
    const total = { watch: 0, watched: 0 };
    for (const item of library.items) total[item.status]++;
    return total;
  }, [library.items]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const close = () => setDialog(null);
  const openAdd = () => setDialog({ type: "add" });
  const openDetail = (id) => setDialog({ type: "detail", id });
  const openBackup = () => setDialog({ type: "backup" });
  const detail = dialog?.type === "detail" ? library.items.find((item) => item.id === dialog.id) : undefined;

  async function add(data, status) {
    const result = await library.mutate((items) => addTitle(items, data, status));
    if (result.added) {
      const list = status === "watched" ? "دیده‌ها" : "فهرست تماشا";
      setNotice({ text: `«${data.title}» به ${list} اضافه شد.` });
    }
    return result;
  }

  async function addFromDiscover(data, status) {
    try {
      await add(data, status);
    } catch (error) {
      setNotice({ text: errorMessage(error), error: true });
    }
  }

  async function save(original, draft) {
    await library.mutate((items) => editTitle(items, original, draft));
    setNotice({ text: "تغییرات ذخیره شد." });
  }

  async function remove(id) {
    await library.mutate((items) => removeTitle(items, id));
    setNotice({ text: "عنوان از فهرست حذف شد." });
  }

  return (
    <>
      <a className="skip-link" href="#main">رفتن به محتوای اصلی</a>
      <header className="site-header">
        <div className="shell topbar">
          <div className="brand">
            <span className="brand-mark"><Icon name="film" size={24} /></span>
            <div><strong>دیدمش<span>!</span></strong><small>دفتر فیلم و سریال</small></div>
          </div>
          <div className="header-actions">
            <Button icon="download" onClick={openBackup}>پشتیبان</Button>
            <Button variant="primary" icon="plus" onClick={openAdd}>افزودن عنوان</Button>
          </div>
        </div>
      </header>

      <main id="main" className="shell app-main" tabIndex={-1}>
        <nav className="view-nav" aria-label="بخش‌های دیدمش">
          {VIEWS.map(([value, title, icon]) => (
            <Button variant="nav" icon={icon} key={value} aria-current={view === value ? "page" : undefined} onClick={() => setView(value)}>
              {title}{value !== "discover" && <span className="nav-count">{formatNumber(counts[value])}</span>}
            </Button>
          ))}
        </nav>

        {library.status === "error" && (
          <StatusPanel tone="error" title="فهرست در حالت فقط‌خواندنی است" action={<Button onClick={library.retry}>تلاش دوباره</Button>}>
            دسترسی به حافظهٔ مرورگر برقرار نشد. در صورت نیاز، از فهرست موجود پشتیبان بگیرید.
          </StatusPanel>
        )}
        {library.migrationWarning && (
          <StatusPanel tone="warning" title="انتقال فهرست قدیمی نیاز به بررسی دارد" action={<Button onClick={openBackup}>باز کردن پشتیبان</Button>}>
            {library.migrationWarning === "unreadable"
              ? "مرورگر دسترسی به حافظهٔ نسخهٔ قبلی را محدود کرده است. برای انتقال می‌توانید فایل پشتیبان را وارد کنید."
              : "بعضی داده‌ها هنگام انتقال قابل استفاده نبودند یا اصلاح شدند. دادهٔ اصلی مرورگر برای بازیابی نگهداری شده است."}
          </StatusPanel>
        )}

        <div hidden={view !== "discover"}>
          <Discover items={library.items} onAdd={addFromDiscover} onOpen={openDetail} writable={writable} />
        </div>
        {view !== "discover" && <LibraryView key={view} view={view} items={library.items} status={library.status} onOpen={openDetail} onAdd={openAdd} />}
      </main>

      <div className="toast-region" role="status" aria-live="polite" aria-atomic="true">
        {notice && <div className={`toast${notice.error ? " toast--error" : ""}`}>
          <Icon name={notice.error ? "close" : "check"} size={18} /><span>{notice.text}</span>
        </div>}
      </div>

      {dialog?.type === "add" && <AddDialog items={library.items} onAdd={add} onOpen={openDetail} onClose={close} writable={writable} />}
      {dialog?.type === "backup" && <BackupDialog items={library.items} onClose={close} writable={writable} migrationWarning={library.migrationWarning}
        onImport={(backup) => library.mutate((items) => mergeBackup(items, backup))} />}
      {detail && <DetailDialog key={detail.id} item={detail} onClose={close} onSave={save} onDelete={remove} writable={writable} />}
      {dialog?.type === "detail" && !detail && <MissingTitle onClose={close} />}
    </>
  );
}

function MissingTitle({ onClose }) {
  return <div className="toast toast--error toast--persistent" role="alert">
    این عنوان دیگر در فهرست نیست.<Button variant="ghost" onClick={onClose}>بستن پیام</Button>
  </div>;
}

class AppBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <main className="shell app-main"><StatusPanel title="بارگیری دیدمش ناموفق بود" tone="error"
        action={<Button onClick={() => location.reload()}>تلاش دوباره</Button>}>صفحه را دوباره بارگیری کنید.</StatusPanel></main>;
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(<AppBoundary><App /></AppBoundary>);
