import type { PageId, Rect } from '../../../shared/engine-api';

export type FieldType =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'combobox'
  | 'listbox'
  | 'button'
  | 'signature';

export interface FieldOption {
  label: string;
  value: string;
}

/** One widget (the visible part of a form field). Several widgets can share one field name. */
export interface FormWidget {
  /** Indirect object number of the widget annotation. */
  id: number;
  pageId: PageId;
  pageIndex: number;
  /** Position in the document-wide tab order. */
  tabIndex: number;
  name: string;
  label: string;
  type: FieldType;
  /** Page-space rectangle (rotation applied, top-left origin). */
  rect: Rect;
  /** Text value, selected choice export value, or button state name ('Off' when off). */
  value: string;
  /** Selected export values of a list box (multi-select aware). */
  values: string[];
  /** Checkbox / radio: this widget's on-state name and export value. */
  onState?: string;
  exportValue?: string;
  checked?: boolean;
  options?: FieldOption[];
  maxLen: number;
  multiline: boolean;
  password: boolean;
  comb: boolean;
  editable: boolean;
  multiSelect: boolean;
  readOnly: boolean;
  required: boolean;
  noToggleToOff: boolean;
  /** 0 means automatic size. */
  fontSize: number;
  textColor: [number, number, number];
  align: 0 | 1 | 2;
  hidden: boolean;
  /** Signature fields: true when a digital signature value is present. */
  signed?: boolean;
  hasCalculation: boolean;
}

export interface FormsListResult {
  revision: number;
  widgets: FormWidget[];
  /** Document-level or field-level scripts exist (they are never run). */
  hasScripts: boolean;
  /** Fields whose calculate action is a supported AFSimple_Calculate call. */
  supportedCalculations: number;
  /** Fields with a calculate action this app cannot evaluate safely. */
  unsupportedCalculations: number;
}

export interface SetValueArgs {
  docId: string;
  pageId: PageId;
  id: number;
  value?: string;
  values?: string[];
  checked?: boolean;
  /** Run supported calculations afterwards (only when the user enabled PDF JavaScript). */
  calculate?: boolean;
}
