// ── Module 21: Chronic Medication Adherence Monitoring
// ── Role: Controller

const svc = require('./chronic-care.service');
const { asyncHandler } = require('../../utils/asyncHandler');
const { ApiResponse } = require('../../utils/ApiResponse');

const conditionOptions = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, { conditions: await svc.listConditionOptions() });
});

const patientConditions = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, { conditions: await svc.listPatientConditions(req.params.customerId) });
});

const addPatientCondition = asyncHandler(async (req, res) => {
  const condition = await svc.addPatientCondition(req.body, req.user.id);
  return ApiResponse.created(res, { condition }, 'Condition recorded.');
});

const deactivateCondition = asyncHandler(async (req, res) => {
  const condition = await svc.deactivatePatientCondition(req.params.id, req.user.id);
  return ApiResponse.success(res, { condition }, 'Condition record deactivated.');
});

const listSchedules = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, { schedules: await svc.listSchedulesForCustomer(req.params.customerId) });
});

const createSchedule = asyncHandler(async (req, res) => {
  const schedule = await svc.createSchedule(req.body, req.user.id);
  return ApiResponse.created(res, { schedule }, 'Medication schedule created.');
});

const updateSchedule = asyncHandler(async (req, res) => {
  const schedule = await svc.updateSchedule(req.params.id, req.body, req.user.id);
  return ApiResponse.success(res, { schedule }, 'Schedule updated.');
});

const deactivateSchedule = asyncHandler(async (req, res) => {
  const schedule = await svc.deactivateSchedule(req.params.id, req.user.id);
  return ApiResponse.success(res, { schedule }, 'Schedule deactivated.');
});

const overdue = asyncHandler(async (req, res) => {
  const schedules = await svc.getOverdueSchedules({ limit: parseInt(req.query.limit) || 20 });
  return ApiResponse.success(res, { schedules });
});

module.exports = {
  conditionOptions,
  patientConditions,
  addPatientCondition,
  deactivateCondition,
  listSchedules,
  createSchedule,
  updateSchedule,
  deactivateSchedule,
  overdue,
};
