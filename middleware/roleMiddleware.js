const isSeller = (req, res, next) => {
  if (req.user && req.user.role === 'seller') {
    return next();
  }
  return res.status(403).json({ error: 'Access denied. Seller role required.' });
};

module.exports = {
  isSeller
};