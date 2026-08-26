import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { plural } from '../../lib/format';
import PageHeader from '../../patterns/PageHeader';
import ConfirmDialog, { useConfirm } from '../../patterns/ConfirmDialog';
import CategoryModal from './CategoryModal';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import EmptyState from '../../ui/EmptyState';
import ErrorState from '../../ui/ErrorState';
import { SkeletonRows } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { PlusIcon } from '../../ui/icons';

const MAX_ACTIVE = 30;

export default function CategoriesPage() {
  const toast = useToast();
  const confirm = useConfirm();

  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [dragIdx, setDragIdx] = useState(null);

  const fetchCategories = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/categories?includeInactive=true');
      setCategories(res.data.categories);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCategories(); }, [fetchCategories]);

  const active = categories.filter((c) => c.is_active);
  const inactive = categories.filter((c) => !c.is_active);
  const atCap = active.length >= MAX_ACTIVE;

  const persistOrder = async (ordered) => {
    try {
      await api.patch('/categories/reorder', { orderedIds: ordered.filter((c) => c.is_active).map((c) => c.id) });
      toast.success('Order saved.');
    } catch (err) {
      toast.error(err.message);
      fetchCategories();
    }
  };

  /* Reordering is available from the keyboard as well as by dragging. HTML5
     drag-and-drop is pointer-only, so on its own it puts a whole feature out
     of reach of a keyboard user and fails A5. The buttons are the accessible
     path; the drag is the fast one. */
  const move = (from, to) => {
    if (to < 0 || to >= active.length) return;
    const reordered = [...active];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    setCategories([...reordered, ...inactive]);
    persistOrder([...reordered, ...inactive]);
  };

  const handleDragOver = (event, idx) => {
    event.preventDefault();
    if (dragIdx === null || dragIdx === idx) return;
    const reordered = [...active];
    const [moved] = reordered.splice(dragIdx, 1);
    reordered.splice(idx, 0, moved);
    setCategories([...reordered, ...inactive]);
    setDragIdx(idx);
  };

  const handleDeactivate = async () => {
    const category = confirm.target;
    await api.patch(`/categories/${category.id}/deactivate`);
    toast.success(`${category.name} deactivated.`);
    fetchCategories();
  };

  const handleReactivate = async (category) => {
    try {
      await api.patch(`/categories/${category.id}/reactivate`);
      toast.success(`${category.name} reactivated.`);
      fetchCategories();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div>
      <PageHeader
        title="Medicine Categories"
        subtitle={`${plural(active.length, 'active category', 'active categories')} · drag or use the arrows to reorder`}
        actions={
          <Button
            variant="primary"
            onClick={() => { setEditing(null); setModalOpen(true); }}
            // Not disabled: §6 forbids a silently dead primary. The button
            // stays live and explains the cap when it is pressed.
            blockedReason={atCap ? `You already have ${MAX_ACTIVE} active categories. Deactivate one below to make room.` : null}
          >
            <PlusIcon className="h-4 w-4" />
            Add category
          </Button>
        }
      />

      {error ? (
        <ErrorState
          title="Couldn't load categories"
          message={error.message}
          onRetry={fetchCategories}
        />
      ) : loading ? (
        <SkeletonRows count={6} />
      ) : active.length === 0 && inactive.length === 0 ? (
        <EmptyState
          title="No categories yet"
          body="Categories group the catalogue so staff can find a medicine without knowing its brand name. Start with the shelves you already use — Pain Relief, Antibiotics, Diabetes."
          action={<Button variant="primary" onClick={() => { setEditing(null); setModalOpen(true); }}>Add the first category</Button>}
        />
      ) : (
        <>
          <ul className="flex flex-col gap-s2">
            {active.map((category, idx) => (
              <CategoryRow
                key={category.id}
                category={category}
                position={idx}
                total={active.length}
                isDragging={dragIdx === idx}
                onDragStart={() => setDragIdx(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={() => { setDragIdx(null); persistOrder([...active, ...inactive]); }}
                onMoveUp={() => move(idx, idx - 1)}
                onMoveDown={() => move(idx, idx + 1)}
                onEdit={() => { setEditing(category); setModalOpen(true); }}
                onDeactivate={() => confirm.ask(category)}
              />
            ))}
          </ul>

          {inactive.length > 0 && (
            <>
              <h2 className="mb-s2 mt-s5 text-base font-bold uppercase tracking-wider text-muted-foreground">
                Deactivated
              </h2>
              <ul className="flex flex-col gap-s2">
                {inactive.map((category) => (
                  <CategoryRow
                    key={category.id}
                    category={category}
                    onEdit={() => { setEditing(category); setModalOpen(true); }}
                    onReactivate={() => handleReactivate(category)}
                  />
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <CategoryModal
        category={editing}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onSaved={(wasEdit) => {
          setEditing(null);
          fetchCategories();
          toast.success(wasEdit ? 'Category updated.' : 'Category created.');
        }}
      />

      <ConfirmDialog
        {...confirm.props}
        destructive
        title={`Deactivate ${confirm.target?.name}?`}
        body="Medicines already in this category keep it, but staff won't be able to pick it for new medicines until you reactivate it."
        confirmLabel="Deactivate category"
        onConfirm={handleDeactivate}
      />
    </div>
  );
}

function CategoryRow({
  category,
  position,
  total,
  onEdit,
  onDeactivate,
  onReactivate,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragOver,
  onDrop,
  isDragging,
}) {
  const reorderable = typeof position === 'number';

  return (
    <li
      draggable={reorderable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        // Mobile: stacked layout
        // Desktop: fixed grid columns so every row aligns consistently
        'min-h-target rounded-card border border-border bg-card px-s3 py-s2',
        'flex flex-col gap-s2',
        'sm:grid sm:grid-cols-[auto_auto_minmax(0,1fr)_300px] sm:items-center sm:gap-s3',
        'transition-colors duration-instant',
        reorderable && 'cursor-grab active:cursor-grabbing',
        isDragging && 'border-ring bg-muted'
      )}
    >
      {/* Drag handle */}
      <div className="flex shrink-0 items-center">
        {reorderable ? (
          <span
            className="select-none text-muted-foreground"
            aria-hidden="true"
          >
            ⠿
          </span>
        ) : (
          // Keep the same grid column for inactive rows
          <span
            className="invisible select-none"
            aria-hidden="true"
          >
            ⠿
          </span>
        )}
      </div>

      {/* Category color */}
      <span
        className="h-3 w-3 shrink-0 rounded-pill"
        style={{ background: category.color }}
        aria-hidden="true"
      />

      {/* Category information */}
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-s2">
          <span className="min-w-0 break-words text-base font-bold text-foreground">
            {category.name}
          </span>

          {!category.is_active && (
            <Badge tone="neutral">Inactive</Badge>
          )}
        </div>

        <p className="min-w-0 break-words text-base text-muted-foreground">
          {plural(category.medicines_count, 'medicine')}
          {category.description && ` · ${category.description}`}
        </p>
      </div>

      {/* Actions */}
      <div
        className={cn(
          // Mobile
          'flex w-full items-center justify-end gap-s1 border-t border-border pt-s2',

          // Desktop
          'sm:w-[300px] sm:border-t-0 sm:pt-0'
        )}
      >
        {reorderable && (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={onMoveUp}
              disabled={position === 0}
              aria-label={`Move ${category.name} up`}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="m6 15 6-6 6 6" />
              </svg>
            </Button>

            <Button
              variant="ghost"
              size="icon"
              onClick={onMoveDown}
              disabled={position === total - 1}
              aria-label={`Move ${category.name} down`}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </Button>
          </>
        )}

        <Button
          variant="ghost"
          size="compact"
          onClick={onEdit}
        >
          Edit
        </Button>

        {category.is_active ? (
          <Button
            variant="ghost"
            size="compact"
            onClick={onDeactivate}
            className="text-destructive"
          >
            Deactivate
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="compact"
            onClick={onReactivate}
            className="text-accent"
          >
            Reactivate
          </Button>
        )}
      </div>
    </li>
  );
}
