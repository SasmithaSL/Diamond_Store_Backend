// MySQL/MariaDB Connection
const mysql = require('mysql2/promise');
require('dotenv').config();

// Set timezone for MySQL connection
// This ensures dates are stored and retrieved in the correct timezone
// Sri Lanka Standard Time (SLST) = UTC+5:30
const timezone = process.env.APP_TIMEZONE || 'Asia/Colombo';

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  database: process.env.DB_NAME || 'topup_db',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: 'local' // Use local timezone (set by process.env.TZ)
});

// Set timezone for all connections
pool.on('connection', (connection) => {
  try {
    // Convert timezone name to offset
    // Asia/Colombo (SLST) = UTC+5:30
    // Asia/Kolkata (IST) = UTC+5:30
    // Asia/Jakarta = UTC+7:00
    let timezoneOffset = '+05:30'; // Default to SLST/IST (UTC+5:30)
    if (timezone === 'Asia/Jakarta') {
      timezoneOffset = '+07:00';
    } else if (timezone === 'Asia/Colombo' || timezone === 'Asia/Kolkata') {
      timezoneOffset = '+05:30';
    } else if (timezone.includes('+') || timezone.includes('-')) {
      // If already an offset, use it directly
      timezoneOffset = timezone;
    }
    // Use promise-based query method
    connection.promise().query(`SET time_zone = '${timezoneOffset}'`)
      .then(() => {
        console.log(`[Database] Timezone set to ${timezoneOffset} (${timezone})`);
      })
      .catch((err) => {
        console.error('Error setting MySQL timezone:', err);
      });
  } catch (err) {
    console.error('Error in connection handler:', err);
  }
});

// Test connection
pool.getConnection()
  .then(connection => {
    console.log('Connected to MySQL database');
    connection.release();
  })
  .catch(err => {
    console.error('Error connecting to MySQL database:', err);
  });

module.exports = pool;

