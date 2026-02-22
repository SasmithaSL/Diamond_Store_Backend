/**
 * Migration: Add referral system and Merchant role support.
 * - users: referral_code (unique, nullable), referred_by_id (nullable FK to users.id)
 * - transactions: merchant_id (nullable FK to users.id) for merchant-added points
 * Run from Backend folder: node scripts/add-referral-and-merchant.js
 */
const pool = require("../database/connection");
require("dotenv").config();

async function run() {
  const connection = await pool.getConnection();
  try {
    // Add referral_code to users if not exists
    const userCols = await connection.query(
      "SHOW COLUMNS FROM users LIKE 'referral_code'"
    );
    if (userCols[0].length === 0) {
      await connection.query(
        "ALTER TABLE users ADD COLUMN referral_code VARCHAR(24) NULL UNIQUE"
      );
      console.log("Added referral_code to users.");
    } else console.log("referral_code already exists on users.");
    const refByCols = await connection.query(
      "SHOW COLUMNS FROM users LIKE 'referred_by_id'"
    );
    if (refByCols[0].length === 0) {
      await connection.query(
        "ALTER TABLE users ADD COLUMN referred_by_id INT NULL"
      );
      await connection.query(
        "ALTER TABLE users ADD INDEX idx_users_referral_code (referral_code)"
      ).catch(() => {});
      await connection.query(
        "ALTER TABLE users ADD INDEX idx_users_referred_by (referred_by_id)"
      ).catch(() => {});
      await connection.query(
        "ALTER TABLE users ADD CONSTRAINT fk_users_referred_by FOREIGN KEY (referred_by_id) REFERENCES users(id) ON DELETE SET NULL"
      ).catch((e) => { if (e.code !== "ER_DUP_KEY") throw e; });
      console.log("Added referred_by_id to users.");
    } else console.log("referred_by_id already exists on users.");

    // Add merchant_id to transactions if not exists
    const txCols = await connection.query(
      "SHOW COLUMNS FROM transactions LIKE 'merchant_id'"
    );
    if (txCols[0].length === 0) {
      await connection.query(
        "ALTER TABLE transactions ADD COLUMN merchant_id INT NULL"
      );
      await connection.query(
        "ALTER TABLE transactions ADD INDEX idx_transactions_merchant (merchant_id)"
      ).catch(() => {});
      await connection.query(
        "ALTER TABLE transactions ADD CONSTRAINT fk_transactions_merchant FOREIGN KEY (merchant_id) REFERENCES users(id) ON DELETE SET NULL"
      ).catch((e) => { if (e.code !== "ER_DUP_KEY") throw e; });
      console.log("Added merchant_id to transactions.");
    } else console.log("merchant_id already exists on transactions.");

    console.log("Referral & merchant migration completed.");
  } catch (error) {
    console.error("Migration error:", error);
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

run();
