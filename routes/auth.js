const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const multer = require("multer");
const pool = require("../database/connection");
const upload = require("../middleware/upload");
const { authenticateToken } = require("../middleware/auth");
const {
  authLimiter,
  validateString,
  validateInteger,
} = require("../middleware/security");
const {
  addSubscriber,
  removeSubscriber,
} = require("../utils/pendingStatusStream");
const {
  sendTelegramUserRegistrationNotification,
} = require("../utils/telegramNotify");
const router = express.Router();

const SALT_ROUNDS = 10;

const notifyRegistrationAsync = (payload) => {
  setImmediate(() => {
    sendTelegramUserRegistrationNotification(payload).catch((err) => {
      console.warn(
        "[Register] Telegram notification failed:",
        err?.message || err
      );
    });
  });
};

const handleRegistrationUpload = (req, res, next) => {
  upload.uploadMultiple(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res
          .status(400)
          .json({ error: "Each image must be 5MB or smaller" });
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({
          error: "Please upload face, ID front, and ID back images only",
        });
      }
      if (err.code === "LIMIT_FIELD_SIZE" || err.code === "LIMIT_FIELD_VALUE") {
        return res.status(400).json({ error: "Form data is too large" });
      }
      return res.status(400).json({ error: "Image upload failed" });
    }

    if (err?.message) {
      return res.status(400).json({ error: err.message });
    }

    return res.status(400).json({ error: "Image upload failed" });
  });
};

let smtpTransport = null;

const getSmtpTransport = () => {
  if (smtpTransport) return smtpTransport;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 0);
  const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port) {
    return null;
  }

  smtpTransport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
  });

  return smtpTransport;
};

