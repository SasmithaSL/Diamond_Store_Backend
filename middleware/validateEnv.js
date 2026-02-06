// Validate environment variables on startup
require('dotenv').config();

const requiredEnvVars = [
  'DB_HOST',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'JWT_SECRET'
];

const validateEnv = () => {
  const missing = [];
  const warnings = [];

  // Check required variables
  requiredEnvVars.forEach(varName => {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  });

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }

  // Security checks
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('❌ JWT_SECRET must be set and at least 32 characters long');
    process.exit(1);
  }

  if (process.env.JWT_SECRET === 'your_super_secret_jwt_key_change_this_in_production') {
    console.error('❌ Default JWT_SECRET detected. Change it immediately.');
    process.exit(1);
  }

  if (
    process.env.STATUS_TOKEN_SECRET &&
    process.env.STATUS_TOKEN_SECRET.length < 32
  ) {
    warnings.push('STATUS_TOKEN_SECRET should be at least 32 characters long');
  }

  if (process.env.NODE_ENV !== 'production' && !process.env.DB_PASSWORD) {
    warnings.push('Database password not set');
  }

  if (!process.env.FRONTEND_URL) {
    warnings.push('FRONTEND_URL not set (password reset links will be wrong)');
  }

  if (
    !process.env.SMTP_HOST ||
    !process.env.SMTP_PORT ||
    !process.env.SMTP_FROM
  ) {
    warnings.push(
      'SMTP is not fully configured (password reset emails will fail)'
    );
  }

  if (warnings.length > 0) {
    console.warn('⚠️  Security Warnings:');
    warnings.forEach(warning => console.warn('  -', warning));
  }

  console.log('✅ Environment variables validated');
};

module.exports = validateEnv;




