class ApiResponse {
  static success(res, data = null, message = 'Success', statusCode = 200) {
    const body = { success: true, message };
    if (data !== null) body.data = data;
    return res.status(statusCode).json(body);
  }
  static created(res, data, message = 'Created successfully') {
    return ApiResponse.success(res, data, message, 201);
  }
}

module.exports = { ApiResponse };
