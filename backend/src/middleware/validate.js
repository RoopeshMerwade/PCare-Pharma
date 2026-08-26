const { validationResult } = require('express-validator');
const { AppError } = require('../utils/AppError');

// Turns express-validator failures into a 422 VALIDATION_ERROR.
// message stays the joined human-readable string (existing contract);
// details adds per-field structure so the frontend can highlight inputs.
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const list = errors.array();
    const messages = list.map((e) => e.msg).join(', ');
    const fields = list.map((e) => ({ field: e.path ?? e.param, message: e.msg }));
    throw new AppError(messages, 422, 'VALIDATION_ERROR', { fields });
  }
  next();
};

module.exports = { validate };
