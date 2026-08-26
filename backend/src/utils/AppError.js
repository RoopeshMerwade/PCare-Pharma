class AppError extends Error {
  // `details` is optional structured data the frontend needs to act on the
  // error (e.g. the list of adherence warnings that require acknowledgment).
  // Existing callers that pass only 3 args are unaffected — details is undefined.
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true; // distinguishes from programming errors
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = { AppError };
