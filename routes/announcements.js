const express = require("express");
const pool = require("../database/connection");
const { authenticateToken, requireAdmin } = require("../middleware/auth");
const { validateString } = require("../middleware/security");
const router = express.Router();

// Ensure announcements table exists
const ensureAnnouncementsTable = async () => {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS announcements (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      type ENUM('info', 'warning', 'success') NOT NULL DEFAULT 'info',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`
  );
};

// Public: get active announcements (no auth required)
router.get("/public", async (req, res) => {
  try {
    await ensureAnnouncementsTable();
    const [rows] = await pool.query(
      "SELECT id, title, message, type, created_at FROM announcements WHERE is_active = 1 ORDER BY created_at DESC"
    );
    res.json({ announcements: rows });
  } catch (err) {
    console.error("[Announcements] Public list error:", err);
    res.status(500).json({ error: "Failed to fetch announcements" });
  }
});

// Admin: list all announcements
router.get("/", authenticateToken, requireAdmin, async (req, res) => {
  try {
    await ensureAnnouncementsTable();
    const [rows] = await pool.query(
      "SELECT id, title, message, type, is_active, created_at, updated_at FROM announcements ORDER BY created_at DESC"
    );
    res.json({ announcements: rows });
  } catch (err) {
    console.error("[Announcements] Admin list error:", err);
    res.status(500).json({ error: "Failed to fetch announcements" });
  }
});

// Admin: create announcement
router.post("/", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, message, type = "info", is_active = true } = req.body;

    const safeTitle = validateString(title, 255);
    const safeMessage = validateString(message, 5000);
    const safeType = ["info", "warning", "success"].includes(type)
      ? type
      : "info";
    const active = is_active ? 1 : 0;

    if (!safeTitle || !safeMessage) {
      return res
        .status(400)
        .json({ error: "Title and message are required" });
    }

    await ensureAnnouncementsTable();
    const [result] = await pool.query(
      "INSERT INTO announcements (title, message, type, is_active) VALUES (?, ?, ?, ?)",
      [safeTitle, safeMessage, safeType, active]
    );

    res.status(201).json({
      id: result.insertId,
      title: safeTitle,
      message: safeMessage,
      type: safeType,
      is_active: active === 1,
    });
  } catch (err) {
    console.error("[Announcements] Create error:", err);
    res.status(500).json({ error: "Failed to create announcement" });
  }
});

// Admin: update announcement
router.put("/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid announcement ID" });
    }

    const { title, message, type, is_active } = req.body;

    const updates = [];
    const values = [];

    if (title !== undefined) {
      updates.push("title = ?");
      values.push(validateString(title, 255) || "");
    }
    if (message !== undefined) {
      updates.push("message = ?");
      values.push(validateString(message, 5000) || "");
    }
    if (type !== undefined && ["info", "warning", "success"].includes(type)) {
      updates.push("type = ?");
      values.push(type);
    }
    if (is_active !== undefined) {
      updates.push("is_active = ?");
      values.push(is_active ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    values.push(id);
    await pool.query(
      `UPDATE announcements SET ${updates.join(", ")} WHERE id = ?`,
      values
    );

    const [rows] = await pool.query(
      "SELECT id, title, message, type, is_active, created_at, updated_at FROM announcements WHERE id = ?",
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Announcement not found" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("[Announcements] Update error:", err);
    res.status(500).json({ error: "Failed to update announcement" });
  }
});

// Admin: delete announcement
router.delete("/:id", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid announcement ID" });
    }

    const [result] = await pool.query("DELETE FROM announcements WHERE id = ?", [
      id,
    ]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Announcement not found" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[Announcements] Delete error:", err);
    res.status(500).json({ error: "Failed to delete announcement" });
  }
});

module.exports = router;
