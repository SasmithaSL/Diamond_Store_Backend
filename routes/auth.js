const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../database/connection');
const upload = require('../middleware/upload');
const { authenticateToken } = require('../middleware/auth');
const { authLimiter, validateString, validateInteger } = require('../middleware/security');
const router = express.Router();

// Register new user
router.post('/register', authLimiter, upload.uploadMultiple, async (req, res) => {
  try {
    const { phoneNumber, nickname, email, idNumber, password } = req.body;

    // Validate and sanitize inputs
    if (!phoneNumber || typeof phoneNumber !== 'string' || phoneNumber.trim() === '') {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Validate phone number format (only digits, at least 10 characters)
    const phoneDigits = phoneNumber.replace(/\D/g, '');
    if (phoneDigits.length < 10) {
      return res.status(400).json({ error: 'Phone number must be at least 10 digits' });
    }

    if (!email || typeof email !== 'string' || email.trim() === '') {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (!idNumber || typeof idNumber !== 'string' || idNumber.trim() === '') {
      return res.status(400).json({ error: 'ID number is required' });
    }

    if (!password || typeof password !== 'string' || password.trim() === '') {
      return res.status(400).json({ error: 'Password is required' });
    }

    // Sanitize inputs
    const sanitizedPhoneNumber = validateString(phoneDigits, 20);
    const sanitizedNickname = nickname ? validateString(nickname, 100) : null;
    const sanitizedEmail = validateString(email.trim().toLowerCase(), 255);
    const sanitizedIdNumber = validateString(idNumber, 50);
    // Use nickname as name, or empty string if no nickname
    const sanitizedName = sanitizedNickname || '';
    
    if (!sanitizedPhoneNumber || !sanitizedEmail || !sanitizedIdNumber) {
      return res.status(400).json({ error: 'Invalid input format' });
    }

    if (password.length < 6 || password.length > 128) {
      return res.status(400).json({ error: 'Password must be between 6 and 128 characters' });
    }

    // Additional password strength check
    if (!/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]+$/.test(password)) {
      return res.status(400).json({ error: 'Password contains invalid characters' });
    }

    // Check if user already exists
    // Allow re-registration ONLY if the existing account was REJECTED
    // (common UX: user fixes info/images and re-submits for approval)
    const [existingUser] = await pool.query(
      'SELECT id, status, role, face_image, id_card_front, id_card_back FROM users WHERE id_number = ?',
      [sanitizedIdNumber]
    );

    // Hash password with higher rounds for production
    const saltRounds = process.env.NODE_ENV === 'production' ? 12 : 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Get uploaded file paths (normalize to relative paths)
    const path = require('path');
    const uploadPath = path.resolve(process.env.UPLOAD_PATH || './uploads');
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
        console.log(`[Register] File exists: ${require('fs').existsSync(resolvedPath)}`);
        
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
          console.log(`[Register] Face image - File exists: ${require('fs').existsSync(file.path)}`);
        } else {
          console.error(`[Register] Failed to normalize path: ${file.path}`);
          return res.status(400).json({ error: 'Invalid face image upload' });
        }
      }

      // Handle ID card front
      if (req.files.idCardFront && req.files.idCardFront[0]) {
        const file = req.files.idCardFront[0];
        const normalized = normalizePath(file.path);
        if (normalized) {
          idCardFront = normalized;
        } else {
          return res.status(400).json({ error: 'Invalid ID card front upload' });
        }
      }

      // Handle ID card back
      if (req.files.idCardBack && req.files.idCardBack[0]) {
        const file = req.files.idCardBack[0];
        const normalized = normalizePath(file.path);
        if (normalized) {
          idCardBack = normalized;
        } else {
          return res.status(400).json({ error: 'Invalid ID card back upload' });
        }
      }
    }

    // Validate required images
    if (!faceImage) {
      return res.status(400).json({ error: 'Face image is required' });
    }

    if (!idCardFront || !idCardBack) {
      return res.status(400).json({ error: 'Both ID card front and back images are required' });
    }

    // If user exists:
    // - REJECTED + USER: update the same record and set status back to PENDING
    // - Otherwise: block duplicate registration
    if (existingUser.length > 0) {
      const existing = existingUser[0];

      // Safety: never allow overwriting admin accounts
      if (existing.role === 'ADMIN') {
        return res.status(400).json({ error: 'ID number already registered' });
      }

      if (existing.status !== 'REJECTED') {
        return res.status(400).json({ error: 'ID number already registered' });
      }

      // Best-effort delete old images to avoid orphaned files
      try {
        const fs = require('fs');
        const oldFiles = [existing.face_image, existing.id_card_front, existing.id_card_back].filter(Boolean);
        for (const oldFile of oldFiles) {
          // We store just filenames (preferred). If absolute path somehow exists, handle it too.
          const oldPath = path.isAbsolute(oldFile) ? oldFile : path.join(uploadPath, oldFile);
          if (fs.existsSync(oldPath)) {
            fs.unlinkSync(oldPath);
          }
        }
      } catch (cleanupErr) {
        // Don't fail registration because of cleanup
        console.warn('[Register] Failed to cleanup old images:', cleanupErr?.message || cleanupErr);
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
        [sanitizedName, sanitizedNickname, sanitizedPhoneNumber, sanitizedEmail, faceImage, idCardFront, idCardBack, passwordHash, existing.id]
      );

      const [result] = await pool.query(
        `SELECT id, name, id_number, status, created_at 
         FROM users WHERE id = ?`,
        [existing.id]
      );

      return res.status(201).json({
        message: 'Registration updated. Waiting for admin approval.',
        user: result[0],
      });
    }

    // Insert new user
    const [insertResult] = await pool.query(
      `INSERT INTO users (name, nickname, phone_number, email, id_number, face_image, id_card_front, id_card_back, password_hash, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [sanitizedName, sanitizedNickname, sanitizedPhoneNumber, sanitizedEmail, sanitizedIdNumber, faceImage, idCardFront, idCardBack, passwordHash]
    );

    // Get the inserted user
    const [result] = await pool.query(
      `SELECT id, name, id_number, status, created_at 
       FROM users WHERE id = ?`,
      [insertResult.insertId]
    );

    res.status(201).json({
      message: 'Registration successful. Waiting for admin approval.',
      user: result[0]
    });
  } catch (error) {
    // Don't log sensitive information
    console.error('Registration error:', error.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate inputs
    if (!email || typeof email !== 'string' || email.trim() === '') {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const sanitizedEmail = validateString(email.trim().toLowerCase(), 255);
    if (!sanitizedEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (password.length > 128) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Find user
    const [result] = await pool.query(
      'SELECT id, name, id_number, email, password_hash, status, role, points_balance FROM users WHERE email = ?',
      [sanitizedEmail]
    );

    if (result.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result[0];

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if user is approved (admin can always login)
    if (user.status !== 'APPROVED' && user.role !== 'ADMIN') {
      return res.status(403).json({ 
        error: 'Account pending approval',
        status: user.status 
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        idNumber: user.id_number,
        status: user.status,
        role: user.role,
        pointsBalance: user.points_balance
      }
    });
  } catch (error) {
    // Don't log sensitive information
    console.error('Login error:', error.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Helper function to normalize image paths for API responses
const normalizeImagePath = (imagePath) => {
  if (!imagePath) return null;
  
  const path = require('path');
  
  // If it's already a relative path (doesn't start with drive letter or /)
  if (!path.isAbsolute(imagePath) && !imagePath.match(/^[A-Za-z]:/)) {
    // Preserve the path exactly as stored, just normalize slashes
    const normalized = imagePath.replace(/\\/g, '/');
    if (process.env.NODE_ENV === 'development') {
      console.log(`[Normalize] Relative path - Input: ${imagePath}, Output: ${normalized}`);
    }
    return normalized;
  }
  
  // If it's an absolute path, extract just the filename (preserves extension)
  const basename = path.basename(imagePath);
  if (process.env.NODE_ENV === 'development') {
    console.log(`[Normalize] Absolute path - Input: ${imagePath}, Output: ${basename}`);
  }
  return basename;
};

// Check user status by ID number (public endpoint for pending page)
router.post('/check-status', authLimiter, async (req, res) => {
  try {
    const { idNumber } = req.body;

    if (!idNumber || typeof idNumber !== 'string' || idNumber.trim() === '') {
      return res.status(400).json({ error: 'ID number is required' });
    }

    const sanitizedIdNumber = validateString(idNumber, 50);
    if (!sanitizedIdNumber) {
      return res.status(400).json({ error: 'Invalid ID number format' });
    }

    const [result] = await pool.query(
      'SELECT id, status FROM users WHERE id_number = ?',
      [sanitizedIdNumber]
    );

    if (result.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ 
      status: result[0].status,
      userId: result[0].id
    });
  } catch (error) {
    console.error('Check status error:', error);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// Get current user profile
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const [result] = await pool.query(
      `SELECT id, name, nickname, phone_number, id_number, face_image, id_card_front, id_card_back, status, points_balance, role, created_at 
       FROM users WHERE id = ?`,
      [req.user.id]
    );

    if (result.length === 0) {
      return res.status(404).json({ error: 'User not found' });
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
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

module.exports = router;

