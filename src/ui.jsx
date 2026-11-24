import { useEffect, useId, useRef, useState } from "react";

const icons = {
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m16 16 4 4" /></>,
  eye: <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  bookmark: <path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16l-6-4-6 4Z" />,
  download: <path d="M12 3v12m-4-4 4 4 4-4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />,
  upload: <path d="M12 15V3m-4 4 4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />,
  film: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4m-4 6h4m10-6h4m-4 6h4" /></>,
  star: <path d="m12 2 3 6.2 6.8 1-4.9 4.8 1.2 6.8-6.1-3.2-6.1 3.2 1.2-6.8-4.9-4.8 6.8-1L12 2Z" />,
  arrowUp: <path d="M7 17 17 7M7 7h10v10" />,
  trash: <path d="M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />,
  check: <path d="m4 12 5 5L20 6" />,
};

const numbers = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 1, useGrouping: false });
export const formatNumber = (value) => numbers.format(value);

export function Icon({ name, size = 20 }) {
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {icons[name]}
    </svg>
  );
}

export function Button({ variant = "secondary", icon, className = "", children, type = "button", ...props }) {
  return (
    <button type={type} className={`button button--${variant} ${className}`} {...props}>
      {icon && <Icon name={icon} size={18} />}{children}
    </button>
  );
}

export function Segmented({ label, options, value, onChange }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([key, title]) => (
        <button key={key} type="button" aria-pressed={value === key} onClick={() => { if (value !== key) onChange(key); }}>{title}</button>
      ))}
    </div>
  );
}

export function SelectField({ label, options, value, onChange }) {
  return (
    <label className="select-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([key, title]) => <option value={key} key={key}>{title}</option>)}
      </select>
    </label>
  );
}

export function SearchForm({ label, value, onChange, onSearch, onClear, initialFocus = false }) {
  return (
    <form className="search-form" role="search" aria-label={label} onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
      <div className="search-field">
        <Icon name="search" size={20} />
        <input type="search" aria-label={label} value={value} onChange={(event) => {
          const next = event.target.value;
          if (next) onChange(next);
          else onClear();
        }}
          placeholder="نام فیلم یا سریال، مثلاً Arrival" dir="auto" maxLength={120} data-initial-focus={initialFocus || undefined} />
        {value && <Button className="icon-button search-clear" variant="ghost" icon="close" aria-label="پاک کردن جستجو" onClick={onClear} />}
      </div>
      <Button type="submit" variant="primary" disabled={!value.trim()}>جستجو</Button>
    </form>
  );
}

export function Poster({ item, compact = false, eager = false }) {
  const [failed, setFailed] = useState("");
  const hasImage = item.poster && failed !== item.poster;
  return (
    <div className={`poster${compact ? " poster--compact" : ""}`} aria-hidden="true">
      {hasImage ? (
        <img src={item.poster} alt="" width="300" height="450" loading={eager ? "eager" : "lazy"}
          decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(item.poster)} />
      ) : <div className="poster-fallback"><Icon name={item.kind === "series" ? "eye" : "film"} size={34} /></div>}
    </div>
  );
}

export function ItemMeta({ item, kind = true }) {
  return (
    <div className="item-meta">
      {kind && <span className="kind-label">{item.kind === "series" ? "سریال" : "فیلم"}</span>}
      {item.year && <bdi>{formatNumber(Number(item.year))}</bdi>}
      {item.imdbRating !== null && <span className="imdb-rating" dir="ltr">IMDb <bdi>{item.imdbRating}</bdi></span>}
    </div>
  );
}

export function StatusPanel({ title, children, action, tone = "default" }) {
  return (
    <div className={`status-panel status-panel--${tone}`} role={tone === "error" ? "alert" : undefined}>
      <div><strong>{title}</strong>{children && <p>{children}</p>}</div>
      {action}
    </div>
  );
}

export function Modal({ title, onClose, busy = false, children, className = "" }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement;
    dialog.showModal();
    dialog.querySelector("[data-initial-focus]")?.focus();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
      else document.getElementById("main")?.focus();
    };
  }, []);

  return (
    <dialog ref={dialogRef} className={`modal ${className}`} aria-labelledby={titleId} aria-busy={busy || undefined}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="modal-body">
        <header className="modal-header">
          <h2 id={titleId} dir="auto">{title}</h2>
          <Button className="icon-button" variant="ghost" icon="close" aria-label="بستن پنجره" onClick={onClose} disabled={busy} />
        </header>
        {children}
      </div>
    </dialog>
  );
}
