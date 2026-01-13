const bcrypt = require("bcryptjs");
const pool = require("../database/connection");
require("dotenv").config();

async function createAdmin() {
  try {
    const adminId = "ADMIN001";
    const adminPassword = "admin123";
    const passwordHash = await bcrypt.hash(adminPassword, 10);

    const [result] = await pool.query(
      `INSERT INTO users (name, nickname, id_number, password_hash, status, role) 
       VALUES (?, ?, ?, ?, 'APPROVED', 'ADMIN')
       ON DUPLICATE KEY UPDATE 
       password_hash = VALUES(password_hash), 
       status = 'APPROVED', 
       role = 'ADMIN',
       nickname = VALUES(nickname)`,
      ["Admin", "Admin", adminId, passwordHash]
    );

    // Get the admin user
    const [admin] = await pool.query(
      `SELECT id, name, id_number, role FROM users WHERE id_number = ?`,
      [adminId]
    );

    console.log("Admin user created/updated successfully:");
    console.log(admin[0]);
    console.log(`\nLogin credentials:`);
    console.log(`ID: ${adminId}`);
    console.log(`Password: ${adminPassword}`);
  } catch (error) {
    console.error("Error creating admin:", error);
  } finally {
    await pool.end();
  }
}

createAdmin();
