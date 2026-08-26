// ── Module 19: Settings
// ── Role: Routes + Validation

const express = require('express');
const { body } = require('express-validator');
const controller = require('./settings.controller');
const { validate }     = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');

const updateRules = [
  body().custom(v => { if (typeof v !== 'object' || Array.isArray(v)) throw new Error('Body must be a key-value object'); return true; }),
];

const router = express.Router();
router.use(authenticate);
router.get('/',  controller.getAll);
router.patch('/', authorize('owner'), updateRules, validate, controller.update);

module.exports = router;
