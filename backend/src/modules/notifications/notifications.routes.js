// ── Module 16: Notifications
// ── Role: Routes + Validation

const express = require('express');
const { param } = require('express-validator');
const controller = require('./notifications.controller');
const { isAlertKey } = require('./notifications.alerts');
const { validate }     = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router = express.Router();
router.use(authenticate);
router.get('/',         controller.list);
router.get('/count',    controller.count);
// `/read-all` stays registered BEFORE `/:id/read`: Express matches in order, and
// the other way round the literal path would bind to :id and fail validation.
router.patch('/read-all', controller.readAll);

// Two identifier shapes through one path. A stored notification is addressed by
// its UUID; a derived alert by its `alert:TYPE:entity:tier` key, which marks a
// dismissal instead. Colons are ordinary characters inside a path parameter —
// Express matches [^/]+ — so no escaping is needed here.
router.patch(
  '/:id/read',
  [param('id').custom((v) => isAlertKey(v) || UUID_RE.test(v))
    .withMessage('Must be a notification id or an alert key.')],
  validate,
  controller.read
);

module.exports = router;
