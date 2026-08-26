// ── Module 21: Chronic Medication Adherence Monitoring — Routes

const express = require('express');
const { body, param } = require('express-validator');
const controller = require('./chronic-care.controller');
const { validate }     = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');

// ── Validation ────────────────────────────────────────────

const uid = (f = 'id') => [param(f).isUUID()];

const patientConditionRules = [
  body('customer_id').isUUID().withMessage('Valid customer ID required'),
  body('condition_id').isUUID().withMessage('Select a condition from the list'),
  body('diagnosed_date').optional({ nullable: true }).isDate({ format: 'YYYY-MM-DD' }),
  body('prescribing_doctor').optional({ nullable: true }).trim().isLength({ max: 150 }),
  body('notes').optional({ nullable: true }).trim().isLength({ max: 500 }),
];

const scheduleCreateRules = [
  body('customer_id').isUUID().withMessage('Valid customer ID required'),
  body('medicine_id').isUUID().withMessage('Valid medicine ID required'),
  body('condition_id').optional({ nullable: true }).isUUID(),
  body('refill_cycle_days').isInt({ min: 1, max: 365 }).withMessage('Refill cycle must be 1-365 days'),
  body('early_grace_days').optional().isInt({ min: 0, max: 60 }),
  body('late_grace_days').optional().isInt({ min: 0, max: 60 }),
];

const scheduleUpdateRules = [
  body('refill_cycle_days').optional().isInt({ min: 1, max: 365 }),
  body('early_grace_days').optional().isInt({ min: 0, max: 60 }),
  body('late_grace_days').optional().isInt({ min: 0, max: 60 }),
];

// ── Routes ────────────────────────────────────────────────
// Both owner and staff may create/edit — per product decision. All writes
// are audit-logged (see service layer), which is the control that matters
// here more than role-gating.

const router = express.Router();
router.use(authenticate);

router.get('/condition-options', controller.conditionOptions);
router.get('/overdue', controller.overdue);

router.get('/customers/:customerId/conditions', uid('customerId'), validate, controller.patientConditions);
router.post('/customers/conditions', patientConditionRules, validate, controller.addPatientCondition);
router.patch('/conditions/:id/deactivate', uid(), validate, controller.deactivateCondition);

router.get('/customers/:customerId/schedules', uid('customerId'), validate, controller.listSchedules);
router.post('/schedules', scheduleCreateRules, validate, controller.createSchedule);
router.patch('/schedules/:id', uid(), scheduleUpdateRules, validate, controller.updateSchedule);
router.patch('/schedules/:id/deactivate', uid(), validate, controller.deactivateSchedule);

module.exports = router;
