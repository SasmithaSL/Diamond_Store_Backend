const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("../database/connection");
const { authenticateToken, requireAdmin } = require("../middleware/auth");
const upload = require("../middleware/upload");
const { validateString } = require("../middleware/security");
const { notifyStatus } = require("../utils/pendingStatusStream");
const path = require("path");
const router = express.Router();

// Helper function to get current date/time directly in Asia/Colombo timezone
const getColomboDateTime = () => {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Colombo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  return {
    year: parseInt(parts.find((p) => p.type === "year").value),
    month: parseInt(parts.find((p) => p.type === "month").value) - 1, // 0-indexed
    day: parseInt(parts.find((p) => p.type === "day").value),
    hour: parseInt(parts.find((p) => p.type === "hour").value),
    minute: parseInt(parts.find((p) => p.type === "minute").value),
    second: parseInt(parts.find((p) => p.type === "second").value),
    weekday: parts.find((p) => p.type === "weekday").value,
  };
};

// Helper function to calculate week boundaries (Thursday 21:30) directly
const getWeekBoundaries = () => {
  const dt = getColomboDateTime();
  const weekdayMap = {
    Sunday: 0,
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
  };
  const currentDay = weekdayMap[dt.weekday];

  // Calculate days to subtract to get to the most recent Thursday
  let daysToSubtract = 0;
  if (currentDay === 4) {
    // Thursday: if before 21:30, use last Thursday; if after, use today
    if (dt.hour < 21 || (dt.hour === 21 && dt.minute < 30)) {
      daysToSubtract = 7;
    } else {
      daysToSubtract = 0;
    }
  } else if (currentDay < 4) {
    // Monday (1), Tuesday (2), Wednesday (3)
    daysToSubtract = 3 + currentDay; // Mon: 4, Tue: 5, Wed: 6
  } else {
    // Friday (5), Saturday (6), Sunday (0)
    if (currentDay === 5) daysToSubtract = 1;
    else if (currentDay === 6) daysToSubtract = 2;
    else daysToSubtract = 3; // Sunday
  }

  // Calculate Thursday date directly using Colombo timezone
  // Create date string in ISO format to avoid timezone issues
  const currentDateStr = `${dt.year}-${String(dt.month + 1).padStart(
    2,
    "0"
  )}-${String(dt.day).padStart(2, "0")}T00:00:00+05:30`;
  const thursdayDate = new Date(currentDateStr);
  thursdayDate.setDate(thursdayDate.getDate() - daysToSubtract);

  // Format helper for MySQL dates (in Colombo timezone)
  const formatDate = (date) => {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Colombo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const year = parts.find((p) => p.type === "year").value;
    const month = parts.find((p) => p.type === "month").value;
    const day = parts.find((p) => p.type === "day").value;
    return `${year}-${month}-${day}`;
  };

  // Format current time in Colombo
  const formatColomboTime = (date) => {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Colombo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    return `${parts.find((p) => p.type === "year").value}-${
      parts.find((p) => p.type === "month").value
    }-${parts.find((p) => p.type === "day").value} ${
      parts.find((p) => p.type === "hour").value
    }:${parts.find((p) => p.type === "minute").value}:${
      parts.find((p) => p.type === "second").value
    }`;
  };

  const weekStartStr = `${formatDate(thursdayDate)} 21:30:00`;
  const weekEndDate = new Date(thursdayDate);
  weekEndDate.setDate(weekEndDate.getDate() + 7);
  const weekEndStr = `${formatDate(weekEndDate)} 21:30:00`;
  const currentTimeStr = formatColomboTime(new Date());

  // Create Date objects for database queries (with timezone)
  const weekStartDate = new Date(`${formatDate(thursdayDate)}T21:30:00+05:30`);
  const weekEndDateObj = new Date(`${formatDate(weekEndDate)}T21:30:00+05:30`);

  return {
    weekStart: weekStartStr,
    weekEnd: weekEndStr,
    currentTime: currentTimeStr,
    weekStartDate,
    weekEndDate: weekEndDateObj,
  };
};

// Helper function to normalize image paths for API responses
const normalizeImagePath = (imagePath) => {
  if (!imagePath) return null;

  // If it's already a relative path (doesn't start with drive letter or /)
  if (!path.isAbsolute(imagePath) && !imagePath.match(/^[A-Za-z]:/)) {
    // Preserve the path exactly as stored, just normalize slashes
    const normalized = imagePath.replace(/\\/g, "/");
    if (process.env.NODE_ENV === "development") {
      console.log(
        `[Normalize] Relative path - Input: ${imagePath}, Output: ${normalized}`
      );
    }
    return normalized;
  }

  // If it's an absolute path, extract just the filename (preserves extension)
  const basename = path.basename(imagePath);
  if (process.env.NODE_ENV === "development") {
    console.log(
      `[Normalize] Absolute path - Input: ${imagePath}, Output: ${basename}`
    );
  }
  return basename;
};

