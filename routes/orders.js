const express = require("express");
const pool = require("../database/connection");
const { authenticateToken, requireAdmin } = require("../middleware/auth");
const { orderLimiter, validateInteger } = require("../middleware/security");
const { uploadOrderPhoto } = require("../middleware/upload");
const {
  addSubscriber,
  removeSubscriber,
  notifyNewOrder,
} = require("../utils/orderStream");
const {
  sendTelegramOrderNotification,
} = require("../utils/telegramNotify");
const router = express.Router();

// Available diamond packages (fixed options)
const DIAMOND_PACKAGES = [10, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

// Get available diamond packages
router.get("/packages", authenticateToken, (req, res) => {
  res.json({ packages: DIAMOND_PACKAGES });
});

// This endpoint is no longer needed - removed recipient selection

// Create diamond request (order) - Parent User submits for Client
router.post(
  "/request",
  authenticateToken,
  orderLimiter,
  uploadOrderPhoto,
  async (req, res) => {
    const connection = await pool.getConnection();

    try {
      const { diamondAmount, quantity, clientImoId } = req.body;
      const userId = req.user.id;
      const profilePhotoFile = req.file; // From multer

      // Validate and sanitize inputs
      const validatedAmount = validateInteger(diamondAmount);
      if (!validatedAmount || !DIAMOND_PACKAGES.includes(validatedAmount)) {
        connection.release();
        return res.status(400).json({
          error: `Invalid diamond amount. Must be one of: ${DIAMOND_PACKAGES.join(
            ", "
          )}`,
        });
      }

      const validatedQty = validateInteger(quantity, 1, 100);
      if (!validatedQty) {
        connection.release();
        return res
          .status(400)
          .json({ error: "Quantity must be between 1 and 100" });
      }

      // Validate client IMO ID (required)
      if (
        !clientImoId ||
        typeof clientImoId !== "string" ||
        clientImoId.trim() === ""
      ) {
        connection.release();
        return res.status(400).json({ error: "Client IMO ID is required" });
      }

      // Sanitize client IMO ID
      const sanitizedClientImoId = clientImoId.trim().substring(0, 100);

      // Handle profile photo filename (optional)
      const profilePhotoFilename = profilePhotoFile
        ? profilePhotoFile.filename
        : null;

      const qty = validatedQty;
      const diamondAmountInt = validatedAmount;

      // Calculate total points needed - prevent integer overflow
      const totalDiamonds = diamondAmountInt * qty;
      if (totalDiamonds > 1000000) {
        // Max 1 million diamonds per order
        connection.release();
        return res.status(400).json({ error: "Order amount too large" });
      }
      const pointsNeeded = totalDiamonds; // 1 point = 1 diamond

      // Check user has enough points
      const [userCheck] = await connection.query(
        `SELECT points_balance FROM users WHERE id = ?`,
        [userId]
      );

      if (userCheck.length === 0) {
        connection.release();
        return res.status(404).json({ error: "User not found" });
      }

      if (userCheck[0].points_balance < pointsNeeded) {
        connection.release();
        return res.status(400).json({
          error: "Insufficient points",
          required: pointsNeeded,
          available: userCheck[0].points_balance,
        });
      }

      await connection.beginTransaction();

      // Generate unique order number
      const orderNumber = `ORD-${Date.now()}-${Math.random()
        .toString(36)
        .substr(2, 9)
        .toUpperCase()}`;

      // Create order with client IMO ID and profile photo
      let orderResult;
      try {
        // Check if client_profile_photo column exists
        const [columns] = await connection.query(
          `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_SCHEMA = DATABASE() 
         AND TABLE_NAME = 'orders' 
         AND COLUMN_NAME = 'client_profile_photo'`
        );

        const hasProfilePhoto = columns.some(
          (col) => col.COLUMN_NAME === "client_profile_photo"
        );

        let insertQuery, insertValues;

        if (hasProfilePhoto) {
          // client_profile_photo column exists
          insertQuery = `INSERT INTO orders (order_number, user_id, client_imo_id, client_profile_photo, diamond_amount, quantity, points_used, status)
                       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')`;
          insertValues = [
            orderNumber,
            userId,
            sanitizedClientImoId,
            profilePhotoFilename,
            diamondAmountInt,
            qty,
            pointsNeeded,
          ];
        } else {
          // Fallback to original query
          insertQuery = `INSERT INTO orders (order_number, user_id, client_imo_id, diamond_amount, quantity, points_used, status)
                       VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`;
          insertValues = [
            orderNumber,
            userId,
            sanitizedClientImoId,
            diamondAmountInt,
            qty,
            pointsNeeded,
          ];
        }

        [orderResult] = await connection.query(insertQuery, insertValues);
      } catch (err) {
        if (err.code === "ER_BAD_FIELD_ERROR") {
          connection.release();
          return res.status(500).json({
            error:
              "Database schema error. Please run migration to add required columns.",
          });
        } else {
          throw err;
        }
      }

      // Deduct points from user
      await connection.query(
        `UPDATE users 
       SET points_balance = points_balance - ?, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
        [pointsNeeded, userId]
      );

      // Record transaction
      await connection.query(
        `INSERT INTO transactions (user_id, amount, transaction_type, description)
       VALUES (?, ?, 'DEDUCTED', ?)`,
        [
          userId,
          pointsNeeded,
          `Diamond request: ${qty}x ${diamondAmountInt} diamonds (Order: ${orderNumber})`,
        ]
      );

      await connection.commit();

      // Get created order
      const [result] = await connection.query(
        `SELECT o.* FROM orders o WHERE o.id = ?`,
        [orderResult.insertId]
      );
      const newOrder = result;

      const [requesterResult] = await connection.query(
        `SELECT name, nickname, id_number FROM users WHERE id = ?`,
        [userId]
      );
      const requester = requesterResult[0] || null;

      connection.release();

      // Log without sensitive data
      console.log(
        `Order created: ${orderNumber}, User ID: ${userId}, Diamonds: ${totalDiamonds}`
      );

      try {
        notifyNewOrder(newOrder[0]);
      } catch (notifyError) {
        console.warn("Failed to notify new order:", notifyError);
      }
      sendTelegramOrderNotification(newOrder[0], requester).catch((notifyError) => {
        console.warn("Failed to send Telegram order notification:", notifyError);
      });

      res.status(201).json({
        message: "Diamond request submitted successfully",
        order: newOrder[0],
      });
    } catch (error) {
      await connection.rollback();
      connection.release();
      console.error("Create order error:", error);
      res
        .status(500)
        .json({ error: "Failed to create order", details: error.message });
    }
  }
);

// Get user's orders (Parent User's submitted orders)
router.get("/my-orders", authenticateToken, async (req, res) => {
  try {
    const statusFilter =
      typeof req.query.status === "string" ? req.query.status.trim() : null;
    const clientImoId =
      typeof req.query.clientImoId === "string"
        ? req.query.clientImoId.trim()
        : null;

    const conditions = ["o.user_id = ?"];
    const params = [req.user.id];

    if (statusFilter) {
      conditions.push("UPPER(TRIM(o.status)) = ?");
      params.push(statusFilter.toUpperCase());
    }

    if (clientImoId) {
      conditions.push("COALESCE(TRIM(o.client_imo_id), '') = ?");
      params.push(clientImoId);
    }

    const whereClause = conditions.join(" AND ");
    const [result] = await pool.query(
      `SELECT o.*, UPPER(TRIM(o.status)) AS status,
       u.email as parent_user_email FROM orders o 
       LEFT JOIN users u ON o.user_id = u.id
       WHERE ${whereClause}
       ORDER BY o.created_at DESC`,
      params
    );

    res.json({ orders: result || [] });
  } catch (error) {
    console.error("Get orders error:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch orders", details: error.message });
  }
});

// Get all pending orders (Admin only)
router.get("/pending", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [result] = await pool.query(
      `SELECT o.*, 
       u.name as parent_user_name, u.id_number as parent_user_id_number, u.email as parent_user_email
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       WHERE o.status = 'PENDING'
       ORDER BY o.created_at DESC`
    );

    res.json({ orders: result || [] });
  } catch (error) {
    console.error("Get pending orders error:", error);
    res
      .status(500)
      .json({
        error: "Failed to fetch pending orders",
        details: error.message,
      });
  }
});

// Get all rejected orders (Admin only)
router.get("/rejected", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [result] = await pool.query(
      `SELECT o.*, 
       u.name as parent_user_name, u.id_number as parent_user_id_number, u.email as parent_user_email
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       WHERE o.status = 'REJECTED'
       ORDER BY o.created_at DESC`
    );

    res.json({ orders: result || [] });
  } catch (error) {
    console.error("Get rejected orders error:", error);
    res
      .status(500)
      .json({
        error: "Failed to fetch rejected orders",
        details: error.message,
      });
  }
});

// Stream new pending orders to admins (SSE)
router.get(
  "/pending-stream",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const origin = req.headers.origin;
      res.setHeader("Access-Control-Allow-Origin", origin || "*");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }

      addSubscriber(res);

      const keepAliveInterval = setInterval(() => {
        res.write(": keep-alive\n\n");
      }, 25000);

      req.on("close", () => {
        clearInterval(keepAliveInterval);
        removeSubscriber(res);
      });
    } catch (error) {
      console.error("Pending orders stream error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream orders" });
        return;
      }
      res.end();
    }
  }
);

// Update order status (Admin only)
router.patch(
  "/:orderId/status",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const connection = await pool.getConnection();

    try {
      const orderId = parseInt(req.params.orderId);
      const { status } = req.body;

      // Validate inputs
      if (isNaN(orderId) || orderId <= 0) {
        connection.release();
        return res.status(400).json({ error: "Invalid order ID" });
      }

      if (
        !status ||
        typeof status !== "string" ||
        !["COMPLETED", "REJECTED"].includes(status.toUpperCase())
      ) {
        connection.release();
        return res
          .status(400)
          .json({ error: "Invalid status. Use COMPLETED or REJECTED" });
      }

      const statusUpper = status.toUpperCase();

      await connection.beginTransaction();

      // Get order details
      const [orderResult] = await connection.query(
        `SELECT * FROM orders WHERE id = ?`,
        [orderId]
      );

      if (orderResult.length === 0) {
        await connection.rollback();
        connection.release();
        return res.status(404).json({ error: "Order not found" });
      }

      const order = orderResult[0];

      if (order.status !== "PENDING") {
        await connection.rollback();
        connection.release();
        return res.status(400).json({ error: "Order is not pending" });
      }

      // Update order status
      await connection.query(
        `UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [statusUpper, orderId]
      );

      // If rejected, refund points
      if (statusUpper === "REJECTED") {
        // Refund points to requester
        await connection.query(
          `UPDATE users 
         SET points_balance = points_balance + ?, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
          [order.points_used, order.user_id]
        );

        // Record refund transaction
        await connection.query(
          `INSERT INTO transactions (user_id, amount, transaction_type, description, admin_id)
         VALUES (?, ?, 'REFUNDED', ?, ?)`,
          [
            order.user_id,
            order.points_used,
            `Order rejected: ${order.order_number}`,
            req.user.id,
          ]
        );
      }

      await connection.commit();
      connection.release();

      // If order is completed, calculate and add weekly sale reward immediately
      // This ensures rewards appear in admin transactions page right away
      if (statusUpper === "COMPLETED") {
        try {
          // Import the reward calculation function
          const usersModule = require("./users");
          if (
            usersModule &&
            typeof usersModule.calculateAndAddWeeklyReward === "function"
          ) {
            await usersModule.calculateAndAddWeeklyReward(order.user_id);
            console.log(
              `[Order Approval] Reward calculated for user ${order.user_id} after order ${orderId} approval`
            );
          } else {
            console.warn(
              `[Order Approval] calculateAndAddWeeklyReward function not found in users module`
            );
          }
        } catch (rewardError) {
          // Don't fail the order approval if reward calculation fails
          console.error(
            `[Order Approval] Failed to calculate reward for user ${order.user_id}:`,
            rewardError
          );
        }
      }

      // Log without sensitive data
      console.log(
        `Order ${orderId} status updated to ${statusUpper} by admin ${req.user.id}`
      );

      res.json({
        message: `Order ${statusUpper.toLowerCase()} successfully`,
        orderId: orderId,
      });
    } catch (error) {
      await connection.rollback();
      connection.release();
      console.error("Update order status error:", error);
      res
        .status(500)
        .json({
          error: "Failed to update order status",
          details: error.message,
        });
    }
  }
);

module.exports = router;
