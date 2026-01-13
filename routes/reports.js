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

    let userCondition = "";
    let queryParams = [weekStartStr, weekEndStr];

    if (userId) {
      userCondition = "AND o.user_id = ?";
      queryParams.push(userId);
    }

    const [summaryResult] = await pool.query(
      `SELECT 
        COUNT(DISTINCT o.user_id) as total_users,
        COUNT(DISTINCT o.id) as total_orders,
        COALESCE(SUM(o.diamond_amount * COALESCE(o.quantity, 1)), 0) as total_sales,
        COALESCE(SUM(CASE WHEN pt.transaction_type = 'ADDED' AND pt.description LIKE 'Weekly Sale Reward%' THEN pt.amount ELSE 0 END), 0) as total_rewards
      FROM orders o
      LEFT JOIN transactions pt ON pt.user_id = o.user_id 
        AND pt.created_at >= ? 
        AND pt.created_at < ?
        AND pt.transaction_type = 'ADDED'
        AND pt.description LIKE 'Weekly Sale Reward%'
      WHERE o.status = 'COMPLETED'
        AND o.created_at >= ?
        AND o.created_at < ?
        ${userCondition}`,
      [...queryParams, weekStartStr, weekEndStr]
    );

    const [userBreakdown] = await pool.query(
      `SELECT 
        u.id as user_id,
        u.name,
        u.nickname,
        u.id_number,
        COUNT(DISTINCT o.id) as order_count,
        COALESCE(SUM(o.diamond_amount * COALESCE(o.quantity, 1)), 0) as user_sales,
        COALESCE(SUM(CASE WHEN pt.transaction_type = 'ADDED' AND pt.description LIKE 'Weekly Sale Reward%' THEN pt.amount ELSE 0 END), 0) as user_reward
      FROM orders o
      INNER JOIN users u ON u.id = o.user_id
      LEFT JOIN transactions pt ON pt.user_id = o.user_id 
        AND pt.created_at >= ? 
        AND pt.created_at < ?
        AND pt.transaction_type = 'ADDED'
        AND pt.description LIKE 'Weekly Sale Reward%'
      WHERE o.status = 'COMPLETED'
        AND o.created_at >= ?
        AND o.created_at < ?
        ${userCondition}
      GROUP BY u.id, u.name, u.nickname, u.id_number
      ORDER BY user_sales DESC`,
      [...queryParams, weekStartStr, weekEndStr]
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

module.exports = router;
