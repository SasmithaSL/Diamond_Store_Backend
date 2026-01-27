// Security middleware for production
const rateLimit = require('express-rate-limit');

// Rate limiting for authentication endpoints
// In development, rate limiting is more lenient
const isDevelopment = process.env.NODE_ENV !== 'production';

const getClientIp = (req) => {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim() !== '') {
    return cfIp.trim();
  }
  return req.ip;
};

const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: isDevelopment ? 100 : 20, // More lenient in development (100), stricter in production (20)
  message: 'Too many login attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
});

// Rate limiting for API endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
});

// Rate limiting for order creation
const orderLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 orders per minute
  message: 'Too many order requests, please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
});

// Input sanitization helper
const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  // Remove potentially dangerous characters
  return input
    .trim()
    .replace(/[<>]/g, '') // Remove < and >
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+=/gi, ''); // Remove event handlers
};

// Validate and sanitize string inputs
const validateString = (value, maxLength = 255) => {
  if (typeof value !== 'string') return null;
  const sanitized = sanitizeInput(value);
  if (sanitized.length > maxLength) return null;
  if (sanitized.length === 0) return null;
  return sanitized;
};

// Validate integer
const validateInteger = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const num = parseInt(value);
  if (isNaN(num)) return null;
  if (num < min || num > max) return null;
  return num;
};

module.exports = {
  authLimiter,
  apiLimiter,
  orderLimiter,
  sanitizeInput,
  validateString,
  validateInteger
};


