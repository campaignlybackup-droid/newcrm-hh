import { z } from 'zod';
import type { Database, Enums } from '@/lib/database.types';

/**
 * Table names are the literal keys of the generated Database type, not
 * plain strings. Passing a widened `string` into supabase-js collapses its
 * Insert/Update generics to `never`, which silently disables type checking
 * on every write.
 */
export type TableName = keyof Database['public']['Tables'];
export type ViewName = keyof Database['public']['Views'];

export type ModuleKey =
  | 'clients' | 'leads' | 'projects' | 'deliverables' | 'tasks' | 'shoots'
  | 'content_calendar' | 'campaigns' | 'assets' | 'approvals' | 'meetings'
  | 'reports' | 'people' | 'leaves' | 'equipment' | 'templates' | 'settings' | 'audit_log';

export type ViewMode = 'list' | 'kanban' | 'calendar' | 'timeline';

export type FieldType =
  | 'text' | 'longtext' | 'number' | 'date' | 'datetime' | 'time'
  | 'select' | 'multiselect' | 'boolean' | 'user' | 'client' | 'relation'
  | 'tags' | 'url' | 'email' | 'phone' | 'json';

export type PermissionAction =
  'view' | 'create' | 'edit' | 'delete' | 'assign' | 'approve' | 'export';

export interface RelationRef {
  /** Table or view to read options from. */
  table: TableName;
  /** Column rendered as the label. */
  labelKey: string;
  /** Extra equality filters applied when loading options. */
  filter?: Record<string, string | number | boolean>;
  /** Column to order options by. */
  orderBy?: string;
}

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** Static options for select/multiselect. */
  options?: readonly string[];
  /** Dynamic options for user/client/relation. */
  relation?: RelationRef;
  required?: boolean;
  /**
   * false => the field is never writable from either surface.
   * Computed rollups and inherited mirrors both set this.
   */
  editable?: boolean;
  /** Inherited from a parent record; shown read-only with provenance. */
  inheritedFrom?: string;
  /** Shown as a column in list view by default. */
  inList?: boolean;
  /** Column width hint in px. */
  width?: number;
  /** Section heading on the detail page. */
  section?: string;
  help?: string;
  /** Placement in the permission model; defaults to the module's own key. */
  permissionAction?: PermissionAction;
  /** Extra validation layered on top of the type's base rule. */
  refine?: (schema: z.ZodTypeAny) => z.ZodTypeAny;
}

export interface ModuleDef {
  key: ModuleKey;
  /** Physical table the module reads and writes. */
  table: TableName;
  label: string;
  singular: string;
  /** Column used as the human title of a record. */
  titleField: string;
  fields: FieldDef[];
  views: ViewMode[];
  defaultView: ViewMode;
  /** Field used to bucket the kanban board (must be a select). */
  kanbanGroupBy?: string;
  /** Additional grouping choices offered in the kanban view. */
  kanbanGroupOptions?: string[];
  calendar?: { start: string; end?: string; allDay?: boolean };
  timeline?: { start: string; end: string; groupBy?: string };
  /**
   * Date columns the user may choose between in the date-range filter.
   * The first entry is the default.
   */
  dateFields: { key: string; label: string }[];
  /** PostgREST select string, including embedded relations for the list view. */
  select: string;
  /** Default sort applied when no saved view says otherwise. */
  defaultSort: { key: string; desc: boolean }[];
  /** True if rows carry client_id (drives the client filter and portal). */
  clientScoped: boolean;
  /** Rows are soft-deleted rather than removed. */
  softDelete: boolean;
  /** Free-text search targets. */
  searchFields: string[];
}

/* ------------------------------------------------------------------ */
/* Schema derivation                                                   */
/*                                                                     */
/* The Zod schema is DERIVED from the field definitions rather than    */
/* written alongside them. That is what makes the acceptance rule      */
/* "every field editable in list view is editable on the detail page,  */
/* with identical validation" true by construction: both surfaces      */
/* render from `fields` and both validate with `moduleSchema(module)`. */
/* ------------------------------------------------------------------ */

const nullish = <T extends z.ZodTypeAny>(s: T) => s.nullish();

function baseSchemaFor(f: FieldDef): z.ZodTypeAny {
  switch (f.type) {
    case 'text':
      return z.string().trim().min(f.required ? 1 : 0).max(500);
    case 'longtext':
      return z.string().trim().max(20000);
    case 'number':
      return z.coerce.number().finite();
    case 'date':
      return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
    case 'datetime':
      return z.string().datetime({ offset: true }).or(z.string().min(1));
    case 'time':
      return z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM');
    case 'select':
      return f.options?.length
        ? z.enum(f.options as [string, ...string[]])
        : z.string();
    case 'multiselect':
    case 'tags':
      return z.array(z.string());
    case 'boolean':
      return z.boolean();
    case 'user':
    case 'client':
    case 'relation':
      return z.string().uuid();
    case 'url':
      return z.string().url();
    case 'email':
      return z.string().email();
    case 'phone':
      return z.string().min(5).max(30);
    case 'json':
      return z.any();
  }
}

/** Full schema for a create form. */
export function moduleSchema(mod: ModuleDef): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};
  for (const f of mod.fields) {
    if (f.editable === false) continue;
    let s = baseSchemaFor(f);
    if (f.refine) s = f.refine(s);
    shape[f.key] = f.required ? s : nullish(s);
  }
  return z.object(shape);
}

/**
 * Schema for a partial update — the shape an inline cell edit produces.
 * Identical rules, just fewer keys, so a single-cell edit cannot slip past
 * a validation the detail form would have applied.
 */
export function modulePatchSchema(mod: ModuleDef): z.ZodObject<z.ZodRawShape> {
  return moduleSchema(mod).partial();
}

export function fieldByKey(mod: ModuleDef, key: string): FieldDef | undefined {
  return mod.fields.find((f) => f.key === key);
}

export function isEditable(f: FieldDef): boolean {
  return f.editable !== false && !f.inheritedFrom;
}

export function listFields(mod: ModuleDef): FieldDef[] {
  return mod.fields.filter((f) => f.inList !== false);
}

export function sections(mod: ModuleDef): { name: string; fields: FieldDef[] }[] {
  const out = new Map<string, FieldDef[]>();
  for (const f of mod.fields) {
    const s = f.section ?? 'Details';
    if (!out.has(s)) out.set(s, []);
    out.get(s)!.push(f);
  }
  return [...out].map(([name, fields]) => ({ name, fields }));
}

export type EnumOf<K extends keyof Enums> = Enums[K];
