// ── Module 16: Notifications
// ── Role: Routes + Validation

const express = require('express');
const { param } = require('express-validator');
const controller = require('./notifications.controller');
const { validate }     = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');

const router = express.Router();
router.use(authenticate);
router.get('/',         controller.list);
router.get('/count',    controller.count);
router.patch('/read-all', controller.readAll);
router.patch('/:id/read', [param('id').isUUID()], validate, controller.read);

module.exports = router;
