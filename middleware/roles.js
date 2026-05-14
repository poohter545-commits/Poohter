const roleGuard = (requiredRole) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (req.user.role !== requiredRole) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    next();
  };
};

const isSeller = roleGuard('seller');
const isBuyer = roleGuard('buyer');
const isAdmin = roleGuard('admin');
const isTopTeam = roleGuard('topteam');

module.exports = {
  isSeller,
  isBuyer,
  isAdmin,
  isTopTeam,
};
