import { PLACEHOLDERS } from '@/lib/templates';
import { Badge, btn, input } from '@/components/ui';
import { Submit } from '@/components/submit';
import { deleteTemplate, saveTemplate } from './actions';

export type TemplateRow = { id: number; finding_code: string; variant: number; template: string; enabled: boolean; uses: number };

/** Edit first-line templates (one brand, or the shared ones when brandId is null). */
export function Templates({ brandId, rows, codes }: { brandId: number | null; rows: TemplateRow[]; codes: string[] }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        Placeholders: {PLACEHOLDERS.map((p) => <code key={p} className="mr-1">{`{${p}}`}</code>)}. A line is only written when every placeholder has a real value.
        Max 25 words, no “!”, no banned phrases (Settings → first_lines.rules). Code <code>niche:&lt;sub-niche key&gt;</code> = a line about the lead’s business.
      </p>
      {rows.map((t) => (
        <form key={t.id} action={saveTemplate} className="grid gap-2 rounded border border-neutral-200 p-3 md:grid-cols-[12rem_4rem_1fr_auto]">
          <input type="hidden" name="brand_id" value={brandId ?? ''} />
          <input type="hidden" name="template_id" value={t.id} />
          <input name="finding_code" defaultValue={t.finding_code} className={input} list="finding-codes" />
          <input name="variant" type="number" min="1" max="9" defaultValue={t.variant} className={input} title="Variant" />
          <textarea name="template" defaultValue={t.template} rows={2} className={input} />
          <div className="flex flex-col items-end gap-1.5">
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="enabled" defaultChecked={t.enabled} /> On</label>
            <Submit className={btn.secondary}>Save</Submit>
            <Badge>{t.uses.toLocaleString('en-US')} lines</Badge>
          </div>
          <div className="md:col-span-4 -mt-1 text-right">
            <button formAction={deleteTemplate} className="text-xs text-red-700 hover:underline">Delete</button>
          </div>
        </form>
      ))}
      <form action={saveTemplate} className="grid gap-2 rounded border border-dashed border-neutral-300 p-3 md:grid-cols-[12rem_4rem_1fr_auto]">
        <input type="hidden" name="brand_id" value={brandId ?? ''} />
        <input name="finding_code" placeholder="finding code" required className={input} list="finding-codes" />
        <input name="variant" type="number" min="1" max="9" defaultValue={1} className={input} />
        <textarea name="template" rows={2} required placeholder="Noticed {domain} …" className={input} />
        <Submit className={btn.primary}>Add</Submit>
      </form>
      <datalist id="finding-codes">{codes.map((c) => <option key={c} value={c} />)}</datalist>
    </div>
  );
}
