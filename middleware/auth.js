const jwt = require('jsonwebtoken');
const pool = require('../database/connection');

const getTokenFromCookies = (req) => {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';').map((part) => part.trim());
  for (const cookie of cookies) {
    if (cookie.startsWith('token=')) {
      return decodeURIComponent(cookie.substring('token='.length));
    }
  }
  return null;
};

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const headerToken = authHeader && authHeader.split(' ')[1];
    const queryToken =
      typeof req.query.token === 'string' ? req.query.token : null;
    const cookieToken = getTokenFromCookies(req);
    const token = headerToken || cookieToken || queryToken;

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Verify user still exists and is approved
    const [result] = await pool.query(
      'SELECT id, name, id_number, status, role, points_balance FROM users WHERE id = ?',
      [decoded.userId]
    );

    if (result.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = result[0];
    
    // Allow admins to bypass status check, regular users must be approved
    if (user.role !== 'ADMIN' && user.status !== 'APPROVED') {
      return res.status(403).json({ error: 'Account not approved' });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(500).json({ error: 'Authentication error' });
  }
};

const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (req.user.role !== 'ADMIN') {
    console.error('Admin access denied. User role:', req.user.role, 'User ID:', req.user.id);
    return res.status(403).json({ 
      error: 'Admin access required',
      userRole: req.user.role,
      userId: req.user.id
    });
  }
  next();
};

module.exports = { authenticateToken, requireAdmin };