// Helper function to calculate and add weekly sale reward for a user
// This can be called from dashboard or when an order is approved
const calculateAndAddWeeklyReward = async (userId) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Get week boundaries directly in Asia/Colombo timezone
    const {
      weekStart: weekStartStr,
      weekEnd: weekEndStr,
      weekStartDate,
      weekEndDate,
    } = getWeekBoundaries();

    const [weeklySalesResult] = await connection.query(
      `SELECT COALESCE(SUM(diamond_amount * quantity), 0) as weekly_sales
       FROM orders 
       WHERE user_id = ? 
       AND status = 'COMPLETED' 
       AND created_at >= ?
       AND created_at < ?`,
      [userId, weekStartStr, weekEndStr]
    );
    const weeklySales = weeklySalesResult[0]?.weekly_sales || 0;

    // Only calculate reward if weekly sales >= 4500
    if (weeklySales < 4500) {
      await connection.commit();
      connection.release();
      return { weeklySales, rewardAdded: false };
    }

    // Check if reward already given for this week (use same Colombo timezone calculation)
    const { weekStartDate: currentWeekStart } = getWeekBoundaries();

    const [existingReward] = await connection.query(
      `SELECT id, amount, description FROM transactions 
       WHERE user_id = ? 
       AND transaction_type = 'ADDED' 
       AND description LIKE 'Weekly Sale Reward%'
       AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, currentWeekStart]
    );

    // Calculate tiered reward
    let totalReward = 0;
    if (weeklySales > 4500) {
      const tier1Amount = Math.min(weeklySales, 18000) - 4500;
      if (tier1Amount > 0) {
        totalReward += tier1Amount * 0.01;
      }
    }
    if (weeklySales > 18000) {
      const tier2Amount = Math.min(weeklySales, 45000) - 18000;
      if (tier2Amount > 0) {
        totalReward += tier2Amount * 0.016;
      }
    }
    if (weeklySales > 45000) {
      const tier3Amount = Math.min(weeklySales, 90000) - 45000;
      if (tier3Amount > 0) {
        totalReward += tier3Amount * 0.021;
      }
    }
    if (weeklySales > 90000) {
      const tier4Amount = weeklySales - 90000;
      if (tier4Amount > 0) {
        totalReward += tier4Amount * 0.026;
      }
    }

    totalReward = Math.round(totalReward * 100) / 100;

    // Calculate incremental reward
    let rewardToAdd = 0;
    if (existingReward.length === 0) {
      rewardToAdd = totalReward;
    } else {
      const existingDescription = existingReward[0].description || "";
      const match = existingDescription.match(/Weekly Sale Reward: ([\d.]+)/);
      const existingRewardAmount = match ? parseFloat(match[1]) : 0;

      if (totalReward > existingRewardAmount) {
        rewardToAdd = totalReward - existingRewardAmount;
      }
    }

    rewardToAdd = Math.round(rewardToAdd * 100) / 100;

    if (rewardToAdd > 0) {
      // Add reward to balance
      await connection.query(
        `UPDATE users 
         SET points_balance = points_balance + ?, 
             updated_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        [rewardToAdd, userId]
      );

      // Record transaction
      await connection.query(
        `INSERT INTO transactions (user_id, amount, transaction_type, description)
         VALUES (?, ?, 'ADDED', ?)`,
        [
          userId,
          rewardToAdd,
          `Weekly Sale Reward: ${totalReward.toFixed(
            2
          )} (Sales: ${weeklySales.toLocaleString()})`,
        ]
      );

      console.log(
        `[Reward Calculation] User ${userId}, Weekly Sales: ${weeklySales}, Reward Added: ${rewardToAdd.toFixed(
          2
        )}, Total: ${totalReward.toFixed(2)}`
      );
    }

    await connection.commit();
    connection.release();

    return {
      weeklySales,
      rewardAdded: rewardToAdd > 0,
      rewardAmount: rewardToAdd,
    };
  } catch (error) {
    await connection.rollback();
    connection.release();
    console.error("Weekly reward calculation error:", error);
    throw error;
  }
};

