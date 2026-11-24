import { useId, useMemo, useState } from "react";
import { catalogItemKey, GENRES, normalizeQuery } from "./catalog.js";
import { indexTitles } from "./library.js";
import { useCatalog } from "./use-catalog.js";
import { Button, formatNumber, ItemMeta, Poster, SearchForm, Segmented, SelectField, StatusPanel } from "./ui.jsx";

const KINDS = [["movie", "فیلم"], ["series", "سریال"]];
const YEARS = [
  ["", "همه سال‌ها", 0, 9999], ["2020", "۲۰۲۰ به بعد", 2020, 9999], ["2010", "۲۰۱۰ تا ۲۰۱۹", 2010, 2019],
  ["2000", "۲۰۰۰ تا ۲۰۰۹", 2000, 2009], ["1990", "۱۹۹۰ تا ۱۹۹۹", 1990, 1999], ["older", "پیش از ۱۹۹۰", 0, 1989],
];
const RATINGS = [["", "همه امتیازها"], ["6", "۶ و بالاتر"], ["7", "۷ و بالاتر"], ["8", "۸ و بالاتر"]];

export function CatalogActions({ item, existing, onAdd, onOpen, writable }) {
  const [pending, setPending] = useState(false);
  const title = item.year ? `${item.title} (${formatNumber(Number(item.year))})` : item.title;
  async function add(status) {
    setPending(true);
    try {
      await onAdd(item, status);
    } finally {
      setPending(false);
    }
  }
  if (existing) {
    const label = existing.status === "watched" ? "در دیده‌ها" : "در فهرست تماشا";
    return <Button variant="saved" icon="check" onClick={() => onOpen(existing.id)} aria-label={`${label}، جزئیات ${title}`}>{label}</Button>;
  }
  return (
    <>
      <Button icon="eye" disabled={!writable || pending} aria-label={`ثبت ${title} در دیده‌ها`} onClick={() => add("watched")}>دیدم</Button>
      <Button icon="bookmark" disabled={!writable || pending} aria-label={`افزودن ${title} به فهرست تماشا`} onClick={() => add("watch")}>تماشا</Button>
    </>
  );
}

export function CatalogCard({ item, existing, onAdd, onOpen, writable, eager }) {
  const titleId = useId();
  return (
    <article className="title-card" aria-labelledby={titleId}>
      <Poster item={item} eager={eager} />
      <div className="card-body">
        <h3 dir="auto" id={titleId}>{item.title}</h3>
        <ItemMeta item={item} kind={false} />
        <div className="card-actions">
          <CatalogActions item={item} existing={existing} onAdd={onAdd} onOpen={onOpen} writable={writable} />
        </div>
      </div>
    </article>
  );
}

export function Discover({ items, onAdd, onOpen, writable }) {
  const [kind, setKind] = useState("movie");
  const [genre, setGenre] = useState("");
  const [catalog, setCatalog] = useState("top");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [year, setYear] = useState("");
  const [rating, setRating] = useState("");
  const index = useMemo(() => indexTitles(items), [items]);
  const page = useCatalog({ kind, catalog: query ? "top" : catalog, genre: query ? "" : genre, q: query });
  const range = YEARS.find(([value]) => value === year);
  const visible = page.items.filter((item) => {
    const releaseYear = Number(item.year);
    const matchesYear = !year || (releaseYear > 0 && releaseYear >= range[2] && releaseYear <= range[3]);
    return matchesYear && (!rating || (item.imdbRating !== null && item.imdbRating >= Number(rating)));
  });

  function clearSearch() {
    setSearch("");
    setQuery("");
  }

  return (
    <>
      <section className="view-heading discover-heading" aria-labelledby="discover-title">
        <div>
          <h1 id="discover-title">کشف فیلم و سریال</h1>
          <p>عنوان موردنظرتان را پیدا کنید و به فهرست تماشا یا دیده‌ها اضافه کنید.</p>
        </div>
        <SearchForm label="جستجو در کاتالوگ" value={search} onChange={setSearch} onClear={clearSearch}
          onSearch={() => setQuery(normalizeQuery(search))} />
      </section>

      <div className="catalog-toolbar">
        <Segmented label="نوع عنوان در کاتالوگ" options={KINDS} value={kind} onChange={setKind} />
        <div className="filters">
          {!query && <SelectField label="ژانر" options={GENRES} value={genre} onChange={setGenre} />}
          <SelectField label="سال انتشار" options={YEARS} value={year} onChange={setYear} />
          <SelectField label="امتیاز IMDb" options={RATINGS} value={rating} onChange={setRating} />
          {!query && <SelectField label="کاتالوگ" options={[["top", "محبوب‌ها"], ["imdbRating", "منتخب‌ها"]]} value={catalog} onChange={setCatalog} />}
        </div>
      </div>

      <section aria-labelledby="results-title">
        <div className="section-heading">
          <h2 id="results-title">
            {query ? <>نتایج جستجوی <bdi>{query}</bdi></> : `${kind === "movie" ? "فیلم‌های" : "سریال‌های"} ${catalog === "top" ? "محبوب" : "منتخب"}`}
          </h2>
          {["ready", "paging", "page-error"].includes(page.status) && <span>{formatNumber(visible.length)} عنوان</span>}
        </div>

        {page.status === "loading" && <p className="loading" role="status">در حال دریافت کاتالوگ…</p>}
        {page.status === "error" && (
          <StatusPanel tone="error" title="دریافت کاتالوگ ناموفق بود" action={<Button onClick={page.retry}>تلاش دوباره</Button>}>
            اتصال به منبع کاتالوگ برقرار نشد. می‌توانید عنوان را دستی ثبت کنید.
          </StatusPanel>
        )}
        {page.status === "ready" && !visible.length && (
          <StatusPanel title={page.items.length ? "عنوانی با این فیلترها پیدا نشد" : "عنوانی پیدا نشد"}>
            {page.items.length
              ? (page.nextOffset !== null ? "فیلترها را تغییر دهید یا صفحهٔ بعد را ببینید." : "سال انتشار یا امتیاز را تغییر دهید. بعضی نتایج امتیاز ندارند.")
              : (query ? "نام اصلی فیلم یا سریال را امتحان کنید." : "ژانر یا نوع عنوان را تغییر دهید.")}
          </StatusPanel>
        )}
        <div className="title-grid">
          {visible.map((item, position) => (
            <CatalogCard key={catalogItemKey(item)} item={item} existing={index.find(item)} eager={position < 5}
              onAdd={onAdd} onOpen={onOpen} writable={writable} />
          ))}
        </div>
        {page.nextOffset !== null && (
          <div className="pagination">
            {page.status === "page-error" && <p className="field-error" role="alert">دریافت صفحهٔ بعد ناموفق بود.</p>}
            <Button onClick={page.loadMore} disabled={page.status === "paging"}>
              {page.status === "paging" ? "در حال دریافت…" : "نمایش صفحهٔ بعد"}
            </Button>
          </div>
        )}
      </section>
    </>
  );
}