const ensurePasswordResetTable = async () => {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      token_hash VARCHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_prt_user_id (user_id),
      INDEX idx_prt_token_hash (token_hash),
      CONSTRAINT fk_prt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`
  );
};

const getResetConfig = () => {
  const frontendUrl = (process.env.FRONTEND_URL || "").trim().replace(/\/+$/, "");
  const expiresMinutes = Number(process.env.RESET_TOKEN_EXPIRES_MINUTES || 60);
  return { frontendUrl, expiresMinutes };
};

const sendResetEmail = async (toEmail, resetUrl) => {
  const transport = getSmtpTransport();
  const from = process.env.SMTP_FROM;

  if (!transport || !from) {
    throw new Error("SMTP_NOT_CONFIGURED");
  }

  const subject = "Reset your password";
  const text = `You requested a password reset.\n\nReset your password using this link:\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`;
  const html = `
    <p>You requested a password reset.</p>
    <p>Reset your password using this link:</p>
    <p><a href="${resetUrl}">${resetUrl}</a></p>
    <p>If you did not request this, you can ignore this email.</p>
  `;

  await transport.sendMail({
    from,
    to: toEmail,
    subject,
    text,
    html,
  });
};

// Register new user
router.post(
  "/register",
  authLimiter,
  handleRegistrationUpload,
  async (req, res) => {
    try {
      const { phoneNumber, nickname, email, idNumber, password } = req.body;

      // Validate and sanitize inputs
      if (
        !phoneNumber ||
        typeof phoneNumber !== "string" ||
        phoneNumber.trim() === ""
      ) {
        return res.status(400).json({ error: "Phone number is required" });
      }

      // Validate phone number format (only digits, at least 10 characters)
      const phoneDigits = phoneNumber.replace(/\D/g, "");
      if (phoneDigits.length < 10) {
        return res
          .status(400)
          .json({ error: "Phone number must be at least 10 digits" });
      }

      if (!email || typeof email !== "string" || email.trim() === "") {
        return res.status(400).json({ error: "Email is required" });
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim())) {
        return res.status(400).json({ error: "Invalid email format" });
      }

      if (!idNumber || typeof idNumber !== "string" || idNumber.trim() === "") {
        return res.status(400).json({ error: "ID number is required" });
      }

      if (!password || typeof password !== "string" || password.trim() === "") {
        return res.status(400).json({ error: "Password is required" });
      }

      // Sanitize inputs
      const sanitizedPhoneNumber = validateString(phoneDigits, 20);
      const sanitizedNickname = nickname ? validateString(nickname, 100) : null;
      const sanitizedEmail = validateString(email.trim().toLowerCase(), 255);
      const sanitizedIdNumber = validateString(idNumber, 50);
      // Use nickname as name, or empty string if no nickname
      const sanitizedName = sanitizedNickname || "";

      if (!sanitizedPhoneNumber || !sanitizedEmail || !sanitizedIdNumber) {
        return res.status(400).json({ error: "Invalid input format" });
      }

      if (password.length < 6 || password.length > 128) {
        return res
          .status(400)
          .json({ error: "Password must be between 6 and 128 characters" });
      }

      // Additional password strength check
      if (!/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]+$/.test(password)) {
        return res
          .status(400)
          .json({ error: "Password contains invalid characters" });
      }

      // Check if user already exists
      // Allow re-registration ONLY if the existing account was REJECTED
      // (common UX: user fixes info/images and re-submits for approval)
      const [existingUser] = await pool.query(
        "SELECT id, status, role, face_image, id_card_front, id_card_back FROM users WHERE id_number = ?",
        [sanitizedIdNumber]
      );

      // Check if email already exists (allow only if it's the same rejected user)
      const [existingEmail] = await pool.query(
        "SELECT id, status, role, id_number FROM users WHERE email = ?",
        [sanitizedEmail]
      );
      if (existingEmail.length > 0) {
        const emailUser = existingEmail[0];
        const isSameUser = emailUser.id_number === sanitizedIdNumber;
        const isRejected = emailUser.status === "REJECTED";
        if (emailUser.role === "ADMIN" || !isSameUser || !isRejected) {
          return res.status(400).json({ error: "Email already registered" });
        }
      }

      // Hash password with higher rounds for production
      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

      // Get uploaded file paths (normalize to relative paths)
      const path = require("path");
      const uploadPath = path.resolve(process.env.UPLOAD_PATH || "./uploads");
      let faceImage = null;
      let idCardFront = null;
      let idCardBack = null;

      if (req.files) {
        // Helper function to normalize path to just filename
        const normalizePath = (filePath) => {
          const resolvedPath = path.resolve(filePath);
          const resolvedUploadPath = path.resolve(uploadPath);
          console.log(`[Register] File path: ${resolvedPath}`);
          console.log(`[Register] Upload path: ${resolvedUploadPath}`);
          console.log(
            `[Register] File exists: ${require("fs").existsSync(resolvedPath)}`
          );

          if (resolvedPath.startsWith(resolvedUploadPath)) {
            // Return just the filename (not relative path) for simpler serving
            const filename = path.basename(resolvedPath);
            console.log(`[Register] Normalized to filename: ${filename}`);
            return filename;
          }
          // If path doesn't start with upload path, try to extract filename anyway
          const filename = path.basename(filePath);
          console.log(`[Register] Extracted filename (fallback): ${filename}`);
          return filename;
        };

        // Handle face image
        if (req.files.faceImage && req.files.faceImage[0]) {
          const file = req.files.faceImage[0];
          const normalized = normalizePath(file.path);
          if (normalized) {
            faceImage = normalized;
            // Log for debugging
            console.log(`[Register] Face image - Original path: ${file.path}`);
            console.log(`[Register] Face image - Filename: ${file.filename}`);
            console.log(`[Register] Face image - Normalized: ${faceImage}`);
            console.log(
              `[Register] Face image - File exists: ${require("fs").existsSync(
                file.path
              )}`
            );
          } else {
            console.error(`[Register] Failed to normalize path: ${file.path}`);
            return res.status(400).json({ error: "Invalid face image upload" });
          }
        }

        // Handle ID card front
        if (req.files.idCardFront && req.files.idCardFront[0]) {
          const file = req.files.idCardFront[0];
          const normalized = normalizePath(file.path);
          if (normalized) {
            idCardFront = normalized;
          } else {
            return res
              .status(400)
              .json({ error: "Invalid ID card front upload" });
          }
        }

        // Handle ID card back
        if (req.files.idCardBack && req.files.idCardBack[0]) {
          const file = req.files.idCardBack[0];
          const normalized = normalizePath(file.path);
          if (normalized) {
            idCardBack = normalized;
          } else {
            return res
              .status(400)
              .json({ error: "Invalid ID card back upload" });
          }
        }
      }

      // Validate required images
      if (!faceImage) {
        return res.status(400).json({ error: "Face image is required" });
      }

      if (!idCardFront || !idCardBack) {
        return res
          .status(400)
          .json({ error: "Both ID card front and back images are required" });
      }

      // If user exists:
      // - REJECTED + USER: update the same record and set status back to PENDING
      // - Otherwise: block duplicate registration
      if (existingUser.length > 0) {
        const existing = existingUser[0];

        // Safety: never allow overwriting admin accounts
        if (existing.role === "ADMIN") {
          return res
            .status(400)
            .json({ error: "ID number already registered" });
        }

        if (existing.status !== "REJECTED") {
          return res
            .status(400)
            .json({ error: "ID number already registered" });
        }

        // Best-effort delete old images to avoid orphaned files
        try {
          const fs = require("fs");
          const oldFiles = [
            existing.face_image,
            existing.id_card_front,
            existing.id_card_back,
          ].filter(Boolean);
          for (const oldFile of oldFiles) {
            // We store just filenames (preferred). If absolute path somehow exists, handle it too.
            const oldPath = path.isAbsolute(oldFile)
              ? oldFile
              : path.join(uploadPath, oldFile);
            if (fs.existsSync(oldPath)) {
              fs.unlinkSync(oldPath);
            }
          }
        } catch (cleanupErr) {
          // Don't fail registration because of cleanup
          console.warn(
            "[Register] Failed to cleanup old images:",
            cleanupErr?.message || cleanupErr
          );
        }

        await pool.query(
          `UPDATE users
         SET name = ?,
             nickname = ?,
             phone_number = ?,
             email = ?,
             face_image = ?,
             id_card_front = ?,
             id_card_back = ?,
             password_hash = ?,
             status = 'PENDING',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
          [
            sanitizedName,
            sanitizedNickname,
            sanitizedPhoneNumber,
            sanitizedEmail,
            faceImage,
            idCardFront,
            idCardBack,
            passwordHash,
            existing.id,
          ]
        );

        const [result] = await pool.query(
          `SELECT id, name, id_number, status, created_at 
         FROM users WHERE id = ?`,
          [existing.id]
        );

        const responseBody = {
          message: "Registration updated. Waiting for admin approval.",
          user: result[0],
        };

        notifyRegistrationAsync({
          ...result[0],
          email: sanitizedEmail,
          phone_number: sanitizedPhoneNumber,
          nickname: sanitizedNickname,
        });

        return res.status(201).json(responseBody);
      }

      // Insert new user
      const [insertResult] = await pool.query(
        `INSERT INTO users (name, nickname, phone_number, email, id_number, face_image, id_card_front, id_card_back, password_hash, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
        [
          sanitizedName,
          sanitizedNickname,
          sanitizedPhoneNumber,
          sanitizedEmail,
          sanitizedIdNumber,
          faceImage,
          idCardFront,
          idCardBack,
          passwordHash,
        ]
      );

      // Get the inserted user
      const [result] = await pool.query(
        `SELECT id, name, id_number, status, created_at 
       FROM users WHERE id = ?`,
        [insertResult.insertId]
      );

      const responseBody = {
        message: "Registration successful. Waiting for admin approval.",
        user: result[0],
      };

      notifyRegistrationAsync({
        ...result[0],
        email: sanitizedEmail,
        phone_number: sanitizedPhoneNumber,
        nickname: sanitizedNickname,
      });

      res.status(201).json(responseBody);
    } catch (error) {
      // Don't log sensitive information
      console.error("Registration error:", error.message);
      let statusCode = 500;
      let message = "Registration failed";

      if (error?.code === "ER_DUP_ENTRY") {
        statusCode = 409;
        if (/email/i.test(error?.message || error?.sqlMessage || "")) {
          message = "Email already registered";
        } else if (
          /id_number/i.test(error?.message || error?.sqlMessage || "")
        ) {
          message = "ID number already registered";
        } else {
          message = "Duplicate value already exists";
        }
      } else if (error?.code === "ER_DATA_TOO_LONG") {
        statusCode = 400;
        message = "Input value too long";
      } else if (error?.code === "ER_TRUNCATED_WRONG_VALUE") {
        statusCode = 400;
        message = "Invalid input value";
      }

      const responseBody = { error: message };
      if (process.env.NODE_ENV !== "production" && error?.message) {
        responseBody.details = error.message;
      }

      res.status(statusCode).json(responseBody);
    }
  }
);

// Login
router.post("/login", authLimiter, async (req, res) => {
  try {
    // Support both email and idNumber for admin login
    const { email, idNumber, password, rememberMe } = req.body;
    const identifier = email || idNumber;

    // Validate inputs
    if (
      !identifier ||
      typeof identifier !== "string" ||
      identifier.trim() === ""
    ) {
      return res
        .status(400)
        .json({ error: "Email/ID and password are required" });
    }

    if (!password) {
      return res.status(400).json({ error: "Password is required" });
    }

    if (password.length > 128) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    let user = null;
    const trimmedIdentifier = identifier.trim();

    // Check if identifier is an email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const isEmail = emailRegex.test(trimmedIdentifier);

    if (isEmail) {
      // Login by email (regular users)
      const sanitizedEmail = validateString(
        trimmedIdentifier.toLowerCase(),
        255
      );
      if (!sanitizedEmail) {
        return res.status(400).json({ error: "Invalid email format" });
      }

      const [result] = await pool.query(
        "SELECT id, name, id_number, email, password_hash, status, role, points_balance FROM users WHERE email = ?",
        [sanitizedEmail]
      );

      if (result.length === 0) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      user = result[0];
    } else {
      // Login by id_number (admin users)
      const sanitizedIdNumber = validateString(trimmedIdentifier, 50);
      if (!sanitizedIdNumber) {
        return res.status(400).json({ error: "Invalid ID number format" });
      }

      const [result] = await pool.query(
        "SELECT id, name, id_number, email, password_hash, status, role, points_balance FROM users WHERE id_number = ?",
        [sanitizedIdNumber]
      );

      if (result.length === 0) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      user = result[0];

      // Only allow id_number login for admin users
      if (user.role !== "ADMIN") {
        return res.status(401).json({ error: "Invalid credentials" });
      }
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check if user is approved (admin can always login)
    if (user.status !== "APPROVED" && user.role !== "ADMIN") {
      return res.status(403).json({
        error: "Account pending approval",
        status: user.status,
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      {
        expiresIn: rememberMe
          ? process.env.JWT_EXPIRES_IN_REMEMBER || "30d"
          : process.env.JWT_EXPIRES_IN || "7d",
      }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        idNumber: user.id_number,
        status: user.status,
        role: user.role,
        pointsBalance: user.points_balance,
      },
    });
  } catch (error) {
    // Don't log sensitive information
    console.error("Login error:", error.message);
    res.status(500).json({ error: "Login failed" });
  }
});

// Request password reset (email)
router.post("/forgot-password", authLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== "string" || email.trim() === "") {
      return res.status(400).json({ error: "Email is required" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const sanitizedEmail = validateString(email.trim().toLowerCase(), 255);
    if (!sanitizedEmail) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const { frontendUrl, expiresMinutes } = getResetConfig();
    if (!frontendUrl) {
      return res
        .status(500)
        .json({ error: "Frontend URL is not configured" });
    }

    await ensurePasswordResetTable();

    const [users] = await pool.query(
      "SELECT id, email FROM users WHERE email = ?",
      [sanitizedEmail]
    );

    // Always respond with success to avoid account enumeration
    if (users.length === 0) {
      return res.json({
        message: "If an account exists, a reset link has been sent.",
      });
    }

    const user = users[0];

    await pool.query(
      "UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL",
      [user.id]
    );

    const resetToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");
    const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000);

    await pool.query(
      "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
      [user.id, tokenHash, expiresAt]
    );

    const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;

    await sendResetEmail(user.email, resetUrl);

    return res.json({
      message: "If an account exists, a reset link has been sent.",
    });
  } catch (error) {
    if (error?.message === "SMTP_NOT_CONFIGURED") {
      return res.status(500).json({ error: "Email service not configured" });
    }
    console.error("Forgot password error:", error.message);
    return res.status(500).json({ error: "Failed to send reset email" });
  }
});

// Reset password using token
router.post("/reset-password", authLimiter, async (req, res) => {
  try {
    const { token, newPassword, email } = req.body;

    if (!token || typeof token !== "string" || token.trim() === "") {
      return res.status(400).json({ error: "Reset token is required" });
    }

    if (!newPassword || typeof newPassword !== "string") {
      return res.status(400).json({ error: "Password is required" });
    }

    if (newPassword.length < 6 || newPassword.length > 128) {
      return res
        .status(400)
        .json({ error: "Password must be between 6 and 128 characters" });
    }

    if (
      !/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]+$/.test(newPassword)
    ) {
      return res
        .status(400)
        .json({ error: "Password contains invalid characters" });
    }

    const sanitizedEmail =
      email && typeof email === "string"
        ? validateString(email.trim().toLowerCase(), 255)
        : null;

    if (email && !sanitizedEmail) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    await ensurePasswordResetTable();

    const tokenHash = crypto
      .createHash("sha256")
      .update(token.trim())
      .digest("hex");

    const [rows] = await pool.query(
      `SELECT prt.id, prt.user_id, prt.expires_at, prt.used_at, u.email
       FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
       WHERE prt.token_hash = ?
       ORDER BY prt.id DESC
       LIMIT 1`,
      [tokenHash]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    const record = rows[0];
    const now = new Date();
    const expiresAt = new Date(record.expires_at);

    if (record.used_at) {
      return res.status(400).json({ error: "Reset token already used" });
    }

    if (expiresAt < now) {
      return res.status(400).json({ error: "Reset token expired" });
    }

    if (sanitizedEmail && record.email !== sanitizedEmail) {
      return res.status(400).json({ error: "Email does not match reset token" });
    }

    const saltRounds = process.env.NODE_ENV === "production" ? 12 : 10;
    const passwordHash = await bcrypt.hash(newPassword, saltRounds);

    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [
      passwordHash,
      record.user_id,
    ]);

    await pool.query("UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?", [
      record.id,
    ]);

    return res.json({ message: "Password reset successful" });
  } catch (error) {
    console.error("Reset password error:", error.message);
    return res.status(500).json({ error: "Failed to reset password" });
  }
});

// Helper function to normalize image paths for API responses
const normalizeImagePath = (imagePath) => {
  if (!imagePath) return null;

  const path = require("path");

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

// Check user status by ID number (public endpoint for pending page)
router.post("/check-status", authLimiter, async (req, res) => {
  try {
    const { idNumber } = req.body;

    if (!idNumber || typeof idNumber !== "string" || idNumber.trim() === "") {
      return res.status(400).json({ error: "ID number is required" });
    }

    const sanitizedIdNumber = validateString(idNumber, 50);
    if (!sanitizedIdNumber) {
      return res.status(400).json({ error: "Invalid ID number format" });
    }

    const [result] = await pool.query(
      "SELECT id, status FROM users WHERE id_number = ?",
      [sanitizedIdNumber]
    );

    if (result.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      status: result[0].status,
      userId: result[0].id,
    });
  } catch (error) {
    console.error("Check status error:", error);
    res.status(500).json({ error: "Failed to check status" });
  }
});

// Stream user status updates by ID number (SSE)
router.get("/status-stream/:idNumber", async (req, res) => {
  try {
    const { idNumber } = req.params;

    const sanitizedIdNumber = validateString(idNumber, 50);
    if (!sanitizedIdNumber) {
      return res.status(400).json({ error: "Invalid ID number format" });
    }

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

    const [result] = await pool.query(
      "SELECT status FROM users WHERE id_number = ?",
      [sanitizedIdNumber]
    );

    if (result.length === 0) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ error: "User not found" })}\n\n`
      );
      return res.end();
    }

    const status = (result[0].status || "").toUpperCase();
    res.write(`event: status\ndata: ${JSON.stringify({ status })}\n\n`);

    if (status !== "PENDING") {
      return res.end();
    }

    addSubscriber(sanitizedIdNumber, res);

    const keepAliveInterval = setInterval(() => {
      res.write(": keep-alive\n\n");
    }, 25000);

    req.on("close", () => {
      clearInterval(keepAliveInterval);
      removeSubscriber(sanitizedIdNumber, res);
    });
  } catch (error) {
    console.error("Status stream error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to stream status" });
      return;
    }
    res.end();
  }
});

// Get current user profile
router.get("/me", authenticateToken, async (req, res) => {
  try {
    const [result] = await pool.query(
      `SELECT id, name, nickname, phone_number, id_number, face_image, id_card_front, id_card_back, status, points_balance, role, created_at 
       FROM users WHERE id = ?`,
      [req.user.id]
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
    console.error("Get profile error:", error);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

module.exports = router;
