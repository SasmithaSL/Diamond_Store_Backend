const mysql = require('mysql2/promise');
require('dotenv').config();

async function renameTable() {
  let connection;
  
  try {
    // Create connection
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'topup_db',
    });

    console.log('Connected to database');

    // Check if point_transactions table exists
    const [tables] = await connection.query(
      "SHOW TABLES LIKE 'point_transactions'"
    );

    if (tables.length === 0) {
      console.log('Table point_transactions does not exist. Nothing to rename.');
      return;
    }

    // Check if transactions table already exists
    const [existingTransactions] = await connection.query(
      "SHOW TABLES LIKE 'transactions'"
    );

    if (existingTransactions.length > 0) {
      console.log('Table transactions already exists. Cannot rename.');
      return;
    }

    // Rename the table
    await connection.query('RENAME TABLE point_transactions TO transactions');
    
    console.log('✅ Successfully renamed point_transactions to transactions');
    
  } catch (error) {
    console.error('❌ Error renaming table:', error.message);
    throw error;
  } finally {
    if (connection) {
      await connection.end();
      console.log('Database connection closed');
    }
  }
}

// Run the migration
renameTable()
  .then(() => {
    console.log('Migration completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