// Get user dashboard data
router.get("/dashboard", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user info (removed sensitive logging)
    let [userResult] = await pool.query(
      `SELECT id, name, nickname, id_number, face_image, points_balance, status, created_at 
       FROM users WHERE id = ?`,
      [userId]
    );

    if (!userResult || userResult.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Get recent orders
    const [ordersResult] = await pool.query(
      `SELECT id, order_number, diamond_amount, quantity, points_used, status, created_at 
       FROM orders 
       WHERE user_id = ? 
       ORDER BY created_at DESC 
       LIMIT 10`,
      [userId]
    );

    // Get order counts by status for Order Center
    const [orderCountsResult] = await pool.query(
      `SELECT 
        COALESCE(SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END), 0) as pending_acceptance,
        COALESCE(SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END), 0) as pending_recharge,
        COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END), 0) as completed,
        COALESCE(SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END), 0) as under_appeal
       FROM orders 
       WHERE user_id = ?`,
      [userId]
    );

    const orderCounts = orderCountsResult[0] || {
      pending_acceptance: 0,
      pending_recharge: 0,
      completed: 0,
      under_appeal: 0,
    };

    // Get sales today (completed orders today)
    // Check if quantity column exists, otherwise use diamond_amount only
    let salesToday = 0;
    try {
      const [salesTodayResult] = await pool.query(
        `SELECT COALESCE(SUM(diamond_amount * COALESCE(quantity, 1)), 0) as sales_today
         FROM orders 
         WHERE user_id = ? 
         AND status = 'COMPLETED' 
         AND DATE(created_at) = CURDATE()`,
        [userId]
      );
      salesToday = salesTodayResult[0]?.sales_today || 0;
    } catch (err) {
      // Fallback if quantity column doesn't exist
      const [salesTodayResult] = await pool.query(
        `SELECT COALESCE(SUM(diamond_amount), 0) as sales_today
         FROM orders 
         WHERE user_id = ? 
         AND status = 'COMPLETED' 
         AND DATE(created_at) = CURDATE()`,
        [userId]
      );
      salesToday = salesTodayResult[0]?.sales_today || 0;
    }

    // Get weekly sales (total order prices for completed orders this week)
    // Week starts on Thursday 21:30 PM (9:30 PM)
    let weeklySales = 0;
    try {
      // Get week boundaries directly in Asia/Colombo timezone
      const {
        weekStart: weekStartStr,
        weekEnd: weekEndStr,
        currentTime: currentTimeStr,
      } = getWeekBoundaries();

      console.log(
        `[Weekly Sales] User ${userId} - Week Start: ${weekStartStr}, Week End: ${weekEndStr}, Current Time: ${currentTimeStr}`
      );

      const [weeklySalesResult] = await pool.query(
        `SELECT COALESCE(SUM(diamond_amount * COALESCE(quantity, 1)), 0) as weekly_sales
         FROM orders 
         WHERE user_id = ? 
         AND status = 'COMPLETED' 
         AND created_at >= ?
         AND created_at < ?`,
        [userId, weekStartStr, weekEndStr]
      );
      weeklySales = weeklySalesResult[0]?.weekly_sales || 0;
      console.log(
        `[Weekly Sales] User ${userId} - Calculated Weekly Sales: ${weeklySales}`
      );
    } catch (err) {
      // Fallback if quantity column doesn't exist
      try {
        const now = new Date();
        const currentDay = now.getDay();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();

        let weekStart = new Date(now);
        weekStart.setHours(21, 30, 0, 0);
        weekStart.setSeconds(0, 0);

        let daysToSubtract = 0;

        if (currentDay === 4) {
          if (currentHour < 21 || (currentHour === 21 && currentMinute < 30)) {
            daysToSubtract = 7;
          } else {
            daysToSubtract = 0;
          }
        } else {
          if (currentDay < 4) {
            daysToSubtract = currentDay + 4;
          } else {
            daysToSubtract = currentDay - 4;
            if (currentDay === 0) {
              daysToSubtract = 3;
            }
          }
        }

        weekStart.setDate(now.getDate() - daysToSubtract);

        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);

        const weekStartStr =
          weekStart.getFullYear() +
          "-" +
          String(weekStart.getMonth() + 1).padStart(2, "0") +
          "-" +
          String(weekStart.getDate()).padStart(2, "0") +
          " " +
          String(weekStart.getHours()).padStart(2, "0") +
          ":" +
          String(weekStart.getMinutes()).padStart(2, "0") +
          ":00";

        const weekEndStr =
          weekEnd.getFullYear() +
          "-" +
          String(weekEnd.getMonth() + 1).padStart(2, "0") +
          "-" +
          String(weekEnd.getDate()).padStart(2, "0") +
          " " +
          String(weekEnd.getHours()).padStart(2, "0") +
          ":" +
          String(weekEnd.getMinutes()).padStart(2, "0") +
          ":00";

        const [weeklySalesResult] = await pool.query(
          `SELECT COALESCE(SUM(diamond_amount), 0) as weekly_sales
           FROM orders 
           WHERE user_id = ? 
           AND status = 'COMPLETED' 
           AND created_at >= ?
           AND created_at < ?`,
          [userId, weekStartStr, weekEndStr]
        );
        weeklySales = weeklySalesResult[0]?.weekly_sales || 0;
      } catch (err2) {
        console.error("Weekly sales calculation error:", err2);
        weeklySales = 0;
      }
    }

    // Calculate and add weekly sale reward if applicable
    // Reward tiers: 4,500-18,000 (1%), 18,000-45,000 (1.6%), 45,000-90,000 (2.1%), 90,000+ (2.6%)
    if (weeklySales >= 4500) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();

        // Check if reward already given for this week and get the amount
        // Use the same week calculation as weekly sales (Thursday 21:30 PM) in Asia/Colombo timezone
        const { weekStart: weekStartStr, weekStartDate: currentWeekStart } =
          getWeekBoundaries();

        const [existingReward] = await connection.query(
          `SELECT id, amount, description FROM transactions 
           WHERE user_id = ? 
           AND transaction_type = 'ADDED' 
           AND description LIKE 'Weekly Sale Reward%'
           AND created_at >= ?
           ORDER BY created_at DESC
           LIMIT 1`,
          [userId, weekStartStr]
        );

        // Calculate tiered reward based on current weekly sales
        let totalReward = 0;
        let tier1Reward = 0;
        let tier2Reward = 0;
        let tier3Reward = 0;
        let tier4Reward = 0;

        // Tier 1: 4,500 - 18,000 at 1%
        if (weeklySales > 4500) {
          const tier1Amount = Math.min(weeklySales, 18000) - 4500;
          if (tier1Amount > 0) {
            tier1Reward = tier1Amount * 0.01;
            totalReward += tier1Reward;
          }
        }

        // Tier 2: 18,000 - 45,000 at 1.6%
        if (weeklySales > 18000) {
          const tier2Amount = Math.min(weeklySales, 45000) - 18000;
          if (tier2Amount > 0) {
            tier2Reward = tier2Amount * 0.016;
            totalReward += tier2Reward;
          }
        }

        // Tier 3: 45,000 - 90,000 at 2.1%
        if (weeklySales > 45000) {
          const tier3Amount = Math.min(weeklySales, 90000) - 45000;
          if (tier3Amount > 0) {
            tier3Reward = tier3Amount * 0.021;
            totalReward += tier3Reward;
          }
        }

        // Tier 4: 90,000+ at 2.6%
        if (weeklySales > 90000) {
          const tier4Amount = weeklySales - 90000;
          if (tier4Amount > 0) {
            tier4Reward = tier4Amount * 0.026;
            totalReward += tier4Reward;
          }
        }

        // Round to 2 decimal places
        totalReward = Math.round(totalReward * 100) / 100;

        // Get current balance before update
        const [currentBalanceResult] = await connection.query(
          `SELECT points_balance FROM users WHERE id = ?`,
          [userId]
        );
        const balanceBefore = currentBalanceResult[0]?.points_balance || 0;

        console.log(
          `[Reward Calculation] User ${userId}, Weekly Sales: ${weeklySales}`
        );
        console.log(
          `[Reward Calculation] Tier 1 (4500-18000): ${tier1Reward.toFixed(2)}`
        );
        console.log(
          `[Reward Calculation] Tier 2 (18000-45000): ${tier2Reward.toFixed(2)}`
        );
        console.log(
          `[Reward Calculation] Tier 3 (45000-90000): ${tier3Reward.toFixed(2)}`
        );
        console.log(
          `[Reward Calculation] Tier 4 (90000+): ${tier4Reward.toFixed(2)}`
        );
        console.log(
          `[Reward Calculation] Total Reward: ${totalReward.toFixed(2)}`
        );
        console.log(`[Reward Calculation] Balance Before: ${balanceBefore}`);

        // Check if reward needs to be added or updated
        let rewardToAdd = 0;
        if (existingReward.length === 0) {
          // No reward given yet, add the full calculated reward
          rewardToAdd = totalReward;
          console.log(
            `[Reward Calculation] No existing reward, adding full amount: ${rewardToAdd.toFixed(
              2
            )}`
          );
        } else {
          // Extract the reward amount from the description
          const existingDescription = existingReward[0].description || "";
          const match = existingDescription.match(
            /Weekly Sale Reward: ([\d.]+)/
          );
          const existingRewardAmount = match ? parseFloat(match[1]) : 0;

          // Only add the difference if the new reward is higher
          if (totalReward > existingRewardAmount) {
            rewardToAdd = totalReward - existingRewardAmount;
            console.log(
              `[Reward Calculation] Existing reward: ${existingRewardAmount.toFixed(
                2
              )}, New reward: ${totalReward.toFixed(
                2
              )}, Adding difference: ${rewardToAdd.toFixed(2)}`
            );
          } else {
            console.log(
              `[Reward Calculation] Reward already up to date (existing: ${existingRewardAmount.toFixed(
                2
              )}, calculated: ${totalReward.toFixed(2)})`
            );
          }
        }

        // Round rewardToAdd to 2 decimal places to avoid floating point precision issues
        rewardToAdd = Math.round(rewardToAdd * 100) / 100;

        if (rewardToAdd > 0) {
          // Add reward to balance (supporting decimal values)
          await connection.query(
            `UPDATE users 
             SET points_balance = points_balance + ?, 
                 updated_at = CURRENT_TIMESTAMP 
             WHERE id = ?`,
            [rewardToAdd, userId]
          );

          // Get balance after update
          const [balanceAfterResult] = await connection.query(
            `SELECT points_balance FROM users WHERE id = ?`,
            [userId]
          );
          const balanceAfter = balanceAfterResult[0]?.points_balance || 0;

          console.log(`[Reward Calculation] Balance After: ${balanceAfter}`);
          console.log(
            `[Reward Calculation] Balance Increase: ${(
              balanceAfter - balanceBefore
            ).toFixed(2)}`
          );

          // Record transaction (store exact decimal amount)
          // Store the exact decimal value (multiply by 100 to preserve 2 decimal places if column is INT)
          // If column is DECIMAL, store directly
          await connection.query(
            `INSERT INTO transactions (user_id, amount, transaction_type, description)
             VALUES (?, ?, 'ADDED', ?)`,
            [
              userId,
              rewardToAdd, // Store exact decimal amount
              `Weekly Sale Reward: ${totalReward.toFixed(
                2
              )} (Sales: ${weeklySales.toLocaleString()})`,
            ]
          );

          console.log(
            `Weekly sale reward added: User ID ${userId}, Amount: ${rewardToAdd.toFixed(
              2
            )}, Total Reward: ${totalReward.toFixed(2)}, Sales: ${weeklySales}`
          );
        }

        await connection.commit();
        connection.release();

        // Refresh user data to get updated balance
        const [updatedUserResult] = await pool.query(
          `SELECT id, name, nickname, id_number, face_image, points_balance, status, role, created_at, updated_at 
           FROM users 
           WHERE id = ?`,
          [userId]
        );
        if (updatedUserResult.length > 0) {
          userResult = updatedUserResult;
        }
      } catch (rewardError) {
        await connection.rollback();
        connection.release();
        console.error("Weekly reward calculation error:", rewardError);
        // Don't fail the entire request if reward calculation fails
      }
    }

    // Get recent point transactions
    const [transactionsResult] = await pool.query(
      `SELECT id, amount, transaction_type, description, created_at 
       FROM transactions 
       WHERE user_id = ? 
       ORDER BY created_at DESC 
       LIMIT 10`,
      [userId]
    );

    // Removed sensitive data from logs

    // Normalize image path
    const user = { ...userResult[0] };
    if (user.face_image) {
      user.face_image = normalizeImagePath(user.face_image);
    }

    res.json({
      user: user,
      recentOrders: ordersResult || [],
      recentTransactions: transactionsResult || [],
      orderCounts: orderCounts,
      salesToday: salesToday,
      weeklySales: weeklySales,
    });
  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({
      error: "Failed to fetch dashboard data",
      details: error.message,
    });
  }
});

