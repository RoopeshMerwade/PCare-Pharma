import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import FormDialog from '../../patterns/FormDialog';
import Field from '../../ui/Field';
import Input from '../../ui/Input';

/* A category colour is user data, not a design token — the owner picks it to
   tell categories apart at a glance. §6's ban on raw colour values governs
   component code, not records the user created.

   What did have to change is how it is used. The old CategoryBadge painted the
   category name IN the chosen colour over a 12% tint of itself, which for a
   pale yellow lands around 1.5:1. The colour is now a decorative dot and the
   name is rendered in `foreground`, so legibility is guaranteed whatever the
   owner picks and the personalisation survives (A1, A4). */

/* eslint-disable no-restricted-syntax --
   The only sanctioned raw colours in the app. These are not design tokens:
   they are the swatches the owner picks from to tell their own categories
   apart, stored per category as data. §6 governs colour in component styling,
   and none of these ever styles a component — the value lands on a decorative
   dot whose adjacent label is always rendered in `foreground`. */
const PRESET_COLORS = [
  '#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6',
  '#EC4899', '#14B8A6', '#F97316', '#06B6D4', '#6B7280',
  '#84CC16', '#E11D48', '#0EA5E9', '#D946EF', '#22C55E',
];
const DEFAULT_COLOR = PRESET_COLORS[0];
/* eslint-enable no-restricted-syntax */

export function CategoryModal({ category, open, onOpenChange, onSaved }) {
  const isEdit = Boolean(category);
  const [form, setForm] = useState({ name: '', description: '', color: DEFAULT_COLOR });
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (category) {
      setForm({ name: category.name, description: category.description || '', color: category.color });
    } else {
      setForm({ name: '', description: '', color: DEFAULT_COLOR });
    }
    setErrors({});
  }, [category, open]);

  const set = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  const validate = () => {
    const found = {};
    const name = form.name.trim();
    if (name.length < 2) found.name = 'Give the category a name of at least 2 characters.';
    else if (name.length > 50) found.name = 'Keep the name to 50 characters or fewer.';
    if (form.description.length > 200) found.description = 'Keep the description to 200 characters or fewer.';
    if (!/^#([0-9A-Fa-f]{6})$/.test(form.color)) found.color = `Enter a 6-digit hex colour, like ${DEFAULT_COLOR}.`;
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) throw new Error('Check the highlighted fields and try again.');
    if (isEdit) await api.patch(`/categories/${category.id}`, form);
    else await api.post('/categories', form);
    onSaved(isEdit);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? 'Edit category' : 'New category'}
      submitLabel={isEdit ? 'Save changes' : 'Create category'}
      onSubmit={handleSubmit}
    >
      <Field label="Name" required error={errors.name}>
        <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Pain Relief" />
      </Field>

      <Field label="Description" hint="(optional)" error={errors.description}>
        <Input
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="Short note about this category"
        />
      </Field>

      <Field label="Colour" error={errors.color} hint="used as a marker beside the name">
        <div className="flex flex-col gap-s3">
          <div className="flex flex-wrap gap-s2">
            {PRESET_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => set('color', color)}
                aria-label={`Use colour ${color}`}
                aria-pressed={form.color === color}
                className={cn(
                  'h-8 w-8 rounded-pill border border-border-strong transition-transform duration-instant',
                  form.color === color && 'scale-110 ring-2 ring-ring ring-offset-2'
                )}
                style={{ background: color }}
              />
            ))}
          </div>

          <div className="flex items-center gap-s3">
            <Input
              value={form.color}
              onChange={(e) => set('color', e.target.value)}
              maxLength={7}
              className="w-[8rem] font-mono"
              aria-label="Hex colour"
            />
            <span className="flex items-center gap-s2 text-base text-muted-foreground">
              Preview:
              <span className="inline-flex items-center gap-s1 text-base font-bold text-foreground">
                <span className="h-3 w-3 shrink-0 rounded-pill" style={{ background: form.color }} aria-hidden="true" />
                {form.name || 'Category'}
              </span>
            </span>
          </div>
        </div>
      </Field>
    </FormDialog>
  );
}

/**
 * The category marker used across the app. The dot is decorative; the name
 * carries the meaning and is always legible.
 */
export function CategoryBadge({ name, color }) {
  if (!name) return null;
  return (
    <span className="inline-flex items-center gap-s1 whitespace-nowrap text-base text-foreground">
      <span className="h-2.5 w-2.5 shrink-0 rounded-pill" style={{ background: color || 'currentColor' }} aria-hidden="true" />
      {name}
    </span>
  );
}

export default CategoryModal;
