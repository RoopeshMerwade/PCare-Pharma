// ── Module: Authentication
// ── Role: Routes + Validation

const express = require('express');
const { body } = require('express-validator');
const controller = require('./auth.controller');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');

const router = express.Router();

// Validation rule sets
const loginRules = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
];

const forgotRules = [
  body('email').isEmail().normalizeEmail(),
];

const resetRules = [
  body('token').notEmpty().withMessage('Token is required'),
  body('new_password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number'),
];

// Public routes
router.post('/login', loginRules, validate, controller.login);
router.post('/forgot-password', forgotRules, validate, controller.forgotPassword);
router.post('/reset-password', resetRules, validate, controller.resetPassword);
router.post('/refresh', controller.refreshToken);

// Protected routes
router.post('/logout', authenticate, controller.logout);
router.get('/me', authenticate, controller.getMe);

module.exports = router;