// Get all pending users (Admin only)
router.get("/pending", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [result] = await pool.query(
      `SELECT id, name, nickname, email, id_number, face_image, status, created_at 
       FROM users 
       WHERE status = 'PENDING' 
       ORDER BY created_at DESC`
    );

    res.json({ users: result });
  } catch (error) {
    console.error("Get pending users error:", error);
    res.status(500).json({ error: "Failed to fetch pending users" });
  }
});

// Approve or reject user (Admin only)
router.patch(
  "/:userId/status",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const userId = parseInt(req.params.userId);
      const { status } = req.body;

      // Validate inputs
      if (isNaN(userId) || userId <= 0) {
        return res.status(400).json({ error: "Invalid user ID" });
      }

      if (
        !status ||
        typeof status !== "string" ||
        !["APPROVED", "REJECTED"].includes(status.toUpperCase())
      ) {
        return res
          .status(400)
          .json({ error: "Invalid status. Use APPROVED or REJECTED" });
      }

      const statusUpper = status.toUpperCase();

      const [updateResult] = await pool.query(
        `UPDATE users 
       SET status = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
        [statusUpper, userId]
      );

      if (updateResult.affectedRows === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get updated user
      const [result] = await pool.query(
        `SELECT id, name, id_number, status FROM users WHERE id = ?`,
        [userId]
      );

      if (result[0]?.id_number) {
        notifyStatus(result[0].id_number, statusUpper);
      }

      res.json({
        message: `User ${statusUpper.toLowerCase()} successfully`,
        user: result[0],
      });
    } catch (error) {
      console.error("Update user status error:", error);
      res.status(500).json({ error: "Failed to update user status" });
    }
  }
);

// Add points to user (Admin only)
router.post(
  "/:userId/points",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const connection = await pool.getConnection();

    try {
      const userId = parseInt(req.params.userId);
      const amount = parseInt(req.body.amount);
      const description = req.body.description;

      // Validate inputs
      if (isNaN(userId) || userId <= 0) {
        connection.release();
        return res.status(400).json({ error: "Invalid user ID" });
      }

      if (!amount || amount <= 0 || isNaN(amount) || amount > 1000000) {
        connection.release();
        return res
          .status(400)
          .json({ error: "Valid amount is required (max 1,000,000)" });
      }

      // Sanitize description
      const sanitizedDescription = description
        ? description.trim().substring(0, 500)
        : null;

      // Start transaction
      await connection.beginTransaction();

      // First, verify the user exists and is NOT an admin (safety check)
      const [userCheck] = await connection.query(
        `SELECT id, name, role FROM users WHERE id = ?`,
        [userId]
      );

      if (userCheck.length === 0) {
        await connection.rollback();
        connection.release();
        return res.status(404).json({ error: "User not found" });
      }

      // Store original role to verify it doesn't change
      const originalRole = userCheck[0].role;
      const userName = userCheck[0].name;

      if (originalRole === "ADMIN") {
        await connection.rollback();
        connection.release();
        return res
          .status(400)
          .json({ error: "Cannot add points to admin account" });
      }

      // Log without sensitive user data
      console.log(
        `Adding points: User ID ${userId}, Amount: ${amount}, Role: ${originalRole}`
      );

      // Update ONLY points_balance - explicitly exclude role
      const [updateResult] = await connection.query(
        `UPDATE users 
       SET points_balance = points_balance + ?, 
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = ? 
       AND role != 'ADMIN'`,
        [amount, userId]
      );

      if (updateResult.affectedRows === 0) {
        await connection.rollback();
        connection.release();
        return res.status(404).json({ error: "User not found or is admin" });
      }

      // Record transaction
      await connection.query(
        `INSERT INTO transactions (user_id, amount, transaction_type, description, admin_id)
         VALUES (?, ?, 'ADDED', ?, ?)`,
        [userId, amount, sanitizedDescription || "Quick Store", req.user.id]
      );

      await connection.commit();

      // Get updated user using the same connection to ensure we see the committed data
      // Explicitly verify role hasn't changed
      const [result] = await connection.query(
        `SELECT id, name, points_balance, role FROM users WHERE id = ?`,
        [userId]
      );

      connection.release();

      if (!result || result.length === 0) {
        return res.status(404).json({ error: "User not found after update" });
      }

      // CRITICAL: Verify role hasn't changed
      if (result[0].role !== originalRole) {
        console.error(
          `🚨 CRITICAL ERROR: User role changed from ${originalRole} to ${result[0].role}!`
        );
        console.error(`User ID: ${userId}, Name: ${userName}`);
        // This should NEVER happen - log critical error
        return res.status(500).json({
          error:
            "Critical error: User role was modified. This should not happen!",
          originalRole: originalRole,
          newRole: result[0].role,
          userId: userId,
        });
      }

      // Log without sensitive data
      console.log(
        `Points added: User ID ${userId}, Amount: ${amount}, New Balance: ${result[0].points_balance}`
      );

      res.json({
        message: "Points added successfully",
        user: {
          id: result[0].id,
          name: result[0].name,
          points_balance: result[0].points_balance,
          role: result[0].role,
        },
      });
    } catch (error) {
      await connection.rollback();
      connection.release();
      console.error("Add points error:", error);
      res
        .status(500)
        .json({ error: "Failed to add points", details: error.message });
    }
  }
);

// Get all approved users (Admin only)
router.get("/approved", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [result] = await pool.query(
      `SELECT id, name, nickname, email, id_number, points_balance, status, created_at 
       FROM users 
       WHERE status = 'APPROVED' AND role = 'USER'
       ORDER BY created_at DESC`
    );

    // Removed sensitive logging

    res.json({ users: result || [] });
  } catch (error) {
    console.error("Get approved users error:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch users", details: error.message });
  }
});

// Update user profile (name, nickname and/or face image)
router.put(
  "/profile",
  authenticateToken,
  upload.single("faceImage"),
  async (req, res) => {
    try {
      const userId = req.user.id;
      const { name, nickname } = req.body;

      // Validate name if provided
      let sanitizedName = null;
      if (name) {
        sanitizedName = validateString(name, 255);
        if (!sanitizedName) {
          return res.status(400).json({ error: "Invalid name format" });
        }
      }

      // Validate nickname if provided
      let sanitizedNickname = null;
      if (nickname !== undefined) {
        if (nickname === "" || nickname === null) {
          sanitizedNickname = null; // Allow clearing nickname
        } else {
          sanitizedNickname = validateString(nickname, 100);
          if (!sanitizedNickname) {
            return res.status(400).json({ error: "Invalid nickname format" });
          }
        }
      }

      // Get current user data
      const [currentUser] = await pool.query(
        "SELECT face_image FROM users WHERE id = ?",
        [userId]
      );

      if (currentUser.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      const updateFields = [];
      const updateValues = [];

      // Update name if provided
      if (sanitizedName) {
        updateFields.push("name = ?");
        updateValues.push(sanitizedName);
      }

      // Update nickname if provided
      if (sanitizedNickname !== undefined) {
        updateFields.push("nickname = ?");
        updateValues.push(sanitizedNickname);
      }

      // Handle face image if uploaded
      let faceImage = currentUser[0].face_image; // Keep existing if not updating
      if (req.file) {
        const path = require("path");
        const uploadPath = path.resolve(process.env.UPLOAD_PATH || "./uploads");
        const resolvedFilePath = path.resolve(req.file.path);
        const resolvedUploadPath = path.resolve(uploadPath);

        if (resolvedFilePath.startsWith(resolvedUploadPath)) {
          // Delete old image if exists
          if (currentUser[0].face_image) {
            const fs = require("fs");
            // Handle both absolute and relative paths
            let oldImagePath;
            if (path.isAbsolute(currentUser[0].face_image)) {
              oldImagePath = currentUser[0].face_image;
            } else {
              oldImagePath = path.join(uploadPath, currentUser[0].face_image);
            }
            if (fs.existsSync(oldImagePath)) {
              try {
                fs.unlinkSync(oldImagePath);
              } catch (err) {
                console.error("Error deleting old image:", err);
              }
            }
          }
          // Store just the filename (not relative path) for simpler serving
          faceImage = path.basename(resolvedFilePath);
          // Log for debugging
          console.log(
            `[Profile Update] Face image - File path: ${req.file.path}`
          );
          console.log(
            `[Profile Update] Face image - Filename: ${req.file.filename}`
          );
          console.log(`[Profile Update] Face image - Stored as: ${faceImage}`);
          updateFields.push("face_image = ?");
          updateValues.push(faceImage);
        } else {
          return res.status(400).json({ error: "Invalid file upload" });
        }
      }

      if (updateFields.length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }

      // Add updated_at
      updateFields.push("updated_at = CURRENT_TIMESTAMP");
      updateValues.push(userId);

      // Update user
      const [updateResult] = await pool.query(
        `UPDATE users SET ${updateFields.join(", ")} WHERE id = ?`,
        updateValues
      );

      if (updateResult.affectedRows === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get updated user
      const [result] = await pool.query(
        `SELECT id, name, nickname, id_number, face_image, status, points_balance, role, created_at 
       FROM users WHERE id = ?`,
        [userId]
      );

      // Normalize image path
      const user = { ...result[0] };
      if (user.face_image) {
        user.face_image = normalizeImagePath(user.face_image);
      }

      res.json({
        message: "Profile updated successfully",
        user: user,
      });
    } catch (error) {
      console.error("Update profile error:", error);
      res.status(500).json({ error: "Failed to update profile" });
    }
  }
);

// Request points from admin
router.post("/request-points", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, reason } = req.body;

    // Validate amount
    const amountInt = parseInt(amount);
    if (!amountInt || amountInt <= 0 || amountInt > 100000) {
      return res
        .status(400)
        .json({ error: "Invalid amount. Must be between 1 and 100000" });
    }

    // Validate reason (optional but recommended)
    const sanitizedReason = reason ? validateString(reason, 500) : null;

    // Check if user has pending request
    const [existingRequest] = await pool.query(
      `SELECT id FROM point_requests 
       WHERE user_id = ? AND status = 'PENDING' 
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (existingRequest.length > 0) {
      return res.status(400).json({
        error:
          "You already have a pending point request. Please wait for admin approval.",
      });
    }

    // Create point request
    const [result] = await pool.query(
      `INSERT INTO point_requests (user_id, requested_amount, reason, status)
       VALUES (?, ?, ?, 'PENDING')`,
      [userId, amountInt, sanitizedReason]
    );

    console.log(
      `Point request created: User ID ${userId}, Amount: ${amountInt}`
    );

    res.status(201).json({
      message:
        "Point request submitted successfully. Waiting for admin approval.",
      requestId: result.insertId,
    });
  } catch (error) {
    console.error("Request points error:", error);
    res.status(500).json({
      error: "Failed to submit point request",
      details: error.message,
    });
  }
});

