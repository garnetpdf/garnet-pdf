/**
 * Fillable form fields drawn as real inputs over the page. MuPDF draws the field appearance in the
 * page image; an input is transparent until it is focused, then shows the value being edited.
 * Tab and Shift+Tab follow the document's tab order across pages.
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { PenLine } from 'lucide-react';
import type { EditPage } from '../../plugin-host/types';
import { activeTab, useApp } from '../../store';
import { pctRect, usePageScale } from '../comment/shared/geometry';
import { OUTSIDE_STANDARD_FONTS, setFieldValue, showToggle, useForms, type FormWidget } from './store';

const FONT = 'Helvetica, Arial, "Liberation Sans", "Noto Sans Arabic", sans-serif';

function tabStops(widgets: FormWidget[]): FormWidget[] {
  const usable = widgets
    .filter((w) => !w.hidden && !w.readOnly && w.type !== 'button' && w.type !== 'signature')
    .sort((a, b) => a.tabIndex - b.tabIndex);
  // One stop per radio group: the selected button, or the first one.
  const seen = new Set<string>();
  const stops: FormWidget[] = [];
  for (const w of usable) {
    if (w.type !== 'radio') {
      stops.push(w);
      continue;
    }
    if (seen.has(w.name)) continue;
    seen.add(w.name);
    stops.push(usable.find((x) => x.type === 'radio' && x.name === w.name && x.checked) ?? w);
  }
  return stops;
}

const fieldSelector = (w: FormWidget) => `[data-field-id="${w.id}"][data-field-page="${w.pageId}"]`;

/** Focuses a field, scrolling to its page first when that page is not on screen yet. */
export function focusField(w: FormWidget) {
  const show = (el: HTMLElement) => {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const el = document.querySelector<HTMLElement>(fieldSelector(w));
  if (el) {
    show(el);
    return;
  }
  const tab = activeTab();
  if (!tab) return;
  useApp.getState().updateTab(tab.info.docId, { page: w.pageIndex });
  let tries = 0;
  const retry = () => {
    const found = document.querySelector<HTMLElement>(fieldSelector(w));
    if (found) show(found);
    else if (tries++ < 90) requestAnimationFrame(retry);
  };
  requestAnimationFrame(retry);
}

function onTab(e: ReactKeyboardEvent, w: FormWidget) {
  if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return false;
  const stops = tabStops(useForms.getState().widgets);
  if (!stops.length) return false;
  let index = stops.findIndex((x) => x.id === w.id && x.pageId === w.pageId);
  if (index < 0) index = stops.findIndex((x) => x.type === 'radio' && x.name === w.name);
  const next = stops[(index + (e.shiftKey ? -1 : 1) + stops.length) % stops.length];
  e.preventDefault();
  (e.currentTarget as HTMLElement).blur();
  focusField(next);
  return true;
}

/**
 * Keys typed in a field stay in the field (no single-key app shortcuts, native text undo), except
 * Ctrl+S, which first stores the value being typed so the save includes it.
 */
function guardKeys(e: ReactKeyboardEvent, commit?: () => void) {
  if (!e.ctrlKey && !e.metaKey) {
    e.stopPropagation();
    return;
  }
  const key = e.key.toLowerCase();
  if (key === 'z' || key === 'y') e.stopPropagation();
  else if (key === 's') commit?.();
}

function fieldStyle(page: EditPage, w: FormWidget, scale: number): CSSProperties {
  const height = w.rect[3] - w.rect[1];
  const auto = w.multiline ? 10 : Math.max(6, Math.min(12, (height - 3) * 0.72));
  const size = (w.fontSize || auto) * scale;
  return {
    ...pctRect(page, w.rect),
    fontSize: size,
    fontFamily: FONT,
    textAlign: w.align === 1 ? 'center' : w.align === 2 ? 'right' : undefined,
    padding: `0 ${2 * scale}px`,
  };
}

const common = (w: FormWidget) => ({
  'data-field-id': w.id,
  'data-field-page': w.pageId,
  'data-field-name': w.name,
  'aria-label': w.label || w.name,
  'aria-required': w.required || undefined,
});

function TextField({ w, page, scale }: { w: FormWidget; page: EditPage; scale: number }) {
  const [value, setValue] = useState(w.value);
  const focused = useRef(false);
  const latest = useRef(value);
  latest.current = value;
  // The value last sent to the document; compared instead of w.value, which lags while a change is applied.
  const sent = useRef(w.value);
  useEffect(() => {
    sent.current = w.value;
    if (!focused.current) setValue(w.value);
  }, [w.value]);
  const commit = () => {
    if (w.readOnly || latest.current === sent.current) return;
    sent.current = latest.current;
    void setFieldValue(w, { value: latest.current });
  };
  const props = {
    ...common(w),
    className: `form-field text ${w.required ? 'required' : ''} ${w.multiline ? 'multiline' : ''} ${
      OUTSIDE_STANDARD_FONTS.test(value) ? 'shows-text' : ''
    }`,
    style: fieldStyle(page, w, scale),
    value,
    readOnly: w.readOnly,
    maxLength: w.maxLen > 0 ? w.maxLen : undefined,
    dir: 'auto' as const,
    spellCheck: false,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      commit();
    },
    onChange: (e: { target: { value: string } }) => setValue(e.target.value),
    onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      guardKeys(e, commit);
      if (onTab(e, w)) return;
      if (e.key === 'Enter' && !w.multiline) {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        setValue(w.value);
        latest.current = w.value;
        e.currentTarget.blur();
      }
    },
  };
  return w.multiline ? <textarea {...props} /> : <input type={w.password ? 'password' : 'text'} autoComplete="off" {...props} />;
}

