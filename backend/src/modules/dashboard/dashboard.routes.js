// ── Modules 17+18: Dashboard
// ── Role: Routes

const express = require('express');
const controller = require('./dashboard.controller');
const { authenticate, authorize } = require('../../middleware/authenticate');

const router = express.Router();
router.use(authenticate);
router.get('/owner', authorize('owner'), controller.ownerDash);
router.get('/staff', controller.staffDash);  // both roles can see staff dashboard

module.exports = router;
