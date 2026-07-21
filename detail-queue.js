'use strict';

function reconcileStoredDetails(database, {
  srnumber = null,
  updatedAt = new Date().toISOString()
} = {}) {
  if (!database) throw new TypeError('database is required');
  const scope = srnumber == null ? '' : 'AND live_detail_queue.srnumber = ?';
  const result = database.prepare(`
    UPDATE live_detail_queue
    SET status = 'found', last_error = NULL, updated_at = ?
    WHERE status <> 'found'
      ${scope}
      AND EXISTS (
        SELECT 1 FROM portal_requests AS details
        WHERE details.srnumber = live_detail_queue.srnumber
      )
  `).run(...(srnumber == null ? [updatedAt] : [updatedAt, srnumber]));
  return Number(result.changes || 0);
}

module.exports = { reconcileStoredDetails };
