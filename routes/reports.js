const express = require("express");
const router = express.Router();
const pool = require("../database/connection");
const { authenticateToken, requireAdmin } = require("../middleware/auth");

// Import the helper function from users.js (or duplicate it here for simplicity)
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
    month: parseInt(parts.find((p) => p.type === "month").value) - 1,
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

  let daysToSubtract = 0;
  if (currentDay === 4) {
    if (dt.hour < 21 || (dt.hour === 21 && dt.minute < 30)) {
      daysToSubtract = 7;
    } else {
      daysToSubtract = 0;
    }
  } else if (currentDay < 4) {
    daysToSubtract = 3 + currentDay;
  } else {
    if (currentDay === 5) daysToSubtract = 1;
    else if (currentDay === 6) daysToSubtract = 2;
    else daysToSubtract = 3;
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

// Get weekly reports (Admin only)
router.get("/weekly", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { weekStart, userId } = req.query;

    // Calculate week period (Thursday 21:30 PM to next Thursday 21:30 PM)
    let weekStartDate, weekEndDate;

    if (weekStart) {
      // weekStart comes as "YYYY-MM-DD" string, parse it and ensure it's Thursday
      const [year, month, day] = weekStart.split("-").map(Number);
      weekStartDate = new Date(year, month - 1, day, 21, 30, 0);
      // Verify it's actually Thursday (day 4), if not, adjust
      if (weekStartDate.getDay() !== 4) {
        // Find the Thursday of that week
        const dayOfWeek = weekStartDate.getDay();
        let daysToAdd = 4 - dayOfWeek;
        if (daysToAdd < 0) daysToAdd += 7;
        weekStartDate.setDate(weekStartDate.getDate() + daysToAdd);
      }
      weekEndDate = new Date(weekStartDate);
      weekEndDate.setDate(weekEndDate.getDate() + 7);
    } else {
      // Get week boundaries directly in Asia/Colombo timezone
      const {
        weekStart: weekStartStr,
        weekEnd: weekEndStr,
        weekStartDate: weekStartDateObj,
        weekEndDate: weekEndDateObj,
      } = getWeekBoundaries();
      weekStartDate = weekStartDateObj;
      weekEndDate = weekEndDateObj;
    }

    // Format dates for MySQL (already formatted in getWeekBoundaries)
    const weekStartStr = weekStartDate
      ? (() => {
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
          const parts = formatter.formatToParts(weekStartDate);
          return `${parts.find((p) => p.type === "year").value}-${
            parts.find((p) => p.type === "month").value
          }-${parts.find((p) => p.type === "day").value} ${
            parts.find((p) => p.type === "hour").value
          }:${parts.find((p) => p.type === "minute").value}:${
            parts.find((p) => p.type === "second").value
          }`;
        })()
      : null;

    const weekEndStr = weekEndDate
      ? (() => {
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
          const parts = formatter.formatToParts(weekEndDate);
          return `${parts.find((p) => p.type === "year").value}-${
            parts.find((p) => p.type === "month").value
          }-${parts.find((p) => p.type === "day").value} ${
            parts.find((p) => p.type === "hour").value
          }:${parts.find((p) => p.type === "minute").value}:${
            parts.find((p) => p.type === "second").value
          }`;
        })()
      : null;

    const ordersUserCondition = userId ? "AND o.user_id = ?" : "";
    const transactionsUserCondition = userId ? "AND t.user_id = ?" : "";

    const summaryParams = [
      weekStartStr,
      weekEndStr,
      ...(userId ? [userId] : []),
      weekStartStr,
      weekEndStr,
      ...(userId ? [userId] : []),
      weekStartStr,
      weekEndStr,
      ...(userId ? [userId] : []),
      weekStartStr,
      weekEndStr,
      ...(userId ? [userId] : []),
      weekStartStr,
      weekEndStr,
      ...(userId ? [userId] : []),
    ];

    const [summaryResult] = await pool.query(
      `SELECT 
        (SELECT COUNT(DISTINCT o.user_id)
         FROM orders o
         WHERE o.status = 'COMPLETED'
           AND o.created_at >= ?
           AND o.created_at < ?
           ${ordersUserCondition}) as total_users,
        (SELECT COUNT(DISTINCT o.id)
         FROM orders o
         WHERE o.status = 'COMPLETED'
           AND o.created_at >= ?
           AND o.created_at < ?
           ${ordersUserCondition}) as total_orders,
        (SELECT COALESCE(SUM(o.diamond_amount * COALESCE(o.quantity, 1)), 0)
         FROM orders o
         WHERE o.status = 'COMPLETED'
           AND o.created_at >= ?
           AND o.created_at < ?
           ${ordersUserCondition}) as total_sales,
        (SELECT COALESCE(SUM(t.amount), 0)
         FROM transactions t
         WHERE t.created_at >= ?
           AND t.created_at < ?
           AND t.transaction_type = 'ADDED'
           AND t.description LIKE 'Weekly Sale Reward%'
           ${transactionsUserCondition}) as total_rewards,
        (SELECT COALESCE(SUM(t.amount), 0)
         FROM transactions t
         WHERE t.created_at >= ?
           AND t.created_at < ?
           AND t.transaction_type = 'ADDED'
           AND t.admin_id IS NOT NULL
           AND (t.description IS NULL OR t.description NOT LIKE 'Weekly Sale Reward%')
           ${transactionsUserCondition}) as total_admin_points`,
      summaryParams
    );

    const ordersParams = [
      weekStartStr,
      weekEndStr,
      ...(userId ? [userId] : []),
    ];
    const rewardsParams = [
      weekStartStr,
      weekEndStr,
      ...(userId ? [userId] : []),
    ];
    const adminPointsParams = [
      weekStartStr,
      weekEndStr,
      ...(userId ? [userId] : []),
    ];

    const [userBreakdown] = await pool.query(
      `SELECT 
        u.id as user_id,
        u.name,
        u.nickname,
        u.id_number,
        u.email,
        o.order_count,
        o.user_sales,
        COALESCE(r.user_reward, 0) as user_reward,
        COALESCE(a.admin_added_points, 0) as admin_added_points
      FROM (
        SELECT 
          user_id,
          COUNT(DISTINCT id) as order_count,
          COALESCE(SUM(diamond_amount * COALESCE(quantity, 1)), 0) as user_sales
        FROM orders
        WHERE status = 'COMPLETED'
          AND created_at >= ?
          AND created_at < ?
          ${userId ? "AND user_id = ?" : ""}
        GROUP BY user_id
      ) o
      INNER JOIN users u ON u.id = o.user_id
      LEFT JOIN (
        SELECT 
          user_id,
          COALESCE(SUM(amount), 0) as user_reward
        FROM transactions
        WHERE created_at >= ?
          AND created_at < ?
          AND transaction_type = 'ADDED'
          AND description LIKE 'Weekly Sale Reward%'
          ${userId ? "AND user_id = ?" : ""}
        GROUP BY user_id
      ) r ON r.user_id = o.user_id
      LEFT JOIN (
        SELECT 
          user_id,
          COALESCE(SUM(amount), 0) as admin_added_points
        FROM transactions
        WHERE created_at >= ?
          AND created_at < ?
          AND transaction_type = 'ADDED'
          AND admin_id IS NOT NULL
          AND (description IS NULL OR description NOT LIKE 'Weekly Sale Reward%')
          ${userId ? "AND user_id = ?" : ""}
        GROUP BY user_id
      ) a ON a.user_id = o.user_id
      ORDER BY o.user_sales DESC`,
      [...ordersParams, ...rewardsParams, ...adminPointsParams]
    );

    // Get all weeks with data - find the Thursday 21:30 of each week
    // DAYOFWEEK returns: 1=Sunday, 2=Monday, ..., 5=Thursday, ..., 7=Saturday
    // We want to find the Thursday (5) of each week
    const [weeksResult] = await pool.query(
      `SELECT DISTINCT
        DATE_FORMAT(
          DATE_SUB(
            created_at,
            INTERVAL (
              CASE 
                WHEN DAYOFWEEK(created_at) = 1 THEN 3  -- Sunday: go back 3 days to Thursday
                WHEN DAYOFWEEK(created_at) = 2 THEN 4  -- Monday: go back 4 days to Thursday
                WHEN DAYOFWEEK(created_at) = 3 THEN 5  -- Tuesday: go back 5 days to Thursday
                WHEN DAYOFWEEK(created_at) = 4 THEN 6  -- Wednesday: go back 6 days to Thursday
                WHEN DAYOFWEEK(created_at) = 5 THEN 0   -- Thursday: no change
                WHEN DAYOFWEEK(created_at) = 6 THEN 1  -- Friday: go back 1 day to Thursday
                WHEN DAYOFWEEK(created_at) = 7 THEN 2   -- Saturday: go back 2 days to Thursday
              END
            ) DAY
          ),
          '%Y-%m-%d'
        ) as week_start
      FROM orders
      WHERE status = 'COMPLETED'
      ORDER BY week_start DESC
      LIMIT 52`
    );

    res.json({
      weekStart: weekStartStr,
      weekEnd: weekEndStr,
      summary: summaryResult[0] || {
        total_users: 0,
        total_orders: 0,
        total_sales: 0,
        total_rewards: 0,
        total_admin_points: 0,
      },
      userBreakdown: userBreakdown || [],
      availableWeeks: weeksResult || [],
    });
  } catch (error) {
    console.error("Weekly report error:", error);
    res.status(500).json({
      error: "Failed to fetch weekly report",
      details: error.message,
    });
  }
});