/**
 * Check boxes and radio buttons take their state from the forms store only: a radio group spans several
 * inputs, and per-input state lets React re-check a stale button after the browser moved the choice.
 */
function ToggleField({ w, page, docId }: { w: FormWidget; page: EditPage; docId: string }) {
  const checked = !!w.checked;
  const radio = w.type === 'radio';
  const set = (next: boolean) => {
    showToggle(w, next);
    void setFieldValue(w, { checked: next });
  };
  return (
    <input
      {...common(w)}
      type={radio ? 'radio' : 'checkbox'}
      name={radio ? `${docId}:${w.name}` : undefined}
      className={`form-field toggle ${radio ? 'radio' : ''} ${w.required ? 'required' : ''}`}
      style={pctRect(page, w.rect)}
      checked={checked}
      disabled={w.readOnly}
      onChange={(e) => set(radio ? true : e.target.checked)}
      onClick={(e) => {
        // A selected radio button can be turned off only when the field allows it.
        if (radio && checked && !w.noToggleToOff) {
          e.preventDefault();
          set(false);
        }
      }}
      onKeyDown={(e) => {
        guardKeys(e);
        onTab(e, w);
      }}
    />
  );
}

function ChoiceField({ w, page, scale }: { w: FormWidget; page: EditPage; scale: number }) {
  const options = w.options ?? [];
  const [value, setValue] = useState(w.value);
  const [values, setValues] = useState(w.values);
  const focused = useRef(false);
  const sent = useRef(w.value);
  useEffect(() => {
    sent.current = w.value;
    if (!focused.current) {
      setValue(w.value);
      setValues(w.values);
    }
  }, [w.value, w.values]);
  const listbox = w.type === 'listbox';
  const style = fieldStyle(page, w, scale);
  const key = (e: ReactKeyboardEvent<HTMLElement>, commit?: () => void) => {
    guardKeys(e, commit);
    onTab(e, w);
  };
  if (!listbox && w.editable) {
    const commit = () => {
      if (value === sent.current) return;
      sent.current = value;
      void setFieldValue(w, { value });
    };
    return (
      <>
        <input
          {...common(w)}
          className={`form-field text ${w.required ? 'required' : ''} ${OUTSIDE_STANDARD_FONTS.test(value) ? 'shows-text' : ''}`}
          style={style}
          list={`choices-${w.pageId}-${w.id}`}
          value={value}
          dir="auto"
          readOnly={w.readOnly}
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            key(e, commit);
          }}
        />
        <datalist id={`choices-${w.pageId}-${w.id}`}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </datalist>
      </>
    );
  }
  if (listbox)
    return (
      <select
        {...common(w)}
        className={`form-field listbox ${w.required ? 'required' : ''}`}
        style={{ ...style, fontSize: Math.min(Number(style.fontSize) || 12, 11 * scale) }}
        multiple
        value={w.multiSelect ? values : values.slice(0, 1)}
        disabled={w.readOnly}
        onFocus={() => (focused.current = true)}
        onBlur={() => (focused.current = false)}
        onChange={(e) => {
          let picked = Array.from(e.target.selectedOptions, (o) => o.value);
          if (!w.multiSelect) picked = picked.slice(-1);
          setValues(picked);
          void setFieldValue(w, { values: picked });
        }}
        onKeyDown={key}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  return (
    <select
      {...common(w)}
      className={`form-field choice ${w.required ? 'required' : ''}`}
      style={style}
      value={value}
      disabled={w.readOnly}
      onFocus={() => (focused.current = true)}
      onBlur={() => (focused.current = false)}
      onChange={(e) => {
        setValue(e.target.value);
        void setFieldValue(w, { value: e.target.value });
      }}
      onKeyDown={key}
    >
      {!options.some((o) => o.value === value) && <option value={value}>{value}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function FormsLayer({ page, onSignField }: { page: EditPage; onSignField?: (w: FormWidget) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const scale = usePageScale(root, page);
  const widgets = useForms((s) => s.widgets);
  const docId = useForms((s) => s.docId);
  const highlight = useForms((s) => s.highlight);
  const hand = useApp((s) => s.hand);
  const mine = widgets.filter((w) => w.pageId === page.pageId && !w.hidden && w.type !== 'button');
  return (
    <div
      ref={root}
      className={`forms-layer garnet-passive ${highlight ? 'highlight' : ''} ${hand ? 'hand' : ''}`}
      data-testid="forms-layer"
      // The page's tool overlay captures the pointer on press, which would send the click to the
      // overlay instead of the check box, radio button, list or button under the pointer.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {mine.map((w) => {
        if (w.type === 'text') return <TextField key={w.id} w={w} page={page} scale={scale} />;
        if (w.type === 'checkbox' || w.type === 'radio') return <ToggleField key={w.id} w={w} page={page} docId={docId ?? ''} />;
        if (w.type === 'combobox' || w.type === 'listbox') return <ChoiceField key={w.id} w={w} page={page} scale={scale} />;
        if (w.type === 'signature' && onSignField && !w.signed)
          return (
            <button
              key={w.id}
              {...common(w)}
              className="form-sign-here"
              style={pctRect(page, w.rect)}
              onClick={() => onSignField(w)}
            >
              <PenLine size={14} />
              <span>Sign here</span>
            </button>
          );
        return null;
      })}
    </div>
  );
}