// Get user's point request history
router.get("/my-point-requests", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [requests] = await pool.query(
      `SELECT id, requested_amount, reason, status, admin_notes, created_at, updated_at
       FROM point_requests 
       WHERE user_id = ? 
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json({ requests: requests || [] });
  } catch (error) {
    console.error("Get point requests error:", error);
    res.status(500).json({
      error: "Failed to fetch point requests",
      details: error.message,
    });
  }
});

// Get transaction history (from admin and rewards)
router.get("/transaction-history", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get all ADDED transactions (from admin OR rewards)
    const [allAddedTransactions] = await pool.query(
      `SELECT 
        pt.id,
        pt.amount,
        pt.transaction_type,
        pt.description,
        pt.admin_id,
        pt.created_at,
        u.name as admin_name
       FROM transactions pt
       LEFT JOIN users u ON pt.admin_id = u.id
       WHERE pt.user_id = ? 
         AND pt.transaction_type = 'ADDED'
       ORDER BY pt.created_at DESC`,
      [userId]
    );

    // Reverse to show newest first
    res.json({
      transactions: allAddedTransactions || [],
      total: allAddedTransactions.length,
    });
  } catch (error) {
    console.error("Get transaction history error:", error);
    res.status(500).json({
      error: "Failed to fetch transaction history",
      details: error.message,
    });
  }
});

// Get all pending point requests (Admin only)
router.get(
  "/point-requests/pending",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const [requests] = await pool.query(
        `SELECT pr.id, pr.user_id, pr.requested_amount, pr.reason, pr.status, pr.created_at,
              u.name, u.nickname, u.id_number, u.points_balance
       FROM point_requests pr
       JOIN users u ON pr.user_id = u.id
       WHERE pr.status = 'PENDING'
       ORDER BY pr.created_at ASC`
      );

      res.json({ requests: requests || [] });
    } catch (error) {
      console.error("Get pending point requests error:", error);
      res.status(500).json({
        error: "Failed to fetch point requests",
        details: error.message,
      });
    }
  }
);

// Process point request (Approve/Reject) - Admin only
router.patch(
  "/point-requests/:requestId",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const connection = await pool.getConnection();
    try {
      const requestId = parseInt(req.params.requestId);
      const { action, adminNotes } = req.body; // action: 'approve' or 'reject'
      const adminId = req.user.id;

      if (!["approve", "reject"].includes(action)) {
        connection.release();
        return res
          .status(400)
          .json({ error: 'Invalid action. Must be "approve" or "reject"' });
      }

      // Get the request
      const [requestResult] = await connection.query(
        `SELECT pr.*, u.points_balance 
       FROM point_requests pr
       JOIN users u ON pr.user_id = u.id
       WHERE pr.id = ? AND pr.status = 'PENDING'`,
        [requestId]
      );

      if (requestResult.length === 0) {
        connection.release();
        return res
          .status(404)
          .json({ error: "Point request not found or already processed" });
      }

      const request = requestResult[0];

      await connection.beginTransaction();

      if (action === "approve") {
        // Update user points
        await connection.query(
          `UPDATE users 
         SET points_balance = points_balance + ?, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
          [request.requested_amount, request.user_id]
        );

        // Record transaction
        await connection.query(
          `INSERT INTO transactions (user_id, amount, transaction_type, description, admin_id)
         VALUES (?, ?, 'ADDED', ?, ?)`,
          [
            request.user_id,
            request.requested_amount,
            `Point request approved (Request #${requestId})`,
            adminId,
          ]
        );

        // Update request status
        await connection.query(
          `UPDATE point_requests 
         SET status = 'APPROVED', admin_id = ?, admin_notes = ?, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
          [adminId, adminNotes || null, requestId]
        );
      } else {
        // Reject request
        await connection.query(
          `UPDATE point_requests 
         SET status = 'REJECTED', admin_id = ?, admin_notes = ?, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
          [adminId, adminNotes || null, requestId]
        );
      }

      await connection.commit();
      connection.release();

      console.log(
        `Point request ${action}d: Request ID ${requestId}, User ID ${request.user_id}`
      );

      res.json({
        message: `Point request ${action}d successfully`,
        requestId: requestId,
      });
    } catch (error) {
      await connection.rollback();
      connection.release();
      console.error("Process point request error:", error);
      res.status(500).json({
        error: "Failed to process point request",
        details: error.message,
      });
    }
  }
);

