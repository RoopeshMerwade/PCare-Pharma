// ── Module 11: Customers
// ── Role: Routes + Validation

const express = require('express');
const { body, param, query } = require('express-validator');
const controller = require('./customers.controller');
const { validate }     = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/authenticate');

// ── Validation
const uid = (f='id') => [param(f).isUUID()];
const createRules = [
  body('name').trim().notEmpty().withMessage('Customer name is required').isLength({ min:2, max:100 }),
  body('phone').optional({ nullable:true }).isMobilePhone('en-IN').withMessage('Valid Indian phone number required'),
  body('email').optional({ nullable:true }).isEmail().normalizeEmail(),
  body('date_of_birth').optional({ nullable:true }).isDate({ format:'YYYY-MM-DD' }),
];
const updateRules = [
  body('name').optional().trim().isLength({ min:2, max:100 }),
  body('email').optional({ nullable:true }).isEmail().normalizeEmail(),
  body('date_of_birth').optional({ nullable:true }).isDate({ format:'YYYY-MM-DD' }),
  body('phone').not().exists().withMessage('Phone cannot be changed after creation'),
];

// ── Routes
const router = express.Router();
router.use(authenticate);

router.get('/search',            [query('q').notEmpty()], validate, controller.search);
router.get('/',                  controller.list);
router.get('/:id',               uid(), validate, controller.getOne);
router.get('/:id/history',       uid(), validate, controller.history);
router.post('/',                 createRules, validate, controller.create);
router.patch('/:id',             authorize('owner'), uid(), updateRules, validate, controller.update);
router.patch('/:id/deactivate',  authorize('owner'), uid(), validate, controller.deactivate);
router.patch('/:id/reactivate',  authorize('owner'), uid(), validate, controller.reactivate);

module.exports = router;
