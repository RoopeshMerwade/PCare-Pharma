// ── Module: Medicine Categories
// ── Role: Service

const { supabase } = require('../../config/supabase');
const { AppError } = require('../../utils/AppError');
const { logAudit } = require('../../utils/audit');
const logger = require('../../utils/logger');

// ── READ ──────────────────────────────────────────────────

async function listCategories({ includeInactive = false } = {}) {
  let query = supabase
    .from('categories_with_count')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  if (!includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw new AppError('Failed to fetch categories.', 500, 'DB_ERROR');
  return data;
}

async function getCategoryById(id) {
  const { data, error } = await supabase
    .from('categories_with_count')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) throw new AppError('Category not found.', 404, 'CATEGORY_NOT_FOUND');
  return data;
}

// ── CREATE ────────────────────────────────────────────────

async function createCategory({ name, description, color }, createdBy) {
  // Enforce max 30 (DB trigger is the hard stop; check here for a clean error message)
  const { count } = await supabase
    .from('medicine_categories')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);

  if (count >= 30) throw new AppError('Maximum 30 active categories allowed.', 409, 'CATEGORY_LIMIT_REACHED');

  // Assign next sort order
  const { data: last } = await supabase
    .from('medicine_categories')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .single();

  const sort_order = (last?.sort_order || 0) + 1;

  const { data, error } = await supabase
    .from('medicine_categories')
    .insert({ name: name.trim(), description: description?.trim(), color: color || '#6B7280', sort_order, created_by: createdBy })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') throw new AppError(`A category named "${name}" already exists.`, 409, 'DUPLICATE_NAME');
    throw new AppError('Failed to create category.', 500, 'DB_ERROR');
  }

  await logAudit(createdBy, 'category_created', { categoryId: data.id, name: data.name });
  logger.info({ createdBy, categoryId: data.id }, 'Category created');
  return data;
}

// ── UPDATE ────────────────────────────────────────────────

async function updateCategory(id, { name, description, color }, requestingUserId) {
  const updates = {};
  if (name !== undefined)        updates.name        = name.trim();
  if (description !== undefined) updates.description = description?.trim();
  if (color !== undefined)       updates.color       = color;

  if (Object.keys(updates).length === 0) throw new AppError('No updatable fields provided.', 422, 'NO_FIELDS');

  const { data, error } = await supabase
    .from('medicine_categories')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') throw new AppError(`A category with that name already exists.`, 409, 'DUPLICATE_NAME');
    throw new AppError('Failed to update category.', 500, 'DB_ERROR');
  }
  if (!data) throw new AppError('Category not found.', 404, 'CATEGORY_NOT_FOUND');

  await logAudit(requestingUserId, 'category_updated', { categoryId: id, fields: Object.keys(updates) });
  return data;
}

// ── REORDER ───────────────────────────────────────────────
// Accepts an ordered array of category IDs and updates sort_order for each

async function reorderCategories(orderedIds, requestingUserId) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0)
    throw new AppError('orderedIds must be a non-empty array of category UUIDs.', 422, 'VALIDATION_ERROR');

  // Deliberately NOT an upsert. upsert() compiles to INSERT ... ON CONFLICT
  // (id) DO UPDATE, so every row it sends must stand on its own as an INSERT —
  // and medicine_categories.name is `not null` with no default. Postgres
  // enforces NOT NULL while building the candidate tuple, before it looks for
  // a conflict on id, so the old { id, sort_order } payload raised 23502 and
  // the DO UPDATE branch was never reached. That made this a 100% failure:
  // reorder has never once worked, for any input.
  //
  // A plain UPDATE writes only the column named and leaves `name` untouched.
  // These run as N separate statements, so a mid-flight failure can leave the
  // list partially renumbered — recoverable by dragging again, and never
  // corrupting anything, since sort_order is only a display hint. Making it
  // genuinely atomic needs a Postgres function (the schema-22 RPC pattern),
  // which is a migration rather than a code fix.
  const results = await Promise.all(
    orderedIds.map((id, idx) =>
      supabase.from('medicine_categories').update({ sort_order: idx + 1 }).eq('id', id)
    )
  );

  const failed = results.find((r) => r.error);
  if (failed) {
    // The previous version discarded the driver error entirely, which is why
    // the 500 arrived with no cause attached and this took a stack trace to
    // find. Client message stays generic; the real one goes to the log.
    logger.error(
      { reason: failed.error.message, code: failed.error.code, count: orderedIds.length },
      'Category reorder failed'
    );
    throw new AppError('Failed to reorder categories.', 500, 'DB_ERROR');
  }

  await logAudit(requestingUserId, 'categories_reordered', { count: orderedIds.length });
  return await listCategories();
}

// ── DEACTIVATE ────────────────────────────────────────────

async function deactivateCategory(id, requestingUserId) {
  // Cannot deactivate if medicines are linked
  const { count } = await supabase
    .from('medicines')
    .select('*', { count: 'exact', head: true })
    .eq('category_id', id)
    .eq('is_active', true);

  if (count > 0)
    throw new AppError(
      `This category has ${count} active medicine${count > 1 ? 's' : ''}. Reassign or deactivate them first.`,
      409, 'CATEGORY_HAS_MEDICINES'
    );

  const { data, error } = await supabase
    .from('medicine_categories')
    .update({ is_active: false })
    .eq('id', id)
    .select()
    .single();

  if (error) throw new AppError('Failed to deactivate category.', 500, 'DB_ERROR');
  if (!data) throw new AppError('Category not found.', 404, 'CATEGORY_NOT_FOUND');

  await logAudit(requestingUserId, 'category_deactivated', { categoryId: id });
  logger.info({ requestedBy: requestingUserId, categoryId: id }, 'Category deactivated');
  return data;
}

async function reactivateCategory(id, requestingUserId) {
  const { data, error } = await supabase
    .from('medicine_categories')
    .update({ is_active: true })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    if (error.message?.includes('CATEGORY_LIMIT_REACHED'))
      throw new AppError('Maximum 30 active categories allowed.', 409, 'CATEGORY_LIMIT_REACHED');
    throw new AppError('Failed to reactivate category.', 500, 'DB_ERROR');
  }
  if (!data) throw new AppError('Category not found.', 404, 'CATEGORY_NOT_FOUND');

  await logAudit(requestingUserId, 'category_reactivated', { categoryId: id });
  return data;
}

module.exports = { listCategories, getCategoryById, createCategory, updateCategory, reorderCategories, deactivateCategory, reactivateCategory };