// Change password
router.put("/change-password", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;

    // Validate inputs
    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({ error: "Current password and new password are required" });
    }

    if (newPassword.length < 6 || newPassword.length > 128) {
      return res
        .status(400)
        .json({ error: "New password must be between 6 and 128 characters" });
    }

    // Additional password strength check
    if (
      !/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]+$/.test(newPassword)
    ) {
      return res
        .status(400)
        .json({ error: "New password contains invalid characters" });
    }

    // Get current user
    const [result] = await pool.query(
      "SELECT password_hash FROM users WHERE id = ?",
      [userId]
    );

    if (result.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Verify current password
    const isValidPassword = await bcrypt.compare(
      currentPassword,
      result[0].password_hash
    );
    if (!isValidPassword) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    // Hash new password
    const saltRounds = process.env.NODE_ENV === "production" ? 12 : 10;
    const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

    // Update password
    await pool.query(
      `UPDATE users 
       SET password_hash = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [newPasswordHash, userId]
    );

    res.json({ message: "Password changed successfully" });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ error: "Failed to change password" });
  }
});

// Get all transactions (Admin only) - with optional user filter
router.get(
  "/transactions/all",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const { userId, idNumber, email, limit = 100 } = req.query;

      let query = `
      SELECT 
        pt.id,
        pt.user_id,
        pt.amount,
        pt.transaction_type,
        pt.description,
        pt.admin_id,
        pt.created_at,
        u.name as user_name,
        u.id_number as user_id_number,
        u.email as user_email,
        u.nickname as user_nickname,
        admin.name as admin_name
      FROM transactions pt
      LEFT JOIN users u ON pt.user_id = u.id
      LEFT JOIN users admin ON pt.admin_id = admin.id
      WHERE 1=1
    `;
      const params = [];

      if (userId) {
        query += ` AND pt.user_id = ?`;
        params.push(parseInt(userId));
      }

      if (idNumber) {
        query += ` AND u.id_number = ?`;
        params.push(idNumber);
      }

      if (email) {
        query += ` AND LOWER(u.email) = LOWER(?)`;
        params.push(email);
      }

      query += ` ORDER BY pt.created_at DESC LIMIT ?`;
      params.push(parseInt(limit));

      const [transactions] = await pool.query(query, params);

      res.json({
        transactions: transactions || [],
        total: transactions.length,
      });
    } catch (error) {
      console.error("Get all transactions error:", error);
      res.status(500).json({
        error: "Failed to fetch transactions",
        details: error.message,
      });
    }
  }
);

// Get user details by ID (Admin only) - MUST be after all specific routes like /pending, /approved, etc.
router.get("/:userId", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);

    if (isNaN(userId) || userId <= 0) {
      return res.status(400).json({ error: "Invalid user ID" });
    }

    const [result] = await pool.query(
      `SELECT id, name, nickname, phone_number, email, id_number, face_image, id_card_front, id_card_back, 
              points_balance, status, role, created_at, updated_at 
       FROM users 
       WHERE id = ?`,
      [userId]
    );

    if (result.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Normalize image paths
    const user = { ...result[0] };
    if (user.face_image) {
      user.face_image = normalizeImagePath(user.face_image);
    }
    if (user.id_card_front) {
      user.id_card_front = normalizeImagePath(user.id_card_front);
    }
    if (user.id_card_back) {
      user.id_card_back = normalizeImagePath(user.id_card_back);
    }

    res.json({ user: user });
  } catch (error) {
    console.error("Get user details error:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch user details", details: error.message });
  }
});

// Export the router and helper function
module.exports = router;
module.exports.calculateAndAddWeeklyReward = calculateAndAddWeeklyReward;
