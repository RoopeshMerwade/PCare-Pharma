// ── Module: User Management
// ── Role: Routes + Validation

const express = require('express');
const { body, param } = require('express-validator');
const controller = require('./users.controller');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// ── Validation rules
const uuidParam = [
  param('id').isUUID().withMessage('Invalid user ID format'),
];

const createRules = [
  body('full_name').trim().isLength({ min: 2, max: 100 }).withMessage('Full name must be 2–100 characters'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  // { values: 'falsy' } — bare .optional() only skips `undefined`, and the
  // Add staff form always sends phone: '' when left blank, so the field
  // failed isMobilePhone on every submission where it was actually omitted.
  body('phone').optional({ values: 'falsy' }).isMobilePhone('en-IN').withMessage('Valid Indian mobile number required'),
];

const updateRules = [
  body('full_name').optional().trim().isLength({ min: 2, max: 100 }).withMessage('Full name must be 2–100 characters'),
  body('phone').optional({ values: 'falsy' }).isMobilePhone('en-IN').withMessage('Valid Indian mobile number'),
  body('avatar_url').optional().isURL().withMessage('Avatar must be a valid URL'),
  // Prevent role/email changes via this endpoint
  body('role').not().exists().withMessage('Role cannot be changed here'),
  body('email').not().exists().withMessage('Email cannot be changed here'),
];

// ── Routes

// Owner only: list all staff
router.get('/', authorize('owner'), controller.list);

// Any authenticated: own profile
router.get('/me', controller.getMe);

// Owner only: get any user
router.get('/:id', authorize('owner'), uuidParam, validate, controller.getOne);

// Owner only: create staff account
router.post('/', authorize('owner'), createRules, validate, controller.create);

// Owner OR self: update profile
router.patch('/:id', uuidParam, updateRules, validate, controller.update);

// Owner only: activate / deactivate / reset password
router.patch('/:id/activate',       authorize('owner'), uuidParam, validate, controller.activate);
router.patch('/:id/deactivate',     authorize('owner'), uuidParam, validate, controller.deactivate);
router.post('/:id/reset-password',  authorize('owner'), uuidParam, validate, controller.resetPassword);

module.exports = router;
