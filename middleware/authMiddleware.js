const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/auth');

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    const expired = error.name === 'TokenExpiredError';
    return res.status(401).json({
      error: expired ? 'Token expired' : 'Invalid token',
      code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
    });
  }
};

module.exports = authMiddleware;
