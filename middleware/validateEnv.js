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

  // Security warnings
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
    warnings.push('JWT_SECRET should be at least 32 characters long');
  }

  if (process.env.JWT_SECRET === 'your_super_secret_jwt_key_change_this_in_production') {
    warnings.push('⚠️  WARNING: Using default JWT_SECRET! Change it immediately!');
  }

  if (process.env.NODE_ENV !== 'production' && !process.env.DB_PASSWORD) {
    warnings.push('Database password not set');
  }

  if (warnings.length > 0) {
    console.warn('⚠️  Security Warnings:');
    warnings.forEach(warning => console.warn('  -', warning));
  }

  console.log('✅ Environment variables validated');
};

module.exports = validateEnv;




