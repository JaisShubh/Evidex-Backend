import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';

export async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in.' } });
  let claims;
  try { claims = jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Your session is invalid or expired.' } }); }
  try {
    const user = await User.findById(claims.id).select('role status tokenVersion');
    if (!user || user.status !== 'active' || (claims.tokenVersion ?? 0) !== user.tokenVersion) {
      return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Your session is invalid or expired.' } });
    }
    req.user = { id: user.id, role: user.role };
    return next();
  } catch (error) { return next(error); }
}
export const requireRole = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to do this.' } });