// Get daily report (Admin only) - summary and user breakdown for a single day
router.get("/daily", authenticateToken, requireAdmin, async (req, res) => {
  try {
    let dateStr = req.query.date;
    if (!dateStr || typeof dateStr !== "string") {
      const dt = getColomboDateTime();
      dateStr = `${dt.year}-${String(dt.month + 1).padStart(2, "0")}-${String(dt.day).padStart(2, "0")}`;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: "Invalid date. Use YYYY-MM-DD." });
    }
    const dayStart = `${dateStr} 00:00:00`;
    const dayEnd = `${dateStr} 23:59:59`;

    const [summaryResult] = await pool.query(
      `SELECT 
        (SELECT COUNT(DISTINCT user_id) FROM orders WHERE status = 'COMPLETED' AND created_at >= ? AND created_at <= ?) as total_users,
        (SELECT COUNT(*) FROM orders WHERE status = 'COMPLETED' AND created_at >= ? AND created_at <= ?) as total_orders,
        (SELECT COALESCE(SUM(diamond_amount * COALESCE(quantity, 1)), 0) FROM orders WHERE status = 'COMPLETED' AND created_at >= ? AND created_at <= ?) as total_sales,
        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE transaction_type = 'ADDED' AND (admin_id IS NOT NULL OR merchant_id IS NOT NULL) AND created_at >= ? AND created_at <= ?) as total_admin_points`,
      [dayStart, dayEnd, dayStart, dayEnd, dayStart, dayEnd, dayStart, dayEnd]
    );

    const [userBreakdown] = await pool.query(
      `SELECT 
        u.id as user_id,
        u.name,
        u.nickname,
        u.id_number,
        u.email,
        o.order_count,
        o.user_sales,
        0 as user_reward,
        COALESCE(a.admin_added_points, 0) as admin_added_points
      FROM (
        SELECT 
          user_id,
          COUNT(*) as order_count,
          COALESCE(SUM(diamond_amount * COALESCE(quantity, 1)), 0) as user_sales
        FROM orders
        WHERE status = 'COMPLETED'
          AND created_at >= ?
          AND created_at <= ?
        GROUP BY user_id
      ) o
      INNER JOIN users u ON u.id = o.user_id
      LEFT JOIN (
        SELECT 
          user_id,
          COALESCE(SUM(amount), 0) as admin_added_points
        FROM transactions
        WHERE created_at >= ?
          AND created_at <= ?
          AND transaction_type = 'ADDED'
          AND (admin_id IS NOT NULL OR merchant_id IS NOT NULL)
        GROUP BY user_id
      ) a ON a.user_id = o.user_id
      ORDER BY o.user_sales DESC`,
      [dayStart, dayEnd, dayStart, dayEnd]
    );

    const [datesResult] = await pool.query(
      `SELECT DISTINCT DATE(created_at) as report_date
       FROM orders
       WHERE status = 'COMPLETED'
       ORDER BY report_date DESC
       LIMIT 90`
    );

    res.json({
      date: dateStr,
      summary: summaryResult[0] || {
        total_users: 0,
        total_orders: 0,
        total_sales: 0,
        total_admin_points: 0,
      },
      userBreakdown: userBreakdown || [],
      availableDates: (datesResult || []).map((r) => ({ date: r.report_date })),
    });
  } catch (error) {
    console.error("Daily report error:", error);
    res.status(500).json({
      error: "Failed to fetch daily report",
      details: error.message,
    });
  }
});

module.exports = router;
